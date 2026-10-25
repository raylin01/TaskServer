const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { createFakePm2, legacyPm2Config } = require('../test-support/fakePm2');
const { createApp } = require('../server');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PM2_SETTINGS = { maxRestarts: 10000, autoRestart: true, restartDelay: 1000 };

const fakeCron = () => ({
  cronRunHistory: {}, cronSuspended: {}, upsertScript() {}, unregisterScript() {}, setSuspended() {}, runNow: async () => {},
});

function request(base, method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(base + url, { method, headers: {
      ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Boots the real app on a free port with a temp config and a fake PM2.
async function boot(t, { scripts, extra = {}, setupPm2 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-routes-'));
  const file = path.join(dir, 'config.yaml');
  const config = { server: { logsDir: path.join(dir, 'logs') }, pm2: PM2_SETTINGS, scripts: scripts || [], ...extra };
  fs.writeFileSync(file, yaml.dump(config));
  process.env.TASKSERVER_CONFIG = file;
  const pm2 = createFakePm2();
  setupPm2?.(pm2, config);
  const app = createApp({ processService: pm2, cronManager: fakeCron() });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  t.after(() => { delete process.env.TASKSERVER_CONFIG; fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = () => yaml.load(fs.readFileSync(file, 'utf8'));
  return { base, pm2, saved, config, dir };
}

const job = (name, extra = {}) => ({ name, type: 'forever', command: `node ${name}.js`, cwd: os.tmpdir(), ...extra });
const unreachable = () => Object.assign(new Error('PM2 is not reachable: connect ENOENT'), { code: 'PM2_UNAVAILABLE' });

test('importing server.js has no side effects: no listener, no PM2 connection', () => {
  const before = process.listenerCount('SIGTERM');
  delete require.cache[require.resolve('../server')];
  require('../server');
  assert.equal(process.listenerCount('SIGTERM'), before);
});

test('dashboard shows what PM2 runs, flags a job running although the config says stopped', async t => {
  const { base } = await boot(t, {
    scripts: [job('Alpha'), job('Beta', { stopped: true }), job('Gamma', { stopped: true })],
    setupPm2: (pm2, config) => {
      pm2.add(legacyPm2Config(config.scripts[0], PM2_SETTINGS, '/logs'));
      pm2.add(legacyPm2Config(config.scripts[1], PM2_SETTINGS, '/logs'));
    },
  });
  const page = (await request(base, 'GET', '/scripts')).text;
  assert.equal(page.match(/marked stopped in config/g).length, 1, 'only Beta is flagged');
  // Beta is running, so it offers Stop; Gamma is not, so it offers Start.
  assert.match(page, /action="\/stop-script\/Beta"/);
  assert.match(page, /action="\/start-script\/Gamma"/);
});

test('dashboard still renders when PM2 is unreachable, and says the state is unknown', async t => {
  const { base, pm2 } = await boot(t, { scripts: [job('Alpha')] });
  pm2.state.listError = unreachable();
  const res = await request(base, 'GET', '/scripts');
  assert.equal(res.status, 200);
  assert.match(res.text, /PM2 is not reachable/);
  assert.match(res.text, />unknown</);
  assert.doesNotMatch(res.text, />Stopped</);
});

test('API with auth on: GitSync restarting TaskServer needs the header key and gets its reply before the restart', async t => {
  const { base, pm2 } = await boot(t, {
    extra: { api: { authEnabled: true, apiKey: 'test-key-1234567890' } },
    setupPm2: pm2 => pm2.add({ name: 'taskserver', script: 'server.js', cwd: os.tmpdir() }),
  });
  assert.equal((await request(base, 'POST', '/api/restart-script/taskserver')).status, 401);
  assert.equal((await request(base, 'POST', '/api/restart-script/taskserver', { headers: { 'x-api-key': 'wrong' } })).status, 401);
  await sleep(150);
  assert.equal(pm2.calls.some(c => c[0] === 'restart'), false, 'nothing restarts without a valid key');

  const res = await request(base, 'POST', '/api/restart-script/taskserver', { headers: { 'x-api-key': 'test-key-1234567890' } });
  assert.equal(res.status, 200);
  assert.equal(res.json().success, true);
  assert.equal(res.headers.connection, 'close');
  // The reply is complete; the restart is requested only after it was written.
  assert.equal(pm2.calls.some(c => c[0] === 'restart'), false);
  await sleep(300);
  assert.deepEqual(pm2.calls.filter(c => c[0] === 'restart'), [['restart', 'taskserver']]);
});

test('self restart: name comes from config, unknown self is a clear 404, PM2 down is a 503', async t => {
  const { base, pm2 } = await boot(t, {
    extra: { server: { selfName: 'ts-main' } },
    setupPm2: pm2 => pm2.add({ name: 'ts-main', script: 'server.js', cwd: os.tmpdir() }),
  });
  assert.equal((await request(base, 'POST', '/api/restart-script/ts-main')).status, 200);
  const other = await request(base, 'POST', '/api/restart-script/taskserver');
  assert.equal(other.status, 404, 'taskserver is no longer special once selfName is set');
  await sleep(250);
  pm2.state.listError = unreachable();
  const down = await request(base, 'POST', '/api/restart-script/ts-main');
  assert.equal(down.status, 503);
  assert.deepEqual(down.json(), { success: false, error: 'PM2 is not reachable right now' });
  assert.equal(pm2.calls.filter(c => c[0] === 'restart').length, 1);
});

test('self restart when TaskServer is not in PM2 under that name is a 404, and restarts nothing', async t => {
  const { base, pm2 } = await boot(t);
  const res = await request(base, 'POST', '/api/restart-script/taskserver');
  assert.equal(res.status, 404);
  assert.match(res.json().error, /server\.selfName/);
  await sleep(150);
  assert.deepEqual(pm2.mutations(), []);
});

test('API restart of a job replaces the process with the current config and clears the stopped flag', async t => {
  const { base, pm2, saved } = await boot(t, {
    scripts: [job('Alpha', { stopped: true, killTimeoutMs: 20000 })],
    setupPm2: (pm2, config) => pm2.add(legacyPm2Config(config.scripts[0], PM2_SETTINGS, '/logs')),
  });
  const res = await request(base, 'POST', '/api/restart-script/Alpha');
  assert.equal(res.status, 200);
  assert.match(res.json().logFile, /^Alpha-out-.*\.log$/);
  assert.deepEqual(pm2.mutations().map(c => c[0]), ['delete', 'start']);
  assert.equal(pm2.procs[0].pm2_env.kill_timeout, 20000);
  assert.equal(saved().scripts[0].stopped, false);
  assert.equal((await request(base, 'POST', '/api/restart-script/Nope')).status, 404);
});

test('API stop marks the job stopped only when PM2 stopped it', async t => {
  const { base, pm2, saved } = await boot(t, {
    scripts: [job('Alpha', { killTimeoutMs: 20000 })],
    setupPm2: (pm2, config) => pm2.add(legacyPm2Config(config.scripts[0], PM2_SETTINGS, '/logs')),
  });
  pm2.state.stopError = new Error('daemon said no');
  const failed = await request(base, 'POST', '/api/stop-script/Alpha');
  assert.equal(failed.status, 500);
  assert.equal(saved().scripts[0].stopped, undefined);
  pm2.state.stopError = null;
  const ok = await request(base, 'POST', '/api/stop-script/Alpha');
  assert.equal(ok.status, 200);
  assert.equal(saved().scripts[0].stopped, true);
  const stop = pm2.calls.find(c => c[0] === 'stop' && !pm2.state.stopError);
  assert.ok(stop[2].timeoutMs >= 20000);
});

test('API start refuses a job that is already running and starts a stopped one', async t => {
  const { base, pm2, saved } = await boot(t, {
    scripts: [job('Alpha'), job('Beta', { stopped: true })],
    setupPm2: (pm2, config) => pm2.add(legacyPm2Config(config.scripts[0], PM2_SETTINGS, '/logs')),
  });
  assert.equal((await request(base, 'POST', '/api/start-script/Alpha')).status, 400);
  assert.equal((await request(base, 'POST', '/api/start-script/Beta')).status, 200);
  assert.equal(pm2.procs.find(p => p.name === 'Beta').pm2_env.status, 'online');
  assert.equal(saved().scripts[1].stopped, false);
});

test('API list reports real state, and a 503 when PM2 is unreachable', async t => {
  const { base, pm2 } = await boot(t, {
    scripts: [job('Alpha', { stopped: true }), job('Beta')],
    setupPm2: (pm2, config) => pm2.add(legacyPm2Config(config.scripts[0], PM2_SETTINGS, '/logs')),
  });
  const body = (await request(base, 'GET', '/api/scripts')).json();
  assert.deepEqual(body.scripts.map(s => [s.name, s.status, s.markedStopped]), [['Alpha', 'online', true], ['Beta', 'stopped', false]]);
  pm2.state.listError = unreachable();
  const down = await request(base, 'GET', '/api/scripts');
  assert.equal(down.status, 503);
  assert.equal(down.json().success, false);
});

test('API add auto-starts a forever job, and reports it when starting fails', async t => {
  const { base, pm2, saved } = await boot(t);
  const added = await request(base, 'POST', '/api/add-script', { body: { name: 'New', type: 'forever', command: 'node x.js' } });
  assert.deepEqual(added.json().autoStarted, true);
  assert.equal(pm2.procs[0].name, 'New');
  pm2.state.startError = unreachable();
  const failed = await request(base, 'POST', '/api/add-script', { body: { name: 'Two', type: 'forever', command: 'node y.js' } });
  assert.equal(failed.status, 200);
  assert.equal(failed.json().autoStarted, false);
  assert.deepEqual(saved().scripts.map(s => s.name), ['New', 'Two']);
});

test('errors give the first line only: no secrets, no stack, no 500 page with paths', async t => {
  const { base, pm2 } = await boot(t, {
    scripts: [job('Alpha')],
    setupPm2: (pm2, config) => pm2.add(legacyPm2Config(config.scripts[0], PM2_SETTINGS, '/logs')),
  });
  pm2.state.startError = new Error('Script not found: /x\nTOKEN=super-secret');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const res = await request(base, 'POST', '/api/restart-script/Alpha');
  assert.equal(res.status, 500);
  assert.equal(res.json().error, 'Script not found: /x');
  assert.doesNotMatch(res.text + errors.join('\n'), /super-secret|\sat\s/);
});

test('form routes: delete keeps the script when PM2 cannot stop it; stop and restart redirect', async t => {
  const { base, pm2, saved } = await boot(t, {
    scripts: [job('Alpha')],
    setupPm2: (pm2, config) => pm2.add(legacyPm2Config(config.scripts[0], PM2_SETTINGS, '/logs')),
  });
  t.mock.method(console, 'error', () => {});
  pm2.state.listError = unreachable();
  const refused = await request(base, 'POST', '/delete-script/Alpha');
  assert.equal(refused.status, 503);
  assert.equal(saved().scripts.length, 1, 'still configured, so it is not left running unmanaged');
  pm2.state.listError = null;
  const stop = await request(base, 'POST', '/stop-script/Alpha');
  assert.equal(stop.status, 302);
  assert.equal(saved().scripts[0].stopped, true);
  const restart = await request(base, 'POST', '/restart-script/Alpha');
  assert.equal(restart.status, 302);
  const gone = await request(base, 'POST', '/delete-script/Alpha');
  assert.equal(gone.status, 302);
  assert.equal(saved().scripts.length, 0);
  assert.deepEqual(pm2.procs, []);
});

test('TaskServer itself in the config cannot be stopped, restarted or deleted from the dashboard or API (400, PM2 untouched)', async t => {
  const { base, pm2, saved } = await boot(t, {
    scripts: [job('taskserver', { command: 'node server.js' })],
    setupPm2: (pm2, config) => pm2.add(legacyPm2Config(config.scripts[0], PM2_SETTINGS, '/logs')),
  });
  t.mock.method(console, 'error', () => {});
  for (const url of ['/stop-script/taskserver', '/start-script/taskserver', '/restart-script/taskserver', '/delete-script/taskserver',
    '/api/stop-script/taskserver']) {
    const res = await request(base, 'POST', url);
    assert.equal(res.status, 400, url);
    assert.match(res.text, /TaskServer itself/);
  }
  assert.deepEqual(pm2.mutations(), []);
  assert.equal(saved().scripts.length, 1, 'delete did not drop the config entry either');
});

test('two quick API starts of a stopped job: one starts it, the other is told it is already running', async t => {
  const { base, pm2 } = await boot(t, { scripts: [job('Alpha', { stopped: true })] });
  const [a, b] = await Promise.all([
    request(base, 'POST', '/api/start-script/Alpha'),
    request(base, 'POST', '/api/start-script/Alpha'),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  assert.equal(pm2.procs.filter(p => p.name === 'Alpha').length, 1);
  assert.deepEqual(pm2.mutations().map(c => c[0]), ['start'], 'started once, never replaced');
});
