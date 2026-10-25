const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const router = require('../routes/scripts');
const { boot, request, job } = require('../test-support/httpApp');
const { listenProblems, localPath } = require('../utils/security');

const KEY = 'example-key-0123456789';
const AUTH = { api: { authEnabled: true, apiKey: KEY } };
const withKey = (extra = {}) => ({ 'x-api-key': KEY, ...extra });
const EVIL = 'http://evil.example';

const forever = () => [job('Example Worker')];

// The token a dashboard page carries for its forms.
async function pageToken(base, headers = {}) {
  const page = await request(base, 'GET', '/add-script', { headers });
  return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
}

// Signs in and returns the cookie to send back.
async function signIn(base) {
  const res = await request(base, 'POST', '/login', { form: { apiKey: KEY, next: '/scripts' } });
  assert.equal(res.status, 302);
  return res.headers['set-cookie'][0].split(';')[0];
}

// ---------------------------------------------------------------------------
// Cross-site requests
// ---------------------------------------------------------------------------

test('a form post from another site cannot add or run a command (authentication off)', async t => {
  const { base, saved, pm2 } = await boot(t);
  const form = { name: 'Injected', type: 'forever', command: 'touch /tmp/should-not-exist', sourceType: 'command' };
  for (const headers of [
    { origin: EVIL },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: EVIL, 'sec-fetch-site': 'cross-site' },
  ]) {
    const res = await request(base, 'POST', '/add-script', { headers, form });
    assert.equal(res.status, 403, JSON.stringify(headers));
  }
  // The same form from this site's own origin, but without the page's token.
  const noToken = await request(base, 'POST', '/add-script', { headers: { origin: base }, form });
  assert.equal(noToken.status, 403);
  assert.match(noToken.text, /CSRF token/);
  assert.deepEqual(saved().scripts, []);
  assert.deepEqual(pm2.mutations(), []);
});

test('a JSON API call from another site cannot change anything, even as text/plain', async t => {
  const { base, saved, pm2 } = await boot(t, { scripts: forever(), setupPm2: (p, c) => p.add({ name: c.scripts[0].name, script: 'x.js', cwd: os.tmpdir() }) });
  const body = JSON.stringify({ name: 'Injected', type: 'forever', command: 'echo hi' });
  for (const headers of [{ origin: EVIL, 'content-type': 'text/plain' }, { origin: EVIL, 'content-type': 'application/json' }]) {
    const add = await request(base, 'POST', '/api/add-script', { headers, raw: body });
    assert.equal(add.status, 403);
    assert.equal((await request(base, 'POST', '/api/stop-script/Example%20Worker', { headers: { origin: EVIL } })).status, 403);
    assert.equal((await request(base, 'POST', '/stop-script/Example%20Worker', { headers: { origin: EVIL } })).status, 403);
    assert.equal((await request(base, 'POST', '/delete-script/Example%20Worker', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await request(base, 'DELETE', '/api/logs/Example%20Worker/delete?file=x', { headers: { origin: EVIL } })).status, 403);
  }
  assert.equal(saved().scripts.length, 1);
  assert.deepEqual(pm2.mutations(), []);
});

test('the dashboard\'s own forms work: same origin with the page\'s token (authentication off)', async t => {
  const { base, saved } = await boot(t);
  const token = await pageToken(base);
  const res = await request(base, 'POST', '/add-script', {
    headers: { origin: base, 'sec-fetch-site': 'same-origin' },
    form: { _csrf: token, name: 'Added', type: 'forever', command: 'echo hi', sourceType: 'command' },
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/scripts');
  assert.equal(saved().scripts[0].name, 'Added');
  const wrong = await request(base, 'POST', '/add-script', { headers: { origin: base }, form: { _csrf: 'nope', name: 'Again', type: 'forever', command: 'x' } });
  assert.equal(wrong.status, 403);
});

test('a program that sends no Origin and no cookie (not a browser) still works when authentication is off', async t => {
  const { base, saved } = await boot(t);
  const res = await request(base, 'POST', '/api/add-script', { json: { name: 'FromScript', type: 'forever', command: 'echo hi', autoStart: false } });
  assert.equal(res.status, 200);
  assert.equal(saved().scripts[0].name, 'FromScript');
});

// ---------------------------------------------------------------------------
// API key clients
// ---------------------------------------------------------------------------

test('API key clients without an Origin keep working: restart, start, stop, list and add', async t => {
  const { base, pm2, saved } = await boot(t, {
    scripts: forever(),
    extra: AUTH,
    setupPm2: (p, c) => { p.add({ name: 'taskserver', script: 'server.js', cwd: os.tmpdir() }); p.add({ name: c.scripts[0].name, script: 'x.js', cwd: os.tmpdir() }); },
  });
  // GitSync: a bodiless POST with only the key header.
  const self = await request(base, 'POST', '/api/restart-script/taskserver', { headers: withKey() });
  assert.equal(self.status, 200);
  assert.equal(self.json().success, true);
  const restart = await request(base, 'POST', '/api/restart-script/Example%20Worker', { headers: withKey() });
  assert.equal(restart.status, 200);

  const list = await request(base, 'GET', '/api/scripts', { headers: withKey() });
  assert.equal(list.status, 200);
  assert.equal(list.json().scripts[0].name, 'Example Worker');

  assert.equal((await request(base, 'POST', '/api/stop-script/Example%20Worker', { headers: withKey() })).status, 200);
  assert.equal((await request(base, 'POST', '/api/start-script/Example%20Worker', { headers: withKey() })).status, 200);
  const add = await request(base, 'POST', '/api/add-script', { headers: withKey(), json: { name: 'Added', type: 'cron', schedule: '0 * * * *', command: 'echo hi' } });
  assert.equal(add.status, 200);
  assert.equal(saved().scripts.at(-1).name, 'Added');
  assert.ok(pm2.mutations().length > 0);
});

test('the API key is only accepted in the X-API-Key header, compared exactly', async t => {
  const { base, pm2 } = await boot(t, { scripts: forever(), extra: AUTH });
  assert.equal((await request(base, 'GET', `/api/scripts?apiKey=${KEY}`)).status, 401, 'not in a URL');
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': `${KEY}x` } })).status, 401);
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': KEY.slice(0, -1) } })).status, 401);
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': '' } })).status, 401);
  assert.equal((await request(base, 'POST', `/api/stop-script/Example%20Worker?apiKey=${KEY}`)).status, 401);
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 200);
  assert.deepEqual(pm2.mutations(), []);
});

test('the key and a bad key give the same plain 401 body, with no hint about the config', async t => {
  const { base } = await boot(t, { extra: AUTH });
  const res = await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': 'wrong' } });
  assert.equal(res.status, 401);
  assert.deepEqual(res.json(), { error: 'Unauthorized', message: 'Valid API key required' });
});

test('API routes take JSON only: a form body or text/plain is refused with 415', async t => {
  const { base, saved } = await boot(t, { extra: AUTH });
  const form = await request(base, 'POST', '/api/add-script', { headers: withKey(), form: { name: 'X', type: 'forever', command: 'echo hi' } });
  assert.equal(form.status, 415);
  const plain = await request(base, 'POST', '/api/add-script', { headers: withKey({ 'content-type': 'text/plain' }), raw: '{"name":"X"}' });
  assert.equal(plain.status, 415);
  assert.deepEqual(saved().scripts, []);
});

// ---------------------------------------------------------------------------
// One check for every route
// ---------------------------------------------------------------------------

function concretePath(routePath) {
  return routePath.replace(/:[A-Za-z]+/g, 'Example%20Worker');
}

const routes = () => router.stack.filter(layer => layer.route).flatMap(layer =>
  Object.keys(layer.route.methods).map(method => ({ method: method.toUpperCase(), path: layer.route.path })));

test('with authentication on, every route refuses a request without the key, and changes nothing', async t => {
  const app = await boot(t, { scripts: [job('Example Worker'), job('Example Cron', { type: 'cron', schedule: '0 * * * *' })], extra: AUTH,
    securityOptions: { freeFailures: Infinity },
    setupPm2: (p, c) => p.add({ name: c.scripts[0].name, script: 'x.js', cwd: os.tmpdir() }) });
  const { base, pm2, saved } = app;
  const before = fs.readFileSync(app.file, 'utf8');
  fs.writeFileSync(path.join(app.logsDir, 'Example Worker-out-1.log'), 'log\n');

  const all = routes();
  assert.ok(all.length >= 25, `found ${all.length} routes`);
  const unauthenticated = [{}, { 'x-api-key': 'wrong' }, { cookie: 'taskserver_session=1.abcd' }, { origin: base, 'sec-fetch-site': 'same-origin' }];
  for (const headers of unauthenticated) {
    for (const { method, path: routePath } of all) {
      const url = concretePath(routePath) + (routePath.includes('logs') ? '?file=Example%20Worker-out-1.log' : '');
      const res = await request(base, method, url, { headers, json: method === 'POST' ? { name: 'X', type: 'forever', command: 'echo hi' } : undefined });
      assert.equal(res.status, 401, `${method} ${routePath} ${JSON.stringify(headers)} -> ${res.status}`);
      assert.deepEqual(res.json(), { error: 'Unauthorized', message: 'Valid API key required' });
    }
  }
  // Paths that match no route are refused too, not answered with a 404.
  assert.equal((await request(base, 'GET', '/nothing-here')).status, 401);
  assert.equal((await request(base, 'POST', '/nothing-here')).status, 401);
  assert.equal(fs.readFileSync(app.file, 'utf8'), before);
  assert.deepEqual(pm2.mutations(), []);
  assert.equal(saved().scripts.length, 2);
  assert.ok(fs.existsSync(path.join(app.logsDir, 'Example Worker-out-1.log')));
});

test('with the key, the same routes answer (none is left out by accident)', async t => {
  const { base } = await boot(t, { scripts: forever(), extra: AUTH });
  for (const { method, path: routePath } of routes().filter(r => r.method === 'GET')) {
    if (routePath.includes('logs') || routePath === '/') continue;
    const res = await request(base, method, concretePath(routePath), { headers: withKey({ accept: 'application/json' }) });
    assert.notEqual(res.status, 401, `${method} ${routePath}`);
  }
});

test('only the login page and the static files are open; browsers are sent to sign in', async t => {
  const { base } = await boot(t, { scripts: forever(), extra: AUTH });
  assert.equal((await request(base, 'GET', '/login')).status, 200);
  for (const file of fs.readdirSync(path.join(__dirname, '../public'))) {
    assert.equal((await request(base, 'GET', `/${file}`)).status, 200, file);
  }
  const page = await request(base, 'GET', '/scripts?x=1', { headers: { accept: 'text/html,application/xhtml+xml' } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, `/login?next=${encodeURIComponent('/scripts?x=1')}`);
  // A program asking for JSON gets a 401, not a redirect.
  assert.equal((await request(base, 'GET', '/scripts', { headers: { accept: 'application/json' } })).status, 401);
});

test('with authentication off nothing asks for a key', async t => {
  const { base } = await boot(t, { scripts: forever() });
  assert.equal((await request(base, 'GET', '/scripts')).status, 200);
  assert.equal((await request(base, 'GET', '/api/scripts')).status, 200);
  assert.equal((await request(base, 'GET', '/login', {})).status, 302);
});

// ---------------------------------------------------------------------------
// Dashboard sign-in
// ---------------------------------------------------------------------------

test('the dashboard works behind the key: sign in, use a form with its token, sign out', async t => {
  const { base, saved, logsDir } = await boot(t, { scripts: forever(), extra: AUTH });
  const wrong = await request(base, 'POST', '/login', { form: { apiKey: 'wrong', next: '/scripts' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  assert.match(wrong.text, /not correct/);
  assert.doesNotMatch(wrong.text, new RegExp(KEY));

  const login = await request(base, 'POST', '/login', { headers: { origin: base }, form: { apiKey: KEY, next: '/settings' } });
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, '/settings');
  const cookieHeader = login.headers['set-cookie'][0];
  assert.match(cookieHeader, /^taskserver_session=/);
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  assert.doesNotMatch(cookieHeader, /Secure/, 'plain http');
  assert.doesNotMatch(cookieHeader, new RegExp(KEY));
  const cookie = cookieHeader.split(';')[0];

  assert.equal((await request(base, 'GET', '/scripts', { headers: { cookie } })).status, 200);
  const token = await pageToken(base, { cookie });

  // A form post needs this site's origin and the token, on top of the cookie.
  const form = { name: 'Added', type: 'forever', command: 'echo hi', sourceType: 'command' };
  assert.equal((await request(base, 'POST', '/add-script', { headers: { cookie } , form })).status, 403, 'cookie alone');
  assert.equal((await request(base, 'POST', '/add-script', { headers: { cookie, origin: base }, form })).status, 403, 'no token');
  assert.equal((await request(base, 'POST', '/add-script', { headers: { cookie, origin: EVIL }, form: { ...form, _csrf: token } })).status, 403, 'other site');
  assert.equal((await request(base, 'POST', '/add-script', { headers: { cookie, origin: base }, form: { ...form, _csrf: 'forged' } })).status, 403, 'wrong token');
  assert.equal(saved().scripts.length, 1);
  const ok = await request(base, 'POST', '/add-script', { headers: { cookie, origin: base }, form: { ...form, _csrf: token } });
  assert.equal(ok.status, 302);
  assert.equal(saved().scripts.length, 2);

  // The log delete button sends the token in a header.
  fs.writeFileSync(path.join(logsDir, 'Example Worker-out-1.log'), 'x');
  const del = (headers) => request(base, 'DELETE', '/api/logs/Example%20Worker/delete?file=Example%20Worker-out-1.log', { headers: { cookie, origin: base, ...headers } });
  assert.equal((await del({})).status, 403);
  assert.equal((await del({ 'x-csrf-token': token })).status, 200);

  const out = await request(base, 'POST', '/logout', { headers: { cookie, origin: base }, form: { _csrf: token } });
  assert.equal(out.status, 302);
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
});

test('a made-up, expired or foreign session cookie is not accepted; the session is not an API key', async t => {
  let clock = Date.now();
  const { base, write, config } = await boot(t, { scripts: forever(), extra: AUTH, securityOptions: { now: () => clock } });
  const cookie = await signIn(base);
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie } })).status, 200);
  const [name, value] = cookie.split('=');
  assert.equal(value.length, 43, 'a random 256-bit id');
  assert.doesNotMatch(value, /\./, 'no expiry or signature to forge');
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie: `${name}=${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}` } })).status, 401, 'altered');
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie: `${name}=${'A'.repeat(43)}` } })).status, 401, 'made up');
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': value } })).status, 401);
  // A new key ends every session.
  write({ ...config, api: { authEnabled: true, apiKey: 'a-different-key-9876' } });
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie } })).status, 401);
  write({ ...config, ...AUTH });
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie } })).status, 200, 'the old key again: the same session');
  clock += 8 * 24 * 60 * 60 * 1000;
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie } })).status, 401, 'expired after 7 days');
});

test('signing out ends the session on the server: a copy of the cookie stops working', async t => {
  const { base } = await boot(t, { scripts: forever(), extra: AUTH });
  const cookie = await signIn(base);
  const copy = `${cookie}`;
  const token = await pageToken(base, { cookie });
  assert.equal((await request(base, 'GET', '/scripts', { headers: { cookie: copy } })).status, 200);
  assert.equal((await request(base, 'POST', '/logout', { headers: { cookie, origin: base }, form: { _csrf: token } })).status, 302);
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie: copy } })).status, 401);
  assert.equal((await request(base, 'GET', '/scripts', { headers: { cookie: copy, accept: 'text/html' } })).status, 302);
  // Another sign-in is a different session.
  const second = await signIn(base);
  assert.notEqual(second, cookie);
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie: second } })).status, 200);
});

test('the cookie and the CSRF token are not derived from the API key', async t => {
  const first = await boot(t, { extra: AUTH });
  const second = await boot(t, { extra: AUTH });
  const [a, b] = [await signIn(first.base), await signIn(second.base)];
  assert.notEqual(a.split('=')[1], b.split('=')[1]);
  assert.notEqual(await pageToken(first.base, { cookie: a }), await pageToken(second.base, { cookie: b }));
  assert.doesNotMatch(a, /^[^=]+=[0-9]+\./, 'not an expiry plus a signature of the key');
});

test('the sign-in page only sends you on to a path of this site', async t => {
  const { base } = await boot(t, { extra: AUTH });
  for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)', '']) {
    const res = await request(base, 'POST', '/login', { form: { apiKey: KEY, next } });
    assert.equal(res.headers.location, '/scripts', JSON.stringify(next));
  }
  assert.equal(localPath('/edit-script/A%20B?x=1'), '/edit-script/A%20B?x=1');
  const crossSite = await request(base, 'POST', '/login', { headers: { origin: EVIL }, form: { apiKey: KEY } });
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.headers['set-cookie'], undefined);
});

test('the secure flag is set on the session cookie when the request came over https', async t => {
  const { base } = await boot(t, { extra: AUTH });
  const res = await request(base, 'POST', '/login', { headers: { 'x-forwarded-proto': 'https' }, form: { apiKey: KEY } });
  assert.match(res.headers['set-cookie'][0], /; Secure/);
});

// ---------------------------------------------------------------------------
// Host names, headers, unreadable config
// ---------------------------------------------------------------------------

test('with authentication off only loopback host names are served (DNS rebinding)', async t => {
  const { base } = await boot(t, { scripts: forever(), extra: { server: { allowedHosts: ['dash.example.test'] } } });
  const port = new URL(base).port;
  for (const host of ['evil.example', `evil.example:${port}`, '192.168.1.5', 'localhost.evil.example']) {
    const res = await request(base, 'GET', '/scripts', { headers: { host } });
    assert.equal(res.status, 403, JSON.stringify(host));
    assert.equal(res.text, 'Host not allowed');
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'localhost', `[::1]:${port}`, 'dash.example.test', 'DASH.example.test:8080']) {
    assert.equal((await request(base, 'GET', '/scripts', { headers: { host } })).status, 200, host);
  }
});

test('every response carries the security headers, and the policy allows no inline script', async t => {
  const { base } = await boot(t, { scripts: forever() });
  for (const url of ['/scripts', '/styles.css', '/api/scripts', '/login']) {
    const res = await request(base, 'GET', url);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /script-src 'self'(;|$)/, url);
    assert.doesNotMatch(csp.match(/script-src [^;]*/)[0], /unsafe/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
  }
});

test('an unreadable config.yaml does not switch authentication off', async t => {
  const { base, file } = await boot(t, { scripts: forever(), extra: AUTH });
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 200);
  fs.writeFileSync(file, 'scripts: [\n  api: {{{ not yaml');
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  t.after(() => { console.error = original; });
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': 'wrong' } })).status, 401, 'still protected');
  assert.equal((await request(base, 'GET', '/scripts')).status, 401);
  console.error = original;
  assert.ok(lines.some(l => l.includes('[Security]') && l.includes('keeping the last good')));
  assert.ok(lines.every(l => !l.includes('not yaml')), 'the bad text is not logged');
});

test('a config.yaml that was never readable refuses every request', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-badconfig-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'api: [');
  process.env.TASKSERVER_CONFIG = path.join(dir, 'config.yaml');
  t.after(() => { delete process.env.TASKSERVER_CONFIG; });
  const { createApp } = require('../server');
  const { createFakePm2 } = require('../test-support/fakePm2');
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  const app = createApp({ processService: createFakePm2() });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await request(base, 'GET', '/api/scripts')).status, 401);
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': '' } })).status, 401);
});

test('an empty api key never matches, even when authentication is on', async t => {
  const { base } = await boot(t, { extra: { api: { authEnabled: true, apiKey: '' } } });
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': '' } })).status, 401);
  assert.equal((await request(base, 'POST', '/login', { form: { apiKey: '' } })).status, 401);
});

// ---------------------------------------------------------------------------
// Refusing to start
// ---------------------------------------------------------------------------

test('TaskServer refuses to start when it is reachable from other machines without a key', () => {
  const config = (server, extra = {}) => ({ server, ...extra });
  const AUTH_ON = { api: { authEnabled: true, apiKey: KEY } };
  assert.deepEqual(listenProblems(config({ host: '127.0.0.1' })), []);
  assert.deepEqual(listenProblems(config({ host: 'localhost' })), []);
  assert.deepEqual(listenProblems(config({ host: '::1' })), []);
  assert.deepEqual(listenProblems(config({ host: '127.0.0.1' }, AUTH_ON)), []);

  assert.match(listenProblems(config({ host: '0.0.0.0' }))[0], /server\.host is 0\.0\.0\.0, not a loopback address.*api\.authEnabled/);
  assert.match(listenProblems(config({ host: '192.168.1.20' }, { api: { authEnabled: false, apiKey: KEY } }))[0], /server\.host/);
  assert.match(listenProblems(config({ host: '127.0.0.1' }, { cloudflare: { enabled: true, tunnelToken: 'x' } }))[0], /cloudflare\.enabled is true/);
  assert.equal(listenProblems(config({ host: '0.0.0.0' }, { cloudflare: { enabled: true } })).length, 1);
  assert.deepEqual(listenProblems(config({ host: '0.0.0.0' }, { ...AUTH_ON, cloudflare: { enabled: true } })), []);
});

test('TaskServer refuses to start with auth settings it cannot trust, naming the key', () => {
  const problems = api => listenProblems({ server: { host: '127.0.0.1' }, api });
  assert.match(problems({ authEnabled: true, apiKey: '' })[0], /api\.apiKey .*at least 16 characters/);
  assert.match(problems({ authEnabled: true })[0], /api\.apiKey .*at least 16 characters/);
  assert.match(problems({ authEnabled: true, apiKey: '   ' })[0], /at least 16/);
  assert.match(problems({ authEnabled: true, apiKey: 'fifteen-chars-x' })[0], /at least 16/);
  assert.deepEqual(problems({ authEnabled: true, apiKey: 'sixteen-chars-xxx' }), []);
  // Truthy words used to turn auth on; now they are an error, not "off".
  for (const value of ['true', 'yes', 'on', 1, 'false', null, [], {}]) {
    assert.match(problems({ authEnabled: value, apiKey: KEY })[0], /api\.authEnabled .*must be true or false/, JSON.stringify(value));
  }
  assert.match(problems({ authEnabled: true, apiKey: 1234567890123456 })[0], /api\.apiKey in config\.yaml must be a string/);
  assert.match(problems({ authEnabled: false, apiKey: 12345 })[0], /must be a string/);
  assert.match(problems('on')[0], /api in config\.yaml must be a mapping/);
  assert.match(listenProblems({ server: { host: '127.0.0.1', publicOrigins: ['not an origin'] } })[0], /server\.publicOrigins/);
  assert.match(listenProblems({ server: { host: '127.0.0.1', allowedHosts: 'dash' } })[0], /server\.allowedHosts .*list of strings/);
  assert.doesNotMatch(JSON.stringify(problems({ authEnabled: true, apiKey: 'short' })), /short|\b5\b/, 'neither the key nor its length');
});

test('starting the server with an unsafe or unreadable config exits before it listens or touches PM2', t => {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-start-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const start = text => {
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, text);
    return spawnSync(process.execPath, [path.join(__dirname, '../server.js')], {
      env: { ...process.env, TASKSERVER_CONFIG: file }, encoding: 'utf8', timeout: 15000,
    });
  };
  const exposed = start('server:\n  host: 0.0.0.0\n  port: 0\n');
  assert.equal(exposed.status, 1);
  assert.match(exposed.stderr, /Refusing to start: server\.host is 0\.0\.0\.0, not a loopback address/);
  assert.match(exposed.stderr, /Fix config\.yaml, then run: pm2 restart taskserver/);
  assert.doesNotMatch(exposed.stdout, /TaskServer running/);

  const tunnel = start('cloudflare:\n  enabled: true\n  tunnelToken: tunnel-secret-value\n');
  assert.equal(tunnel.status, 1);
  assert.match(tunnel.stderr, /cloudflare\.enabled is true/);
  assert.doesNotMatch(tunnel.stderr + tunnel.stdout, /tunnel-secret-value/);

  const broken = start('api:\n  apiKey: super-secret-value\n  bad: [unclosed\n');
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /Refusing to start: config\.yaml is not valid YAML: .* at line \d+, column \d+/);
  assert.doesNotMatch(broken.stderr + broken.stdout, /super-secret-value|unclosed/);
});

// ---------------------------------------------------------------------------
// Settings that go bad while running
// ---------------------------------------------------------------------------

test('config.yaml going missing, empty, cut off or odd while running never switches auth off', async t => {
  const { base, file, config, write } = await boot(t, { scripts: forever(), extra: AUTH, securityOptions: { freeFailures: Infinity } });
  const good = fs.readFileSync(file, 'utf8');
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 200);
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  t.after(() => { console.error = original; });

  const bad = {
    'missing': () => fs.unlinkSync(file),
    'empty': () => fs.writeFileSync(file, ''),
    'only a comment': () => fs.writeFileSync(file, '# nothing\n'),
    'cut off before the api section': () => fs.writeFileSync(file, good.slice(0, good.indexOf('api:'))),
    'cut off inside the api section': () => fs.writeFileSync(file, good.slice(0, good.indexOf('apiKey:') + 'apiKey: examp'.length)),
    'cut off in the middle of a word': () => fs.writeFileSync(file, `${good.slice(0, good.indexOf('authEnabled:'))}authEnabled: tr`),
    'a list': () => fs.writeFileSync(file, '- a\n- b\n'),
    'a plain word': () => fs.writeFileSync(file, 'hello\n'),
    'auth switched to a word': () => write({ ...config, api: { authEnabled: 'true', apiKey: KEY } }),
    'auth switched to a number': () => write({ ...config, api: { authEnabled: 1, apiKey: KEY } }),
    'a key that is a number': () => write({ ...config, api: { authEnabled: true, apiKey: 1234567890123456 } }),
    'a key that is too short': () => write({ ...config, api: { authEnabled: true, apiKey: 'short' } }),
    'api section not a mapping': () => write({ ...config, api: 'on' }),
    'broken yaml': () => fs.writeFileSync(file, 'api: {{{'),
  };
  for (const [what, damage] of Object.entries(bad)) {
    damage();
    assert.equal((await request(base, 'GET', '/api/scripts')).status, 401, `${what}: no key`);
    assert.equal((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': 'wrong' } })).status, 401, `${what}: wrong key`);
    assert.equal((await request(base, 'GET', '/scripts')).status, 401, `${what}: dashboard`);
    assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 200, `${what}: the key still works`);
    fs.writeFileSync(file, good);
  }
  assert.ok(logged.some(l => l.includes('[Security]') && l.includes('keeping the last good')));
  const text = logged.join('\n');
  assert.doesNotMatch(text, new RegExp(KEY));
  assert.doesNotMatch(text, /examp|short|hello/);
});

test('only the first read of settings may fall back to "no authentication" (no config.yaml yet)', async t => {
  const { base, file } = await boot(t, { scripts: forever() });
  fs.unlinkSync(file);
  assert.equal((await request(base, 'GET', '/api/scripts')).status, 200, 'first read, nothing to keep');
});

test('a change that really turns auth on or rotates the key is still picked up', async t => {
  const { base, write, config } = await boot(t, { scripts: forever() });
  assert.equal((await request(base, 'GET', '/api/scripts')).status, 200);
  write({ ...config, ...AUTH });
  assert.equal((await request(base, 'GET', '/api/scripts')).status, 401);
  write({ ...config, api: { authEnabled: true, apiKey: 'rotated-key-0123456789' } });
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 401);
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': 'rotated-key-0123456789' } })).status, 200);
});

test('config.yaml is replaced atomically: temp file in the same folder, flushed, then renamed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-write-'));
  t.after(() => { delete process.env.TASKSERVER_CONFIG; fs.rmSync(dir, { recursive: true, force: true }); });
  const target = path.join(dir, 'config.yaml');
  fs.writeFileSync(target, 'scripts: []\n', { mode: 0o600 });
  process.env.TASKSERVER_CONFIG = target;
  const configHandler = require('../utils/configHandler');
  const order = [];
  const realFsync = fs.fsyncSync;
  const realRename = fs.renameSync;
  t.mock.method(fs, 'fsyncSync', fd => { order.push('fsync'); return realFsync(fd); });
  t.mock.method(fs, 'renameSync', (from, to) => {
    order.push('rename');
    assert.equal(path.dirname(from), fs.realpathSync(dir));
    assert.notEqual(from, target);
    assert.equal(fs.realpathSync(path.dirname(to)), fs.realpathSync(dir));
    assert.equal(path.basename(to), 'config.yaml');
    assert.match(fs.readFileSync(from, 'utf8'), /name: Example/, 'complete before it is moved into place');
    return realRename(from, to);
  });
  configHandler.writeConfig({ scripts: [{ name: 'Example', type: 'forever', command: 'echo hi' }] });
  assert.deepEqual(order, ['fsync', 'rename', 'fsync'], 'file flushed, renamed, then the folder flushed');
  assert.match(fs.readFileSync(target, 'utf8'), /name: Example/);
  assert.deepEqual(fs.readdirSync(dir), ['config.yaml'], 'no temporary file is left');
  if (process.platform !== 'win32') assert.equal(fs.statSync(target).mode & 0o777, 0o600, 'the mode is kept');
});

test('a failed write is an error, leaves the old config.yaml alone and no temporary file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-write-'));
  t.after(() => { delete process.env.TASKSERVER_CONFIG; fs.rmSync(dir, { recursive: true, force: true }); });
  const target = path.join(dir, 'config.yaml');
  fs.writeFileSync(target, 'scripts: []\n');
  process.env.TASKSERVER_CONFIG = target;
  const configHandler = require('../utils/configHandler');
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk says no'); });
  t.mock.method(console, 'error', () => {});
  assert.throws(() => configHandler.writeConfig({ scripts: [{ name: 'Changed' }] }), /Could not write config\.yaml/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'scripts: []\n');
  assert.deepEqual(fs.readdirSync(dir), ['config.yaml']);
});

// ---------------------------------------------------------------------------
// Wrong keys
// ---------------------------------------------------------------------------

test('different wrong keys from one address are slowed down, doubling up to a limit, and forgotten later', async t => {
  let clock = 1_000_000;
  // A configured public origin means a proxy may share the address: the full ladder.
  const { base } = await boot(t, { extra: { ...AUTH, server: { publicOrigins: ['https://dash.example.test'] } }, securityOptions: { now: () => clock } });
  let n = 0;
  const wrong = () => request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': `wrong-key-${n += 1}` } });
  for (let i = 0; i < 5; i += 1) assert.equal((await wrong()).status, 401, `attempt ${i + 1}`);
  const blocked = await wrong();
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['retry-after'], '1');
  assert.deepEqual(blocked.json(), { error: 'Too Many Requests', message: 'Too many wrong keys; wait and try again' });
  // Even the right key waits out the pause: otherwise 429 against 200 would tell a guesser which key is right.
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 429);
  clock += 1001;
  assert.equal((await wrong()).status, 401);
  assert.equal((await wrong()).headers['retry-after'], '2', 'doubled');
  clock += 2001;
  assert.equal((await wrong()).status, 401);
  assert.equal((await wrong()).headers['retry-after'], '4');
  clock += 4001;
  for (let i = 0; i < 6; i += 1) { await wrong(); clock += 31000; }
  clock -= 31000;
  assert.equal((await wrong()).headers['retry-after'], '30', 'never longer than 30 seconds');
  clock += 31000;
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 200, 'the right key works once the pause is over');
  clock += 11 * 60 * 1000;
  for (let i = 0; i < 5; i += 1) assert.equal((await wrong()).status, 401, 'forgotten after ten quiet minutes');
});

test('one stale key sent over and over never locks anyone out', async t => {
  const { base } = await boot(t, { extra: AUTH });
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': 'stale-key-of-a-poller' } })).status, 401, `repeat ${i + 1}`);
  }
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 200);
  assert.equal((await request(base, 'POST', '/login', { form: { apiKey: KEY } })).status, 302);
  for (let i = 0; i < 20; i += 1) assert.equal((await request(base, 'POST', '/login', { form: { apiKey: 'stale-key-of-a-poller' } })).status, 401);
  assert.equal((await request(base, 'POST', '/login', { form: { apiKey: KEY } })).status, 302);
});

test('twenty different wrong keys get 429, and the right key is refused during the pause', async t => {
  const { base } = await boot(t, { extra: AUTH });
  const statuses = [];
  for (let i = 0; i < 20; i += 1) statuses.push((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': `guess-${i}` } })).status);
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
  assert.ok(statuses.slice(5).every(status => status === 429), statuses.join());
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 429);
  // A key already tried also gets the pause, not a different answer.
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': 'guess-0' } })).status, 429);
});

test('on the loopback interface the pause is short (2 s) unless a proxy is configured or announced', async t => {
  let clock = 1_000_000;
  const { base } = await boot(t, { extra: AUTH, securityOptions: { now: () => clock } });
  let n = 0;
  const wrong = headers => request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': `wrong-key-${n += 1}`, ...headers } });
  const pauses = [];
  for (let i = 0; i < 20; i += 1) {
    const res = await wrong();
    if (res.status === 429) { pauses.push(Number(res.headers['retry-after'])); clock += 3000; }
  }
  assert.ok(pauses.length >= 5);
  assert.ok(pauses.every(seconds => seconds <= 2), pauses.join());
  clock += 11 * 60 * 1000;
  // The same address with proxy headers: the full ladder.
  const proxied = [];
  for (let i = 0; i < 14; i += 1) {
    const res = await wrong({ 'x-forwarded-for': '203.0.113.9' });
    if (res.status === 429) { proxied.push(Number(res.headers['retry-after'])); clock += Number(res.headers['retry-after']) * 1000 + 1; }
  }
  assert.ok(proxied.some(seconds => seconds > 2), proxied.join());
});

test('a right key outside a pause starts the count again', async t => {
  let clock = 1_000_000;
  const { base } = await boot(t, { extra: AUTH, securityOptions: { now: () => clock } });
  let n = 0;
  const wrong = () => request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': `wrong-key-${n += 1}` } });
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 4; i += 1) assert.equal((await wrong()).status, 401, `round ${round} wrong ${i + 1}`);
    assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 200);
  }
});

test('the sign-in form is slowed down the same way, and requests without a key count for nothing', async t => {
  let clock = 1_000_000;
  const { base } = await boot(t, { extra: AUTH, securityOptions: { now: () => clock } });
  for (let i = 0; i < 20; i += 1) assert.equal((await request(base, 'GET', '/api/scripts')).status, 401);
  for (let i = 0; i < 5; i += 1) assert.equal((await request(base, 'POST', '/login', { form: { apiKey: `wrong-${i}` } })).status, 401);
  const blocked = await request(base, 'POST', '/login', { form: { apiKey: KEY } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['retry-after'], '1');
  assert.equal(blocked.headers['set-cookie'], undefined);
  assert.match(blocked.text, /Too many wrong keys/);
  assert.doesNotMatch(blocked.text, new RegExp(KEY));
  clock += 1500;
  assert.equal((await request(base, 'POST', '/login', { form: { apiKey: KEY } })).status, 302);
});

test('the table of clients is capped, least recently touched first, and swept at most once a minute', () => {
  const { createThrottle } = require('../utils/security');
  let clock = 1_000_000;
  const throttle = createThrottle(() => clock, 1, { maxClients: 100 });
  for (let i = 0; i < 100; i += 1) throttle.fail(`client-${i}`, 'a');
  assert.equal(throttle.size(), 100);
  throttle.fail('client-0', 'b'); // touched again: now the newest
  throttle.fail('client-new', 'a');
  assert.equal(throttle.size(), 100);
  assert.ok(throttle.wait('client-0') > 0, 'the recently touched client was kept');
  assert.equal(throttle.wait('client-1'), 0, 'the oldest was evicted');
  for (let i = 0; i < 10_000; i += 1) throttle.fail(`flood-${i}`, 'a');
  assert.equal(throttle.size(), 100, 'a flood cannot grow the table');
  // Stale entries are swept, but not on every call.
  clock += 11 * 60 * 1000;
  throttle.fail('fresh', 'a');
  assert.equal(throttle.size(), 1, 'swept after ten quiet minutes');
  const sweeps = [];
  const spy = createThrottle(() => clock, 1, { maxClients: 100 });
  spy.fail('x', 'a');
  clock += 11 * 60 * 1000;
  spy.fail('y', 'a'); // sweeps x
  sweeps.push(spy.size());
  clock += 12 * 60 * 1000;
  spy.fail('z', 'a'); clock += 1000; spy.fail('w', 'a');
  sweeps.push(spy.size());
  assert.deepEqual(sweeps, [1, 2]);
});

// ---------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------

test('server.publicOrigins adds exact origins to the same-host check; X-Forwarded-Host is not used', async t => {
  const { base } = await boot(t, { scripts: forever(), extra: { ...AUTH, server: { publicOrigins: ['https://dash.example.test'] } } });
  const cookie = await signIn(base);
  const token = await pageToken(base, { cookie });
  const post = headers => request(base, 'POST', '/settings', { headers: { cookie, ...headers }, form: { _csrf: token, retentionDays: '5' } });
  // The proxy rewrote Host, but the page's origin is on the list.
  assert.equal((await post({ origin: 'https://dash.example.test' })).status, 302);
  assert.equal((await post({ origin: 'https://dash.example.test:8443' })).status, 403, 'other port');
  assert.equal((await post({ origin: 'http://dash.example.test' })).status, 403, 'other scheme');
  assert.equal((await post({ origin: 'https://other.example.test' })).status, 403);
  assert.equal((await post({ origin: 'https://dash.example.test.evil.example' })).status, 403);
  assert.equal((await post({ origin: EVIL, 'x-forwarded-host': 'evil.example' })).status, 403);
  assert.equal((await post({ origin: 'https://other.example.test', 'x-forwarded-host': 'other.example.test' })).status, 403);
  assert.equal((await post({ origin: base })).status, 302, 'same host still works');
});

test('Sec-Fetch-Site "none" and a cookie without any Origin do not pass for a state change', async t => {
  const { base, saved } = await boot(t, { scripts: forever(), extra: AUTH });
  const cookie = await signIn(base);
  const token = await pageToken(base, { cookie });
  const form = { _csrf: token, name: 'Added', type: 'forever', command: 'echo hi', sourceType: 'command' };
  assert.equal((await request(base, 'POST', '/add-script', { headers: { cookie }, form })).status, 403, 'cookie, no Origin');
  assert.equal((await request(base, 'POST', '/add-script', { headers: { cookie, 'sec-fetch-site': 'none' }, form })).status, 403);
  assert.equal((await request(base, 'POST', '/add-script', { headers: { cookie, 'sec-fetch-site': 'same-site' }, form })).status, 403);
  assert.equal(saved().scripts.length, 1);
  assert.equal((await request(base, 'POST', '/add-script', { headers: { cookie, 'sec-fetch-site': 'same-origin' }, form })).status, 302, 'same-origin with no Origin header');
});

test('a log delete with a session needs the token header and this site\'s origin', async t => {
  const { base, logsDir } = await boot(t, { scripts: forever(), extra: AUTH });
  const cookie = await signIn(base);
  const token = await pageToken(base, { cookie });
  const file = 'Example%20Worker-out-1.log';
  const url = `/api/logs/Example%20Worker/delete?file=${file}`;
  fs.writeFileSync(path.join(logsDir, 'Example Worker-out-1.log'), 'x');
  assert.equal((await request(base, 'DELETE', url, { headers: { cookie } })).status, 403, 'no Origin, no token');
  assert.equal((await request(base, 'DELETE', url, { headers: { cookie, 'x-csrf-token': token } })).status, 403, 'token but no Origin');
  assert.equal((await request(base, 'DELETE', url, { headers: { cookie, origin: base } })).status, 403, 'Origin but no token');
  assert.equal((await request(base, 'DELETE', url, { headers: { cookie, origin: EVIL, 'x-csrf-token': token } })).status, 403);
  assert.ok(fs.existsSync(path.join(logsDir, 'Example Worker-out-1.log')));
  assert.equal((await request(base, 'DELETE', url, { headers: { cookie, origin: base, 'x-csrf-token': token } })).status, 200);
  assert.equal(fs.existsSync(path.join(logsDir, 'Example Worker-out-1.log')), false);
});

test('the sign-in page does not send you back to itself', async t => {
  const { base } = await boot(t, { extra: AUTH });
  for (const next of ['/login', '/login?next=/scripts', '/login/x']) {
    const res = await request(base, 'POST', '/login', { form: { apiKey: KEY, next } });
    assert.equal(res.headers.location, '/scripts', next);
  }
  assert.equal(localPath('/loginfo'), '/scripts');
});

// ---------------------------------------------------------------------------
// Settings from start-up, and other settings changes
// ---------------------------------------------------------------------------

test('settings checked at start-up are in force from the first request, even if the file is empty by then', async t => {
  const { base, file } = await boot(t, { scripts: forever(), extra: AUTH, seedFromStartup: true });
  fs.writeFileSync(file, '');
  assert.equal((await request(base, 'GET', '/api/scripts')).status, 401);
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 200);
  fs.unlinkSync(file);
  assert.equal((await request(base, 'GET', '/scripts')).status, 401);
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 200);
});

test('an api section that drops authEnabled does not turn authentication off; false does', async t => {
  const { base, write, config } = await boot(t, { scripts: forever(), extra: AUTH });
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 200);
  write({ ...config, api: { apiKey: KEY } });
  assert.equal((await request(base, 'GET', '/api/scripts')).status, 401, 'dropped: the last good settings stay');
  write({ ...config, api: {} });
  assert.equal((await request(base, 'GET', '/api/scripts')).status, 401);
  write({ ...config, api: { authEnabled: false, apiKey: KEY } });
  assert.equal((await request(base, 'GET', '/api/scripts')).status, 200, 'an explicit false is a decision');
});

test('turning authentication off forgets every session, so turning it on again needs a new sign-in', async t => {
  const { base, write, config } = await boot(t, { scripts: forever(), extra: AUTH });
  const cookie = await signIn(base);
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie } })).status, 200);
  write({ ...config, api: { authEnabled: false, apiKey: KEY } });
  assert.equal((await request(base, 'GET', '/api/scripts')).status, 200);
  write({ ...config, ...AUTH });
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie } })).status, 401);
});

test('a failed config write is an error response, not a reported success', async t => {
  const { base, saved } = await boot(t, { scripts: forever() });
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('disk says no'), { code: 'EIO' }); });
  t.mock.method(console, 'error', () => {});
  const res = await request(base, 'POST', '/api/add-script', { json: { name: 'Added', type: 'cron', schedule: '0 * * * *', command: 'echo hi' } });
  assert.equal(res.status, 500);
  assert.match(res.json().error, /Could not write config\.yaml/);
  assert.equal(saved().scripts.length, 1);
});

test('a symbolic link as the config path: the file it points to is replaced, the link stays', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-link-'));
  t.after(() => { delete process.env.TASKSERVER_CONFIG; fs.rmSync(dir, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(dir, 'real'));
  const real = path.join(dir, 'real', 'config.yaml');
  const link = path.join(dir, 'config.yaml');
  fs.writeFileSync(real, 'scripts: []\n');
  fs.symlinkSync(real, link);
  process.env.TASKSERVER_CONFIG = link;
  require('../utils/configHandler').writeConfig({ scripts: [{ name: 'Example' }] });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.match(fs.readFileSync(real, 'utf8'), /name: Example/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'real')), ['config.yaml']);
});
