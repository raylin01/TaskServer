const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakePm2, legacyPm2Config } = require('../test-support/fakePm2');
const { createJobControl, describeJob } = require('../utils/jobControl');
const { buildPm2Config, killTimeoutFor } = require('../utils/jobSpec');

const PM2 = { maxRestarts: 10000, autoRestart: true, restartDelay: 1000, killTimeoutMs: 5000 };
const sudoJob = { name: 'Example Helper', type: 'forever', command: 'sudo -n python3 helper.py', cwd: '/srv/example-helper', killTimeoutMs: 20000 };

// Time that only moves when something sleeps, so waits cost nothing.
function fakeClock() {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; } };
}

function setup(t, { legacy = true, script = sudoJob, alive = () => false, signalTree, runStopCommand, killSignal } = {}) {
  const pm2 = createFakePm2();
  const clock = fakeClock();
  const logger = { warns: [], errors: [], warn(m) { this.warns.push(m); }, log() {}, error(m) { this.errors.push(m); } };
  const signals = [];
  const proc = pm2.add(legacy ? legacyPm2Config(script, PM2, '/logs') : buildPm2Config(script, PM2, '/logs'));
  const control = createJobControl({
    service: pm2, logger, getPm2Settings: () => PM2, getLogsDir: () => '/logs', pollMs: 100,
    now: clock.now, sleep: clock.sleep, isAlive: pid => alive(pid, clock.now()),
    signalTree: signalTree || (async (pid, signal) => { signals.push([pid, signal]); }),
    runStopCommand: runStopCommand || (async () => ({ code: 0 })),
    killSignal: killSignal || (() => 'SIGINT'),
    getSelfName: () => 'taskserver',
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
  assert.match(spec.out_file, /Example Helper-out-/);
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

test('two restarts of the same job at once are serialised: one process, no error, no duplicate', async t => {
  const { pm2, control } = setup(t, { alive: () => false });
  const results = await Promise.allSettled([control.startFresh(sudoJob), control.startFresh(sudoJob), control.startFresh(sudoJob)]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(pm2.procs.filter(p => p.name === sudoJob.name).length, 1);
  assert.deepEqual(pm2.mutations().map(c => c[0]), ['delete', 'start', 'delete', 'start', 'delete', 'start']);
});

test('a stop and a restart of the same job do not interleave, and other jobs are not held up', async t => {
  const { pm2, control } = setup(t, { alive: () => false });
  const other = { name: 'Other', type: 'forever', command: 'node o.js', cwd: '/srv' };
  pm2.add(buildPm2Config(other, PM2, '/logs'));
  const order = [];
  await Promise.all([
    control.stopJob(sudoJob.name, sudoJob).then(() => order.push('stop')),
    control.startFresh(sudoJob).then(() => order.push('restart')),
    control.stopJob(other.name, other).then(() => order.push('other')),
  ]);
  assert.deepEqual(order.filter(x => x !== 'other'), ['stop', 'restart']);
  assert.deepEqual(pm2.procs.map(p => p.name).sort(), [other.name, sudoJob.name].sort());
  assert.equal(pm2.procs.find(p => p.name === sudoJob.name).pm2_env.status, 'online');
});

test('a failed job does not block the next one on the same name', async t => {
  const { pm2, control } = setup(t, { alive: () => false });
  pm2.state.stopError = new Error('boom');
  await assert.rejects(control.stopJob(sudoJob.name, sudoJob), /boom/);
  pm2.state.stopError = null;
  assert.equal(await control.stopJob(sudoJob.name, sudoJob), true);
});

test('when the start fails after the old process was removed, the log says so', async t => {
  const { pm2, control, logger } = setup(t, { alive: () => false });
  pm2.state.startError = new Error('spawn failed');
  await assert.rejects(control.startFresh(sudoJob), /spawn failed/);
  assert.equal(pm2.procs.length, 0);
  assert.equal(logger.errors.length, 1);
  assert.match(logger.errors[0], /Example Helper.*removed from PM2 but could not be started again: spawn failed/);
});

test('no "removed" message when there was nothing to remove', async t => {
  const { pm2, control, logger } = setup(t);
  pm2.state.startError = new Error('spawn failed');
  await assert.rejects(control.startFresh({ name: 'New', type: 'forever', command: 'x', cwd: '/srv' }), /spawn failed/);
  assert.deepEqual(logger.errors, []);
});

test('when no process of the job can be signalled, the stop does not wait out the timeout, and says so once', async t => {
  // Every process is root-owned: EPERM on all of them.
  const { pm2, control, clock, logger } = setup(t, { alive: () => true, signalTree: async () => false });
  await control.stopJob(sudoJob.name, sudoJob);
  assert.equal(clock.now(), 0, 'no polling');
  assert.equal(logger.warns.filter(w => /could not signal any process/.test(w)).length, 1);
  assert.match(logger.warns[0], /stopCommand/);
  assert.deepEqual(pm2.mutations().map(c => c[0]), ['stop'], 'PM2 is still asked to stop it');
});

test('a signal that was delivered still gets the full wait', async t => {
  const { control, clock, logger } = setup(t, { alive: () => true, signalTree: async () => true });
  await control.stopJob(sudoJob.name, sudoJob);
  assert.ok(clock.now() >= 20000);
  assert.equal(logger.warns.filter(w => /could not signal any process/.test(w)).length, 0);
});

test('TaskServer itself is refused by stop, remove and startFresh with a 400, and PM2 is not touched', async t => {
  const { pm2, control } = setup(t);
  pm2.add({ name: 'taskserver', script: 'server.js', cwd: '/srv' });
  const self = { name: 'taskserver', type: 'forever', command: 'node server.js' };
  for (const call of [() => control.stopJob('taskserver', self), () => control.removeJob('taskserver', self), () => control.startFresh(self)]) {
    await assert.rejects(call(), error => error.status === 400 && /TaskServer itself/.test(error.message));
  }
  assert.deepEqual(pm2.mutations(), []);
});
