const cron = require('node-cron');
const path = require('path');
const configHandler = require('./configHandler');
const { createRunCleanup } = require('./runCleanup');
const { applyScriptExecution } = require('./scriptRunner');
const { killTimeoutFor } = require('./jobSpec');

let lastRunId = 0;

function buildRunConfig(script, trigger) {
  const runId = Math.max(Date.now(), lastRunId + 1);
  lastRunId = runId;
  const logsDir = configHandler.getLogsDir();
  const pm2Config = {
    name: `${script.name}-${trigger}-${runId}`,
    args: script.args || [],
    env: script.env || {},
    autorestart: false,
    kill_timeout: killTimeoutFor(script, configHandler.loadConfig().pm2),
    out_file: path.join(logsDir, `${script.name}-out-${runId}.log`),
    error_file: path.join(logsDir, `${script.name}-error-${runId}.log`),
  };

  return applyScriptExecution(pm2Config, script);
}

// `options.service` is the shared PM2 client (utils/processService.js).
function createCronManager(options = {}) {
  const jobs = new Map();
  const runCleanup = createRunCleanup({ getScripts: () => configHandler.loadConfig().scripts, ...options });
  const cronRunHistory = runCleanup.history;
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
      await runCleanup.launch(script.name, pm2Config);
    } catch (error) {
      cronRunHistory[script.name].lastError = error.message;
      throw error;
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

  // Start the cleanup scans in the background. The failure of a scan is already
  // logged with its message, and scans keep retrying.
  function startCleanup() {
    return runCleanup.start().catch(() => {});
  }

  // Register every cron job right away. Scheduling never waits on PM2 or on the
  // startup sweep. The server passes `cleanup: false` and starts the sweep
  // itself once it is listening and the jobs are reconciled, so the sweep's
  // PM2 calls do not queue ahead of job control at boot.
  function bootstrap(scripts, { cleanup = true } = {}) {
    scripts.forEach((script) => upsertScript(script));
    return cleanup ? startCleanup() : Promise.resolve();
  }

  function shutdown() {
    runCleanup.shutdown();
    Array.from(jobs.keys()).forEach((scriptName) => unregisterScript(scriptName));
  }

  return {
    cronRunHistory,
    start: runCleanup.start,
    bootstrap,
    startCleanup,
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

createCronManager.buildRunConfig = buildRunConfig;

module.exports = createCronManager;
