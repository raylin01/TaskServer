const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { boot, request, job } = require('../test-support/httpApp');
const { KEY, PASSWORD, AUTH } = require('../test-support/authFixture');
const { legacyPm2Config } = require('../test-support/fakePm2');
const { hashPassword, verifyPassword, parseHash } = require('../utils/passwordHash');
const { readHidden } = require('../utils/hiddenPrompt');
const { listenProblems } = require('../utils/security');
const setApiKey = require('../scripts/set-api-key');
const setDashboardPassword = require('../scripts/set-dashboard-password');

const PM2_SETTINGS = { maxRestarts: 10000, autoRestart: true, restartDelay: 1000 };
const withKey = (extra = {}) => ({ 'x-api-key': KEY, ...extra });

// ---------------------------------------------------------------------------
// POST /api/delete-script/:name
// ---------------------------------------------------------------------------

test('API delete stops and removes a running forever job, and a cron job; unknown names are a JSON 404', async t => {
  const unregistered = [];
  const { base, pm2, saved, app } = await boot(t, {
    scripts: [job('Alpha'), job('Nightly', { type: 'cron', schedule: '0 * * * *' }), job('Other')],
    setupPm2: (p, c) => p.add(legacyPm2Config(c.scripts[0], PM2_SETTINGS, '/logs')),
  });
  app.locals.cronManager.unregisterScript = name => unregistered.push(name);

  const forever = await request(base, 'POST', '/api/delete-script/Alpha');
  assert.equal(forever.status, 200);
  assert.deepEqual(forever.json(), { success: true, message: "Script 'Alpha' deleted" });
  assert.deepEqual(pm2.procs, [], 'stopped and removed from PM2');
  assert.deepEqual(saved().scripts.map(s => s.name), ['Nightly', 'Other']);

  assert.equal((await request(base, 'POST', '/api/delete-script/Nightly')).status, 200);
  assert.deepEqual(unregistered, ['Nightly']);
  assert.deepEqual(saved().scripts.map(s => s.name), ['Other']);

  const missing = await request(base, 'POST', '/api/delete-script/Alpha');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json(), { success: false, error: 'Script not found' });
  assert.deepEqual(saved().scripts.map(s => s.name), ['Other']);
});

test('API delete needs the API key when authentication is on', async t => {
  const { base, saved } = await boot(t, { scripts: [job('Alpha')], extra: AUTH });
  assert.equal((await request(base, 'POST', '/api/delete-script/Alpha')).status, 401);
  assert.equal((await request(base, 'POST', '/api/delete-script/Alpha', { headers: { 'x-api-key': 'wrong' } })).status, 401);
  assert.equal(saved().scripts.length, 1);
  assert.equal((await request(base, 'POST', '/api/delete-script/Alpha', { headers: withKey() })).status, 200);
  assert.equal((await request(base, 'POST', '/api/delete-script/Alpha', { headers: withKey() })).status, 404);
  assert.equal(saved().scripts.length, 0);
});

// ---------------------------------------------------------------------------
// Refusals, Referer, login
// ---------------------------------------------------------------------------

test('a refused API request logs one line with method, path and address, and never the key or the query', async t => {
  const lines = [];
  t.mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
  const { base } = await boot(t, { extra: AUTH });
  const guess = 'guessed-secret-value';
  await request(base, 'GET', `/api/scripts?apiKey=${guess}`);
  await request(base, 'POST', '/api/add-script', { headers: { 'x-api-key': guess }, json: { name: 'X' } });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^TaskServer API refused: GET \/api\/scripts from (::ffff:)?127\.0\.0\.1$/);
  assert.match(lines[1], /^TaskServer API refused: POST \/api\/add-script from /);
  assert.doesNotMatch(lines.join('\n'), new RegExp(`${guess}|${KEY}|apiKey`));
});

test('with no Origin, the Referer must be this site; Origin wins when both are sent', async t => {
  const { base, saved } = await boot(t, { extra: AUTH });
  const login = await request(base, 'POST', '/login', { headers: { origin: base }, form: { password: PASSWORD } });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const token = (await request(base, 'GET', '/add-script', { headers: { cookie } })).text.match(/name="_csrf" value="([^"]+)"/)[1];
  const post = headers => request(base, 'POST', '/add-script', {
    headers: { cookie, ...headers },
    form: { _csrf: token, name: 'Added', type: 'forever', command: 'echo hi', sourceType: 'command' },
  });
  assert.equal((await post({ referer: 'http://evil.example/page' })).status, 403);
  assert.equal((await post({ referer: 'not a url' })).status, 403);
  assert.equal((await post({ origin: 'http://evil.example', referer: `${base}/add-script` })).status, 403);
  assert.deepEqual(saved().scripts, []);
  assert.equal((await post({ referer: `${base}/add-script` })).status, 302);
  assert.equal(saved().scripts.length, 1);
});

test('the login POST is checked for Origin like any other, and a wrong password logs the refusal without the password', async t => {
  const lines = [];
  t.mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
  const { base } = await boot(t, { extra: AUTH });
  assert.equal((await request(base, 'POST', '/login', { form: { password: PASSWORD } })).status, 403, 'no Origin, no Referer');
  assert.equal((await request(base, 'POST', '/login', { headers: { origin: 'http://evil.example' }, form: { password: PASSWORD } })).status, 403);
  const wrong = await request(base, 'POST', '/login', { headers: { origin: base }, form: { password: 'a-wrong-password' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  assert.ok(lines.some(line => /^TaskServer login refused: POST \/login from /.test(line)));
  assert.doesNotMatch(lines.join('\n') + wrong.text, /a-wrong-password|example-dashboard-password/);
  // The API key is not the password.
  assert.equal((await request(base, 'POST', '/login', { headers: { origin: base }, form: { password: KEY } })).status, 401);
});

test('the session cookie is HttpOnly, SameSite=Strict, Path=/ with a 256-bit random id', async t => {
  const { base } = await boot(t, { extra: AUTH });
  const ids = new Set();
  for (let i = 0; i < 2; i += 1) {
    const res = await request(base, 'POST', '/login', { headers: { origin: base }, form: { password: PASSWORD } });
    const [pair, ...attributes] = res.headers['set-cookie'][0].split('; ');
    assert.equal(attributes[0], 'Path=/');
    assert.ok(attributes.includes('HttpOnly'));
    assert.ok(attributes.includes('SameSite=Strict'));
    assert.match(pair, /^taskserver_session=[A-Za-z0-9_-]{43}$/);
    ids.add(pair);
  }
  assert.equal(ids.size, 2);
});

// ---------------------------------------------------------------------------
// Password hashes, config writes and the command-line helpers
// ---------------------------------------------------------------------------

test('a password hash is salted scrypt that verifies only the right password; odd hashes are refused', async () => {
  const cheap = { N: 1024, r: 8, p: 1 };
  const [a, b] = [await hashPassword('correct horse battery', cheap), await hashPassword('correct horse battery', cheap)];
  assert.notEqual(a, b, 'a new salt each time');
  assert.match(a, /^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword('correct horse battery', a), true);
  assert.equal(await verifyPassword('correct horse batter', a), false);
  assert.equal(await verifyPassword('', a), false);
  assert.equal(await verifyPassword('x'.repeat(5000), a), false);
  for (const bad of ['', 'plain', 'scrypt$1000$8$1$AAAA$AAAA', 'scrypt$1024$8$1$AAAA', 'bcrypt$1024$8$1$a$b', a.replace('1024', '4294967296'), undefined, 42]) {
    assert.equal(parseHash(bad), null, String(bad));
    assert.equal(await verifyPassword('anything', bad), false);
  }
});

test('config.yaml is always written with mode 600, even over a more open file', t => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-mode-'));
  t.after(() => { delete process.env.TASKSERVER_CONFIG; fs.rmSync(dir, { recursive: true, force: true }); });
  const target = path.join(dir, 'config.yaml');
  fs.writeFileSync(target, 'scripts: []\n');
  fs.chmodSync(target, 0o644);
  process.env.TASKSERVER_CONFIG = target;
  require('../utils/configHandler').writeConfig({ scripts: [] });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

// A fake terminal that records what is written to it.
const fakeTerminal = (isTTY = true) => ({ isTTY, text: '', write(chunk) { this.text += chunk; } });

function withConfig(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-cli-'));
  const file = path.join(dir, 'config.yaml');
  if (content !== undefined) fs.writeFileSync(file, yaml.dump(content));
  process.env.TASKSERVER_CONFIG = file;
  t.after(() => { delete process.env.TASKSERVER_CONFIG; fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, read: () => yaml.load(fs.readFileSync(file, 'utf8')) };
}

test('set-api-key makes a random key, shows it once on a terminal, and stores it in a 600 file', async t => {
  const { file, read } = withConfig(t, { scripts: [{ name: 'Keep', type: 'forever', command: 'echo hi' }] });
  const stdout = fakeTerminal();
  const stderr = fakeTerminal();
  assert.equal(await setApiKey.main({ stdin: { isTTY: true }, stdout, stderr }), 0);
  const stored = read().auth.apiKey;
  assert.match(stored, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(stdout.text.split(stored).length - 1, 1, 'shown exactly once');
  assert.equal(stderr.text, '');
  assert.equal(read().scripts[0].name, 'Keep', 'the rest of the config is kept');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.yaml'], 'no temporary file left');

  // A second run asks before replacing; "no" changes nothing and shows nothing.
  const again = fakeTerminal();
  assert.equal(await setApiKey.main({ stdin: { isTTY: true }, stdout: again, stderr, confirm: async () => false }), 0);
  assert.equal(read().auth.apiKey, stored);
  assert.doesNotMatch(again.text, new RegExp(stored));
  assert.equal(await setApiKey.main({ stdin: { isTTY: true }, stdout: fakeTerminal(), stderr, confirm: async () => true }), 0);
  assert.notEqual(read().auth.apiKey, stored);
});

test('set-api-key refuses to run without a terminal, so the key is never lost or leaked into a pipe', async t => {
  const { file } = withConfig(t);
  const stderr = fakeTerminal();
  assert.equal(await setApiKey.main({ stdin: { isTTY: false }, stdout: fakeTerminal(false), stderr }), 1);
  assert.equal(await setApiKey.main({ stdin: { isTTY: true }, stdout: fakeTerminal(false), stderr }), 1);
  assert.match(stderr.text, /must run in a terminal/);
  assert.equal(fs.existsSync(file), false);
});

test('set-dashboard-password asks twice, stores only a hash, never prints the password', async t => {
  const { file, read } = withConfig(t, { auth: { apiKey: KEY } });
  const answers = (...list) => async () => list.shift();
  const [stdout, stderr] = [fakeTerminal(), fakeTerminal()];

  assert.equal(await setDashboardPassword.main({ prompt: answers('too short', 'too short'), stdout, stderr }), 1);
  assert.equal(await setDashboardPassword.main({ prompt: answers('a long enough password', 'another long password'), stdout, stderr }), 1);
  assert.equal(read().auth.dashboardPasswordHash, undefined, 'nothing stored after a mistake');

  assert.equal(await setDashboardPassword.main({ prompt: answers('a long enough password', 'a long enough password'), stdout, stderr }), 0);
  const { apiKey, dashboardPasswordHash } = read().auth;
  assert.equal(apiKey, KEY, 'the key is kept');
  assert.equal(await verifyPassword('a long enough password', dashboardPasswordHash), true);
  assert.doesNotMatch(stdout.text + stderr.text + fs.readFileSync(file, 'utf8'), /a long enough password|another long password/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // The steps in the README leave a config the server accepts.
  const config = read();
  config.auth.required = true;
  assert.deepEqual(listenProblems(config), []);
});

test('the hidden prompt does not echo, handles backspace, and needs a terminal', async () => {
  const { EventEmitter } = require('events');
  const input = Object.assign(new EventEmitter(), { isTTY: true, raw: false, setRawMode(on) { this.raw = on; }, setEncoding() {}, resume() {}, pause() {} });
  const output = fakeTerminal();
  const pending = readHidden('Password: ', { input, output });
  input.emit('data', 'secrex');
  input.emit('data', '\u007f');
  input.emit('data', 't\r');
  assert.equal(await pending, 'secret');
  assert.equal(output.text, 'Password: \n', 'only the question and a newline are written');
  assert.equal(input.raw, false);
  assert.equal(input.listenerCount('data'), 0);

  const cancelled = readHidden('Password: ', { input, output: fakeTerminal() });
  input.emit('data', '\u0003');
  await assert.rejects(cancelled, /Cancelled/);
  await assert.rejects(readHidden('x', { input: { isTTY: false }, output }), /needs a terminal/);
});

// ---------------------------------------------------------------------------
// Upgrade path: check-config, the old settings, the commands on a live config
// ---------------------------------------------------------------------------

const checkConfig = require('../scripts/check-config');

function runCheck() {
  const [stdout, stderr] = [fakeTerminal(), fakeTerminal()];
  const code = checkConfig.main({ stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

test('check-config says OK or lists every problem by key name, never a value, and does not change the file', t => {
  const { file } = withConfig(t, { server: { host: '127.0.0.1' }, auth: { required: true, apiKey: KEY, dashboardPasswordHash: AUTH.auth.dashboardPasswordHash } });
  const before = fs.readFileSync(file, 'utf8');
  const ok = runCheck();
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /^OK: /);
  assert.equal(ok.stderr, '');

  // The old block next to missing new settings: one run shows everything to fix.
  fs.writeFileSync(file, yaml.dump({ server: { host: '0.0.0.0' }, api: { authEnabled: true, apiKey: 'old-secret-value-0123456789' }, auth: { required: 'yes' } }));
  const bad = runCheck();
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Problem: config\.yaml still has the old settings api\.authEnabled, api\.apiKey;/);
  assert.match(bad.stderr, /Problem: auth\.required in config\.yaml must be true or false/);
  assert.match(bad.stderr, /Problem: server\.host is 0\.0\.0\.0/);
  assert.match(bad.stderr, /3 problems in /);
  assert.doesNotMatch(bad.stderr + bad.stdout, /old-secret-value/);

  fs.writeFileSync(file, 'auth: {{{ super-secret-text');
  const broken = runCheck();
  assert.equal(broken.code, 1);
  assert.match(broken.stderr, /config\.yaml is not valid YAML/);
  assert.doesNotMatch(broken.stderr, /super-secret-text/);

  // The old example block, switched off, is fine; so is no file at all.
  fs.writeFileSync(file, yaml.dump({ api: { authEnabled: false, apiKey: '' } }));
  assert.equal(runCheck().code, 0);
  fs.unlinkSync(file);
  assert.match(runCheck().stdout, /^OK: there is no /);
  assert.equal(before.length > 0, true);
});

test('the set-* commands work on a live config that still has the old api block, and change only auth', async t => {
  const old = { api: { authEnabled: true, apiKey: 'old-key-0123456789' }, scripts: [{ name: 'Keep', type: 'forever', command: 'echo hi' }] };
  const { read } = withConfig(t, old);
  const terminal = () => ({ stdin: { isTTY: true }, stdout: fakeTerminal(), stderr: fakeTerminal(), confirm: async () => true });
  assert.equal(await setApiKey.main(terminal()), 0);
  assert.equal(await setDashboardPassword.main({ prompt: async () => 'a long enough password', stdout: fakeTerminal(), stderr: fakeTerminal() }), 0);
  const after = read();
  assert.deepEqual(after.api, old.api, 'the old block is left exactly as it was for the running version');
  assert.deepEqual(after.scripts, old.scripts);
  assert.deepEqual(Object.keys(after.auth).sort(), ['apiKey', 'dashboardPasswordHash']);
  assert.equal(after.auth.required, undefined, 'turning it on is a separate step');
});

test('the set-* commands re-read the file just before writing, so a change made while they waited is kept', async t => {
  const { file, read } = withConfig(t, { scripts: [] });
  const addScript = () => fs.writeFileSync(file, yaml.dump({ ...read(), scripts: [{ name: 'AddedMeanwhile' }] }));
  assert.equal(await setApiKey.main({ stdin: { isTTY: true }, stdout: fakeTerminal(), stderr: fakeTerminal(), confirm: async () => true }), 0);
  const calls = [];
  const prompt = async () => { calls.push(1); if (calls.length === 2) addScript(); return 'a long enough password'; };
  assert.equal(await setDashboardPassword.main({ prompt, stdout: fakeTerminal(), stderr: fakeTerminal() }), 0);
  assert.equal(read().scripts[0].name, 'AddedMeanwhile');
  assert.ok(read().auth.apiKey && read().auth.dashboardPasswordHash);
});

test('the set-* commands never replace a config.yaml they cannot read', async t => {
  const { file } = withConfig(t);
  fs.writeFileSync(file, 'scripts: [unclosed\n');
  await assert.rejects(setApiKey.main({ stdin: { isTTY: true }, stdout: fakeTerminal(), stderr: fakeTerminal() }), /not valid YAML/);
  await assert.rejects(setDashboardPassword.main({ prompt: async () => 'a long enough password', stdout: fakeTerminal(), stderr: fakeTerminal() }), /not valid YAML/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'scripts: [unclosed\n');
});

// ---------------------------------------------------------------------------
// Unreadable config on write paths, shared defaults
// ---------------------------------------------------------------------------

test('a request that would write config.yaml fails with a 500 when the file cannot be read, and leaves it alone', async t => {
  const { base, file } = await boot(t, { scripts: [job('Alpha')] });
  t.mock.method(console, 'error', () => {});
  assert.equal((await request(base, 'GET', '/scripts')).status, 200); // the security settings have been read once
  fs.writeFileSync(file, 'scripts: [unclosed secret-text\n');
  const results = [
    await request(base, 'POST', '/settings', { form: { retentionDays: '5' } }),
    await request(base, 'POST', '/add-script', { form: { name: 'New', type: 'forever', command: 'echo hi' } }),
    await request(base, 'POST', '/delete-script/Alpha'),
    await request(base, 'POST', '/api/add-script', { json: { name: 'New', type: 'forever', command: 'echo hi' } }),
    await request(base, 'POST', '/api/delete-script/Alpha'),
    await request(base, 'POST', '/stop-script/Alpha'),
  ];
  for (const res of results) {
    assert.equal(res.status, 500);
    assert.match(res.text, /config\.yaml is not valid YAML/);
    assert.doesNotMatch(res.text, /secret-text/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'scripts: [unclosed secret-text\n');
});

test('the defaults are never shared: changing a loaded config does not change the next one', t => {
  const { file } = withConfig(t);
  const configHandler = require('../utils/configHandler');
  for (const load of [configHandler.loadConfig, configHandler.loadConfigStrict]) {
    fs.rmSync(file, { force: true });
    const first = load();
    first.scripts.push({ name: 'Leak' });
    first.logManagement.autoDelete = true;
    first.server.port = 1;
    const second = load();
    assert.deepEqual(second.scripts, []);
    assert.equal(second.logManagement.autoDelete, false);
    assert.equal(second.server.port, 3000);
  }
});

// ---------------------------------------------------------------------------
// Throttles, limits, odd paths
// ---------------------------------------------------------------------------

test('the same wrong password sent again and again is limited too, at a higher count', async t => {
  let clock = 1_000_000;
  const { base } = await boot(t, { extra: AUTH, securityOptions: { now: () => clock } });
  const wrong = () => request(base, 'POST', '/login', { headers: { origin: base }, form: { password: 'the-same-wrong-password' } });
  for (let i = 0; i < 15; i += 1) assert.equal((await wrong()).status, 401, `repeat ${i + 1}`);
  const statuses = [];
  for (let i = 0; i < 10; i += 1) statuses.push((await wrong()).status);
  assert.ok(statuses.includes(429), statuses.join());
  // During the pause not even the right password is checked.
  assert.equal((await request(base, 'POST', '/login', { headers: { origin: base }, form: { password: PASSWORD } })).status, 429);
  clock += 40_000;
  assert.equal((await request(base, 'POST', '/login', { headers: { origin: base }, form: { password: PASSWORD } })).status, 302);
});

test('only a few password checks run at once; the rest get 429 without being checked', async t => {
  let running = 0;
  let peak = 0;
  const verify = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 80));
    running -= 1;
    return false;
  };
  const { base } = await boot(t, { extra: AUTH, securityOptions: { verify, freeFailures: Infinity } });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    request(base, 'POST', '/login', { headers: { origin: base }, form: { password: `wrong-${i}` } })));
  const statuses = results.map(r => r.status).sort();
  assert.deepEqual(statuses, [401, 401, 429, 429, 429, 429]);
  assert.equal(peak, 2);
  assert.equal(results.find(r => r.status === 429).headers['retry-after'], '1');
});

test('an API key must be printable characters without spaces, and the same text is what gets compared', () => {
  const problems = apiKey => listenProblems({ server: { host: '127.0.0.1' }, auth: { ...AUTH.auth, apiKey } });
  assert.deepEqual(problems(KEY), []);
  assert.match(problems(` ${KEY}`)[0], /auth\.apiKey/);
  assert.match(problems(`${KEY} `)[0], /auth\.apiKey/);
  assert.match(problems('a'.repeat(16) + ' ' + 'a'.repeat(16))[0], /auth\.apiKey/);
  assert.match(problems(' '.repeat(40))[0], /auth\.apiKey/);
  assert.match(problems(`${KEY}é`)[0], /auth\.apiKey/);
});

test('a hash with cost numbers that are not plain digits is refused', async () => {
  const good = await hashPassword('correct horse battery', { N: 1024, r: 8, p: 1 });
  assert.notEqual(parseHash(good), null);
  for (const [from, to] of [['$1024$', '$0x400$'], ['$1024$', '$1e3$'], ['$1024$', '$ 1024$'], ['$1024$', '$+1024$'], ['$1024$', '$1024.0$']]) {
    assert.equal(parseHash(good.replace(from, to)), null, to);
  }
});

test('HEAD, OPTIONS and a trailing slash do not get around the check on /api', async t => {
  const { base } = await boot(t, { scripts: [job('Alpha')], extra: AUTH });
  for (const method of ['HEAD', 'OPTIONS']) {
    assert.equal((await request(base, method, '/api/scripts')).status, 401, `${method} /api`);
    assert.equal((await request(base, method, '/scripts')).status, 401, `${method} dashboard`);
  }
  assert.equal((await request(base, 'GET', '/api/scripts/')).status, 401);
  assert.equal((await request(base, 'GET', '/api/')).status, 401);
  assert.equal((await request(base, 'GET', '/api')).status, 401);
  assert.equal((await request(base, 'GET', '/api/scripts/', { headers: withKey() })).status, 200);
});
