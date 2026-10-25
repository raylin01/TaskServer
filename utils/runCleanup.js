const fs = require('fs');
const path = require('path');
const { errorText, isUnknownId } = require('./processService');

function runPattern(jobName) {
  const escaped = jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Use a strict end assertion: `$` also accepts a trailing newline.
  return new RegExp(`^${escaped}-(cron|manual)-(\\d{13})(?![\\s\\S])`);
}

// Compile the per-job patterns once, so a scan over thousands of entries does
// not rebuild them for every entry.
function createMatcher(jobNames) {
  if (jobNames.patterns) return jobNames;
  const names = new Set(jobNames);
  return { names, patterns: Array.from(names, name => ({ name, regex: runPattern(name) })) };
}

function matchRun(proc, jobNames) {
  const matcher = createMatcher(jobNames);
  // A registered job may itself have a run-shaped name. Its own process wins.
  if (matcher.names.has(proc.name)) return null;
  for (const { name, regex } of matcher.patterns) {
    const match = regex.exec(proc.name);
    if (match) return { scriptName: name, trigger: match[1], runId: Number(match[2]) };
  }
  return null;
}

function selectStoppedRuns(list, jobNames) {
  const matcher = createMatcher(jobNames);
  return list.filter(proc => Number.isInteger(proc.pm_id) && proc.pm_id >= 0
    && proc.pm2_env?.status === 'stopped' && matchRun(proc, matcher));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// How many deletes may pass before the status recheck data is refreshed.
const RECHECK_EVERY = 25;

function createRunCleanup({
  // The shared PM2 client (utils/processService.js). It owns the connection,
  // the queue and the per-call timeouts.
  service,
  getScripts,
  historyPath = path.join(__dirname, '../.taskserver-run-history.json'),
  // Steady state: exits are collected within about a minute.
  intervalMs = 30000,
  // While a backlog of old entries remains, the next scan follows quickly.
  backlogIntervalMs = 1000,
  chunkSize = 50,
  maxDeletesPerScan = 1000,
  chunkPauseMs = 100,
  operationTimeoutMs = 120000,
  chunkTimeoutMs = 180000,
  logger = console,
} = {}) {
  if (!service) throw new Error('createRunCleanup needs a PM2 service');
  const history = Object.create(null);
  const launchedNames = new Set();
  let lastSaved;
  let timer;
  let closed = false;
  let backlog = false;

  // Persist only what the dashboard reads, plus runId, which keeps the newest
  // launch when overlapping runs finish out of order.
  function snapshot() {
    const out = Object.create(null);
    for (const [name, entry] of Object.entries(history)) {
      if (!entry?.lastRun) continue;
      out[name] = {
        ...(Number.isSafeInteger(entry.runId) ? { runId: entry.runId } : {}),
        lastRun: entry.lastRun instanceof Date ? entry.lastRun.toISOString() : entry.lastRun,
        lastTrigger: entry.lastTrigger ?? null,
      };
    }
    return JSON.stringify(out);
  }

  // A zero-length, truncated or non-object file (for example after a power
  // cut) must not stop TaskServer from booting.
  function loadHistory() {
    if (!fs.existsSync(historyPath)) return;
    let parsed;
    let problem;
    try {
      parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      if (!isPlainObject(parsed)) problem = 'not an object';
    } catch (error) {
      problem = errorText(error);
    }
    if (problem) {
      const aside = `${historyPath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(historyPath, aside);
        logger.warn?.(`[Run Cleanup] Ignoring unreadable run history (${problem}); moved to ${path.basename(aside)}`);
      } catch (error) {
        logger.warn?.(`[Run Cleanup] Ignoring unreadable run history (${problem}); could not move it: ${errorText(error)}`);
      }
      return;
    }
    for (const [name, entry] of Object.entries(parsed)) {
      if (isPlainObject(entry)) history[name] = entry;
    }
    lastSaved = snapshot();
  }
  loadHistory();

  // Operations run one after another on the shared client, and none can hold
  // the queue forever.
  function connected(work, timeoutMs = operationTimeoutMs) {
    return service.exclusive(work, { timeoutMs });
  }

  function save() {
    const serialized = snapshot();
    if (serialized === lastSaved && fs.existsSync(historyPath)) return;
    const temp = `${historyPath}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeSync(fd, serialized);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, historyPath);
    try {
      const dirFd = fs.openSync(path.dirname(historyPath), 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error) {
      // Directory fsync is best effort; the file itself is already durable.
    }
    lastSaved = serialized;
  }

  function record(run) {
    const previous = history[run.scriptName];
    // An older overlapping run finishing must not replace the newest launch.
    if (previous?.runId > run.runId) return;
    history[run.scriptName] = {
      runId: run.runId,
      lastRun: new Date(run.runId).toISOString(),
      lastTrigger: run.trigger,
      lastError: null,
    };
  }

  // Delete one chunk of the planned entries. The chunk takes its own fresh
  // list, and an entry is deleted only if that list still shows the same name,
  // stopped, at the same numeric pm_id (ids are reused after a delete). Deleting
  // an online process would kill it, so the list is refreshed every
  // RECHECK_EVERY deletes and the recheck data is never older than that.
  function deleteChunk(planned, matcher) {
    return connected(async call => {
      let current;
      let sinceList = 0;
      const refresh = async () => {
        current = new Map();
        for (const proc of await call('list')) current.set(proc.pm_id, proc);
        sinceList = 0;
      };
      await refresh();
      let count = 0;
      for (const { pm_id: id, name } of planned) {
        if (sinceList >= RECHECK_EVERY) await refresh();
        const proc = current.get(id);
        if (!proc || proc.name !== name || proc.pm2_env?.status !== 'stopped') continue;
        const run = matchRun(proc, matcher);
        if (!run) continue;
        record(run);
        // Persist before deleting anything. A write failure leaves PM2 history intact.
        save();
        sinceList += 1;
        try {
          await call('deleteById', id);
        } catch (error) {
          // Already gone (for example a manual `pm2 delete`): nothing to do.
          if (isUnknownId(error, id)) continue;
          throw error;
        }
        count += 1;
      }
      return count;
    }, chunkTimeoutMs);
  }

  async function reconcile() {
    const matcher = createMatcher([...getScripts().map(script => script.name), ...launchedNames]);
    // Plan: one list, history for every matching run, then a bounded candidate list.
    const plan = await connected(async call => {
      const list = await call('list');
      for (const proc of list) {
        const run = matchRun(proc, matcher);
        if (run && ['online', 'stopped'].includes(proc.pm2_env?.status)) record(run);
      }
      // Forget scripts that are no longer configured. An unreadable config
      // reads as no scripts, so an empty set never prunes.
      const configured = new Set(getScripts().map(script => script.name));
      if (configured.size) {
        for (const name of Object.keys(history)) if (!configured.has(name)) delete history[name];
      }
      save();
      const stopped = selectStoppedRuns(list, matcher);
      backlog = stopped.length > maxDeletesPerScan;
      return stopped.slice(0, maxDeletesPerScan).map(proc => ({ pm_id: proc.pm_id, name: proc.name }));
    });
    let count = 0;
    for (let i = 0; i < plan.length && !closed; i += chunkSize) {
      count += await deleteChunk(plan.slice(i, i + chunkSize), matcher);
      // Between chunks the queue is free, so launches already waiting run first.
      await new Promise(resolve => setTimeout(resolve, chunkPauseMs));
    }
    if (count) logger.log(`[Run Cleanup] Removed ${count} stopped runs${backlog ? ' (more remain)' : ''}`);
    return count;
  }

  async function scan() {
    try {
      return await reconcile();
    } catch (error) {
      logger.error(`[Run Cleanup] Scan failed; will retry: ${errorText(error)}`);
      throw error;
    }
  }

  // A self-scheduled scan cannot accumulate overlapping polls. Every scan opens
  // a fresh connection, so PM2 outages and exits during downtime are retried.
  function schedule() {
    if (closed) return;
    timer = setTimeout(async () => {
      try {
        await scan();
      } catch (error) {
        // Already logged by scan().
      }
      schedule();
    }, backlog ? backlogIntervalMs : intervalMs);
    timer.unref?.();
  }

  async function start() {
    try {
      return await scan();
    } finally {
      schedule();
    }
  }

  async function launch(scriptName, config) {
    launchedNames.add(scriptName);
    let startSent = false;
    try {
      return await connected(async call => {
        startSent = true;
        const processes = await call('start', config);
        // The run has started. A history write problem must not make the caller
        // think it failed; the next scan retries the save before deleting anything.
        try {
          for (const proc of processes) {
            const run = matchRun(proc, [scriptName]);
            if (run) record(run);
          }
          save();
        } catch (error) {
          logger.error(`[Run Cleanup] Could not save run history after launch: ${errorText(error)}`);
        }
      });
    } catch (error) {
      // No reply does not mean no run: the daemon may have started it. Never
      // retried here and not recorded as a clean launch; a later scan picks the
      // process up by name if it exists.
      if (startSent && error?.timeout) {
        throw Object.assign(new Error('PM2 start timed out; the run may still have started. '
          + 'Check the log before running again.'), { timeout: true, maybeStarted: true });
      }
      throw error;
    }
  }

  function shutdown() {
    closed = true;
    clearTimeout(timer);
  }

  return { history, start, reconcile, launch, shutdown };
}

module.exports = { createRunCleanup, createMatcher, runPattern, selectStoppedRuns };
