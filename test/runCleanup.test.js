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

function fixture(t, entries, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { entries, deleted: [], events: [], listSizes: [], failConnect: false, captureSaved: true,
    onDelete: null, errors: [], warnings: [] };
  const historyPath = path.join(dir, 'history.json');
  const client = {
    connect(cb) { state.events.push('connect'); cb(state.failConnect ? new Error('offline') : null); },
    disconnect(cb) { state.events.push('disconnect'); cb?.(); },
    list(cb) { state.events.push('list'); state.listSizes.push(state.entries.length); cb(null, state.entries); },
    // The cleanup deletes through the daemon's numeric-id method, never pm2.delete().
    delete() { assert.fail('pm2.delete() resolves numbers as process names; must not be used'); },
    Client: { executeRemote(method, id, cb) {
      assert.equal(method, 'deleteProcessId');
      client.deleteById(id, cb);
    } },
    deleteById(id, cb) {
      assert.equal(typeof id, 'number');
      const saved = state.captureSaved ? JSON.parse(fs.readFileSync(historyPath)) : null;
      state.events.push('delete');
      state.deleted.push({ id, saved });
      state.entries = state.entries.filter(p => p.pm_id !== id);
      state.onDelete?.(id);
      cb(null);
    },
    start(config, cb) {
      state.events.push('start');
      const proc = processEntry(config.name, 50, 'online');
      state.entries.push(proc);
      cb(null, [proc]);
    },
  };
  const options = { client, getScripts: () => [{ name: 'Aeros DDNS' }, { name: 'Aeros WireGuard Tunnel' }],
    historyPath, chunkPauseMs: 0, backlogIntervalMs: 5,
    logger: { log() {}, warn: m => state.warnings.push(m), error: m => state.errors.push(m) }, ...extra };
  const manager = createRunCleanup(options);
  t.after(() => manager.shutdown());
  return { manager, state, client, historyPath, options };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

test('finished run is persisted before numeric deletion; last-run info survives reload', async t => {
  const run = processEntry('Aeros DDNS-cron-1792800000000', 1, 'stopped', 7);
  const { manager, state, options } = fixture(t, [run]);
  assert.equal(await manager.reconcile(), 1);
  assert.equal(state.deleted[0].id, 1);
  const saved = state.deleted[0].saved['Aeros DDNS'];
  assert.deepEqual(saved, { runId: 1792800000000, lastRun: new Date(1792800000000).toISOString(), lastTrigger: 'cron' });
  const reloaded = createRunCleanup(options).history['Aeros DDNS'];
  assert.equal(reloaded.runId, saved.runId);
  assert.equal(reloaded.lastRun, saved.lastRun);
  assert.equal(reloaded.lastTrigger, saved.lastTrigger);
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
  assert.equal(manager.history['Aeros DDNS'].lastTrigger, 'manual');
  state.entries[0].pm2_env.status = 'stopped';
  await manager.reconcile();
  assert.equal(manager.history['Aeros DDNS'].runId, 1792800000001);
  assert.deepEqual(state.deleted.map(p => p.id), [1, 2]);
});

test('a stopped entry that becomes online between the plan and the delete chunk is kept', async t => {
  const { manager, client, state } = fixture(t, [processEntry('Aeros DDNS-cron-1792800000000', 1)]);
  const list = client.list;
  let calls = 0;
  client.list = cb => list(() => cb(null, ++calls === 1 ? state.entries
    : [processEntry('Aeros DDNS-cron-1792800000000', 1, 'online')]));
  assert.equal(await manager.reconcile(), 0);
  assert.equal(state.deleted.length, 0);
});

test('pm_id reuse: a different name or a vanished id at the same pm_id is never deleted', async t => {
  const { manager, client, state } = fixture(t, [
    processEntry('Aeros DDNS-cron-1792800000000', 1),
    processEntry('Aeros DDNS-cron-1792800000001', 2),
    processEntry('Aeros DDNS-cron-1792800000002', 3),
  ]);
  const list = client.list;
  let calls = 0;
  client.list = cb => list(() => cb(null, ++calls === 1 ? state.entries : [
    // pm_id 1 was reused by an unrelated stopped process, 2 is gone, 3 is unchanged.
    processEntry('Unrelated service', 1),
    processEntry('Aeros DDNS-cron-1792800000002', 3),
  ]));
  assert.equal(await manager.reconcile(), 1);
  assert.deepEqual(state.deleted.map(d => d.id), [3]);
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
  // The failed attempt, then a plan operation and a delete chunk.
  assert.equal(state.events.filter(e => e === 'connect').length, 3);
});

test('manual launch uses same collector and serializes concurrent PM2 operations', async t => {
  const { manager, state } = fixture(t, []);
  await Promise.all([
    manager.launch('Aeros DDNS', { name: 'Aeros DDNS-manual-1792800000000' }),
    manager.reconcile(),
  ]);
  assert.deepEqual(state.events, ['connect', 'start', 'disconnect', 'connect', 'list', 'disconnect']);
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

function bulkEntries(count) {
  const entries = [];
  for (let i = 0; i < count; i++) entries.push(processEntry(`Aeros DDNS-cron-${1792800000000 + i}`, i + 10));
  // Entries that must survive: unrelated, near-match, online forever job and an online run.
  entries.push(processEntry('Aeros DDNS', 1, 'online'), processEntry('Other-cron-1792800000000', 2),
    processEntry('Aeros DDNS-cron-1792800000000-tail', 3), processEntry('Aeros DDNS-cron-1792809999999', count + 20, 'online'));
  return entries;
}

test('sweep at scale: bounded deletes per list, capped per scan, no describe, newest run kept', async t => {
  const { manager, state, client } = fixture(t, bulkEntries(5200), { chunkSize: 100, maxDeletesPerScan: 1000 });
  state.captureSaved = false;
  client.describe = () => assert.fail('describe must not be used');
  let removed = 0;
  let scans = 0;
  while (state.entries.some(p => p.pm2_env.status === 'stopped' && /-cron-\d{13}$/.test(p.name)
    && p.name.startsWith('Aeros DDNS-'))) {
    const count = await manager.reconcile();
    assert.ok(count <= 1000, `scan deleted ${count}`);
    removed += count;
    scans += 1;
  }
  assert.equal(removed, 5200);
  assert.equal(scans, 6);
  // Between two list calls there are never more than chunkSize deletes.
  let run = 0;
  for (const event of state.events) {
    if (event === 'delete') assert.ok(++run <= 100, 'too many deletes after one list');
    else if (event === 'list') run = 0;
  }
  assert.deepEqual(state.entries.map(p => p.name).sort(), ['Aeros DDNS', 'Aeros DDNS-cron-1792800000000-tail',
    'Aeros DDNS-cron-1792809999999', 'Other-cron-1792800000000']);
  assert.equal(manager.history['Aeros DDNS'].runId, 1792809999999);
});

test('a launch waits for at most one chunk and runs before the rest of the sweep', async t => {
  const { manager, state } = fixture(t, bulkEntries(1000), { chunkSize: 100, maxDeletesPerScan: 1000 });
  state.captureSaved = false;
  let launched;
  state.onDelete = () => {
    if (!launched && state.deleted.length === 30) {
      launched = manager.launch('Aeros WireGuard Tunnel', { name: 'Aeros WireGuard Tunnel-manual-1792800009999' });
    }
  };
  assert.equal(await manager.reconcile(), 1000);
  await launched;
  const at = state.events.indexOf('start');
  const deletesBefore = state.events.slice(0, at).filter(e => e === 'delete').length;
  assert.equal(deletesBefore, 100, 'launch runs right after the chunk that was in progress');
  assert.equal(state.deleted.length, 1000);
});

test('a backlog is drained by follow-up scans soon after the first one', async t => {
  const { state, options } = fixture(t, bulkEntries(250));
  const manager = createRunCleanup({ ...options, maxDeletesPerScan: 100, chunkSize: 50, intervalMs: 60000 });
  t.after(() => manager.shutdown());
  assert.equal(await manager.start(), 100);
  const deadline = Date.now() + 3000;
  while (state.deleted.length < 250 && Date.now() < deadline) await sleep(10);
  assert.equal(state.deleted.length, 250);
});

test('an RPC error releases the queue and is logged with its message', async t => {
  const { manager, state, client } = fixture(t, []);
  const list = client.list;
  client.list = cb => cb(new Error('daemon exploded'));
  await assert.rejects(manager.start(), /daemon exploded/);
  assert.ok(state.errors.some(line => line.includes('daemon exploded')), state.errors.join('|'));
  client.list = list;
  await manager.launch('Aeros DDNS', { name: 'Aeros DDNS-manual-1792800000000' });
  assert.equal(state.events.at(-1), 'disconnect');
  assert.ok(state.events.includes('start'));
});

test('an RPC timeout rejects, disconnects and releases the queue; a late reply is ignored', async t => {
  const { manager, state, client } = fixture(t, [processEntry('Aeros DDNS-cron-1792800000000', 1)], { rpcTimeoutMs: 30 });
  const list = client.list;
  let late;
  client.list = cb => { late = cb; };
  await assert.rejects(manager.reconcile(), /list timed out/);
  assert.equal(state.events.at(-1), 'disconnect');
  client.list = list;
  late(null, []);
  // Another operation (queued behind the wedge) goes through normally.
  await manager.launch('Aeros DDNS', { name: 'Aeros DDNS-manual-1792800000009' });
  assert.equal(await manager.reconcile(), 1);
  assert.equal(state.deleted.length, 1);
});

test('operations never overlap even when one times out', async t => {
  const { manager, state, client } = fixture(t, [], { rpcTimeoutMs: 40 });
  const start = client.start;
  let open = 0;
  let overlap = false;
  client.connect = cb => { open += 1; overlap ||= open > 1; cb(null); };
  client.disconnect = cb => { open -= 1; cb(); };
  client.start = (config, cb) => { if (config.name.endsWith('hang')) return; start(config, cb); };
  const results = await Promise.allSettled([
    manager.launch('Aeros DDNS', { name: 'Aeros DDNS-manual-hang' }),
    manager.launch('Aeros DDNS', { name: 'Aeros DDNS-manual-1792800000001' }),
    manager.reconcile(),
  ]);
  assert.deepEqual(results.map(r => r.status), ['rejected', 'fulfilled', 'fulfilled']);
  assert.equal(overlap, false);
  assert.equal(open, 0);
});

test('an operation that exceeds its overall deadline is abandoned and makes no further calls', async t => {
  const { manager, state, client } = fixture(t, [], { operationTimeoutMs: 30, rpcTimeoutMs: 1000 });
  const start = client.start;
  client.start = (config, cb) => setTimeout(() => start(config, cb), 100);
  await assert.rejects(manager.launch('Aeros DDNS', { name: 'Aeros DDNS-manual-1792800000000' }), /operation timed out/);
  assert.equal(state.events.at(-1), 'disconnect');
});

test('a disconnect that never answers cannot wedge the queue', async t => {
  const { manager, state, client } = fixture(t, [], { disconnectTimeoutMs: 20 });
  client.disconnect = () => { state.events.push('disconnect'); };
  await manager.reconcile();
  await manager.reconcile();
  assert.equal(state.events.filter(e => e === 'connect').length, 2);
});

test('corrupt, empty or non-object history is set aside and boot continues', async t => {
  for (const content of ['', '{"Aeros DDNS": {"runId": 1792', '[]', 'null', '"text"', '7', 'not json']) {
    const { state, historyPath, options } = fixture(t, []);
    fs.writeFileSync(historyPath, content);
    const manager = createRunCleanup(options);
    assert.deepEqual(Object.keys(manager.history), [], content);
    assert.equal(Object.getPrototypeOf(manager.history), null);
    assert.equal(state.warnings.length, 1, content);
    assert.equal(fs.existsSync(historyPath), false);
    const aside = fs.readdirSync(path.dirname(historyPath)).filter(f => f.includes('.corrupt-'));
    assert.equal(aside.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(historyPath), aside[0]), 'utf8'), content);
    await manager.launch('Aeros DDNS', { name: 'Aeros DDNS-manual-1792800000000' });
    assert.equal(JSON.parse(fs.readFileSync(historyPath, 'utf8'))['Aeros DDNS'].runId, 1792800000000);
  }
});

test('valid history loads, ignores non-object entries and cannot pollute prototypes', t => {
  const { state, historyPath, options } = fixture(t, []);
  fs.writeFileSync(historyPath, '{"Aeros DDNS":{"runId":1792800000000,"lastRun":"2026-10-24T00:00:00.000Z","lastTrigger":"cron"},'
    + '"bad":5,"__proto__":{"polluted":true}}');
  const manager = createRunCleanup(options);
  assert.equal(manager.history['Aeros DDNS'].runId, 1792800000000);
  assert.equal(manager.history.bad, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(state.warnings.length, 0);
});

test('history is written to a temp file, fsynced, then renamed', async t => {
  const { manager, historyPath } = fixture(t, []);
  const calls = [];
  for (const name of ['fsyncSync', 'renameSync']) {
    const original = fs[name];
    t.mock.method(fs, name, (...args) => { calls.push(name); return original(...args); });
  }
  await manager.launch('Aeros DDNS', { name: 'Aeros DDNS-manual-1792800000000' });
  assert.ok(calls.indexOf('fsyncSync') < calls.indexOf('renameSync'), calls.join());
  assert.equal(fs.existsSync(`${historyPath}.tmp`), false);
  assert.equal(JSON.parse(fs.readFileSync(historyPath, 'utf8'))['Aeros DDNS'].lastTrigger, 'manual');
});

test('a history write failure after a successful start does not fail the launch; no run is deleted until it saves', async t => {
  const { state, options } = fixture(t, []);
  const blocked = path.join(options.historyPath, 'missing', 'history');
  const manager = createRunCleanup({ ...options, historyPath: blocked });
  await manager.launch('Aeros DDNS', { name: 'Aeros DDNS-manual-1792800000000' });
  assert.ok(state.events.includes('start'));
  assert.ok(state.errors.some(line => line.includes('Could not save run history') && line.includes('ENOENT')), state.errors.join('|'));
  state.entries[0].pm2_env.status = 'stopped';
  await assert.rejects(manager.reconcile(), /ENOENT/);
  assert.equal(state.deleted.length, 0);
});

test('scan failures are logged with the error message and no job details', async t => {
  const { manager, state } = fixture(t, []);
  state.failConnect = true;
  await assert.rejects(manager.start(), /offline/);
  assert.deepEqual(state.errors, ['[Run Cleanup] Scan failed; will retry: offline']);
});

test('cron registration does not wait for the startup sweep', async t => {
  const { state, options, client } = fixture(t, bulkEntries(300), { rpcTimeoutMs: 50 });
  client.list = cb => { state.events.push('list'); };
  const manager = require('../utils/cronManager')(options);
  t.after(() => manager.shutdown());
  const booting = manager.bootstrap([
    { name: 'Aeros DDNS', type: 'cron', schedule: '*/5 * * * *' },
    { name: 'Aeros WireGuard Tunnel', type: 'forever' },
    { name: 'Suspended', type: 'cron', schedule: '0 * * * *', suspended: true },
  ]);
  // Registered synchronously, while the sweep's first list call is still unanswered.
  assert.deepEqual(manager.listJobs().map(job => job.name), ['Aeros DDNS', 'Suspended']);
  assert.equal(manager.cronSuspended.Suspended, true);
  await booting;
  assert.deepEqual(state.errors, ['[Run Cleanup] Scan failed; will retry: PM2 list timed out']);
});

test('the installed pm2 exposes the calls the cleanup relies on', () => {
  const pm2 = require('pm2');
  const client = new pm2.custom();
  for (const method of ['connect', 'disconnect', 'list', 'start']) assert.equal(typeof client[method], 'function', method);
  assert.equal(typeof client.Client.executeRemote, 'function');
});
