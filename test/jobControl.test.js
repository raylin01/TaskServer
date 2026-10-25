const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakePm2, legacyPm2Config } = require('../test-support/fakePm2');
const { createJobControl, describeJob } = require('../utils/jobControl');
const { buildPm2Config, killTimeoutFor } = require('../utils/jobSpec');

const PM2 = { maxRestarts: 10000, autoRestart: true, restartDelay: 1000, killTimeoutMs: 5000 };
const sudoJob = { name: 'WireGuard Helper', type: 'forever', command: 'sudo -n python3 helper.py', cwd: '/srv/wg', killTimeoutMs: 20000 };

// Time that only moves when something sleeps, so waits cost nothing.
function fakeClock() {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; } };
}

function setup(t, { legacy = true, script = sudoJob, alive = () => false, signalTree, runStopCommand, killSignal } = {}) {
  const pm2 = createFakePm2();
  const clock = fakeClock();
  const logger = { warns: [], warn(m) { this.warns.push(m); }, log() {}, error() {} };
  const signals = [];
  const proc = pm2.add(legacy ? legacyPm2Config(script, PM2, '/logs') : buildPm2Config(script, PM2, '/logs'));
  const control = createJobControl({
    service: pm2, logger, getPm2Settings: () => PM2, getLogsDir: () => '/logs', pollMs: 100,
    now: clock.now, sleep: clock.sleep, isAlive: pid => alive(pid, clock.now()),
    signalTree: signalTree || (async (pid, signal) => { signals.push([pid, signal]); }),
    runStopCommand: runStopCommand || (async () => ({ code: 0 })),
    killSignal: killSignal || (() => 'SIGINT'),
  });
  return { pm2, control, proc, signals, clock, logger };
}

test('kill timeout: per job, then the pm2 default, then 5 s; it is passed to PM2', () => {
  assert.equal(killTimeoutFor({ killTimeoutMs: 20000 }, { killTimeoutMs: 8000 }), 20000);
  assert.equal(killTimeoutFor({}, { killTimeoutMs: 8000 }), 8000);
  assert.equal(killTimeoutFor({}, {}), 5000);
  assert.equal(killTimeoutFor({ killTimeoutMs: 'abc' }, {}), 5000);
  assert.equal(killTimeoutFor({ killTimeoutMs: -5 }, {}), 5000);
  assert.equal(buildPm2Config(sudoJob, PM2, '/logs').kill_timeout, 20000);
  assert.equal(buildPm2Config({ name: 'x', command: 'y' }, PM2, '/logs').kill_timeout, 5000);
});

test('a process adopted from before (1600 ms kill timeout) is signalled and given the full time before PM2 stops it', async t => {
  // Exits 7.5 s after being signalled.
  let signalledAt = null;
  const { pm2, control, proc } = setup(t, {
    alive: (pid, now) => !(signalledAt !== null && now >= signalledAt + 7500),
    signalTree: async () => { signalledAt = 0; },
  });
  assert.equal(proc.pm2_env.kill_timeout, undefined);
  assert.equal(await control.stopJob(sudoJob.name, sudoJob), true);
  const [stop] = pm2.mutations();
  assert.equal(stop[0], 'stop');
  assert.ok(stop[2].timeoutMs >= 20000, 'the PM2 call gets a limit that covers the timeout');
  assert.equal(signalledAt, 0);
});

test('the signal goes to the whole tree and is the one PM2 would use', async t => {
  const { control, signals, proc } = setup(t, { killSignal: () => 'SIGTERM', alive: () => false });
  const pid = proc.pid;
  await control.stopJob(sudoJob.name, sudoJob);
  assert.deepEqual(signals, [[pid, 'SIGTERM']]);
});

test('a process that ignores the signal is left to PM2 after the job timeout, with a warning', async t => {
  const { pm2, control, clock, logger } = setup(t, { alive: () => true });
  await control.stopJob(sudoJob.name, sudoJob);
  assert.ok(clock.now() >= 20000, `waited the full timeout (${clock.now()} ms)`);
  assert.equal(pm2.mutations()[0][0], 'stop');
  assert.match(logger.warns[0], /still running after 20000 ms/);
});

test('a process that already has the job timeout is stopped by PM2 directly, with no pre-signal', async t => {
  const { pm2, control, signals } = setup(t, { legacy: false, alive: () => true });
  await control.stopJob(sudoJob.name, sudoJob);
  assert.deepEqual(signals, []);
  assert.deepEqual(pm2.mutations().map(c => c[0]), ['stop']);
});

test('if PM2 relaunches the job right after it exits, the new process is signalled too', async t => {
  const pm2 = createFakePm2();
  const first = pm2.add(legacyPm2Config(sudoJob, PM2, '/logs')).pid;
  const dead = new Set();
  const signalled = [];
  const clock = fakeClock();
  const control = createJobControl({
    service: pm2, logger: { warn() {}, log() {}, error() {} }, getPm2Settings: () => PM2, getLogsDir: () => '/logs',
    now: clock.now, sleep: clock.sleep, isAlive: pid => !dead.has(pid),
    signalTree: async pid => {
      signalled.push(pid);
      dead.add(pid);
      // PM2 notices the exit and relaunches the job under a new pid (restart delay 0).
      if (pid === first) pm2.procs[0].pid = 9999;
    },
  });
  await control.stopJob(sudoJob.name, sudoJob);
  assert.deepEqual(signalled, [first, 9999]);
});

test('stopCommand runs before the stop, and its failure never blocks the stop', async t => {
  const order = [];
  const { pm2, control, logger } = setup(t, {
    script: { ...sudoJob, stopCommand: 'sudo -n helper.py --stop' },
    runStopCommand: async (script, ms) => { order.push(['stopCommand', script.stopCommand, ms]); return { code: 3 }; },
    signalTree: async () => order.push(['signal']),
  });
  await control.stopJob(sudoJob.name, { ...sudoJob, stopCommand: 'sudo -n helper.py --stop' });
  assert.deepEqual(order[0], ['stopCommand', 'sudo -n helper.py --stop', 20000]);
  assert.equal(pm2.mutations()[0][0], 'stop');
  assert.match(logger.warns[0], /stopCommand exited with code 3/);
});

test('stopping or removing a job PM2 does not have is not an error', async t => {
  const { control, pm2 } = setup(t);
  assert.equal(await control.stopJob('ghost', {}), false);
  assert.equal(await control.removeJob('ghost', {}), false);
  assert.deepEqual(pm2.mutations(), []);
});

test('a process that is not running is not signalled', async t => {
  const { control, signals, pm2, proc } = setup(t);
  proc.pm2_env.status = 'stopped';
  await control.removeJob(sudoJob.name, sudoJob);
  assert.deepEqual(signals, []);
  assert.deepEqual(pm2.mutations().map(c => c[0]), ['delete']);
});

test('startFresh replaces the entry: graceful removal, then a start with the job kill timeout', async t => {
  const { pm2, control } = setup(t, { alive: () => false });
  const spec = await control.startFresh(sudoJob);
  assert.deepEqual(pm2.mutations().map(c => c[0]), ['delete', 'start']);
  assert.equal(pm2.procs.length, 1);
  assert.equal(pm2.procs[0].pm2_env.kill_timeout, 20000);
  assert.equal(spec.kill_timeout, 20000);
  assert.match(spec.out_file, /WireGuard Helper-out-/);
});

test('startFresh on a job PM2 does not have just starts it', async t => {
  const { pm2, control } = setup(t);
  await control.startFresh({ name: 'New', type: 'forever', command: 'node x.js', cwd: '/srv' });
  assert.deepEqual(pm2.mutations().map(c => c[0]), ['start']);
});

test('the dashboard state is what PM2 says, with the config flag shown as a mismatch', () => {
  const online = { pm2_env: { status: 'online' } };
  assert.deepEqual(describeJob({}, online), { status: 'online', running: true, markedStopped: false, drift: false });
  assert.deepEqual(describeJob({ stopped: true }, online), { status: 'online', running: true, markedStopped: true, drift: true });
  assert.deepEqual(describeJob({ stopped: true }, undefined), { status: 'stopped', running: false, markedStopped: true, drift: false });
  assert.equal(describeJob({}, undefined, { pm2Available: false }).status, 'unknown');
  assert.equal(describeJob({}, { pm2_env: { status: 'waiting restart' } }).running, true);
  assert.equal(describeJob({}, { pm2_env: { status: 'errored' } }).running, false);
});
