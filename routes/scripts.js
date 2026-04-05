// Express router for script management
const express = require('express');
const router = express.Router();
const pm2 = require('pm2');
const cron = require('node-cron');
const configHandler = require('../utils/configHandler');
const logViewer = require('../utils/logViewer');
const path = require('path');
const { applyScriptExecution } = require('../utils/scriptRunner');

/**
 * Build PM2 config for a script (reduces code duplication)
 * @param {Object} script - Script config object
 * @param {Object} pm2Settings - PM2 settings from config
 * @returns {Object} PM2 config object
 */
function buildPm2Config(script, pm2Settings) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logsDir = configHandler.getLogsDir();
  const pm2Config = {
    name: script.name,
    args: script.args || [],
    env: script.env || {},
    autorestart: pm2Settings.autoRestart !== undefined ? pm2Settings.autoRestart : true,
    max_restarts: pm2Settings.maxRestarts || 10000,
    restart_delay: pm2Settings.restartDelay !== undefined ? pm2Settings.restartDelay : 1000,
    out_file: path.join(logsDir, `${script.name}-out-${timestamp}.log`),
    error_file: path.join(logsDir, `${script.name}-error-${timestamp}.log`),
  };

  return applyScriptExecution(pm2Config, script);
}

function validateCronSchedule(schedule) {
  return typeof schedule === 'string' && cron.validate(schedule.trim());
}

function buildScriptFromRequest(body) {
  const { name, path: scriptPath, command, type, schedule, count, args, env, cwd } = body;
  const script = {
    name,
    type,
    schedule: type === 'cron' ? schedule?.trim() : undefined,
    count: (type === 'cron' && count) ? parseInt(count, 10) : undefined,
    args: Array.isArray(args) ? args : (args ? args.split(',').map(a => a.trim()).filter(a => a) : []),
    env: typeof env === 'object' ? env : (env ? JSON.parse(env) : {}),
  };

  if (cwd && String(cwd).trim()) {
    script.cwd = String(cwd).trim();
  }

  if (command && command.trim()) {
    script.command = command;
  } else {
    script.path = scriptPath;
  }

  return script;
}

// API key authentication middleware (optional, configured in config.yaml)
function apiAuth(req, res, next) {
  const config = configHandler.loadConfig();
  
  // If auth is not enabled, skip authentication
  if (!config.api?.authEnabled) {
    return next();
  }
  
  // Check for API key in header or query param
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  
  if (apiKey && apiKey === config.api.apiKey) {
    return next();
  }
  
  res.status(401).json({ error: 'Unauthorized', message: 'Valid API key required' });
}

// Home page - redirect to scripts
router.get('/', (req, res) => {
  res.redirect('/scripts');
});

// List all scripts and status
router.get('/scripts', (req, res) => {
  pm2.connect(() => {
    pm2.list((err, list) => {
      const config = configHandler.loadConfig();
      res.render('scripts', {
        scripts: config.scripts,
        pm2list: list || [],
        cronRunHistory: req.app.locals.cronRunHistory || {},
        cronSuspended: req.app.locals.cronSuspended || {},
        serverTimeZone: req.app.locals.serverTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        serverNow: new Date(),
      });
      pm2.disconnect();
    });
  });
});

// View logs for a script
router.get('/logs/:scriptName', (req, res) => {
  const scriptName = req.params.scriptName;
  const logs = logViewer.listLogs(scriptName);
  const selectedLog = req.query.file || (logs.length ? logs[0].name : '');
  const logContent = selectedLog ? logViewer.readLog(selectedLog) : '';
  const stats = logViewer.getLogStats(scriptName);
  res.render('logs', { scriptName, logs, logContent, selectedLog, stats });
});

// API endpoint to fetch log content (for auto-refresh)
router.get('/api/logs/:scriptName', (req, res) => {
  const scriptName = req.params.scriptName;
  const logs = logViewer.listLogs(scriptName);
  const selectedLog = req.query.file || (logs.length ? logs[0].name : '');
  const logContent = selectedLog ? logViewer.readLog(selectedLog) : '';
  res.json({ logs, logContent, selectedLog });
});

// API endpoint to fetch log stats (for auto-refresh detection)
router.get('/api/logs/:scriptName/stats', (req, res) => {
  const scriptName = req.params.scriptName;
  const stats = logViewer.getLogStats(scriptName);
  res.json(stats);
});

// API endpoint to fetch log chunks (for progressive loading)
router.get('/api/logs/:scriptName/chunk', (req, res) => {
  const scriptName = req.params.scriptName;
  const filename = req.query.file;
  
  if (!filename) {
    return res.status(400).json({ error: 'No file specified' });
  }
  
  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 500;
  const fromEnd = req.query.fromEnd !== 'false'; // default true
  
  const result = logViewer.readLogChunk(filename, { offset, limit, fromEnd });
  res.json(result);
});

// API endpoint to download log file
router.get('/api/logs/:scriptName/download', (req, res) => {
  const scriptName = req.params.scriptName;
  const filename = req.query.file;

  if (!filename) {
    return res.status(400).send('No file specified');
  }

  // Security: use basename to prevent path traversal
  const safeFilename = path.basename(filename);
  if (safeFilename !== filename || !safeFilename.startsWith(scriptName)) {
    return res.status(403).send('Access denied');
  }

  const fs = require('fs');
  const logsDir = configHandler.getLogsDir();
  const filePath = path.join(logsDir, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Log file not found');
  }

  res.download(filePath, safeFilename);
});

// API endpoint to delete log file
router.delete('/api/logs/:scriptName/delete', (req, res) => {
  const scriptName = req.params.scriptName;
  const filename = req.query.file;

  if (!filename) {
    return res.status(400).json({ success: false, error: 'No file specified' });
  }

  // Security: use basename to prevent path traversal
  const safeFilename = path.basename(filename);
  if (safeFilename !== filename || !safeFilename.startsWith(scriptName)) {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }

  const fs = require('fs');
  const logsDir = configHandler.getLogsDir();
  const filePath = path.join(logsDir, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'Log file not found' });
  }

  try {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add a new script (form)
router.get('/add-script', (req, res) => {
  res.render('add-script', {
    script: null,
    isEdit: false,
    serverTimeZone: req.app.locals.serverTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

// Add a new script (POST)
router.post('/add-script', (req, res) => {
  const config = configHandler.loadConfig();
  const newScript = buildScriptFromRequest(req.body);

  if (newScript.type === 'cron' && !validateCronSchedule(newScript.schedule)) {
    return res.status(400).send('Invalid cron schedule');
  }

  config.scripts.push(newScript);
  configHandler.writeConfig(config);

  if (req.app.locals.cronManager) {
    req.app.locals.cronManager.upsertScript(newScript);
  }

  res.redirect('/scripts');
});

// Edit a script (form)
router.get('/edit-script/:scriptName', (req, res) => {
  const config = configHandler.loadConfig();
  const script = config.scripts.find(s => s.name === req.params.scriptName);
  if (!script) {
    return res.status(404).send('Script not found');
  }
  res.render('edit-script', {
    script,
    isEdit: true,
    serverTimeZone: req.app.locals.serverTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
});

// Edit a script (POST)
router.post('/edit-script/:scriptName', (req, res) => {
  const config = configHandler.loadConfig();
  const scriptIndex = config.scripts.findIndex(s => s.name === req.params.scriptName);
  if (scriptIndex === -1) {
    return res.status(404).send('Script not found');
  }

  const previousScript = config.scripts[scriptIndex];
  const updatedScript = buildScriptFromRequest(req.body);

  if (updatedScript.type === 'forever' && previousScript.stopped) {
    updatedScript.stopped = true;
  }
  if (updatedScript.type === 'cron' && previousScript.suspended) {
    updatedScript.suspended = true;
  }

  if (updatedScript.type === 'cron' && !validateCronSchedule(updatedScript.schedule)) {
    return res.status(400).send('Invalid cron schedule');
  }

  config.scripts[scriptIndex] = updatedScript;
  configHandler.writeConfig(config);

  if (req.app.locals.cronManager) {
    req.app.locals.cronManager.upsertScript(updatedScript, previousScript.name);
  }

  if (previousScript.type === 'forever' && (updatedScript.type !== 'forever' || previousScript.name !== updatedScript.name)) {
    pm2.connect(() => {
      pm2.delete(previousScript.name, () => {
        pm2.disconnect();
      });
    });
  }

  res.redirect('/scripts');
});

// Delete a script
router.post('/delete-script/:scriptName', (req, res) => {
  const config = configHandler.loadConfig();
  const scriptIndex = config.scripts.findIndex(s => s.name === req.params.scriptName);
  
  if (scriptIndex === -1) {
    return res.status(404).send('Script not found');
  }
  
  const script = config.scripts[scriptIndex];
  
  // If it's a forever script, stop it from PM2 first
  if (script.type === 'forever') {
    pm2.connect(() => {
      pm2.delete(req.params.scriptName, (err) => {
        if (err) console.error(`Failed to delete ${req.params.scriptName} from PM2:`, err);
        pm2.disconnect();
      });
    });
  }
  
  // If it's a cron job, remove it from the live scheduler too
  if (script.type === 'cron' && req.app.locals.cronManager) {
    req.app.locals.cronManager.unregisterScript(req.params.scriptName);
  }
  
  // Remove from config
  config.scripts.splice(scriptIndex, 1);
  configHandler.writeConfig(config);
  
  res.redirect('/scripts');
});

// Stop a running script (forever tasks only)
router.post('/stop-script/:scriptName', (req, res) => {
  pm2.connect(() => {
    pm2.stop(req.params.scriptName, () => {
      // Save stopped status to config
      const config = configHandler.loadConfig();
      const script = config.scripts.find(s => s.name === req.params.scriptName);
      if (script && script.type === 'forever') {
        script.stopped = true;
        configHandler.writeConfig(config);
      }
      pm2.disconnect();
      res.redirect('/scripts');
    });
  });
});

// Start a stopped script (forever tasks only)
router.post('/start-script/:scriptName', (req, res) => {
  const config = configHandler.loadConfig();
  const script = config.scripts.find(s => s.name === req.params.scriptName && s.type === 'forever');
  
  if (!script) {
    return res.status(404).send('Script not found or not a forever task');
  }
  
  pm2.connect(() => {
    // Check if already running
    pm2.list((err, list) => {
      const isRunning = list.some(p => p.name === script.name);
      
      const startFreshProcess = () => {
        const pm2Config = buildPm2Config(script, config.pm2);

        pm2.start(pm2Config, (err) => {
          if (err) console.error(`Failed to start ${script.name}:`, err);
          // Clear stopped status in config
          script.stopped = false;
          configHandler.writeConfig(config);
          pm2.disconnect();
          res.redirect('/scripts');
        });
      };
      
      if (isRunning) {
        // Delete existing process first, then start fresh with new logs
        pm2.delete(script.name, (err) => {
          if (err) console.error(`Failed to delete ${script.name}:`, err);
          startFreshProcess();
        });
      } else {
        // Start fresh
        startFreshProcess();
      }
    });
  });
});

// Restart a script (creates new log files)
router.post('/restart-script/:scriptName', (req, res) => {
  const config = configHandler.loadConfig();
  const script = config.scripts.find(s => s.name === req.params.scriptName && s.type === 'forever');

  if (!script) {
    return res.status(404).send('Script not found or not a forever task');
  }

  pm2.connect(() => {
    // Delete the existing process
    pm2.delete(req.params.scriptName, (err) => {
      if (err) console.error(`Failed to delete ${req.params.scriptName}:`, err);

      const pm2Config = buildPm2Config(script, config.pm2);

      pm2.start(pm2Config, (err) => {
        if (err) console.error(`Failed to restart ${script.name}:`, err);
        pm2.disconnect();
        res.redirect('/scripts');
      });
    });
  });
});

// Suspend a cron job
router.post('/suspend-cron/:scriptName', (req, res) => {
  if (req.app.locals.cronManager) {
    req.app.locals.cronManager.setSuspended(req.params.scriptName, true);
  }
  
  // Save suspended status to config
  const config = configHandler.loadConfig();
  const script = config.scripts.find(s => s.name === req.params.scriptName && s.type === 'cron');
  if (script) {
    script.suspended = true;
    configHandler.writeConfig(config);
  }
  
  res.redirect('/scripts');
});

// Resume a cron job
router.post('/resume-cron/:scriptName', (req, res) => {
  if (req.app.locals.cronManager) {
    req.app.locals.cronManager.setSuspended(req.params.scriptName, false);
  }
  
  // Clear suspended status from config
  const config = configHandler.loadConfig();
  const script = config.scripts.find(s => s.name === req.params.scriptName && s.type === 'cron');
  if (script) {
    script.suspended = false;
    configHandler.writeConfig(config);
  }
  
  res.redirect('/scripts');
});

router.post('/run-cron-now/:scriptName', async (req, res) => {
  const config = configHandler.loadConfig();
  const script = config.scripts.find(s => s.name === req.params.scriptName && s.type === 'cron');

  if (!script) {
    return res.status(404).send('Cron script not found');
  }

  try {
    if (req.app.locals.cronManager) {
      await req.app.locals.cronManager.runNow(req.params.scriptName);
    }
    res.redirect('/scripts');
  } catch (error) {
    console.error(`Failed to run cron ${req.params.scriptName} manually:`, error);
    res.status(500).send(`Failed to run cron job: ${error.message}`);
  }
});

// Settings page
router.get('/settings', (req, res) => {
  const config = configHandler.loadConfig();
  res.render('settings', { 
    logManagement: config.logManagement || { autoDelete: false, retentionDays: 7, checkInterval: 3600000 }
  });
});

// Update settings
router.post('/settings', (req, res) => {
  const config = configHandler.loadConfig();
  const { autoDelete, retentionDays, checkInterval } = req.body;
  
  config.logManagement = {
    autoDelete: autoDelete === 'on',
    retentionDays: parseInt(retentionDays) || 7,
    checkInterval: parseInt(checkInterval) || 3600000
  };
  
  configHandler.writeConfig(config);
  res.redirect('/settings?saved=true');
});

// =============================================================================
// JSON API Endpoints (for programmatic access, e.g., from GitSync)
// These endpoints return JSON instead of redirects and support API key auth
// =============================================================================

// Restart a script (JSON API)
router.post('/api/restart-script/:scriptName', apiAuth, (req, res) => {
  const config = configHandler.loadConfig();
  // Find script (either in config or just in PM2 if we want to allow restarting unmanaged scripts, but config is safer)
  // For self-restart (taskserver), it might not be in config.scripts if we decided not to add it there. 
  // But standard practice: only manage what's in config.
  // HOWEVER: User plan said "No Self-Config", so we might need to allow it if name matches.
  
  const scriptName = req.params.scriptName;
  const script = config.scripts.find(s => s.name === scriptName && s.type === 'forever');
  
  // Special handling for TaskServer self-restart
  // Check if we are restarting OURSELVES (the current process)
  const isSelf = (process.env.name === scriptName) || (scriptName === 'taskserver');

  if (!script && !isSelf) {
    return res.status(404).json({ 
      success: false, 
      error: 'Script not found or not a forever task' 
    });
  }
  
  pm2.connect((err) => {
    if (err) {
      return res.status(500).json({ success: false, error: 'PM2 connection failed' });
    }
    
    // IF SELF: Use pm2.restart (preserves process identity, doesn't wait for completion in same way)
    if (isSelf) {
        pm2.restart(scriptName, (restartErr) => {
            pm2.disconnect();
            if (restartErr) {
                console.error(`Failed to restart self (${scriptName}):`, restartErr);
                return res.status(500).json({ 
                    success: false, 
                    error: `Failed to restart self: ${restartErr.message}` 
                });
            }
            // We might technically die before sending this, but usually restart has a small delay
            res.json({ 
                success: true, 
                message: `TaskServer (${scriptName}) restarting...`,
                logFile: 'pending...' 
            });
        });
        return;
    }

    // IF OTHER: Delete and Start Fresh (for new log files)
    pm2.delete(req.params.scriptName, (deleteErr) => {
      if (deleteErr) console.error(`Failed to delete ${req.params.scriptName}:`, deleteErr);

      const pm2Config = buildPm2Config(script, config.pm2);

      pm2.start(pm2Config, (startErr) => {
        // Clear stopped status (important: ensures UI shows correct status after restart)
        script.stopped = false;
        configHandler.writeConfig(config);
        pm2.disconnect();

        if (startErr) {
          console.error(`Failed to restart ${script.name}:`, startErr);
          return res.status(500).json({
            success: false,
            error: `Failed to restart: ${startErr.message}`
          });
        }
        res.json({
          success: true,
          message: `Script '${script.name}' restarted successfully`,
          logFile: path.basename(pm2Config.out_file)
        });
      });
    });
  });
});

// Stop a script (JSON API)
router.post('/api/stop-script/:scriptName', apiAuth, (req, res) => {
  const config = configHandler.loadConfig();
  const script = config.scripts.find(s => s.name === req.params.scriptName && s.type === 'forever');
  
  if (!script) {
    return res.status(404).json({ 
      success: false, 
      error: 'Script not found or not a forever task' 
    });
  }
  
  pm2.connect((err) => {
    if (err) {
      return res.status(500).json({ success: false, error: 'PM2 connection failed' });
    }
    
    pm2.stop(req.params.scriptName, (stopErr) => {
      // Save stopped status to config
      script.stopped = true;
      configHandler.writeConfig(config);
      pm2.disconnect();
      
      if (stopErr) {
        return res.status(500).json({ 
          success: false, 
          error: `Failed to stop: ${stopErr.message}` 
        });
      }
      res.json({ 
        success: true, 
        message: `Script '${script.name}' stopped successfully` 
      });
    });
  });
});

// Start a script (JSON API)
router.post('/api/start-script/:scriptName', apiAuth, (req, res) => {
  const config = configHandler.loadConfig();
  const script = config.scripts.find(s => s.name === req.params.scriptName && s.type === 'forever');
  
  if (!script) {
    return res.status(404).json({ 
      success: false, 
      error: 'Script not found or not a forever task' 
    });
  }
  
  pm2.connect((err) => {
    if (err) {
      return res.status(500).json({ success: false, error: 'PM2 connection failed' });
    }
    
    pm2.list((listErr, list) => {
      const isRunning = list && list.some(p => p.name === script.name && p.pm2_env.status === 'online');
      
      if (isRunning) {
        pm2.disconnect();
        return res.status(400).json({
          success: false,
          error: 'Script is already running'
        });
      }

      const pm2Config = buildPm2Config(script, config.pm2);

      pm2.start(pm2Config, (startErr) => {
        // Clear stopped status
        script.stopped = false;
        configHandler.writeConfig(config);
        pm2.disconnect();

        if (startErr) {
          return res.status(500).json({
            success: false,
            error: `Failed to start: ${startErr.message}`
          });
        }
        res.json({
          success: true,
          message: `Script '${script.name}' started successfully`,
          logFile: path.basename(pm2Config.out_file)
        });
      });
    });
  });
});

// List all scripts (JSON API)
router.get('/api/scripts', apiAuth, (req, res) => {
  pm2.connect((err) => {
    if (err) {
      return res.status(500).json({ success: false, error: 'PM2 connection failed' });
    }
    
    pm2.list((listErr, list) => {
      const config = configHandler.loadConfig();
      
      const scripts = config.scripts.map(script => {
        const pm2Process = list && list.find(p => p.name === script.name);
        return {
          name: script.name,
          type: script.type,
          status: pm2Process ? pm2Process.pm2_env.status : (script.type === 'cron' ? 'scheduled' : 'stopped'),
          path: script.path || null,
          command: script.command || null,
          cwd: script.cwd || null,
          schedule: script.schedule || null,
          suspended: script.suspended || false,
        };
      });
      
      pm2.disconnect();
      res.json({ success: true, scripts });
    });
  });
});

// Add a new script (JSON API)
router.post('/api/add-script', apiAuth, (req, res) => {
  const config = configHandler.loadConfig();
  const { name, path: scriptPath, command, type, schedule } = req.body;
  
  // Validate required fields
  if (!name) {
    return res.status(400).json({ success: false, error: 'Script name is required' });
  }
  if (!type || !['forever', 'cron'].includes(type)) {
    return res.status(400).json({ success: false, error: 'Script type must be "forever" or "cron"' });
  }
  if (!scriptPath && !command) {
    return res.status(400).json({ success: false, error: 'Either path or command is required' });
  }
  if (type === 'cron' && !schedule) {
    return res.status(400).json({ success: false, error: 'Schedule is required for cron scripts' });
  }
  if (type === 'cron' && !validateCronSchedule(schedule)) {
    return res.status(400).json({ success: false, error: 'Invalid cron schedule' });
  }
  
  // Check if script already exists
  const existingScript = config.scripts.find(s => s.name === name);
  if (existingScript) {
    return res.status(409).json({ success: false, error: `Script '${name}' already exists` });
  }
  
  const newScript = buildScriptFromRequest(req.body);
  
  // Add to config and save
  config.scripts.push(newScript);
  configHandler.writeConfig(config);

  if (type === 'cron' && req.app.locals.cronManager) {
    req.app.locals.cronManager.upsertScript(newScript);
  }
  
  // If it's a forever script, optionally start it immediately
  if (type === 'forever' && req.body.autoStart !== false) {
    const pm2Config = buildPm2Config(newScript, config.pm2);

    pm2.connect((err) => {
      if (err) {
        return res.json({
          success: true,
          message: `Script '${name}' added but failed to auto-start: ${err.message}`,
          autoStarted: false
        });
      }

      pm2.start(pm2Config, (startErr) => {
        pm2.disconnect();
        res.json({
          success: true,
          message: `Script '${name}' added${startErr ? ' (auto-start failed)' : ' and started'}`,
          autoStarted: !startErr
        });
      });
    });
  } else {
    res.json({
      success: true,
      message: `Script '${name}' added`,
      autoStarted: false
    });
  }
});

module.exports = router;
