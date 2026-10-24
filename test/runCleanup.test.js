const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunCleanup, runPattern, selectStoppedRuns } = require('../utils/runCleanup');

function processEntry(name, id, status = 'stopped', exitCode = 0) {
  return { name, pm_id: id, pid: status === 'online' ? 1000 + id : 0,
    pm2_env: { name, pm_id: id, status, exit_code: exitCode,
      pm_uptime: 1792800000000, pm_out_log_path: `/logs/${id}-out.log`,
      pm_err_log_path: `/logs/${id}-error.log`, autorestart: false } };
}

function fixture(t, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { entries, deleted: [], events: [], failConnect: false };
  const historyPath = path.join(dir, 'history.json');
  const client = {
    connect(cb) { state.events.push('connect'); cb(state.failConnect ? new Error('offline') : null); },
    disconnect() { state.events.push('disconnect'); },
    list(cb) { cb(null, state.entries); },
    describe(id, cb) { cb(null, state.entries.filter(p => p.pm_id === id)); },
    delete(id, cb) {
      const saved = JSON.parse(fs.readFileSync(historyPath));
      state.events.push('delete');
      state.deleted.push({ id, saved });
      state.entries = state.entries.filter(p => p.pm_id !== id);
      cb(null);
    },
    start(config, cb) {
      const proc = processEntry(config.name, 50, 'online');
      state.entries.push(proc);
      cb(null, [proc]);
    },
  };
  const options = { client, getScripts: () => [{ name: 'Aeros DDNS' }, { name: 'Aeros WireGuard Tunnel' }],
    historyPath, logger: { log() {}, error() {} } };
  const manager = createRunCleanup(options);
  t.after(() => manager.shutdown());
  return { manager, state, client, historyPath, options };
}

test('run names escape all regex punctuation and require the exact full name', () => {
  const name = 'Job .+*?^$()[]{}|\\ with spaces';
  const pattern = runPattern(name);
  assert.ok(pattern.test(`${name}-cron-1792800000000`));
  assert.ok(pattern.test(`${name}-manual-1792800000000`));
  for (const invalid of [name, `${name}-cron-123`, `prefix-${name}-cron-1792800000000`,
    `${name}-cron-1792800000000-extra`, `${name}-cron-1792800000000\n`,
    `${name}-manual-17928000000000`, `${name}-other-1792800000000`, 'Job X-cron-1792800000000']) {
    assert.equal(pattern.test(invalid), false, invalid);
  }
});

test('sweep selects only stopped exact registered runs from real-shaped PM2 entries', () => {
  const entries = [
    processEntry('Aeros DDNS', 0),
    processEntry('Aeros DDNS-cron-1792800000000', 1),
    processEntry('Aeros DDNS-manual-1792800000001', 2),
    processEntry('Aeros DDNS-cron-1792800000002', 3, 'online'),
    processEntry('Aeros WireGuard Tunnel', 4, 'online'),
    processEntry('Aeros WireGuard Tunnel-manual-1792800000003', 5),
    processEntry('Other-cron-1792800000004', 6),
    processEntry('Aeros DDNS-cron-1792800000005-tail', 7),
    processEntry('Aeros DDNS-cron-1792800000006', 8, 'errored'),
    processEntry('Aeros DDNS-cron-1792800000007', 9),
  ];
  assert.deepEqual(selectStoppedRuns(entries, ['Aeros DDNS', 'Aeros WireGuard Tunnel', 'Aeros DDNS-cron-1792800000007']).map(p => p.pm_id), [1, 2, 5]);
});

test('finished run is persisted before numeric deletion; logs and history survive reload', async t => {
  const run = processEntry('Aeros DDNS-cron-1792800000000', 1, 'stopped', 7);
  const { manager, state, options } = fixture(t, [run]);
  assert.equal(await manager.reconcile(), 1);
  assert.equal(state.deleted[0].id, 1);
  const saved = state.deleted[0].saved['Aeros DDNS'];
  assert.equal(saved.exitCode, 7);
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.outFile, '/logs/1-out.log');
  assert.equal(saved.errorFile, '/logs/1-error.log');
  assert.equal(saved.lastTrigger, 'cron');
  assert.equal(saved.lastRun, new Date(1792800000000).toISOString());
  assert.deepEqual(createRunCleanup(options).history['Aeros DDNS'], saved);
  assert.equal(state.events.at(-1), 'disconnect');
});

test('overlapping runs keep newest launch metadata and never delete online run', async t => {
  const { manager, state } = fixture(t, [
    processEntry('Aeros DDNS-manual-1792800000001', 2, 'online'),
    processEntry('Aeros DDNS-cron-1792800000000', 1),
  ]);
  await manager.reconcile();
  assert.deepEqual(state.deleted.map(p => p.id), [1]);
  assert.equal(manager.history['Aeros DDNS'].runId, 1792800000001);
  assert.equal(manager.history['Aeros DDNS'].status, 'online');
  state.entries[0].pm2_env.status = 'stopped';
  await manager.reconcile();
  assert.equal(manager.history['Aeros DDNS'].status, 'stopped');
  assert.deepEqual(state.deleted.map(p => p.id), [1, 2]);
});

test('rechecks status before delete if a stopped entry becomes online', async t => {
  const { manager, client, state } = fixture(t, [processEntry('Aeros DDNS-cron-1792800000000', 1)]);
  client.describe = (id, cb) => cb(null, [processEntry('Aeros DDNS-cron-1792800000000', id, 'online')]);
  assert.equal(await manager.reconcile(), 0);
  assert.equal(state.deleted.length, 0);
});

test('failed metadata write never deletes a run', async t => {
  const { state, options } = fixture(t, [processEntry('Aeros DDNS-cron-1792800000000', 1)]);
  const manager = createRunCleanup({ ...options, historyPath: path.join(options.historyPath, 'missing', 'history') });
  await assert.rejects(manager.reconcile());
  assert.equal(state.deleted.length, 0);
  assert.equal(state.events.at(-1), 'disconnect');
});

test('a later scan reconnects after failure and catches an exit missed during downtime', async t => {
  const { manager, state } = fixture(t, [processEntry('Aeros DDNS-cron-1792800000000', 1)]);
  state.failConnect = true;
  await assert.rejects(manager.reconcile(), /offline/);
  state.failConnect = false;
  await manager.start();
  assert.equal(state.deleted.length, 1);
  assert.equal(state.events.filter(e => e === 'connect').length, 2);
});

test('manual launch uses same collector and serializes concurrent PM2 operations', async t => {
  const { manager, state } = fixture(t, []);
  await Promise.all([
    manager.launch('Aeros DDNS', { name: 'Aeros DDNS-manual-1792800000000' }),
    manager.reconcile(),
  ]);
  assert.deepEqual(state.events, ['connect', 'disconnect', 'connect', 'disconnect']);
  state.entries[0].pm2_env.status = 'stopped';
  await manager.reconcile();
  assert.equal(state.deleted.length, 1);
  assert.equal(manager.history['Aeros DDNS'].lastTrigger, 'manual');
});

test('periodic collector retries a failed startup connection and removes a later exit', async t => {
  const { state, options } = fixture(t, [processEntry('Aeros DDNS-cron-1792800000000', 1, 'online')]);
  const manager = createRunCleanup({ ...options, intervalMs: 10 });
  t.after(() => manager.shutdown());
  state.failConnect = true;
  await assert.rejects(manager.start(), /offline/);
  state.failConnect = false;
  state.entries[0].pm2_env.status = 'stopped';
  const deadline = Date.now() + 2000;
  while (state.deleted.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(state.deleted.length, 1);
});

test('run-now launches in the same millisecond have distinct process names and logs', async t => {
  const { options, client } = fixture(t, []);
  const configs = [];
  const start = client.start;
  client.start = (config, cb) => { configs.push(config); start(config, cb); };
  const configHandler = require('../utils/configHandler');
  t.mock.method(configHandler, 'getLogsDir', () => path.dirname(options.historyPath));
  t.mock.method(Date, 'now', () => 1792800000100);
  const manager = require('../utils/cronManager')(options);
  t.after(() => manager.shutdown());
  manager.upsertScript({ name: 'Aeros DDNS', path: '/synthetic/tick.js', type: 'cron', schedule: '* * * * *', suspended: true });
  await Promise.all([manager.runNow('Aeros DDNS'), manager.runNow('Aeros DDNS')]);
  assert.notEqual(configs[0].name, configs[1].name);
  assert.notEqual(configs[0].out_file, configs[1].out_file);
  assert.ok(configs.every(config => config.autorestart === false));
});
