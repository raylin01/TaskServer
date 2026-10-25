'use strict';

// Boot-time reconciliation of the config against what PM2 already runs.
//
// PM2 outlives TaskServer. When TaskServer starts (every deploy, every login)
// the jobs are usually already running, so the right move is to adopt them, not
// to restart them. Per forever job:
//
//   not in PM2                       -> start
//   stopped / errored                -> start, unless the config says stopped
//   online, same effective config    -> adopt (leave alone)
//   online, config changed           -> restart, logging which fields changed
//   launching / waiting restart /    -> leave alone (PM2 is mid-transition)
//     stopping
//   online but config says stopped   -> leave running, warn, show it in the UI.
//
// The last rule is deliberate: reconciling at boot never stops anything. A job
// that is up while the config says "stopped" was started by someone (a manual
// `pm2 start`, or a `pm2 resurrect` after login), and killing it during a
// deploy is the more harmful surprise. The dashboard shows the real state, and
// Stop in the UI stops it for good.

const configHandler = require('./configHandler');
const { buildPm2Config, diffJob } = require('./jobSpec');
const { errorText, isUnavailable } = require('./processService');
const { findProcess, statusOf } = require('./jobControl');

const SETTLED_DOWN = new Set(['stopped', 'errored']);
const RUNNING = new Set(['online', 'one-launch-status']);

// Decide what to do with one job. Pure: no PM2 calls.
function planJob(script, spec, proc) {
  if (!proc) {
    return script.stopped
      ? { action: 'skip', reason: 'marked stopped' }
      : { action: 'start' };
  }
  const status = statusOf(proc);
  if (SETTLED_DOWN.has(status)) {
    return script.stopped
      ? { action: 'skip', reason: 'marked stopped' }
      : { action: 'start', reason: `was ${status}` };
  }
  if (RUNNING.has(status)) {
    if (script.stopped) return { action: 'adopt', warn: 'is running but marked stopped in config' };
    const changed = diffJob(spec, proc);
    return changed.length ? { action: 'restart', changed } : { action: 'adopt' };
  }
  return { action: 'leave', reason: status };
}

async function reconcileJobs({
  service,
  jobControl,
  config = configHandler.loadConfig(),
  logsDir = configHandler.getLogsDir(),
  logger = console,
}) {
  const list = await service.list();
  const summary = { started: [], restarted: [], adopted: [], left: [], skipped: [], failed: [] };

  for (const script of config.scripts) {
    if (script.type !== 'forever') continue;
    const spec = buildPm2Config(script, config.pm2, logsDir);
    const plan = planJob(script, spec, findProcess(list, script.name));
    try {
      switch (plan.action) {
        case 'adopt':
          summary.adopted.push(script.name);
          if (plan.warn) logger.warn?.(`[Reconcile] ${script.name} ${plan.warn}; leaving it running`);
          break;
        case 'leave':
          summary.left.push(script.name);
          logger.log?.(`[Reconcile] ${script.name} is ${plan.reason}; leaving it to PM2`);
          break;
        case 'skip':
          summary.skipped.push(script.name);
          logger.log?.(`[Reconcile] Skipping ${script.name} (${plan.reason})`);
          break;
        case 'start':
        case 'restart': {
          // Look again under the job's lock: a restart from GitSync or the
          // dashboard may have run since the list above was taken.
          const outcome = await jobControl.inLock(script.name, async ops => {
            const current = planJob(script, spec, findProcess(await service.list(), script.name));
            if (current.action !== 'start' && current.action !== 'restart') return current;
            await ops.startFresh(script, spec);
            return current;
          });
          if (outcome.action === 'start') {
            summary.started.push(script.name);
            logger.log?.(`[Reconcile] Started ${script.name}${outcome.reason ? ` (${outcome.reason})` : ''}`);
          } else if (outcome.action === 'restart') {
            summary.restarted.push(script.name);
            logger.log?.(`[Reconcile] Restarted ${script.name}: changed ${outcome.changed.join(', ')}`);
          } else {
            summary.left.push(script.name);
            logger.log?.(`[Reconcile] ${script.name} changed while reconciling (${outcome.action}); left as is`);
          }
          break;
        }
        default:
          break;
      }
    } catch (error) {
      // PM2 went away mid-way: let the caller retry the whole pass. Jobs
      // already handled are then simply adopted.
      if (isUnavailable(error)) throw error;
      summary.failed.push(script.name);
      logger.error?.(`[Reconcile] Could not ${plan.action} ${script.name}: ${errorText(error)}`);
    }
  }

  logger.log?.(`[Reconcile] ${summary.adopted.length} adopted, ${summary.started.length} started, `
    + `${summary.restarted.length} restarted, ${summary.left.length + summary.skipped.length} left alone, `
    + `${summary.failed.length} failed`);
  return summary;
}

// PM2 may not be reachable the moment TaskServer starts. Try again, with a
// growing pause, until it works or `isClosed()` says to stop.
async function reconcileWithRetry({ isClosed = () => false, sleep, initialDelayMs = 1000, maxDelayMs = 15000, logger = console, ...options }) {
  const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let delay = initialDelayMs;
  while (!isClosed()) {
    try {
      return await reconcileJobs({ logger, ...options });
    } catch (error) {
      logger.error?.(`[Reconcile] PM2 is not ready (${errorText(error)}); retrying in ${delay} ms`);
      await wait(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }
  return null;
}

// Warn when the pm2 package TaskServer uses is not the version of the running
// daemon. Returns the versions so callers and tests can look at them.
async function checkPm2Versions({ service, libraryVersion = require('pm2/package.json').version, logger = console }) {
  let daemon;
  try {
    daemon = await service.daemonVersion();
  } catch (error) {
    logger.warn?.(`[PM2] Could not read the daemon version: ${errorText(error)}`);
    return { library: libraryVersion, daemon: null, match: null };
  }
  const match = daemon === libraryVersion;
  if (!match) {
    logger.warn?.(`[PM2] Version mismatch: TaskServer uses the pm2 package ${libraryVersion} but the daemon is ${daemon}. `
      + 'Run "bun install" so they match.');
  }
  return { library: libraryVersion, daemon, match };
}

module.exports = { planJob, reconcileJobs, reconcileWithRetry, checkPm2Versions };
