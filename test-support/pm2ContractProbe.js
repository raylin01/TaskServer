'use strict';

// Run by test/pm2Contract.test.js in a child process. Drives the installed pm2
// package through TaskServer's own PM2 service, against a real PM2 core (God)
// running inside this process in a private temp home ("independent" mode, no
// daemon). It never touches the user's PM2. Prints one JSON line, then exits.

const fs = require('fs');
const os = require('os');
const pm2 = require('pm2');
const { createProcessService } = require('../utils/processService');
const { buildPm2Config, diffJob } = require('../utils/jobSpec');

const quiet = { log() {}, warn() {}, error() {} };

async function main() {
  const out = {};
  let api;
  const service = createProcessService({
    createClient: () => { api = new pm2.custom({ independent: true }); return api; },
    logger: quiet,
  });
  const script = { name: 'contract-job', type: 'forever', command: 'exec sleep 60', cwd: os.tmpdir(), env: { CONTRACT_N: 7, CONTRACT_B: true, CONTRACT_S: 'x y' }, killTimeoutMs: 12345 };
  const settings = { maxRestarts: 10000, autoRestart: true, restartDelay: 1000 };

  out.libraryVersion = require('pm2/package.json').version;
  out.executeRemoteArity = typeof pm2.custom.prototype.connect === 'function' ? 'ok' : 'missing connect';
  out.daemonVersion = await service.daemonVersion();
  out.executeRemoteType = typeof api.Client.executeRemote;

  const spec = buildPm2Config(script, settings, os.tmpdir());
  await service.start(spec);
  const proc = (await service.list()).find(p => p.name === script.name);
  out.status = proc.pm2_env.status;
  out.fields = Object.fromEntries(['pm_exec_path', 'pm_cwd', 'args', 'autorestart', 'max_restarts',
    'exp_backoff_restart_delay', 'kill_timeout', 'pm_out_log_path'].map(k => [k, k in proc.pm2_env]));
  // The reconcile comparison against what a real PM2 stored for this config.
  out.diffAgainstRealPm2 = diffJob(buildPm2Config(script, settings, os.tmpdir(), 'another-stamp'), proc);
  out.changedCommandDiff = diffJob(buildPm2Config({ ...script, command: 'exec sleep 61' }, settings, os.tmpdir()), proc);
  out.changedEnvDiff = diffJob(buildPm2Config({ ...script, env: { ...script.env, CONTRACT_N: 8 } }, settings, os.tmpdir()), proc);
  out.killTimeoutStored = proc.pm2_env.kill_timeout;

  // The calls the run cleanup and the job control depend on.
  await service.stop(script.name, { timeoutMs: 15000 });
  out.afterStop = (await service.list()).find(p => p.name === script.name).pm2_env.status;
  await service.restart(script.name);
  out.afterRestart = (await service.list()).find(p => p.name === script.name).pm2_env.status;
  await service.deleteById(proc.pm_id);
  out.afterDeleteById = (await service.list()).length;
  try {
    await service.deleteById(proc.pm_id + 100);
    out.unknownIdError = null;
  } catch (error) {
    out.unknownIdError = error.message;
  }
  out.unknownIdExpected = `${proc.pm_id + 100} : id unknown`;

  const home = api.pm2_home;
  out.privateHome = typeof home === 'string' && home.startsWith(os.tmpdir() === '/var/folders' ? '/' : '/') && home !== process.env.PM2_HOME;
  await service.delete(script.name).catch(() => {});
  if (home && home.startsWith('/tmp/')) fs.rmSync(home, { recursive: true, force: true });
  return out;
}

main().then(out => {
  process.stdout.write(`\nRESULT ${JSON.stringify(out)}\n`);
  process.exit(0);
}, error => {
  process.stdout.write(`\nRESULT ${JSON.stringify({ error: String(error?.stack || error) })}\n`);
  process.exit(1);
});
