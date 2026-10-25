'use strict';

// An in-memory stand-in for the PM2 service (utils/processService.js) for
// tests. `start` stores a process the way PM2 does: the exec path resolved
// against the cwd, the launcher's whole environment merged under the job's own
// env, and everything else as given.

const path = require('path');
const { applyScriptExecution } = require('../utils/scriptRunner');
const { pm2CommandForm, resolveExecPath } = require('../utils/jobSpec');

// What the launching process (TaskServer) had in its environment.
const LAUNCHER_ENV = { PATH: '/usr/bin:/bin', HOME: '/home/test', SHELL: '/bin/sh', LAUNCHER_ONLY: 'x' };

// The PM2 config today's code (before this change) built for a forever job.
// Kept here as a fixture of "a process started by the previous TaskServer".
function legacyPm2Config(script, pm2Settings, logsDir, stamp = '2026-10-23T10-00-00-000Z') {
  const pm2Config = {
    name: script.name,
    args: script.args || [],
    env: script.env || {},
    autorestart: pm2Settings.autoRestart !== undefined ? pm2Settings.autoRestart : true,
    max_restarts: pm2Settings.maxRestarts || 10000,
    exp_backoff_restart_delay: pm2Settings.restartDelay !== undefined ? pm2Settings.restartDelay : 1000,
    out_file: path.join(logsDir, `${script.name}-out-${stamp}.log`),
    error_file: path.join(logsDir, `${script.name}-error-${stamp}.log`),
  };
  return applyScriptExecution(pm2Config, script);
}

function createFakePm2({ launcherEnv = LAUNCHER_ENV, version = '6.0.14' } = {}) {
  const procs = [];
  const calls = [];
  let nextId = 0;
  let nextPid = 4000;
  const state = { listError: null, startError: null, stopError: null };

  function toProcess(config) {
    const cwd = path.resolve(config.cwd || '/');
    // PM2 (Common.verifyConfs) turns a script that contains a space into
    // `bash -c <script>` and drops the configured args; test/pm2Contract checks
    // this against a real PM2.
    const form = pm2CommandForm(config.script, config.args || []);
    return {
      name: config.name,
      pid: nextPid += 1,
      pm_id: nextId += 1,
      pm2_env: {
        name: config.name,
        status: 'online',
        restart_time: 0,
        pm_exec_path: resolveExecPath(form.script, cwd),
        pm_cwd: cwd,
        args: form.args,
        exec_interpreter: 'none',
        autorestart: config.autorestart,
        max_restarts: config.max_restarts,
        exp_backoff_restart_delay: config.exp_backoff_restart_delay,
        kill_timeout: config.kill_timeout,
        pm_out_log_path: config.out_file,
        pm_err_log_path: config.error_file,
        env: { ...launcherEnv, ...(config.env || {}) },
      },
    };
  }

  const find = name => procs.find(p => p.name === name);
  const remove = name => {
    const index = procs.findIndex(p => p.name === name);
    if (index !== -1) procs.splice(index, 1);
  };

  const service = {
    calls,
    procs,
    state,
    async list() {
      calls.push(['list']);
      if (state.listError) throw state.listError;
      return procs.map(p => structuredClone(p));
    },
    async start(config) {
      calls.push(['start', config.name]);
      if (state.startError) throw state.startError;
      const existing = find(config.name);
      if (existing) remove(config.name);
      const proc = toProcess(config);
      procs.push(proc);
      service.lastStart = config;
      return [structuredClone(proc)];
    },
    async stop(name, options) {
      calls.push(['stop', name, options]);
      if (state.stopError) throw state.stopError;
      const proc = find(name);
      if (!proc) throw new Error('process or namespace not found');
      proc.pm2_env.status = 'stopped';
      proc.pid = 0;
    },
    async delete(name, options) {
      calls.push(['delete', name, options]);
      if (!find(name)) throw new Error('process or namespace not found');
      remove(name);
    },
    async restart(name) {
      calls.push(['restart', name]);
      const proc = find(name);
      if (!proc) throw new Error('process or namespace not found');
      proc.pm2_env.restart_time += 1;
    },
    async daemonVersion() {
      calls.push(['version']);
      return version;
    },
    async exclusive(work) {
      return work(async (method, ...args) => service[method === 'deleteById' ? 'deleteById' : method](...args));
    },
    async deleteById(id) {
      calls.push(['deleteById', id]);
      const proc = procs.find(p => p.pm_id === id);
      if (proc) remove(proc.name);
    },
    async close() {},
    // Test helpers
    add(config, overrides = {}) {
      const proc = toProcess(config);
      Object.assign(proc.pm2_env, overrides.pm2_env || {});
      if (overrides.pid !== undefined) proc.pid = overrides.pid;
      procs.push(proc);
      return proc;
    },
    mutations() {
      return calls.filter(([method]) => ['start', 'stop', 'delete', 'restart', 'deleteById'].includes(method));
    },
  };
  return service;
}

module.exports = { createFakePm2, legacyPm2Config, LAUNCHER_ENV };
