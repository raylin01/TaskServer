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
