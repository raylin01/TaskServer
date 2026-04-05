const cron = require('node-cron');
const pm2 = require('pm2');
const path = require('path');
const configHandler = require('./configHandler');
const { applyScriptExecution } = require('./scriptRunner');

function buildRunConfig(script, trigger) {
  const runId = Date.now();
  const logsDir = configHandler.getLogsDir();
  const pm2Config = {
    name: `${script.name}-${trigger}-${runId}`,
    args: script.args || [],
    env: script.env || {},
    autorestart: false,
    out_file: path.join(logsDir, `${script.name}-out-${runId}.log`),
    error_file: path.join(logsDir, `${script.name}-error-${runId}.log`),
  };

  return applyScriptExecution(pm2Config, script);
}

function connectPm2() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function startPm2(pm2Config) {
  return new Promise((resolve, reject) => {
    pm2.start(pm2Config, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function disconnectPm2() {
  try {
    pm2.disconnect();
  } catch (error) {
    // Ignore disconnect errors because PM2 may already be disconnected.
  }
}

function createCronManager() {
  const jobs = new Map();
  const cronRunHistory = {};
  const cronSuspended = {};

  function ensureHistory(scriptName) {
    if (!cronRunHistory[scriptName]) {
      cronRunHistory[scriptName] = {
        lastRun: null,
        lastTrigger: null,
        lastError: null,
      };
    }
  }

  async function executeScript(script, trigger) {
    ensureHistory(script.name);
    cronRunHistory[script.name].lastRun = new Date();
    cronRunHistory[script.name].lastTrigger = trigger;
    cronRunHistory[script.name].lastError = null;

    const pm2Config = buildRunConfig(script, trigger);

    try {
      await connectPm2();
      await startPm2(pm2Config);
    } catch (error) {
      cronRunHistory[script.name].lastError = error.message;
      throw error;
    } finally {
      disconnectPm2();
    }
  }

  function unregisterScript(scriptName, options = {}) {
    const existing = jobs.get(scriptName);
    if (existing) {
      existing.job.stop();
      if (typeof existing.job.destroy === 'function') {
        existing.job.destroy();
      }
      jobs.delete(scriptName);
    }

    delete cronSuspended[scriptName];
    if (!options.preserveHistory) {
      delete cronRunHistory[scriptName];
    }
  }

  function registerScript(script) {
    if (script.type !== 'cron' || !script.schedule) {
      return;
    }

    unregisterScript(script.name, { preserveHistory: true });
    ensureHistory(script.name);
    cronSuspended[script.name] = Boolean(script.suspended);

    const state = {
      script: { ...script },
      runCount: 0,
      maxRuns: script.count || Infinity,
    };

    const job = cron.schedule(script.schedule, async () => {
      if (cronSuspended[script.name]) {
        return;
      }

      if (state.runCount >= state.maxRuns) {
        return;
      }

      state.runCount += 1;

      try {
        await executeScript(state.script, 'cron');
      } catch (error) {
        console.error(`Failed to start cron ${script.name}:`, error);
      }
    });

    jobs.set(script.name, {
      job,
      state,
      schedule: script.schedule,
    });
  }

  function upsertScript(script, previousName) {
    if (previousName && previousName !== script.name) {
      unregisterScript(previousName);
    }

    if (script.type === 'cron' && script.schedule) {
      registerScript(script);
      return;
    }

    unregisterScript(script.name);
  }

  async function runNow(scriptName) {
    const activeJob = jobs.get(scriptName);
    if (activeJob) {
      await executeScript(activeJob.state.script, 'manual');
      return;
    }

    const config = configHandler.loadConfig();
    const script = config.scripts.find((entry) => entry.name === scriptName && entry.type === 'cron');
    if (!script) {
      throw new Error(`Cron script '${scriptName}' was not found`);
    }

    cronSuspended[script.name] = Boolean(script.suspended);
    await executeScript(script, 'manual');
  }

  function setSuspended(scriptName, suspended) {
    cronSuspended[scriptName] = Boolean(suspended);
  }

  function shutdown() {
    Array.from(jobs.keys()).forEach((scriptName) => unregisterScript(scriptName));
  }

  return {
    cronRunHistory,
    cronSuspended,
    upsertScript,
    unregisterScript,
    runNow,
    setSuspended,
    shutdown,
    listJobs: () => Array.from(jobs.entries()).map(([name, entry]) => ({
      name,
      schedule: entry.schedule,
    })),
  };
}

module.exports = createCronManager;
