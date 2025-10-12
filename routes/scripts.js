// Express router for script management
const express = require('express');
const router = express.Router();
const pm2 = require('pm2');
const configHandler = require('../utils/configHandler');
const logViewer = require('../utils/logViewer');
const path = require('path');

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

// Stop a running script
router.post('/stop-script/:scriptName', (req, res) => {
  pm2.connect(() => {
    pm2.stop(req.params.scriptName, () => {
      pm2.disconnect();
      res.redirect('/scripts');
    });
  });
});

// Restart a script
router.post('/restart-script/:scriptName', (req, res) => {
  pm2.connect(() => {
    pm2.restart(req.params.scriptName, () => {
      pm2.disconnect();
      res.redirect('/scripts');
    });
  });
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

module.exports = router;
