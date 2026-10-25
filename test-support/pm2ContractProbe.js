'use strict';

// Run by test/pm2Contract.test.js in a child process. Drives the installed pm2
// package through TaskServer's own PM2 service, against a real PM2 core (God)
// running inside this process in a private temp home ("independent" mode, no
// daemon). It never touches the user's PM2. Prints one JSON line, then exits.

const fs = require('fs');
const os = require('os');
const pm2 = require('pm2');
const { createProcessService } = require('../utils/processService');
const path = require('path');
const { buildPm2Config, diffJob } = require('../utils/jobSpec');
const { applyScriptExecution } = require('../utils/scriptRunner');

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

  // Jobs whose stored form differs from the config in the ways PM2 rewrites:
  // a script with a space becomes `bash -c <script>` with the args dropped, and a
  // bare command is looked up on PATH. Without a cwd the job runs in this process's cwd.
  const shapes = [
    { name: 'contract-spaced', type: 'forever', path: 'sleep 60', args: ['--ignored'], cwd: os.tmpdir() },
    { name: 'contract-spaced-nocwd', type: 'forever', path: 'sleep 61' },
    { name: 'contract-bare', type: 'forever', path: 'sleep', args: ['62'], cwd: os.tmpdir() },
    { name: 'contract-bare-nocwd', type: 'forever', path: 'sleep', args: ['63'] },
    { name: 'contract-command-nocwd', type: 'forever', command: 'exec sleep 64' },
  ];
  out.shapes = {};
  for (const shape of shapes) {
    await service.start(buildPm2Config(shape, settings, os.tmpdir()));
    const stored = (await service.list()).find(p => p.name === shape.name);
    out.shapes[shape.name] = {
      status: stored.pm2_env.status,
      diff: diffJob(buildPm2Config(shape, settings, os.tmpdir(), 'other-stamp'), stored),
      changedDiff: diffJob(buildPm2Config({ ...shape, path: shape.path && `${shape.path}0`, command: shape.command && `${shape.command}0` }, settings, os.tmpdir()), stored).length > 0,
      storedArgs: stored.pm2_env.args.length,
    };
    await service.delete(shape.name);
  }

  // A cron run whose cwd uses ~ and contains spaces (the "Example DNS" shape),
  // built by the cron manager's own code and launched through PM2.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-probe-home-'));
  const cronCwd = path.join(fakeHome, 'Library', 'Application Support', 'Example DNS');
  fs.mkdirSync(cronCwd, { recursive: true });
  const probeConfig = path.join(fakeHome, 'config.yaml');
  fs.writeFileSync(probeConfig, `server:\n  logsDir: ${JSON.stringify(path.join(fakeHome, 'logs'))}\npm2:\n  killTimeoutMs: 5000\nscripts: []\n`);
  fs.mkdirSync(path.join(fakeHome, 'logs'));
  process.env.TASKSERVER_CONFIG = probeConfig;
  const savedHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const cronScript = { name: 'Example DNS', type: 'cron', schedule: '0 3 * * *', command: 'pwd > cwd-seen.txt', cwd: '~/Library/Application Support/Example DNS' };
  const runConfig = require('../utils/cronManager').buildRunConfig(cronScript, 'manual');
  process.env.HOME = savedHome;
  out.cronCwdExpanded = runConfig.cwd === cronCwd;
  await service.start(runConfig);
  for (let i = 0; i < 150; i += 1) {
    const run = (await service.list()).find(p => p.name === runConfig.name);
    if (run && run.pm2_env.status !== 'online' && run.pm2_env.status !== 'launching') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const seen = path.join(cronCwd, 'cwd-seen.txt');
  out.cronRanInCwd = fs.existsSync(seen) && fs.realpathSync(fs.readFileSync(seen, 'utf8').trim()) === fs.realpathSync(cronCwd);
  await service.delete(runConfig.name).catch(() => {});
  fs.rmSync(fakeHome, { recursive: true, force: true });

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
