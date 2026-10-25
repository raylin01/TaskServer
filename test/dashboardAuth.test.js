const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const router = require('../routes/scripts');
const { boot, request, job } = require('../test-support/httpApp');
const { createSecurity, listenProblems, parseSettings } = require('../utils/security');

// api.dashboardAuth: false. The dashboard pages need no key from this machine;
// /api always does.

const KEY = 'example-key-0123456789';
const EVIL = 'http://evil.example';
const DASH = { api: { authEnabled: true, apiKey: KEY, dashboardAuth: false } };
const withKey = (extra = {}) => ({ 'x-api-key': KEY, ...extra });
const HTML = { accept: 'text/html' };
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip'];
const forever = () => [job('Example Worker')];

async function pageToken(base, headers = {}) {
  const page = await request(base, 'GET', '/add-script', { headers });
  return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
}

const routes = () => router.stack.filter(layer => layer.route).flatMap(layer =>
  Object.keys(layer.route.methods).map(method => ({ method: method.toUpperCase(), path: layer.route.path })));
const concretePath = routePath => routePath.replace(/:[A-Za-z]+/g, 'Example%20Worker');

// ---------------------------------------------------------------------------
// The dashboard needs no key
// ---------------------------------------------------------------------------

test('dashboard pages and forms work with no key or session, and show no sign-out', async t => {
  const { base, saved } = await boot(t, { scripts: forever(), extra: DASH });
  assert.equal((await request(base, 'GET', '/', { headers: HTML })).headers.location, '/scripts');
  for (const url of ['/scripts', '/add-script', '/settings', '/edit-script/Example%20Worker', '/logs/Example%20Worker']) {
    const res = await request(base, 'GET', url, { headers: HTML });
    assert.equal(res.status, 200, url);
    assert.doesNotMatch(res.text, /action="\/logout"/, 'nothing to sign out of');
  }
  const token = await pageToken(base);
  const res = await request(base, 'POST', '/add-script', {
    headers: { origin: base, 'sec-fetch-site': 'same-origin' },
    form: { _csrf: token, name: 'Added', type: 'forever', command: 'echo hi', sourceType: 'command' },
  });
  assert.equal(res.status, 302);
  assert.equal(saved().scripts.at(-1).name, 'Added');
});

test('while the dashboard is keyless, /login sends you straight on and /logout has nothing to end', async t => {
  const { base } = await boot(t, { scripts: forever(), extra: DASH });
  const get = await request(base, 'GET', '/login?next=/settings');
  assert.equal(get.status, 302);
  assert.equal(get.headers.location, '/settings');
  const post = await request(base, 'POST', '/login', { form: { apiKey: 'wrong', next: '/settings' } });
  assert.equal(post.status, 302);
  assert.equal(post.headers.location, '/settings');
  assert.equal(post.headers['set-cookie'], undefined, 'no session is made');
  const token = await pageToken(base);
  const out = await request(base, 'POST', '/logout', { headers: { origin: base }, form: { _csrf: token } });
  assert.equal(out.status, 302);
  assert.equal(out.headers.location, '/scripts');
});

test('the log viewer uses dashboard routes, not /api, and they work without a key', async t => {
  for (const file of fs.readdirSync(path.join(__dirname, '../public')).filter(f => f.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), /\/api\b/, file);
  }
  const views = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory()
    ? views(path.join(dir, entry.name)) : entry.name.endsWith('.ejs') ? [path.join(dir, entry.name)] : []));
  const templates = views(path.join(__dirname, '../views'));
  assert.ok(templates.length >= 8 && templates.some(file => file.includes('partials')));
  for (const file of templates) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /["'`]\/api\b/, file);
  }
  const { base, logsDir } = await boot(t, { scripts: forever(), extra: DASH });
  const name = 'Example Worker-out-1.log';
  fs.writeFileSync(path.join(logsDir, name), 'one\ntwo\n');
  const data = '/logs/Example%20Worker/data';
  const q = `file=${encodeURIComponent(name)}`;
  assert.deepEqual((await request(base, 'GET', `${data}?${q}`)).json().logContent, 'one\ntwo\n');
  assert.equal((await request(base, 'GET', `${data}/stats`)).json().count, 1);
  assert.match((await request(base, 'GET', `${data}/chunk?${q}`)).json().content, /two/);
  assert.equal((await request(base, 'GET', `${data}/download?${q}`)).text, 'one\ntwo\n');
  // Deleting is a state change: the page's token and this site's origin.
  const del = headers => request(base, 'DELETE', `${data}/delete?${q}`, { headers });
  assert.equal((await del({})).status, 403);
  assert.equal((await del({ origin: base })).status, 403);
  assert.equal((await del({ origin: EVIL, 'x-csrf-token': await pageToken(base) })).status, 403);
  assert.equal((await del({ origin: base, 'x-csrf-token': await pageToken(base) })).status, 200);
  assert.ok(!fs.existsSync(path.join(logsDir, name)));
});

// ---------------------------------------------------------------------------
// /api keeps requiring the key
// ---------------------------------------------------------------------------

test('every /api route still answers 401 without the key, whatever else the request carries', async t => {
  const { base, pm2, saved, file } = await boot(t, {
    scripts: [job('Example Worker'), job('Example Cron', { type: 'cron', schedule: '0 * * * *' })], extra: DASH,
    securityOptions: { freeFailures: Infinity },
    setupPm2: (p, c) => p.add({ name: c.scripts[0].name, script: 'x.js', cwd: os.tmpdir() }),
  });
  const before = fs.readFileSync(file, 'utf8');
  const token = await pageToken(base);
  const apiRoutes = routes().filter(r => r.path.startsWith('/api/'));
  assert.ok(apiRoutes.length >= 9, `found ${apiRoutes.length} /api routes`);
  const attempts = [
    {},
    { 'x-api-key': 'wrong' },
    { origin: base, 'sec-fetch-site': 'same-origin' },
    { origin: base, 'sec-fetch-site': 'same-origin', 'x-csrf-token': token },
    { origin: base, 'x-csrf-token': token, accept: 'text/html' },
    { cookie: 'taskserver_session=1.abcd' },
  ];
  for (const headers of attempts) {
    for (const { method, path: routePath } of apiRoutes) {
      const url = concretePath(routePath) + (routePath.includes('logs') ? '?file=Example%20Worker-out-1.log' : '');
      const res = await request(base, method, url, { headers, json: method === 'POST' ? { name: 'X', type: 'forever', command: 'echo hi', _csrf: token } : undefined });
      assert.equal(res.status, 401, `${method} ${routePath} ${JSON.stringify(headers)} -> ${res.status}`);
      assert.deepEqual(res.json(), { error: 'Unauthorized', message: 'Valid API key required' });
    }
  }
  // Odd spellings of an /api path, and paths that are not routes, are not let in either.
  for (const url of ['/API/scripts', '/Api/scripts', '//api/scripts', '/api//scripts', '/%61pi/scripts', '/api/scripts/', '/scripts/../api/scripts', '/nothing-here']) {
    const res = await request(base, 'GET', url, { headers: { origin: base } });
    assert.notEqual(res.status, 200, url);
    assert.ok([401, 404].includes(res.status), `${url} -> ${res.status}`);
    if (res.status === 404) assert.doesNotMatch(res.text, /"scripts"/, url);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(pm2.mutations(), []);
  assert.equal(saved().scripts.length, 2);
  // With the key the API works exactly as before.
  assert.equal((await request(base, 'GET', '/api/scripts', { headers: withKey() })).status, 200);
  assert.equal((await request(base, 'POST', '/api/add-script', { headers: withKey(), json: { name: 'Added', type: 'cron', schedule: '0 * * * *', command: 'echo hi' } })).status, 200);
});

test('every dashboard route is open to this machine, and every other path still asks for the key', async t => {
  const { base } = await boot(t, { scripts: forever(), extra: DASH });
  const token = await pageToken(base);
  for (const { method, path: routePath } of routes().filter(r => !r.path.startsWith('/api/'))) {
    const url = concretePath(routePath);
    const res = await request(base, method, url, { headers: method === 'GET' ? HTML : { origin: base }, form: method === 'GET' ? undefined : { name: 'x' } });
    // A write that gets as far as the token check was not stopped by authentication.
    assert.notEqual(res.status, 401, `${method} ${routePath}`);
    assert.ok(!String(res.headers.location || '').startsWith('/login'), `${method} ${routePath}`);
    if (method !== 'GET') assert.equal(res.status, 403, `${method} ${routePath} needs the token`);
  }
  assert.ok(token);
  // Not a dashboard page: asks for the key, like before.
  assert.equal((await request(base, 'GET', '/nothing-here', { headers: HTML })).status, 302);
});

// ---------------------------------------------------------------------------
// State changes keep the Origin and CSRF checks
// ---------------------------------------------------------------------------

test('dashboard state changes still need this site\'s origin and the page\'s token, even with no Origin sent', async t => {
  const { base, saved, pm2 } = await boot(t, { scripts: forever(), extra: DASH,
    setupPm2: (p, c) => p.add({ name: c.scripts[0].name, script: 'x.js', cwd: os.tmpdir() }) });
  const token = await pageToken(base);
  const form = { name: 'Injected', type: 'forever', command: 'touch should-not-exist', sourceType: 'command' };
  const attempts = [
    ['no Origin, no token (a bare script)', {}, form],
    ['no Origin, token', {}, { ...form, _csrf: token }],
    ['Sec-Fetch-Site none, token', { 'sec-fetch-site': 'none' }, { ...form, _csrf: token }],
    ['other site, token', { origin: EVIL, 'sec-fetch-site': 'cross-site' }, { ...form, _csrf: token }],
    ['null origin, token', { origin: 'null' }, { ...form, _csrf: token }],
    ['this site, no token', { origin: base }, form],
    ['this site, wrong token', { origin: base }, { ...form, _csrf: 'forged' }],
    ['this site, a made-up token of the right shape', { origin: base }, { ...form, _csrf: 'ab'.repeat(32) }],
  ];
  for (const [label, headers, body] of attempts) {
    assert.equal((await request(base, 'POST', '/add-script', { headers, form: body })).status, 403, label);
  }
  for (const url of ['/stop-script/Example%20Worker', '/delete-script/Example%20Worker', '/restart-script/Example%20Worker']) {
    assert.equal((await request(base, 'POST', url, { headers: { origin: EVIL } })).status, 403, url);
    assert.equal((await request(base, 'POST', url, {})).status, 403, url);
  }
  assert.equal(saved().scripts.length, 1);
  assert.deepEqual(pm2.mutations(), []);
  // The page's own form: same origin and the token. The token also goes in a header.
  const ok = await request(base, 'POST', '/stop-script/Example%20Worker', { headers: { origin: base, 'x-csrf-token': token } });
  assert.equal(ok.status, 302);
  assert.ok(pm2.mutations().length > 0);
});

test('the dashboard token is bound to this process, differs from a session\'s, and does not come from the key', async t => {
  const first = await boot(t, { extra: DASH });
  const second = await boot(t, { extra: DASH });
  const [a1, a2, b] = [await pageToken(first.base), await pageToken(first.base), await pageToken(second.base)];
  assert.equal(a1, a2, 'stable for the life of the process');
  assert.notEqual(a1, b, 'another process has another token');
  assert.match(a1, /^[0-9a-f]{64}$/);
  assert.ok(!a1.includes(KEY));
  // A token from a normal signed-in session is not this token.
  const normal = await boot(t, { extra: { api: { authEnabled: true, apiKey: KEY } } });
  const login = await request(normal.base, 'POST', '/login', { form: { apiKey: KEY } });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.notEqual(await pageToken(normal.base, { cookie }), a1);
});

// ---------------------------------------------------------------------------
// Anything that does not look local falls back to normal authentication
// ---------------------------------------------------------------------------

test('a proxy header on the request falls back to the key (pages redirect to sign in, writes get 401)', async t => {
  const { base, saved } = await boot(t, { scripts: forever(), extra: DASH });
  const token = await pageToken(base);
  for (const name of PROXY_HEADERS) {
    const headers = { [name]: name === 'forwarded' ? 'for=203.0.113.9' : '203.0.113.9' };
    const page = await request(base, 'GET', '/scripts', { headers: { ...headers, ...HTML } });
    assert.equal(page.status, 302, name);
    assert.match(page.headers.location, /^\/login\?next=/, name);
    assert.equal((await request(base, 'GET', '/scripts', { headers })).status, 401, name);
    const post = await request(base, 'POST', '/add-script', { headers: { ...headers, origin: base }, form: { _csrf: token, name: 'X', type: 'forever', command: 'echo hi' } });
    assert.equal(post.status, 401, name);
    // And the sign-in page is a real sign-in page again.
    assert.equal((await request(base, 'GET', '/login', { headers })).status, 200, name);
  }
  assert.equal(saved().scripts.length, 1);
  // With the key the same request works, as it always did.
  assert.equal((await request(base, 'GET', '/scripts', { headers: withKey({ 'x-forwarded-for': '203.0.113.9' }) })).status, 200);
});

test('a Host header that is not loopback (DNS rebinding) falls back to the key', async t => {
  const { base } = await boot(t, { scripts: forever(), extra: DASH });
  const port = new URL(base).port;
  for (const host of ['evil.example', `evil.example:${port}`, '192.168.1.5', 'localhost.evil.example']) {
    const res = await request(base, 'GET', '/scripts', { headers: { host, ...HTML } });
    assert.equal(res.status, 302, JSON.stringify(host));
    assert.match(res.headers.location, /^\/login/);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'LOCALHOST']) {
    assert.equal((await request(base, 'GET', '/scripts', { headers: { host, ...HTML } })).status, 200, host);
  }
});

test('a socket that is not loopback falls back to the key', () => {
  const settings = parseSettings(DASH).settings;
  const security = createSecurity({ loadAuth: () => settings });
  const run = (remoteAddress, extra = {}) => {
    const req = { method: 'GET', path: '/scripts', originalUrl: '/scripts', headers: { host: '127.0.0.1:3000', accept: 'text/html', ...extra }, socket: { remoteAddress } };
    const outcome = { next: false, redirect: null };
    const res = { locals: {}, redirect: location => { outcome.redirect = location; }, status: () => ({ json: () => { outcome.refused = true; } }) };
    security.authenticate(req, res, () => { outcome.next = true; });
    return { ...outcome, mode: req.authMode };
  };
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    assert.deepEqual(run(address), { next: true, redirect: null, mode: 'local' }, address);
  }
  // A configured proxy closes it too, whatever else the settings say.
  const proxied = createSecurity({ loadAuth: () => ({ ...settings, publicOrigins: ['https://dash.example.test'] }) });
  const proxiedReq = { method: 'GET', path: '/scripts', originalUrl: '/scripts', headers: { host: '127.0.0.1:3000', accept: 'text/html' }, socket: { remoteAddress: '127.0.0.1' } };
  let reached = false;
  proxied.authenticate(proxiedReq, { locals: {}, redirect: () => {} }, () => { reached = true; });
  assert.equal(reached, false);
  for (const address of ['192.0.2.7', '10.0.0.5', '::ffff:192.0.2.7', '2001:db8::1', 'unknown', undefined, '']) {
    const outcome = run(address);
    assert.equal(outcome.next, false, String(address));
    assert.match(outcome.redirect, /^\/login/);
  }
});

test('changing config.yaml while running: publicOrigins or a non-boolean never open the dashboard up', async t => {
  const { base, write, config } = await boot(t, { scripts: forever(), extra: DASH });
  assert.equal((await request(base, 'GET', '/scripts', { headers: HTML })).status, 200);
  // A proxy configured while running: back to the key (start-up would refuse this).
  write({ ...config, server: { ...config.server, publicOrigins: ['https://dash.example.test'] } });
  assert.equal((await request(base, 'GET', '/scripts', { headers: HTML })).status, 302);
  write(config);
  assert.equal((await request(base, 'GET', '/scripts', { headers: HTML })).status, 200);
  // A value that makes no sense keeps the last good settings (which are keyless).
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  write({ ...config, api: { ...config.api, dashboardAuth: 'false' } });
  assert.equal((await request(base, 'GET', '/scripts', { headers: HTML })).status, 200, 'last good: still keyless');
  // Removing the setting is the default: the key is needed.
  write({ ...config, api: { authEnabled: true, apiKey: KEY } });
  assert.equal((await request(base, 'GET', '/scripts', { headers: HTML })).status, 302);
});

test('a non-boolean value never starts keyless at run time: the last good (or refuse-all) settings stay', async t => {
  const { base, write, config } = await boot(t, { scripts: forever(), extra: { api: { authEnabled: true, apiKey: KEY } } });
  const original = console.error;
  console.error = () => {};
  t.after(() => { console.error = original; });
  for (const value of ['false', 0, null, 'no', []]) {
    write({ ...config, api: { authEnabled: true, apiKey: KEY, dashboardAuth: value } });
    assert.equal((await request(base, 'GET', '/scripts', { headers: HTML })).status, 302, JSON.stringify(value));
  }
});

// ---------------------------------------------------------------------------
// Default behaviour is unchanged
// ---------------------------------------------------------------------------

test('without the setting, or with it true, the dashboard asks for the key as before', async t => {
  for (const extra of [{ api: { authEnabled: true, apiKey: KEY } }, { api: { authEnabled: true, apiKey: KEY, dashboardAuth: true } }]) {
    const { base } = await boot(t, { scripts: forever(), extra });
    const page = await request(base, 'GET', '/scripts', { headers: HTML });
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, '/login?next=%2Fscripts');
    assert.equal((await request(base, 'GET', '/scripts', { headers: { accept: 'application/json' } })).status, 401);
    assert.equal((await request(base, 'POST', '/add-script', { headers: { origin: base }, form: { name: 'X' } })).status, 401);
    assert.equal((await request(base, 'GET', '/login')).status, 200, 'the sign-in page is a sign-in page');
    assert.equal((await request(base, 'GET', '/api/scripts')).status, 401);
    assert.equal((await request(base, 'GET', '/scripts', { headers: withKey() })).status, 200);
    const login = await request(base, 'POST', '/login', { form: { apiKey: KEY } });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const home = await request(base, 'GET', '/scripts', { headers: { cookie } });
    assert.equal(home.status, 200);
    assert.match(home.text, /action="\/logout"/);
  }
});

test('with authentication off the setting changes nothing', async t => {
  const { base } = await boot(t, { scripts: forever(), extra: { api: { authEnabled: false, dashboardAuth: false } } });
  assert.equal((await request(base, 'GET', '/scripts')).status, 200);
  assert.equal((await request(base, 'GET', '/api/scripts')).status, 200);
  assert.equal((await request(base, 'GET', '/scripts', { headers: { host: 'evil.example' } })).status, 403);
});

// ---------------------------------------------------------------------------
// Start-up refusals
// ---------------------------------------------------------------------------

test('start-up refuses api.dashboardAuth: false with a non-loopback host, the tunnel or publicOrigins, naming the key', () => {
  const config = (server, extra = {}) => ({ server: { host: '127.0.0.1', ...server }, api: { authEnabled: true, apiKey: KEY, dashboardAuth: false }, ...extra });
  assert.deepEqual(listenProblems(config({})), []);
  assert.deepEqual(listenProblems(config({ host: 'localhost' })), []);
  assert.deepEqual(listenProblems(config({ publicOrigins: [] })), []);

  const host = listenProblems(config({ host: '0.0.0.0' }));
  assert.equal(host.length, 1);
  assert.match(host[0], /api\.dashboardAuth is false but server\.host is 0\.0\.0\.0, not a loopback address/);
  const lan = listenProblems(config({ host: '192.168.1.20' }));
  assert.match(lan[0], /server\.host is 192\.168\.1\.20/);

  const tunnel = listenProblems(config({}, { cloudflare: { enabled: true, tunnelToken: 'x' } }));
  assert.equal(tunnel.length, 1);
  assert.match(tunnel[0], /api\.dashboardAuth is false but cloudflare\.enabled is true/);

  const origins = listenProblems(config({ publicOrigins: ['https://dash.example.test'] }));
  assert.equal(origins.length, 1);
  assert.match(origins[0], /api\.dashboardAuth is false but server\.publicOrigins is not empty/);

  const all = listenProblems(config({ host: '0.0.0.0', publicOrigins: ['https://dash.example.test'] }, { cloudflare: { enabled: true } }));
  assert.equal(all.length, 3);

  // The same exposure with the default (or true) is fine: the key protects everything.
  for (const dashboardAuth of [undefined, true]) {
    const api = { authEnabled: true, apiKey: KEY, dashboardAuth };
    assert.deepEqual(listenProblems({ server: { host: '0.0.0.0', publicOrigins: ['https://dash.example.test'] }, cloudflare: { enabled: true }, api }), []);
  }
});

test('start-up refuses a dashboardAuth that is not true or false, naming the key', () => {
  for (const value of ['false', 'no', 0, 1, null, [], {}, '']) {
    const problems = listenProblems({ server: { host: '127.0.0.1' }, api: { authEnabled: true, apiKey: KEY, dashboardAuth: value } });
    assert.equal(problems.length, 1, JSON.stringify(value));
    assert.match(problems[0], /api\.dashboardAuth in config\.yaml must be true or false/);
  }
  assert.deepEqual(listenProblems({ server: { host: '127.0.0.1' }, api: { authEnabled: true, apiKey: KEY, dashboardAuth: true } }), []);
  assert.deepEqual(listenProblems({ server: { host: '127.0.0.1' }, api: { authEnabled: true, apiKey: KEY, dashboardAuth: false } }), []);
});

test('the real start-up exits with an error instead of starting', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-refuse-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const attempt = config => {
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, yaml.dump({ server: { logsDir: path.join(dir, 'logs') }, scripts: [], ...config }));
    return spawnSync(process.execPath, [path.join(__dirname, '../server.js')], {
      env: { ...process.env, TASKSERVER_CONFIG: file }, encoding: 'utf8', timeout: 30000,
    });
  };
  const api = dashboardAuth => ({ authEnabled: true, apiKey: KEY, dashboardAuth });
  for (const [config, pattern] of [
    [{ api: api('false') }, /api\.dashboardAuth in config\.yaml must be true or false/],
    [{ api: api(false), server: { host: '0.0.0.0', logsDir: path.join(dir, 'logs') } }, /api\.dashboardAuth is false but server\.host/],
    [{ api: api(false), cloudflare: { enabled: true, tunnelToken: 'x' } }, /api\.dashboardAuth is false but cloudflare\.enabled/],
    [{ api: api(false), server: { publicOrigins: ['https://dash.example.test'], logsDir: path.join(dir, 'logs') } }, /api\.dashboardAuth is false but server\.publicOrigins/],
  ]) {
    const result = attempt(config);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Refusing to start: /);
    assert.match(result.stderr, pattern);
  }
});
