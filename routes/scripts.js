// Express router for script management
const express = require('express');
const router = express.Router();
const cron = require('node-cron');
const configHandler = require('../utils/configHandler');
const logViewer = require('../utils/logViewer');
const path = require('path');
const { asyncHandler: wrap } = require('../utils/httpErrors');
const { describeJob, findProcess, LIVE } = require('../utils/jobControl');
const { errorText } = require('../utils/processService');
const { afterReply } = require('../utils/afterReply');

// The PM2 client, job control and cron manager are created once, by
// createApp() in server.js, and shared through app.locals.
const processService = req => req.app.locals.processService;
const jobControl = req => req.app.locals.jobControl;

function validateCronSchedule(schedule) {
  return typeof schedule === 'string' && cron.validate(schedule.trim());
}

// Record that a forever job is, or is no longer, marked as stopped. The config
// is loaded right before the write with nothing awaited in between, so a slow
// PM2 call earlier in the request cannot overwrite another change with a
// stale copy.
function setStopped(name, stopped) {
  const config = configHandler.loadConfig();
  const script = config.scripts.find(s => s.name === name && s.type === 'forever');
  if (script) {
    script.stopped = stopped;
    configHandler.writeConfig(config);
  }
}

const selfName = config => configHandler.getSelfName(config);

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
router.get('/scripts', wrap(async (req, res) => {
  let pm2list = [];
  let pm2Available = true;
  try {
    pm2list = await processService(req).list();
  } catch (error) {
    // Still show the scripts, but say the state is unknown instead of "Stopped".
    pm2Available = false;
    console.error(`[HTTP] Could not read PM2 state for the dashboard: ${errorText(error)}`);
  }
  const config = configHandler.loadConfig();
  const jobStates = {};
  for (const script of config.scripts) {
    if (script.type === 'forever') {
      jobStates[script.name] = describeJob(script, findProcess(pm2list, script.name), { pm2Available });
    }
  }
  res.render('scripts', {
    scripts: config.scripts,
    pm2list,
    pm2Available,
    jobStates,
    cronRunHistory: req.app.locals.cronRunHistory || {},
    cronSuspended: req.app.locals.cronSuspended || {},
  });
}));

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
router.post('/edit-script/:scriptName', wrap(async (req, res) => {
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
    try {
      await jobControl(req).removeJob(previousScript.name, previousScript);
    } catch (error) {
      console.error(`Failed to remove ${previousScript.name} from PM2: ${errorText(error)}`);
    }
  }

  res.redirect('/scripts');
}));

// Delete a script
router.post('/delete-script/:scriptName', wrap(async (req, res) => {
  const name = req.params.scriptName;
  const found = configHandler.loadConfig().scripts.find(s => s.name === name);
  if (!found) {
    return res.status(404).send('Script not found');
  }

  // A forever job is stopped and removed from PM2 first. If that fails the
  // script stays in the config, so it is not left running with nothing in
  // charge of it.
  if (found.type === 'forever') {
    await jobControl(req).removeJob(name, found);
  }

  // If it's a cron job, remove it from the live scheduler too
  if (found.type === 'cron' && req.app.locals.cronManager) {
    req.app.locals.cronManager.unregisterScript(name);
  }

  // Remove from config (loaded fresh: the PM2 call above can take a while)
  const config = configHandler.loadConfig();
  const index = config.scripts.findIndex(s => s.name === name);
  if (index !== -1) {
    config.scripts.splice(index, 1);
    configHandler.writeConfig(config);
  }

  res.redirect('/scripts');
}));

function findForever(name) {
  return configHandler.loadConfig().scripts.find(s => s.name === name && s.type === 'forever');
}

// Stop a running script (forever tasks only)
router.post('/stop-script/:scriptName', wrap(async (req, res) => {
  const script = findForever(req.params.scriptName);
  if (!script) {
    return res.status(404).send('Script not found or not a forever task');
  }
  await jobControl(req).stopJob(script.name, script);
  setStopped(script.name, true);
  res.redirect('/scripts');
}));

// Start a stopped script (forever tasks only)
router.post('/start-script/:scriptName', wrap(async (req, res) => {
  const script = findForever(req.params.scriptName);
  if (!script) {
    return res.status(404).send('Script not found or not a forever task');
  }
  await jobControl(req).startFresh(script);
  setStopped(script.name, false);
  res.redirect('/scripts');
}));

// Restart a script (creates new log files)
router.post('/restart-script/:scriptName', wrap(async (req, res) => {
  const script = findForever(req.params.scriptName);
  if (!script) {
    return res.status(404).send('Script not found or not a forever task');
  }
  await jobControl(req).startFresh(script);
  res.redirect('/scripts');
}));

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
    console.error(`Failed to run cron ${req.params.scriptName} manually:`, errorText(error));
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
router.post('/api/restart-script/:scriptName', apiAuth, wrap(async (req, res) => {
  const config = configHandler.loadConfig();
  const scriptName = req.params.scriptName;

  // TaskServer restarting itself (GitSync does this on every deploy). The name
  // it runs under in PM2 comes from `server.selfName` (default "taskserver").
  if (scriptName === selfName(config)) {
    const running = findProcess(await processService(req).list(), scriptName);
    if (!running) {
      return res.status(404).json({
        success: false,
        error: `TaskServer is not running under PM2 as '${scriptName}'; set server.selfName`,
      });
    }
    // Answer first. The restart kills this process, so it is only asked for
    // once the reply has been written, and the caller never sees a reset. The
    // reply says "requested": whether PM2 carries it out is only known later,
    // so a failure is logged loudly here instead.
    res.set('Connection', 'close');
    afterReply(res, () => {
      processService(req).restart(scriptName).catch(error => {
        console.error(`[Self-restart] FAILED to restart '${scriptName}': ${errorText(error)}. `
          + 'TaskServer is still running the old code; restart it by hand.');
      });
    });
    return res.json({
      success: true,
      message: `Restart of TaskServer (${scriptName}) requested`,
    });
  }

  const script = config.scripts.find(s => s.name === scriptName && s.type === 'forever');
  if (!script) {
    return res.status(404).json({
      success: false,
      error: 'Script not found or not a forever task'
    });
  }

  // Replace the process: new log files, current config.
  const spec = await jobControl(req).startFresh(script);
  setStopped(script.name, false);
  res.json({
    success: true,
    message: `Script '${script.name}' restarted successfully`,
    logFile: path.basename(spec.out_file)
  });
}));

// Stop a script (JSON API)
router.post('/api/stop-script/:scriptName', apiAuth, wrap(async (req, res) => {
  const script = findForever(req.params.scriptName);
  if (!script) {
    return res.status(404).json({
      success: false,
      error: 'Script not found or not a forever task'
    });
  }

  await jobControl(req).stopJob(script.name, script);
  setStopped(script.name, true);
  res.json({
    success: true,
    message: `Script '${script.name}' stopped successfully`
  });
}));

// Start a script (JSON API)
router.post('/api/start-script/:scriptName', apiAuth, wrap(async (req, res) => {
  const script = findForever(req.params.scriptName);
  if (!script) {
    return res.status(404).json({
      success: false,
      error: 'Script not found or not a forever task'
    });
  }

  // The check and the start are one step under the job's lock, so two quick
  // clicks cannot both pass the check.
  const spec = await jobControl(req).inLock(script.name, async ops => {
    const existing = findProcess(await processService(req).list(), script.name);
    if (existing && LIVE.has(existing.pm2_env.status)) return null;
    return ops.startFresh(script);
  });
  if (!spec) {
    return res.status(400).json({
      success: false,
      error: 'Script is already running'
    });
  }
  setStopped(script.name, false);
  res.json({
    success: true,
    message: `Script '${script.name}' started successfully`,
    logFile: path.basename(spec.out_file)
  });
}));

// List all scripts (JSON API)
router.get('/api/scripts', apiAuth, wrap(async (req, res) => {
  const list = await processService(req).list();
  const config = configHandler.loadConfig();

  const scripts = config.scripts.map(script => {
    const pm2Process = findProcess(list, script.name);
    return {
      name: script.name,
      type: script.type,
      status: pm2Process ? pm2Process.pm2_env.status : (script.type === 'cron' ? 'scheduled' : 'stopped'),
      path: script.path || null,
      command: script.command || null,
      cwd: script.cwd || null,
      schedule: script.schedule || null,
      suspended: script.suspended || false,
      markedStopped: script.type === 'forever' ? Boolean(script.stopped) : false,
    };
  });

  res.json({ success: true, scripts });
}));

// Add a new script (JSON API)
router.post('/api/add-script', apiAuth, wrap(async (req, res) => {
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
    try {
      await jobControl(req).startFresh(newScript);
    } catch (error) {
      console.error(`Failed to auto-start ${name}: ${errorText(error)}`);
      return res.json({
        success: true,
        message: `Script '${name}' added but failed to auto-start`,
        autoStarted: false
      });
    }
    return res.json({
      success: true,
      message: `Script '${name}' added and started`,
      autoStarted: true
    });
  }

  res.json({
    success: true,
    message: `Script '${name}' added`,
    autoStarted: false
  });
}));

module.exports = router;
