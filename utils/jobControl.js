'use strict';

// Starting, stopping and replacing configured forever jobs.
//
// Stopping is the delicate part. PM2 signals a job, waits `kill_timeout`, and
// then SIGKILLs it. A job that needs longer (for example a `sudo` wrapper whose
// root child must shut down) is cut off and its child is orphaned. New
// processes get the job's own `kill_timeout` at start, but PM2 uses the value
// stored on the *running* process, and processes started before this option
// existed have PM2's 1600 ms. So before asking PM2 to stop such a process,
// TaskServer signals the process tree itself (the same signal PM2 would send),
// waits up to the job's timeout for it to exit, and only then lets PM2 stop or
// delete the entry, which by then is already dead.

const { execFile, spawn } = require('child_process');
const configHandler = require('./configHandler');
const { errorText } = require('./processService');
const { getShellArgs, getShellExecutable, resolveScriptCwd } = require('./scriptRunner');
const { buildPm2Config, killTimeoutFor, runningKillTimeout } = require('./jobSpec');

// PM2 statuses in which a process exists and will be (or is being) run.
const LIVE = new Set(['online', 'launching', 'one-launch-status']);
// Statuses in which PM2 is about to run the job again by itself.
const PENDING = new Set(['launching', 'waiting restart', 'stopping']);

function statusOf(proc) {
  return proc?.pm2_env?.status;
}

function findProcess(list, name) {
  return list.find(proc => proc.name === name);
}

// The state the dashboard shows for a forever job: what PM2 says, not what the
// config says. `markedStopped` + `running` is a job someone started (or PM2
// resurrected) although the config says it is stopped.
function describeJob(script, proc, { pm2Available = true } = {}) {
  const status = proc ? statusOf(proc) : (pm2Available ? 'stopped' : 'unknown');
  const running = LIVE.has(status) || status === 'waiting restart';
  const markedStopped = Boolean(script.stopped);
  return { status, running, markedStopped, drift: markedStopped && running };
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function psTable() {
  return new Promise(resolve => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout));
  });
}

// Signal a process and everything below it, children first, like PM2 does.
// Processes we may not signal (a root-owned child) are skipped.
async function defaultSignalTree(pid, signal) {
  if (process.platform === 'win32') return;
  const children = new Map();
  for (const line of (await psTable()).split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const order = [];
  const seen = new Set([pid]);
  (function walk(parent) {
    for (const child of children.get(parent) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      walk(child);
      order.push(child);
    }
  })(pid);
  order.push(pid);
  for (const target of order) {
    try {
      process.kill(target, signal);
    } catch (error) {
      // Already gone, or not ours to signal.
    }
  }
}

// Run a job's `stopCommand`. Its output is discarded. Resolves with how it
// ended, never rejects.
function defaultRunStopCommand(script, timeoutMs) {
  return new Promise(resolve => {
    let child;
    let timedOut = false;
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      resolve(result);
    };
    const limit = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (error) { /* already gone */ }
      finish({ timedOut: true });
    }, timeoutMs);
    try {
      child = spawn(getShellExecutable(), getShellArgs(script.stopCommand), {
        cwd: resolveScriptCwd(script),
        env: { ...process.env, ...(script.env || {}) },
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      return finish({ error: errorText(error) });
    }
    child.on('error', error => finish({ error: errorText(error) }));
    child.on('exit', code => finish({ code, timedOut }));
  });
}

function createJobControl({
  service,
  getPm2Settings = () => configHandler.loadConfig().pm2,
  getLogsDir = () => configHandler.getLogsDir(),
  logger = console,
  signalTree = defaultSignalTree,
  runStopCommand = defaultRunStopCommand,
  isAlive = defaultIsAlive,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  pollMs = 100,
  killSignal = () => process.env.PM2_KILL_SIGNAL || 'SIGINT',
} = {}) {
  // Give a process up to `wanted` ms to exit on its own, signalling it the way
  // PM2 would. Gives up quietly: PM2's own stop follows either way.
  async function waitForExit(name, proc, wanted) {
    let current = proc;
    // More than one round only if PM2 relaunched the job right after it exited
    // (a restart delay of 0), which would otherwise be killed again at once.
    for (let round = 0; round < 3 && current?.pid && LIVE.has(statusOf(current)); round += 1) {
      const pid = current.pid;
      // Every process gets the full time, including one PM2 just relaunched.
      const deadline = now() + wanted;
      await signalTree(pid, killSignal());
      while (isAlive(pid) && now() < deadline) await sleep(pollMs);
      if (isAlive(pid)) {
        logger.warn?.(`[Job ${name}] still running after ${wanted} ms; PM2 will stop it now`);
        return;
      }
      current = findProcess(await service.list(), name);
      if (!current || current.pid === pid) return;
    }
  }

  // Everything that has to happen before PM2 is asked to stop or delete `name`.
  async function prepareStop(name, script) {
    const wanted = killTimeoutFor(script, getPm2Settings());
    const proc = findProcess(await service.list(), name);
    if (!proc) return { proc: null, wanted };
    if (LIVE.has(statusOf(proc))) {
      if (script?.stopCommand) {
        const result = await runStopCommand(script, wanted);
        if (result.timedOut) logger.warn?.(`[Job ${name}] stopCommand timed out after ${wanted} ms`);
        else if (result.error) logger.warn?.(`[Job ${name}] stopCommand failed: ${result.error}`);
        else if (result.code) logger.warn?.(`[Job ${name}] stopCommand exited with code ${result.code}`);
      }
      if (process.platform !== 'win32' && runningKillTimeout(proc) < wanted) {
        await waitForExit(name, proc, wanted);
      }
    }
    // PM2 may need its own full kill timeout on top, plus slack.
    return { proc, timeoutMs: Math.max(wanted, runningKillTimeout(proc)) + 10000 };
  }

  // Stop a job and keep its entry in PM2. Resolves false if PM2 has no such job.
  async function stopJob(name, script) {
    const { proc, timeoutMs } = await prepareStop(name, script);
    if (!proc) return false;
    await service.stop(name, { timeoutMs });
    return true;
  }

  // Remove a job from PM2, stopping it first. Resolves false if there was none.
  async function removeJob(name, script) {
    const { proc, timeoutMs } = await prepareStop(name, script);
    if (!proc) return false;
    await service.delete(name, { timeoutMs });
    return true;
  }

  // Replace whatever PM2 has under this name with a fresh process from the
  // config (new log files, current settings). Used for start and restart.
  // `spec` may be given when the caller already built it.
  async function startFresh(script, spec) {
    const config = spec || buildPm2Config(script, getPm2Settings(), getLogsDir());
    await removeJob(script.name, script);
    await service.start(config);
    return config;
  }

  return { stopJob, removeJob, startFresh };
}

module.exports = { createJobControl, describeJob, findProcess, statusOf, LIVE, PENDING };
