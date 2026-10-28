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
const { errorMiddleware, installProcessHandlers, isApiPath } = require('./utils/httpErrors');
const { createSecurity, createAuthSource, startupCheck } = require('./utils/security');
const scriptsRouter = require('./routes/scripts');

function createApp({ processService, jobControl, cronManager, security = createSecurity() } = {}) {
  if (!processService) throw new Error('createApp needs a processService');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Order matters. Everything below the static files and the login page is
  // behind the authentication check, and nothing reads a request body before it.
  app.use(security.headers);
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(security.hostGuard);
  app.use(security.loginRouter);
  app.use(security.authenticate);
  // Forms are only for the dashboard pages; /api takes JSON.
  const forms = bodyParser.urlencoded({ extended: true });
  app.use((req, res, next) => (isApiPath(req.path) ? next() : forms(req, res, next)));
  app.use(bodyParser.json());
  app.use(security.csrfGuard);
  app.use(security.sessionRouter);

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

// Say exactly why, and how to recover: PM2 keeps restarting a process that exits
// like this, and then leaves it "errored".
function refuseToStart(problems, selfName) {
  for (const problem of problems) console.error(`Refusing to start: ${problem}`);
  console.error(`Fix config.yaml, then run: pm2 restart ${selfName}   (see "Recovering from a startup refusal" in the README)`);
  process.exit(1);
}

async function main() {
  // Do not start with settings that cannot be read, or that would expose the
  // dashboard without a key.
  const { config, problems } = startupCheck();
  if (problems.length) refuseToStart(problems, configHandler.getSelfName(config || {}));
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
  // Schedule cron jobs now. The sweep of old stopped runs starts later (below),
  // after the server listens and the jobs are reconciled, so it never queues
  // ahead of job control at boot.
  const cronManager = createCronManager({ service: processService });
  cronManager.bootstrap(config.scripts, { cleanup: false });

  // The security settings start from the config checked above, so there is no
  // moment at which a missing or empty file could count as "no authentication".
  const security = createSecurity({ loadAuth: createAuthSource({ seed: config }) });
  const app = createApp({ processService, jobControl, cronManager, security });
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
  // The version check runs alongside, so a slow answer cannot delay it.
  checkPm2Versions({ service: processService })
    .catch(error => console.error(`[PM2] Version check failed: ${errorText(error)}`));
  reconcileWithRetry({ service: processService, jobControl, isClosed: () => closing })
    .catch(error => console.error(`[Reconcile] Failed: ${errorText(error)}`))
    .finally(() => { if (!closing) cronManager.startCleanup(); });

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
