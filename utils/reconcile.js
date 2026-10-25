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
    const notes = [];
    const changed = diffJob(spec, proc, { shellJob: Boolean(script.command), notes });
    return changed.length ? { action: 'restart', changed, notes } : { action: 'adopt', notes };
  }
  return { action: 'leave', reason: status };
}

// How many of the changed jobs boot may restart at once. If more than this
// fraction of the online jobs (and more than MIN_TRIPPED_RESTARTS) look changed,
// the cause is almost certainly the environment (the shell, a working
// directory, a PATH) and not the config, so none are restarted. A value of 1 or
// more switches the check off.
const DEFAULT_MAX_RESTART_FRACTION = 0.5;
const MIN_TRIPPED_RESTARTS = 2;

function maxRestartFraction(pm2Settings) {
  const value = pm2Settings?.reconcileMaxRestartFraction;
  return typeof value === 'number' && value >= 0 ? value : DEFAULT_MAX_RESTART_FRACTION;
}

async function reconcileJobs({
  service,
  jobControl,
  config,
  loadConfig = () => config || configHandler.loadConfig(),
  logsDir = configHandler.getLogsDir(),
  logger = console,
  selfName = configHandler.getSelfName,
}) {
  const initial = loadConfig();
  const list = await service.list();
  const summary = { started: [], restarted: [], adopted: [], left: [], skipped: [], failed: [] };
  const self = selfName(initial);

  // Plan every forever job from one list.
  const plans = [];
  for (const script of initial.scripts) {
    if (script.type !== 'forever') continue;
    if (script.name === self) {
      summary.skipped.push(script.name);
      logger.warn?.(`[Reconcile] '${script.name}' in the config is TaskServer itself; skipping it. Remove it from the config.`);
      continue;
    }
    const spec = buildPm2Config(script, initial.pm2, logsDir);
    plans.push({ script, spec, plan: planJob(script, spec, findProcess(list, script.name)) });
  }

  // Safety valve: too many restarts at once is read as an environment mismatch.
  const online = plans.filter(p => p.plan.action === 'adopt' || p.plan.action === 'restart');
  const restarts = plans.filter(p => p.plan.action === 'restart');
  if (restarts.length > MIN_TRIPPED_RESTARTS && restarts.length > online.length * maxRestartFraction(initial.pm2)) {
    logger.warn?.(`[Reconcile] ${restarts.length} of ${online.length} running jobs look changed, which is more than `
      + 'boot restarts at once (an environment difference such as the shell or a working directory?). '
      + 'Adopting all of them unchanged; restart a job yourself to apply its change. '
      + 'Set pm2.reconcileMaxRestartFraction to 1 to turn this check off.');
    for (const { script, plan } of restarts) {
      logger.warn?.(`[Reconcile] ${script.name} differs in: ${plan.changed.join(', ')}`);
      plan.action = 'adopt';
    }
  }

  for (const { script, spec, plan } of plans) {
    try {
      switch (plan.action) {
        case 'adopt':
          summary.adopted.push(script.name);
          if (plan.warn) logger.warn?.(`[Reconcile] ${script.name} ${plan.warn}; leaving it running`);
          for (const note of plan.notes || []) logger.info?.(`[Reconcile] ${script.name}: ${note}`);
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
          // Look again under the job's lock, at PM2 and at the config: a restart
          // or a Stop from GitSync or the dashboard may have run since the
          // list above was taken, and must not be undone.
          const outcome = await jobControl.inLock(script.name, async ops => {
            const current = loadConfig();
            const fresh = current.scripts.find(entry => entry.name === script.name && entry.type === 'forever');
            if (!fresh) return { action: 'skip', reason: 'removed from the config' };
            const freshSpec = buildPm2Config(fresh, current.pm2, logsDir);
            const now = planJob(fresh, freshSpec, findProcess(await service.list(), script.name));
            if (now.action !== 'start' && now.action !== 'restart') return now;
            await ops.startFresh(fresh, freshSpec);
            return now;
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
      const lost = plan.action === 'restart' || plan.action === 'start'
        ? ' If the old process was already removed, the job is not running now.' : '';
      logger.error?.(`[Reconcile] Could not ${plan.action} ${script.name}: ${errorText(error)}.${lost}`);
    }
  }

  logger.log?.(`[Reconcile] ${summary.adopted.length} adopted, ${summary.started.length} started, `
    + `${summary.restarted.length} restarted, ${summary.left.length + summary.skipped.length} left alone, `
    + `${summary.failed.length} failed`);
  return summary;
}

// PM2 may not be reachable the moment TaskServer starts (a cold boot starts
// both at once). Try again, with a growing pause, until it works or
// `isClosed()` says to stop.
//  - "PM2 is not reachable" is retried for as long as it lasts.
//  - Any other failure can also be a daemon that is still coming up and
//    answers with something unexpected, so it is retried too, but only
//    `maxOtherRetries` times; after that the error goes to the caller, which
//    logs it as it is. A pass that already handled some jobs is safe to repeat:
//    those jobs are then simply adopted.
async function reconcileWithRetry({
  isClosed = () => false,
  sleep,
  initialDelayMs = 1000,
  maxDelayMs = 15000,
  maxOtherRetries = 5,
  logger = console,
  ...options
}) {
  const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let delay = initialDelayMs;
  let otherFailures = 0;
  while (!isClosed()) {
    try {
      return await reconcileJobs({ logger, ...options });
    } catch (error) {
      if (!isUnavailable(error)) {
        otherFailures += 1;
        if (otherFailures > maxOtherRetries) throw error;
        logger.error?.(`[Reconcile] Unexpected error (${errorText(error)}); `
          + `retrying in ${delay} ms (${otherFailures}/${maxOtherRetries})`);
      } else {
        logger.error?.(`[Reconcile] PM2 is not ready (${errorText(error)}); retrying in ${delay} ms`);
      }
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
