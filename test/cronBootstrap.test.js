const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createCronManager = require('../utils/cronManager');

// At boot the server registers cron jobs first and starts the sweep of old runs
// only once it is listening and the jobs are reconciled.
test('bootstrap with cleanup: false schedules jobs but leaves the sweep for startCleanup', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-cron-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const service = {
    exclusive: async work => work(async method => { calls.push(method); return []; }),
  };
  const manager = createCronManager({ service, historyPath: path.join(dir, 'history.json'), logger: { log() {}, warn() {}, error() {} } });
  t.after(() => manager.shutdown());

  await manager.bootstrap([{ name: 'Nightly', type: 'cron', schedule: '0 3 * * *', command: 'true' }], { cleanup: false });
  assert.deepEqual(manager.listJobs().map(j => j.name), ['Nightly']);
  assert.deepEqual(calls, [], 'no PM2 call before the sweep is started');

  await manager.startCleanup();
  assert.ok(calls.includes('list'), 'the sweep lists PM2 once started');
});
