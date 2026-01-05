// Express router for script management
const express = require('express');
const router = express.Router();
const pm2 = require('pm2');
const configHandler = require('../utils/configHandler');
const logViewer = require('../utils/logViewer');
const path = require('path');

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
  
  const fs = require('fs');
  const logsDir = path.join(__dirname, '../logs');
  const filePath = path.join(logsDir, filename);
  
  if (!fs.existsSync(filePath) || !filename.startsWith(scriptName)) {
    return res.status(404).send('Log file not found');
  }
  
  res.download(filePath, filename);
});

// API endpoint to delete log file
router.delete('/api/logs/:scriptName/delete', (req, res) => {
  const scriptName = req.params.scriptName;
  const filename = req.query.file;
  
  if (!filename) {
    return res.status(400).json({ success: false, error: 'No file specified' });
  }
  
  const fs = require('fs');
  const logsDir = path.join(__dirname, '../logs');
  const filePath = path.join(logsDir, filename);
  
  // Security check: ensure file belongs to this script
  if (!filename.startsWith(scriptName)) {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }
  
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
  res.render('add-script', { script: null, isEdit: false });
});

// Add a new script (POST)
router.post('/add-script', (req, res) => {
  const config = configHandler.loadConfig();
  const { name, path: scriptPath, command, type, schedule, count, args, env } = req.body;
  const newScript = {
    name,
    type,
    schedule: type === 'cron' ? schedule : undefined,
    count: (type === 'cron' && count) ? parseInt(count) : undefined,
    args: args ? args.split(',').map(a => a.trim()).filter(a => a) : [],
    env: env ? JSON.parse(env) : {},
  };
  
  // Use either command or path
  if (command && command.trim()) {
    newScript.command = command;
  } else {
    newScript.path = scriptPath;
  }
  
  config.scripts.push(newScript);
  configHandler.writeConfig(config);
  res.redirect('/scripts');
});

// Edit a script (form)
router.get('/edit-script/:scriptName', (req, res) => {
  const config = configHandler.loadConfig();
  const script = config.scripts.find(s => s.name === req.params.scriptName);
  if (!script) {
    return res.status(404).send('Script not found');
  }
  res.render('edit-script', { script, isEdit: true });
});

// Edit a script (POST)
router.post('/edit-script/:scriptName', (req, res) => {
  const config = configHandler.loadConfig();
  const scriptIndex = config.scripts.findIndex(s => s.name === req.params.scriptName);
  if (scriptIndex === -1) {
    return res.status(404).send('Script not found');
  }
  
  const { name, path: scriptPath, command, type, schedule, count, args, env } = req.body;
  config.scripts[scriptIndex] = {
    name,
    type,
    schedule: type === 'cron' ? schedule : undefined,
    count: (type === 'cron' && count) ? parseInt(count) : undefined,
    args: args ? args.split(',').map(a => a.trim()).filter(a => a) : [],
    env: env ? JSON.parse(env) : {},
  };
  
  // Use either command or path
  if (command && command.trim()) {
    config.scripts[scriptIndex].command = command;
  } else {
    config.scripts[scriptIndex].path = scriptPath;
  }
  
  configHandler.writeConfig(config);
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
  
  // If it's a cron job, mark it in suspended state (it will be removed on next restart)
  if (script.type === 'cron' && req.app.locals.cronSuspended) {
    req.app.locals.cronSuspended[req.params.scriptName] = true;
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
        // Start with new log files
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const pm2Config = {
          name: script.name,
          args: script.args || [],
          env: script.env || {},
          cwd: process.cwd(),
          autorestart: true,
          max_restarts: 10000,
          out_file: `logs/${script.name}-out-${timestamp}.log`,
          error_file: `logs/${script.name}-error-${timestamp}.log`,
        };

        if (script.command) {
          // Redirect stderr to stdout so all output goes to out log
          pm2Config.script = '/bin/bash';
          pm2Config.args = ['-c', `${script.command} 2>&1`];
        } else {
          pm2Config.script = script.path;
        }

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
      
      // Start fresh with new log files
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const pm2Config = {
        name: script.name,
        args: script.args || [],
        env: script.env || {},
        cwd: process.cwd(),
        autorestart: true,
        max_restarts: 10000,
        out_file: `logs/${script.name}-out-${timestamp}.log`,
        error_file: `logs/${script.name}-error-${timestamp}.log`,
      };

      if (script.command) {
        // Redirect stderr to stdout so all output goes to out log
        pm2Config.script = '/bin/bash';
        pm2Config.args = ['-c', `${script.command} 2>&1`];
      } else {
        pm2Config.script = script.path;
      }

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
  if (req.app.locals.cronSuspended) {
    req.app.locals.cronSuspended[req.params.scriptName] = true;
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
  if (req.app.locals.cronSuspended) {
    req.app.locals.cronSuspended[req.params.scriptName] = false;
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
    
    // Delete the existing process
    pm2.delete(req.params.scriptName, (deleteErr) => {
      if (deleteErr) console.error(`Failed to delete ${req.params.scriptName}:`, deleteErr);
      
      // Start fresh with new log files
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const pm2Config = {
        name: script.name,
        args: script.args || [],
        env: script.env || {},
        cwd: process.cwd(),
        autorestart: true,
        max_restarts: 10000,
        out_file: `logs/${script.name}-out-${timestamp}.log`,
        error_file: `logs/${script.name}-error-${timestamp}.log`,
      };

      if (script.command) {
        pm2Config.script = '/bin/bash';
        pm2Config.args = ['-c', `${script.command} 2>&1`];
      } else {
        pm2Config.script = script.path;
      }

      pm2.start(pm2Config, (startErr) => {
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
          logFile: `${script.name}-out-${timestamp}.log`
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
      
      // Start fresh with new log files
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const pm2Config = {
        name: script.name,
        args: script.args || [],
        env: script.env || {},
        cwd: process.cwd(),
        autorestart: true,
        max_restarts: 10000,
        out_file: `logs/${script.name}-out-${timestamp}.log`,
        error_file: `logs/${script.name}-error-${timestamp}.log`,
      };

      if (script.command) {
        pm2Config.script = '/bin/bash';
        pm2Config.args = ['-c', `${script.command} 2>&1`];
      } else {
        pm2Config.script = script.path;
      }

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
          logFile: `${script.name}-out-${timestamp}.log`
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
          schedule: script.schedule || null,
          suspended: script.suspended || false,
        };
      });
      
      pm2.disconnect();
      res.json({ success: true, scripts });
    });
  });
});

module.exports = router;

