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

test('a session cookie from another key, or an altered one, is not accepted; the session is not an API key', async t => {
  const { base, write, config } = await boot(t, { scripts: forever(), extra: AUTH });
  const cookie = await signIn(base);
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie } })).status, 200);
  const [name, value] = cookie.split('=');
  const [expires, sig] = value.split('.');
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie: `${name}=${Number(expires) + 1}.${sig}` } })).status, 401, 'longer lifetime');
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie: `${name}=${expires}.${sig.replace(/.$/, c => (c === '0' ? '1' : '0'))}` } })).status, 401, 'altered');
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie: `${name}=${Date.now() - 1000}.${sig}` } })).status, 401, 'expired');
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { 'x-api-key': value } })).status, 401);
  // A new key ends every session.
  write({ ...config, api: { authEnabled: true, apiKey: 'a-different-key-9876' } });
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: { cookie } })).status, 401);
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
  assert.deepEqual(listenProblems(config({ host: '127.0.0.1' })), []);
  assert.deepEqual(listenProblems(config({ host: 'localhost' })), []);
  assert.deepEqual(listenProblems(config({ host: '::1' })), []);
  assert.deepEqual(listenProblems(config({ host: '127.0.0.1' }, { api: { authEnabled: true, apiKey: KEY } })), []);

  assert.match(listenProblems(config({ host: '0.0.0.0' }))[0], /not a loopback address.*api\.authEnabled/);
  assert.match(listenProblems(config({ host: '192.168.1.20' }, { api: { authEnabled: false, apiKey: KEY } }))[0], /loopback/);
  assert.match(listenProblems(config({ host: '127.0.0.1' }, { cloudflare: { enabled: true, tunnelToken: 'x' } }))[0], /Cloudflare Tunnel is enabled/);
  assert.equal(listenProblems(config({ host: '0.0.0.0' }, { cloudflare: { enabled: true } })).length, 1);
  assert.deepEqual(listenProblems(config({ host: '0.0.0.0' }, { api: { authEnabled: true, apiKey: KEY }, cloudflare: { enabled: true } })), []);

  assert.match(listenProblems(config({ host: '127.0.0.1' }, { api: { authEnabled: true, apiKey: '' } }))[0], /apiKey is empty/);
  assert.match(listenProblems(config({ host: '127.0.0.1' }, { api: { authEnabled: true, apiKey: '   ' } }))[0], /apiKey is empty/);
  assert.equal(listenProblems(config({ host: '0.0.0.0' }, { api: { authEnabled: true } })).length, 2);
  assert.equal(listenProblems(config({ host: '0.0.0.0' }, { api: { authEnabled: 'yes', apiKey: KEY } })).length, 1, 'only true turns it on');
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
  assert.doesNotMatch(exposed.stdout, /TaskServer running/);

  const tunnel = start('cloudflare:\n  enabled: true\n  tunnelToken: tunnel-secret-value\n');
  assert.equal(tunnel.status, 1);
  assert.match(tunnel.stderr, /Cloudflare Tunnel is enabled/);
  assert.doesNotMatch(tunnel.stderr + tunnel.stdout, /tunnel-secret-value/);

  const broken = start('api:\n  apiKey: super-secret-value\n  bad: [unclosed\n');
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /Refusing to start: config\.yaml is not valid YAML: .* at line \d+, column \d+/);
  assert.doesNotMatch(broken.stderr + broken.stdout, /super-secret-value|unclosed/);
});
