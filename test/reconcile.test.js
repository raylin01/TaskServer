const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakePm2, legacyPm2Config } = require('../test-support/fakePm2');
const { createJobControl } = require('../utils/jobControl');
const { planJob, reconcileJobs, reconcileWithRetry, checkPm2Versions } = require('../utils/reconcile');
const { buildPm2Config, diffJob } = require('../utils/jobSpec');

const LOGS = '/logs';
const PM2 = { maxRestarts: 10000, autoRestart: true, restartDelay: 1000, killTimeoutMs: 5000 };

// A set of jobs shaped like a real config: commands (some with env), a script
// path, and a sudo-wrapped runner.
function scripts() {
  return [
    { name: 'DNS', type: 'forever', command: 'python3 dns.py --serve', cwd: '/srv/dns', env: { DNS_PORT: 53, SECRET_TOKEN: 'hunter2' } },
    { name: 'DDNS', type: 'forever', command: 'node ddns.js', cwd: '/srv/ddns' },
    { name: 'WireGuard Helper', type: 'forever', command: 'sudo -n python3 helper.py', cwd: '/srv/wg', killTimeoutMs: 30000 },
    { name: 'Worker', type: 'forever', path: './worker.js', args: ['--fast', 7], cwd: '/srv/worker', env: { DEBUG: true, EMPTY: '', NOTHING: null, NESTED: { a: [1, 2] } } },
    { name: 'Nightly', type: 'cron', command: 'node nightly.js', schedule: '0 3 * * *' },
  ];
}

function setup(t, { legacy = true, extra = {} } = {}) {
  const pm2 = createFakePm2();
  const logger = { logs: [], infos: [], warns: [], errors: [], log(m) { this.logs.push(m); }, info(m) { this.infos.push(m); }, warn(m) { this.warns.push(m); }, error(m) { this.errors.push(m); } };
  const jobControl = createJobControl({ service: pm2, logger, getPm2Settings: () => PM2, getLogsDir: () => LOGS, isAlive: () => false, getSelfName: () => 'taskserver' });
  const config = { pm2: PM2, scripts: scripts(), ...extra };
  if (legacy) {
    // Processes exactly as the previous TaskServer started them: no kill_timeout.
    for (const script of config.scripts.filter(s => s.type === 'forever')) pm2.add(legacyPm2Config(script, PM2, LOGS));
  }
  const run = () => reconcileJobs({ service: pm2, jobControl, config, logsDir: LOGS, logger });
  return { pm2, logger, jobControl, config, run };
}

test('deploy: jobs started by the previous TaskServer are all adopted and nothing is restarted', async t => {
  const { pm2, logger, run } = setup(t);
  const summary = await run();
  assert.deepEqual(pm2.mutations(), [], 'no start, stop, delete or restart call at all');
  assert.deepEqual(summary.adopted.sort(), ['DDNS', 'DNS', 'WireGuard Helper', 'Worker']);
  assert.equal(summary.restarted.length + summary.started.length, 0);
  assert.match(logger.logs.at(-1), /4 adopted, 0 started, 0 restarted/);
});

test('adoption also holds when the log timestamps and the kill timeout differ', async t => {
  const { pm2, run } = setup(t, { legacy: false });
  const config = scripts().filter(s => s.type === 'forever');
  config.forEach((script, i) => {
    // Started by this version: has kill_timeout, and its own log paths.
    pm2.add(buildPm2Config(script, PM2, '/old/logs', `stamp-${i}`));
  });
  await run();
  assert.deepEqual(pm2.mutations(), []);
});

test('a changed command restarts only that job, and the log names the field but no values', async t => {
  const { pm2, logger, config, run } = setup(t);
  config.scripts[1].command = 'node ddns.js --verbose';
  const before = pm2.procs.map(p => `${p.name}:${p.pid}`);
  const summary = await run();
  assert.deepEqual(summary.restarted, ['DDNS']);
  assert.deepEqual(pm2.mutations().map(([m, name]) => `${m}:${name}`), ['delete:DDNS', 'start:DDNS']);
  const after = pm2.procs.map(p => `${p.name}:${p.pid}`);
  assert.deepEqual(after.filter(x => !x.startsWith('DDNS:')).sort(), before.filter(x => !x.startsWith('DDNS:')).sort());
  const line = logger.logs.find(l => l.includes('Restarted DDNS'));
  assert.match(line, /changed args/);
  assert.doesNotMatch(logger.logs.join('\n'), /--verbose/);
});

test('env changes are detected by key and never logged by value', async t => {
  const { logger, config, run } = setup(t);
  config.scripts[0].env = { DNS_PORT: 53, SECRET_TOKEN: 'rotated-secret-value' };
  const summary = await run();
  assert.deepEqual(summary.restarted, ['DNS']);
  const text = [...logger.logs, ...logger.warns, ...logger.errors].join('\n');
  assert.match(text, /env\.SECRET_TOKEN/);
  assert.doesNotMatch(text, /rotated-secret-value|hunter2/);
});

test('an added env key, a new cwd and a new exec path each count as a change', async t => {
  const { pm2, config } = setup(t);
  const [dns, , , worker] = config.scripts;
  const spec = script => buildPm2Config(script, PM2, LOGS);
  const running = name => pm2.procs.find(p => p.name === name);
  assert.deepEqual(diffJob(spec({ ...dns, env: { ...dns.env, NEW_KEY: '1' } }), running('DNS')), ['env.NEW_KEY']);
  assert.deepEqual(diffJob(spec({ ...dns, cwd: '/srv/elsewhere' }), running('DNS')), ['cwd']);
  assert.deepEqual(diffJob(spec({ ...worker, path: './other.js' }), running('Worker')), ['exec path']);
});

test('settings that change how PM2 supervises count; log paths and kill timeout do not', async t => {
  const { pm2, config } = setup(t);
  const dns = config.scripts[0];
  const proc = pm2.procs.find(p => p.name === 'DNS');
  const withSettings = settings => buildPm2Config(dns, { ...PM2, ...settings }, LOGS);
  assert.deepEqual(diffJob(withSettings({ restartDelay: 2000 }), proc), ['exp_backoff_restart_delay']);
  assert.deepEqual(diffJob(withSettings({ maxRestarts: 5 }), proc), ['max_restarts']);
  assert.deepEqual(diffJob(withSettings({ autoRestart: false }), proc), ['autorestart']);
  assert.deepEqual(diffJob(withSettings({ killTimeoutMs: 99999 }), proc), []);
  assert.deepEqual(diffJob(buildPm2Config({ ...dns, killTimeoutMs: 1 }, PM2, '/elsewhere', 'other-stamp'), proc), []);
});

test('env values compare the way PM2 stores them (numbers, booleans, null, objects)', async t => {
  const { pm2, config } = setup(t);
  const worker = config.scripts[3];
  assert.deepEqual(diffJob(buildPm2Config(worker, PM2, LOGS), pm2.procs.find(p => p.name === 'Worker')), []);
});

test('missing, stopped and errored jobs are started; a job marked stopped is not', async t => {
  const { pm2, config, run } = setup(t);
  pm2.procs.splice(pm2.procs.findIndex(p => p.name === 'DNS'), 1);
  pm2.procs.find(p => p.name === 'DDNS').pm2_env.status = 'stopped';
  pm2.procs.find(p => p.name === 'WireGuard Helper').pm2_env.status = 'errored';
  config.scripts[3].stopped = true;
  pm2.procs.find(p => p.name === 'Worker').pm2_env.status = 'stopped';
  const summary = await run();
  assert.deepEqual(summary.started.sort(), ['DDNS', 'DNS', 'WireGuard Helper']);
  assert.deepEqual(summary.skipped, ['Worker']);
  assert.equal(pm2.procs.find(p => p.name === 'Worker').pm2_env.status, 'stopped');
});

test('jobs PM2 is already restarting are left alone', async t => {
  const { pm2, run } = setup(t);
  for (const [name, status] of [['DNS', 'waiting restart'], ['DDNS', 'launching'], ['Worker', 'stopping']]) {
    pm2.procs.find(p => p.name === name).pm2_env.status = status;
  }
  const summary = await run();
  assert.deepEqual(summary.left.sort(), ['DDNS', 'DNS', 'Worker']);
  assert.deepEqual(pm2.mutations(), []);
});

test('a job that is online although the config says stopped keeps running, with a warning', async t => {
  const { pm2, logger, config, run } = setup(t);
  config.scripts[1].stopped = true;
  await run();
  assert.deepEqual(pm2.mutations(), []);
  assert.equal(pm2.procs.find(p => p.name === 'DDNS').pm2_env.status, 'online');
  assert.ok(logger.warns.some(w => w.includes('DDNS') && w.includes('marked stopped')));
});

test('processes that are not in the config, and cron runs, are never touched', async t => {
  const { pm2, run } = setup(t);
  pm2.add({ name: 'taskserver', script: 'server.js', cwd: '/srv/ts' });
  pm2.add({ name: 'Nightly-cron-1792800000000', script: '/bin/sh', cwd: '/srv' });
  await run();
  assert.deepEqual(pm2.mutations(), []);
});

test('one job failing does not stop the others; PM2 going away aborts the pass', async t => {
  const { pm2, logger, config, run } = setup(t);
  config.scripts[0].command = 'changed';
  config.scripts[1].command = 'changed too';
  pm2.state.startError = new Error('spawn failed');
  const summary = await run();
  assert.deepEqual(summary.failed.sort(), ['DDNS', 'DNS']);
  assert.ok(logger.errors.some(e => e.includes('spawn failed')));
  pm2.state.startError = Object.assign(new Error('PM2 is not reachable: x'), { code: 'PM2_UNAVAILABLE' });
  await assert.rejects(run(), /not reachable/);
});

test('boot retries until PM2 answers, then reconciles once', async t => {
  const { pm2, logger, jobControl, config } = setup(t);
  let attempts = 0;
  const list = pm2.list.bind(pm2);
  pm2.list = async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('PM2 is not reachable: connect'), { code: 'PM2_UNAVAILABLE' });
    return list();
  };
  const waits = [];
  const summary = await reconcileWithRetry({ service: pm2, jobControl, config, logsDir: LOGS, logger,
    sleep: async ms => { waits.push(ms); }, initialDelayMs: 10, maxDelayMs: 25 });
  assert.equal(summary.adopted.length, 4);
  assert.deepEqual(waits, [10, 20]);
  assert.deepEqual(pm2.mutations(), []);
});

test('retry stops when TaskServer is shutting down', async t => {
  const { pm2, logger, jobControl, config } = setup(t);
  pm2.state.listError = Object.assign(new Error('PM2 is not reachable: down'), { code: 'PM2_UNAVAILABLE' });
  let closed = false;
  const result = await reconcileWithRetry({ service: pm2, jobControl, config, logsDir: LOGS, logger,
    isClosed: () => closed, sleep: async () => { closed = true; } });
  assert.equal(result, null);
});

test('planJob table', () => {
  const spec = buildPm2Config({ name: 'X', type: 'forever', command: 'x', cwd: '/srv' }, PM2, LOGS);
  const proc = status => ({ name: 'X', pm2_env: { status } });
  assert.equal(planJob({ name: 'X' }, spec, null).action, 'start');
  assert.equal(planJob({ name: 'X', stopped: true }, spec, null).action, 'skip');
  assert.equal(planJob({ name: 'X' }, spec, proc('errored')).action, 'start');
  assert.equal(planJob({ name: 'X' }, spec, proc('waiting restart')).action, 'leave');
  assert.equal(planJob({ name: 'X', stopped: true }, spec, proc('online')).action, 'adopt');
});

test('version check warns on a mismatch and stays quiet on a match', async () => {
  const warns = [];
  const logger = { warn: m => warns.push(m) };
  const service = version => ({ daemonVersion: async () => version });
  assert.deepEqual(await checkPm2Versions({ service: service('6.0.14'), libraryVersion: '6.0.14', logger }),
    { library: '6.0.14', daemon: '6.0.14', match: true });
  assert.equal(warns.length, 0);
  const result = await checkPm2Versions({ service: service('6.0.14'), libraryVersion: '5.4.3', logger });
  assert.equal(result.match, false);
  assert.match(warns[0], /5\.4\.3.*6\.0\.14/);
  const failing = await checkPm2Versions({ service: { daemonVersion: async () => { throw new Error('nope'); } }, libraryVersion: '6.0.14', logger });
  assert.equal(failing.match, null);
});

// Shapes that exist in a real config: the exec path and args PM2 stores differ
// from what TaskServer asked for in some of them, and none may count as a change.
const os = require('os');
const path = require('path');
const fs = require('fs');

function adoptionCase(t, jobs) {
  const pm2 = createFakePm2();
  const logger = { logs: [], infos: [], warns: [], errors: [], log(m) { this.logs.push(m); }, info(m) { this.infos.push(m); }, warn(m) { this.warns.push(m); }, error(m) { this.errors.push(m); } };
  const jobControl = createJobControl({ service: pm2, logger, getPm2Settings: () => PM2, getLogsDir: () => LOGS, isAlive: () => false, getSelfName: () => 'taskserver' });
  const config = { pm2: PM2, scripts: jobs };
  for (const script of jobs) pm2.add(legacyPm2Config(script, PM2, LOGS));
  return { pm2, logger, run: () => reconcileJobs({ service: pm2, jobControl, config, logsDir: LOGS, logger }) };
}

test('adopts, with zero mutations: a spaced path, a command with no cwd, a command with a ~ cwd containing spaces, and a path with no cwd', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-home-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = savedHome; fs.rmSync(home, { recursive: true, force: true }); });
  const jobs = [
    { name: 'Spaced Path', type: 'forever', path: '/Applications/My Tool/run it', args: ['--keep'], cwd: '/srv/spaced' },
    { name: 'Spaced Relative', type: 'forever', path: './my tool/run.sh', cwd: '/srv/spaced' },
    { name: 'Command No Cwd', type: 'forever', command: 'node ddns.js --serve' },
    { name: 'Command Tilde Cwd', type: 'forever', command: 'bash ./update.sh', cwd: '~/Library/Application Support/Aeros DDNS' },
    { name: 'Path No Cwd', type: 'forever', path: 'worker.js', args: ['--fast'] },
    { name: 'Path On PATH', type: 'forever', path: 'sleep', args: ['60'] },
  ];
  const { pm2, run } = adoptionCase(t, jobs);
  const summary = await run();
  assert.deepEqual(pm2.mutations(), []);
  assert.deepEqual(summary.adopted.sort(), jobs.map(j => j.name).sort());
  assert.equal(pm2.procs.find(p => p.name === 'Command Tilde Cwd').pm2_env.pm_cwd, path.join(home, 'Library/Application Support/Aeros DDNS'));
  // PM2's own rewrite of the spaced path is what is stored, and it still matches.
  assert.deepEqual(pm2.procs.find(p => p.name === 'Spaced Path').pm2_env.args, ['-c', '/Applications/My Tool/run it']);
});

test('a changed spaced path is still noticed and restarts only that job', async t => {
  const jobs = [
    { name: 'Spaced Path', type: 'forever', path: '/Applications/My Tool/run it', cwd: '/srv/spaced' },
    { name: 'Steady', type: 'forever', command: 'node steady.js', cwd: '/srv/steady' },
  ];
  const { pm2, run, logger } = adoptionCase(t, jobs);
  jobs[0].path = '/Applications/My Tool/run it v2';
  const summary = await run();
  assert.deepEqual(summary.restarted, ['Spaced Path']);
  assert.deepEqual(pm2.mutations().map(([m, name]) => `${m}:${name}`), ['delete:Spaced Path', 'start:Spaced Path']);
  assert.doesNotMatch(logger.logs.join('\n'), /v2/);
});

test('a restart that lands while reconcile waits for the job lock is not undone: reconcile re-checks and leaves it', async t => {
  const jobs = [{ name: 'DDNS', type: 'forever', command: 'node ddns.js', cwd: '/srv/ddns' }];
  const { pm2, run, logger } = adoptionCase(t, jobs);
  const jobControl = createJobControl({ service: pm2, logger, getPm2Settings: () => PM2, getLogsDir: () => LOGS, isAlive: () => false });
  jobs[0].command = 'node ddns.js --v2';
  // GitSync's restart takes the lock first; reconcile has already planned a restart from its stale list.
  const config = { pm2: PM2, scripts: jobs };
  const route = jobControl.startFresh(jobs[0]);
  const summary = await Promise.all([route, reconcileJobs({ service: pm2, jobControl, config, logsDir: LOGS, logger })]).then(r => r[1]);
  assert.deepEqual(pm2.mutations().map(([m]) => m), ['delete', 'start'], 'one replacement, not two');
  assert.equal(pm2.procs.length, 1);
  assert.deepEqual(summary.restarted, []);
  assert.deepEqual(summary.left, ['DDNS']);
});

test('a job started under another shell (bash vs zsh) is adopted, with an info line; a real change still restarts', async t => {
  const jobs = [
    { name: 'Connector', type: 'forever', command: 'cloudflared tunnel run', cwd: '/srv/c' },
    { name: 'Other', type: 'forever', command: 'node o.js', cwd: '/srv/o' },
  ];
  const savedShell = process.env.SHELL;
  t.after(() => { process.env.SHELL = savedShell; });
  process.env.SHELL = '/bin/bash';
  const { pm2, logger, run } = adoptionCase(t, jobs);
  process.env.SHELL = '/bin/zsh';
  assert.equal(pm2.procs[0].pm2_env.pm_exec_path, '/bin/bash');
  const summary = await run();
  assert.deepEqual(pm2.mutations(), []);
  assert.deepEqual(summary.adopted.sort(), ['Connector', 'Other']);
  assert.equal(logger.infos.filter(l => /shell differs \(running bash, config would use zsh\).*next restart/.test(l)).length, 2);

  jobs[0].command = 'cloudflared tunnel run --changed';
  const again = await run();
  assert.deepEqual(again.restarted, ['Connector']);
  assert.deepEqual(pm2.mutations().map(([m, name]) => `${m}:${name}`), ['delete:Connector', 'start:Connector']);
});

test('a different executable that is not a shell is still a change', () => {
  const spec = buildPm2Config({ name: 'P', type: 'forever', path: '/srv/p/run', cwd: '/srv/p' }, PM2, LOGS);
  const proc = { pm2_env: { status: 'online', pm_exec_path: '/srv/p/other', pm_cwd: '/srv/p', args: [], autorestart: true, max_restarts: 10000, exp_backoff_restart_delay: 1000, env: {} } };
  assert.deepEqual(diffJob(spec, proc, { shellJob: false }), ['exec path']);
  const bash = { ...proc, pm2_env: { ...proc.pm2_env, pm_exec_path: '/bin/bash' } };
  assert.deepEqual(diffJob({ ...spec, script: '/bin/zsh' }, bash, { shellJob: false }), ['exec path'], 'only command jobs get the shell tolerance');
});

test('a config entry named like TaskServer itself is skipped with a warning, never touched', async t => {
  const { pm2, logger, config, run } = setup(t, { extra: {} });
  config.scripts.push({ name: 'taskserver', type: 'forever', command: 'node server.js', cwd: '/srv/ts' });
  const summary = await run();
  assert.ok(summary.skipped.includes('taskserver'));
  assert.ok(logger.warns.some(w => /'taskserver' in the config is TaskServer itself/.test(w)));
  assert.deepEqual(pm2.mutations(), []);
  config.scripts.find(s => s.name === 'taskserver').command = 'node server.js --new';
  pm2.add(buildPm2Config(config.scripts.at(-1), PM2, LOGS));
  await run();
  assert.deepEqual(pm2.mutations(), []);
});

test('a Stop that lands while reconcile waits for the job lock is not undone', async t => {
  const { pm2, config, run, jobControl } = setup(t);
  config.scripts[1].command = 'node ddns.js --v2';            // reconcile plans a restart of DDNS from its first look
  const holder = jobControl.inLock('DDNS', async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    config.scripts[1].stopped = true;                          // the dashboard's Stop, saved to the config meanwhile
  });
  const [, summary] = await Promise.all([holder, run()]);
  assert.deepEqual(pm2.mutations(), [], 'the running job is left as it is');
  assert.ok(summary.left.includes('DDNS'));
  assert.equal(summary.restarted.length, 0);
});

test('a job removed from the config while reconcile waits is not started', async t => {
  const { pm2, config, run, jobControl } = setup(t, { legacy: false });
  const holder = jobControl.inLock('DNS', async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    config.scripts = config.scripts.filter(s => s.name !== 'DNS');
  });
  await Promise.all([holder, run()]);
  assert.equal(pm2.procs.some(p => p.name === 'DNS'), false);
});

test('only "PM2 is not reachable" is retried; any other failure is thrown once, without the "not ready" message', async t => {
  const { pm2, logger, jobControl, config } = setup(t);
  pm2.state.listError = new Error('unexpected: bad shape');
  let waits = 0;
  await assert.rejects(reconcileWithRetry({ service: pm2, jobControl, config, logsDir: LOGS, logger, sleep: async () => { waits += 1; } }), /bad shape/);
  assert.equal(waits, 0);
  assert.equal(pm2.calls.filter(c => c[0] === 'list').length, 1);
  assert.doesNotMatch(logger.errors.join('\n'), /not ready/);
});

// Safety valve: an environment mismatch must not bounce every job at boot.
function changeJobs(config, names) {
  for (const script of config.scripts) if (names.includes(script.name)) script.command = `${script.command} --changed`;
}

test('safety valve: more than half of the running jobs (and more than 2) look changed -> none restart, all are adopted, fields are warned', async t => {
  const extra = { scripts: Array.from({ length: 5 }, (_, i) => ({ name: `J${i}`, type: 'forever', command: `node j${i}.js`, cwd: '/srv' })) };
  const { pm2, logger, config, run } = setup(t, { legacy: false, extra });
  for (const script of config.scripts) pm2.add(legacyPm2Config(script, PM2, LOGS));
  changeJobs(config, ['J0', 'J1', 'J2']);
  const summary = await run();
  assert.deepEqual(pm2.mutations(), []);
  assert.equal(summary.adopted.length, 5);
  assert.equal(summary.restarted.length, 0);
  const text = logger.warns.join('\n');
  assert.match(text, /3 of 5 running jobs look changed/);
  for (const name of ['J0', 'J1', 'J2']) assert.match(text, new RegExp(`${name} differs in: args`));
  assert.doesNotMatch(text, /--changed|node j0/, 'field names only');
  assert.match(text, /reconcileMaxRestartFraction/);
});

test('safety valve: up to the limit, changes are applied as before', async t => {
  const extra = { scripts: Array.from({ length: 6 }, (_, i) => ({ name: `J${i}`, type: 'forever', command: `node j${i}.js`, cwd: '/srv' })) };
  const { pm2, config, run } = setup(t, { legacy: false, extra });
  for (const script of config.scripts) pm2.add(legacyPm2Config(script, PM2, LOGS));
  changeJobs(config, ['J0', 'J1', 'J2']);      // exactly half of 6
  assert.equal((await run()).restarted.length, 3);
  changeJobs(config, ['J3', 'J4']);            // one and two changed jobs are never "too many"
  const small = setup(t, { legacy: false, extra: { scripts: extra.scripts.slice(0, 3).map(s => ({ ...s })) } });
  for (const script of small.config.scripts) small.pm2.add(legacyPm2Config(script, PM2, LOGS));
  changeJobs(small.config, ['J0', 'J1']);
  assert.equal((await small.run()).restarted.length, 2);
});

test('safety valve: pm2.reconcileMaxRestartFraction of 1 switches it off', async t => {
  const extra = { pm2: { ...PM2, reconcileMaxRestartFraction: 1 }, scripts: Array.from({ length: 4 }, (_, i) => ({ name: `J${i}`, type: 'forever', command: `node j${i}.js`, cwd: '/srv' })) };
  const { pm2, config, run } = setup(t, { legacy: false, extra });
  for (const script of config.scripts) pm2.add(legacyPm2Config(script, PM2, LOGS));
  changeJobs(config, ['J0', 'J1', 'J2', 'J3']);
  assert.equal((await run()).restarted.length, 4);
  assert.equal(pm2.mutations().length, 8);
});
