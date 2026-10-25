// Main entry point for TaskServer.
//
// Requiring this file has no side effects: createApp() builds the Express app
// from the pieces it is given, and main() (run only when this file is the
// entry point) wires up PM2, cron, the listener and signal handling.
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const configHandler = require('./utils/configHandler');
const logCleanup = require('./utils/logCleanup');
const cloudflareTunnel = require('./utils/cloudflareTunnel');
const createCronManager = require('./utils/cronManager');
const { createProcessService, errorText } = require('./utils/processService');
const { createJobControl } = require('./utils/jobControl');
const { reconcileWithRetry, checkPm2Versions } = require('./utils/reconcile');
const { errorMiddleware, installProcessHandlers } = require('./utils/httpErrors');
const scriptsRouter = require('./routes/scripts');

function createApp({ processService, jobControl, cronManager } = {}) {
  if (!processService) throw new Error('createApp needs a processService');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(bodyParser.json());

  app.locals.processService = processService;
  app.locals.jobControl = jobControl || createJobControl({ service: processService });
  // Make cron history and jobs available to routes
  app.locals.cronManager = cronManager;
  app.locals.cronRunHistory = cronManager?.cronRunHistory;
  app.locals.cronSuspended = cronManager?.cronSuspended;
  app.locals.serverTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  app.use((req, res, next) => {
    res.locals.serverTimeZone = req.app.locals.serverTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    res.locals.serverNow = new Date();
    next();
  });

  app.use('/', scriptsRouter);
  app.use(errorMiddleware());
  return app;
}

// Listen, and cope with the port still being held by the previous instance
// (for example a restart that raced the old process shutting down): say so
// clearly and retry with a growing pause instead of crash-looping. Gives up
// after `attempts` tries.
function listenWithRetry(app, port, host, {
  attempts = 8,
  baseDelayMs = 500,
  maxDelayMs = 5000,
  logger = console,
  isClosed = () => false,
} = {}) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      attempt += 1;
      const server = app.listen(port, host);
      server.once('listening', () => resolve(server));
      server.once('error', error => {
        if (error.code === 'EADDRINUSE' && attempt < attempts && !isClosed()) {
          const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
          logger.error(`Port ${port} on ${host} is already in use (attempt ${attempt}/${attempts}); `
            + `another TaskServer may still be shutting down. Retrying in ${delay} ms`);
          setTimeout(tryListen, delay);
          return;
        }
        if (error.code === 'EADDRINUSE') {
          logger.error(`Port ${port} on ${host} is still in use after ${attempt} attempts. `
            + 'Stop whatever holds it, or change server.port in config.yaml.');
        }
        reject(error);
      });
    };
    tryListen();
  });
}

async function main() {
  const config = configHandler.loadConfig();
  let closing = false;

  // Setup automatic log cleanup if enabled
  let cleanupInterval = null;
  if (config.logManagement && config.logManagement.autoDelete) {
    const retentionDays = config.logManagement.retentionDays || 7;
    const checkInterval = config.logManagement.checkInterval || 3600000; // default 1 hour
    cleanupInterval = logCleanup.startAutoCleanup(retentionDays, checkInterval);
  }

  const processService = createProcessService();
  const jobControl = createJobControl({ service: processService });
  // Schedule cron jobs now; the sweep of old stopped runs runs in the background.
  const cronManager = createCronManager({ service: processService });
  cronManager.bootstrap(config.scripts);

  const app = createApp({ processService, jobControl, cronManager });
  let server = null;

  // PM2 keeps running while TaskServer restarts, so shutting down only closes
  // TaskServer's own things. It never stops a job.
  const shutdown = (signal, exitCode = 0) => {
    if (closing) return;
    closing = true;
    console.log(`\nShutting down TaskServer (${signal})...`);
    // PM2 force-kills a process 1600 ms after asking it to stop; stay inside that.
    setTimeout(() => process.exit(exitCode), 1000).unref();
    cronManager.shutdown();
    if (cleanupInterval) clearInterval(cleanupInterval);
    cloudflareTunnel.stopTunnel();
    if (server) {
      server.close();
      server.closeIdleConnections?.();
      setTimeout(() => server.closeAllConnections?.(), 300).unref();
    }
    processService.close().finally(() => process.exit(exitCode));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  installProcessHandlers({ onFatal: () => shutdown('uncaughtException', 1) });

  const PORT = config.server.port || 3000;
  const HOST = config.server.host;
  try {
    server = await listenWithRetry(app, PORT, HOST, { isClosed: () => closing });
  } catch (error) {
    console.error(`Could not listen on ${HOST}:${PORT}: ${errorText(error)}`);
    shutdown('listen failure', 1);
    return;
  }
  const address = server.address();
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  console.log(`TaskServer running at http://${host}:${address.port}`);

  // Adopt the jobs PM2 already runs and start the missing ones. Runs in the
  // background and retries until PM2 answers.
  checkPm2Versions({ service: processService })
    .then(() => reconcileWithRetry({ service: processService, jobControl, isClosed: () => closing }))
    .catch(error => console.error(`[Reconcile] Failed: ${errorText(error)}`));

  const tunnelOrigin = cloudflareTunnel.localOrigin(address);
  // Start Cloudflare Tunnel if configured
  if (config.cloudflare && config.cloudflare.enabled && config.cloudflare.tunnelToken) {
    try {
      const tunnelUrl = await cloudflareTunnel.startTunnel(config.cloudflare.tunnelToken, tunnelOrigin);
      if (tunnelUrl) {
        console.log(`✅ Dashboard accessible online at: ${tunnelUrl}`);
      } else {
        console.log('⚠️  Cloudflare Tunnel started but URL could not be determined');
      }
    } catch (error) {
      console.error('❌ Failed to start Cloudflare Tunnel:', error.message);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { createApp, listenWithRetry, main };
