// Main entry point for TaskServer
const express = require('express');
const bodyParser = require('body-parser');
const pm2 = require('pm2');
const cron = require('node-cron');
const path = require('path');
const configHandler = require('./utils/configHandler');
const logViewer = require('./utils/logViewer');
const logCleanup = require('./utils/logCleanup');
const cloudflareTunnel = require('./utils/cloudflareTunnel');
const scriptsRouter = require('./routes/scripts');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// Load config
const config = configHandler.loadConfig();

// Setup automatic log cleanup if enabled
let cleanupInterval = null;
if (config.logManagement && config.logManagement.autoDelete) {
  const retentionDays = config.logManagement.retentionDays || 7;
  const checkInterval = config.logManagement.checkInterval || 3600000; // default 1 hour
  cleanupInterval = logCleanup.startAutoCleanup(retentionDays, checkInterval);
}

// Start PM2 and forever scripts
pm2.connect(function(err) {
  if (err) {
    console.error('PM2 connect error:', err);
    process.exit(2);
  }
  config.scripts.forEach(script => {
    if (script.type === 'forever') {
      // Only start if not marked as stopped
      if (script.stopped) {
        console.log(`Skipping ${script.name} (marked as stopped)`);
        return;
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const pm2Config = {
        name: script.name,
        args: script.args || [],
        env: script.env || {},
        cwd: process.cwd(),
        autorestart: true,
        max_restarts: 10000, // Allow many restarts
        out_file: `logs/${script.name}-out-${timestamp}.log`,
        error_file: `logs/${script.name}-error-${timestamp}.log`,
      };

      // Check if it's a command (no path) or a script file (has path)
      if (script.command) {
        // Run as shell command - redirect stderr to stdout so all output goes to out log
        pm2Config.script = '/bin/bash';
        pm2Config.args = ['-c', `${script.command} 2>&1`];
      } else {
        // Run as script file
        pm2Config.script = script.path;
      }

      pm2.start(pm2Config, (err) => {
        if (err) console.error(`Failed to start ${script.name}:`, err);
      });
    }
  });
});

// Setup cron jobs with last run tracking
const cronJobs = [];
const cronRunHistory = {}; // Track last run times
const cronSuspended = {}; // Track suspended cron jobs

config.scripts.forEach(script => {
  if (script.type === 'cron' && script.schedule) {
    let runCount = 0;
    const maxRuns = script.count || Infinity;
    
    // Initialize tracking
    cronRunHistory[script.name] = { lastRun: null, nextRun: null };
    // Load suspended state from config
    cronSuspended[script.name] = script.suspended || false;
    
    const job = cron.schedule(script.schedule, () => {
      if (runCount >= maxRuns || cronSuspended[script.name]) return;
      runCount++;
      
      // Update last run time
      cronRunHistory[script.name].lastRun = new Date();
      
      const pm2Config = {
        name: `${script.name}-cron-${Date.now()}`,
        args: script.args || [],
        env: script.env || {},
        cwd: process.cwd(),
        autorestart: false,
        out_file: `logs/${script.name}-out-${Date.now()}.log`,
        error_file: `logs/${script.name}-error-${Date.now()}.log`,
      };

      // Check if it's a command (no path) or a script file (has path)
      if (script.command) {
        // Run as shell command - redirect stderr to stdout so all output goes to out log
        pm2Config.script = '/bin/bash';
        pm2Config.args = ['-c', `${script.command} 2>&1`];
      } else {
        // Run as script file
        pm2Config.script = script.path;
      }
      
      pm2.start(pm2Config, (err) => {
        if (err) console.error(`Failed to start cron ${script.name}:`, err);
      });
    });
    cronJobs.push({ name: script.name, job, schedule: script.schedule });
  }
});

// Make cron history and jobs available to routes
app.locals.cronRunHistory = cronRunHistory;
app.locals.cronJobs = cronJobs;
app.locals.cronSuspended = cronSuspended;

// Use scripts router
app.use('/', scriptsRouter);

// Start server
const PORT = 3000;
app.listen(PORT, async () => {
  console.log(`TaskServer running at http://localhost:${PORT}`);
  
  // Start Cloudflare Tunnel if configured
  if (config.cloudflare && config.cloudflare.enabled && config.cloudflare.tunnelToken) {
    try {
      const tunnelUrl = await cloudflareTunnel.startTunnel(config.cloudflare.tunnelToken, PORT);
      if (tunnelUrl) {
        console.log(`✅ Dashboard accessible online at: ${tunnelUrl}`);
      } else {
        console.log('⚠️  Cloudflare Tunnel started but URL could not be determined');
      }
    } catch (error) {
      console.error('❌ Failed to start Cloudflare Tunnel:', error.message);
    }
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down TaskServer...');
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    console.log('Stopped log cleanup interval');
  }
  cloudflareTunnel.stopTunnel();
  pm2.disconnect();
  process.exit();
});
