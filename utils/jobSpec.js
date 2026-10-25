'use strict';

// What PM2 should run for a configured job, and how to tell whether a process
// PM2 already has is that job.

const fs = require('fs');
const path = require('path');
const { applyScriptExecution } = require('./scriptRunner');

// PM2's own default, used when a running process has no kill_timeout stored
// (every process started before this option existed).
const PM2_DEFAULT_KILL_TIMEOUT_MS = 1600;
// Used when neither the job nor the `pm2:` settings say otherwise.
const DEFAULT_KILL_TIMEOUT_MS = 5000;
const MAX_KILL_TIMEOUT_MS = 10 * 60 * 1000;

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), MAX_KILL_TIMEOUT_MS) : undefined;
}

// How long a job gets to exit after it is asked to, before PM2 force-kills it.
function killTimeoutFor(script, pm2Settings = {}) {
  return positiveInteger(script?.killTimeoutMs)
    ?? positiveInteger(pm2Settings.killTimeoutMs)
    ?? DEFAULT_KILL_TIMEOUT_MS;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// PM2 start config for a forever job. `logsDir` is passed in by the caller.
function buildPm2Config(script, pm2Settings, logsDir, stamp = timestamp()) {
  const settings = pm2Settings || {};
  const pm2Config = {
    name: script.name,
    // Copies: pm2.start() adds keys to the env object it is given, and that
    // must not be the job's own config.
    args: [...(script.args || [])],
    env: { ...(script.env || {}) },
    autorestart: settings.autoRestart !== undefined ? settings.autoRestart : true,
    max_restarts: settings.maxRestarts || 10000,
    exp_backoff_restart_delay: settings.restartDelay !== undefined ? settings.restartDelay : 1000,
    kill_timeout: killTimeoutFor(script, settings),
    out_file: path.join(logsDir, `${script.name}-out-${stamp}.log`),
    error_file: path.join(logsDir, `${script.name}-error-${stamp}.log`),
  };
  return applyScriptExecution(pm2Config, script);
}

// ---------------------------------------------------------------------------
// Comparing a desired config with a running process
// ---------------------------------------------------------------------------

// The fields that decide what a job runs and how PM2 supervises it. Left out
// on purpose:
//  - log file paths (timestamped on every start),
//  - kill_timeout and anything else that only matters when the process is
//    killed (changing it must not restart a healthy job),
//  - options that do not change what runs.
// Env is handled separately.
// PM2 stores env values as given (numbers and booleans), but turns null,
// objects and arrays into strings.
function envText(value) {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// PM2's own `which` (lib/tools/which.js) for unix: a bare name is searched in
// $PATH, anything with a slash is taken as a path. Mirrored here so that the
// executable PM2 stored can be predicted exactly.
function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.existsSync(file) && !fs.statSync(file).isDirectory();
  } catch (error) {
    return false;
  }
}

function which(command) {
  if (command.includes('/')) return isExecutable(command) ? path.resolve(command) : null;
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const attempt = path.resolve(dir, command);
    if (isExecutable(attempt)) return attempt;
  }
  return null;
}

// What PM2 does to the script before it starts a process (Common.verifyConfs):
// on unix a script with a space in it is a command line, so PM2 runs it as
// `bash -c "<script>"` (or `sh -c`), replacing the configured args. A `path:`
// job like "sudo -n python3 helper.py" ends up stored that way.
function pm2CommandForm(script, args) {
  if (process.platform !== 'win32' && script.includes(' ')) {
    if (which('bash')) return { script: 'bash', args: ['-c', script] };
    if (which('sh')) return { script: 'sh', args: ['-c', script] };
  }
  return { script, args };
}

// What PM2 stores as the executable (Common.prepareAppConf): the script
// relative to the cwd if that exists, else found in $PATH.
function resolveExecPath(script, cwd) {
  const direct = path.resolve(cwd, script);
  return fs.existsSync(direct) ? direct : (which(script) || direct);
}

function sameList(a, b) {
  return a.length === b.length && a.every((item, i) => String(item) === String(b[i]));
}

function sameBoolean(a, b) {
  return String(a) === String(b);
}

// Which fields differ between the config a job should have and the process PM2
// is running. Only the fields listed above, and only the env keys the job
// configures: PM2 merges the whole environment of whoever started the process
// into its env, so the rest of it says nothing about this job.
//
// Returns names only, for logging. Never values.
function diffJob(desired, proc) {
  const env = proc?.pm2_env || {};
  const changed = [];
  const wantCwd = desired.cwd;

  if (!env.pm_cwd || path.resolve(env.pm_cwd) !== path.resolve(wantCwd)) changed.push('cwd');
  // Compare with what PM2 will have made of the config, not the config itself.
  const form = pm2CommandForm(desired.script, desired.args || []);
  if (env.pm_exec_path !== resolveExecPath(form.script, wantCwd)) changed.push('exec path');
  if (!sameList(Array.isArray(env.args) ? env.args : [], form.args)) changed.push('args');
  if (!sameBoolean(env.autorestart, desired.autorestart)) changed.push('autorestart');
  if (Number(env.max_restarts) !== Number(desired.max_restarts)) changed.push('max_restarts');
  if (Number(env.exp_backoff_restart_delay) !== Number(desired.exp_backoff_restart_delay)) {
    changed.push('exp_backoff_restart_delay');
  }

  const running = env.env || {};
  for (const [key, value] of Object.entries(desired.env || {})) {
    if (value === undefined) continue; // PM2 drops these
    if (!(key in running) || envText(running[key]) !== envText(value)) changed.push(`env.${key}`);
  }
  return changed;
}

// The kill timeout PM2 will actually use for this running process.
function runningKillTimeout(proc) {
  const stored = Number(proc?.pm2_env?.kill_timeout);
  return stored > 0 ? stored : PM2_DEFAULT_KILL_TIMEOUT_MS;
}

module.exports = {
  buildPm2Config,
  pm2CommandForm,
  resolveExecPath,
  diffJob,
  killTimeoutFor,
  runningKillTimeout,
  DEFAULT_KILL_TIMEOUT_MS,
  PM2_DEFAULT_KILL_TIMEOUT_MS,
};
