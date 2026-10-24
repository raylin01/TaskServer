const fs = require('fs');
const path = require('path');
const pm2 = require('pm2');

function runPattern(jobName) {
  const escaped = jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Use a strict end assertion: `$` also accepts a trailing newline.
  return new RegExp(`^${escaped}-(cron|manual)-(\\d{13})(?![\\s\\S])`);
}

function matchRun(proc, jobNames) {
  // A registered job may itself have a run-shaped name. Its own process wins.
  if (new Set(jobNames).has(proc.name)) return null;
  for (const name of jobNames) {
    const match = runPattern(name).exec(proc.name);
    if (match) return { scriptName: name, trigger: match[1], runId: Number(match[2]) };
  }
  return null;
}

function selectStoppedRuns(list, jobNames) {
  return list.filter(proc => Number.isInteger(proc.pm_id) && proc.pm_id >= 0
    && proc.pm2_env?.status === 'stopped' && matchRun(proc, jobNames));
}

function createRunCleanup({
  client = new pm2.custom(),
  getScripts,
  historyPath = path.join(__dirname, '../.taskserver-run-history.json'),
  intervalMs = 2000,
  logger = console,
} = {}) {
  const history = Object.create(null);
  const launchedNames = new Set();
  if (fs.existsSync(historyPath)) {
    Object.assign(history, JSON.parse(fs.readFileSync(historyPath, 'utf8')));
  }
  let lastSaved = JSON.stringify(history);
  let queue = Promise.resolve();
  let timer;
  let closed = false;

  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      client[method](...args, (err, result) => err ? reject(err) : resolve(result));
    });
  }

  // One dedicated client, serialized operations, and no connection per live run.
  function connected(work) {
    const operation = queue.then(async () => {
      try {
        await call('connect');
        return await work();
      } finally {
        client.disconnect();
      }
    });
    queue = operation.catch(() => {});
    return operation;
  }

  function save() {
    const serialized = JSON.stringify(history);
    if (serialized === lastSaved && fs.existsSync(historyPath)) return;
    const temp = `${historyPath}.tmp`;
    fs.writeFileSync(temp, serialized, { mode: 0o600 });
    fs.renameSync(temp, historyPath);
    lastSaved = serialized;
  }

  function record(proc, run) {
    const previous = history[run.scriptName];
    // An older overlapping run finishing must not replace the newest launch.
    if (previous?.runId > run.runId) return;
    const env = proc.pm2_env;
    history[run.scriptName] = {
      runId: run.runId,
      lastRun: new Date(run.runId).toISOString(),
      lastTrigger: run.trigger,
      lastError: null,
      status: env.status,
      exitCode: env.status === 'stopped' ? (env.exit_code ?? null) : null,
      outFile: env.pm_out_log_path,
      errorFile: env.pm_err_log_path,
    };
  }

  async function reconcile() {
    return connected(async () => {
      const names = new Set([...getScripts().map(script => script.name), ...launchedNames]);
      const list = await call('list');
      const stopped = selectStoppedRuns(list, names);
      for (const proc of list) {
        const run = matchRun(proc, names);
        if (run && ['online', 'stopped'].includes(proc.pm2_env?.status)) record(proc, run);
      }
      // Persist before deleting anything. A write failure leaves PM2 history intact.
      save();
      let count = 0;
      for (const proc of stopped) {
        // Recheck by numeric ID immediately before deleting, never by job name.
        const current = (await call('describe', proc.pm_id))[0];
        if (!current || current.name !== proc.name || current.pm2_env?.status !== 'stopped') continue;
        record(current, matchRun(current, names));
        save();
        await call('delete', proc.pm_id);
        count += 1;
      }
      if (count) logger.log(`[Run Cleanup] Removed ${count} stopped runs`);
      return count;
    });
  }

  // A self-scheduled scan cannot accumulate overlapping polls. Every scan opens
  // a fresh connection, so PM2 outages and exits during downtime are retried.
  function schedule() {
    if (closed) return;
    timer = setTimeout(async () => {
      try {
        await reconcile();
      } catch (error) {
        logger.error('[Run Cleanup] Scan failed; will retry');
      }
      schedule();
    }, intervalMs);
    timer.unref?.();
  }

  async function start() {
    try {
      return await reconcile();
    } finally {
      schedule();
    }
  }

  async function launch(scriptName, config) {
    launchedNames.add(scriptName);
    return connected(async () => {
      const processes = await call('start', config);
      for (const proc of processes) {
        const run = matchRun(proc, [scriptName]);
        if (run) record(proc, run);
      }
      save();
    });
  }

  function shutdown() {
    closed = true;
    clearTimeout(timer);
  }

  return { history, start, reconcile, launch, shutdown };
}

module.exports = { createRunCleanup, runPattern, selectStoppedRuns };
