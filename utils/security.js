'use strict';

// Who may talk to TaskServer, and from where.
//
// One check sits in front of every route (only the login page and the static
// files in public/ are open):
//
//  - With `api.authEnabled: true` a request must carry the API key in the
//    `X-API-Key` header (scripts and other programs) or a session cookie (the
//    dashboard, after signing in at /login with the same key). The key is never
//    accepted in a URL, and is compared in constant time. Repeated wrong keys
//    from one address are slowed down.
//  - A session is a random id kept in memory. Signing out removes it, and so does
//    a restart (everyone signs in again). The cookie and the CSRF token are made
//    from random per-process secrets, never from the API key.
//  - A state-changing request from a browser must come from this site: its
//    Origin has to be this server's own host or one of `server.publicOrigins`
//    (or, with no Origin, Sec-Fetch-Site has to say same-origin), and it has to
//    carry the CSRF token the dashboard pages embed. A request with a valid API
//    key header is exempt: a web page cannot add that header to a cross-site
//    request. Programs that send neither an Origin nor a cookie are not
//    browsers and are only let through when authentication is off.
//  - With authentication off, only loopback host names (and `server.allowedHosts`)
//    are served, so a page cannot reach TaskServer through DNS rebinding.
//  - Once settings have been read, a config.yaml that later goes missing, is
//    empty, is cut off, or holds settings that make no sense never replaces
//    them: the last good settings stay in force. With none, every request is
//    refused.

const crypto = require('crypto');
const express = require('express');
const configHandler = require('./configHandler');

const SESSION_COOKIE = 'taskserver_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const MIN_KEY_LENGTH = 16;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

// Wrong keys: after FREE_FAILURES different wrong keys from one address, further
// requests from it are refused for a pause that doubles up to MAX_PAUSE_MS. The
// same wrong key again counts for nothing (a client that forgot to update its
// key must not lock everyone else out). A right key outside a pause starts the
// count again. Failures are forgotten after FORGET_MS without a new one.
// Clients on the loopback interface (the scripts and the console on the same
// machine, all sharing one address) get a short pause, LOOPBACK_PAUSE_MS, unless a
// proxy or tunnel is configured or announced by its headers.
const FREE_FAILURES = 5;
const BASE_PAUSE_MS = 1000;
const MAX_PAUSE_MS = 30000;
const LOOPBACK_PAUSE_MS = 2000;
const FORGET_MS = 10 * 60 * 1000;
const REMEMBERED_WRONG_KEYS = 8;
const MAX_CLIENTS = 10000;
const SWEEP_MS = 60 * 1000;
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip'];

// Scripts and styles only from this site, nothing inline. Inline styles stay
// allowed because the pages use style attributes.
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest();
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest('hex');

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isLoopbackHost(host) {
  const name = String(host || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK_NAMES.has(name) || /^127(\.\d{1,3}){3}$/.test(name);
}

const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The security settings in a config (as YAML gave it, or merged with defaults).
// Returns { settings } or { problem } where the problem names the config key and
// carries nothing from the file. `previous` is what was read last time, if
// anything: settings may not quietly lose their `api` block.
function parseSettings(config, previous = null) {
  if (config === undefined || config === null) {
    return previous
      ? { problem: 'config.yaml is missing or empty' }
      : { settings: settingsOf({}, {}, false) };
  }
  if (!isMapping(config)) return { problem: 'config.yaml must be a mapping of settings' };

  const hasApi = config.api !== undefined;
  if (previous?.hasApi && !hasApi) return { problem: 'config.yaml no longer has the api section' };
  if (hasApi && !isMapping(config.api)) return { problem: 'api in config.yaml must be a mapping' };
  const api = hasApi ? config.api : {};
  if (previous?.enabled && api.authEnabled === undefined) {
    return { problem: 'api.authEnabled in config.yaml is missing (it was on); set it to false to turn authentication off' };
  }
  if (api.authEnabled !== undefined && typeof api.authEnabled !== 'boolean') {
    return { problem: 'api.authEnabled in config.yaml must be true or false' };
  }
  if (api.apiKey !== undefined && typeof api.apiKey !== 'string') {
    return { problem: 'api.apiKey in config.yaml must be a string' };
  }
  const enabled = api.authEnabled === true;
  const apiKey = api.apiKey ?? '';
  if (enabled && apiKey.trim().length < MIN_KEY_LENGTH) {
    return { problem: `api.apiKey in config.yaml must be at least ${MIN_KEY_LENGTH} characters when api.authEnabled is true` };
  }

  if (config.server !== undefined && config.server !== null && !isMapping(config.server)) {
    return { problem: 'server in config.yaml must be a mapping' };
  }
  const server = config.server || {};
  for (const key of ['allowedHosts', 'publicOrigins']) {
    if (server[key] !== undefined && (!Array.isArray(server[key]) || server[key].some(item => typeof item !== 'string'))) {
      return { problem: `server.${key} in config.yaml must be a list of strings` };
    }
  }
  const publicOrigins = [];
  for (const entry of server.publicOrigins || []) {
    try {
      const url = new URL(entry);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
      publicOrigins.push(url.origin);
    } catch (error) {
      return { problem: 'server.publicOrigins in config.yaml must hold origins such as https://dashboard.example.com' };
    }
  }
  return { settings: { ...settingsOf(api, server, hasApi), enabled, apiKey, publicOrigins } };
}

function settingsOf(api, server, hasApi) {
  return {
    enabled: false,
    apiKey: '',
    hasApi,
    host: typeof server.host === 'string' ? server.host : undefined,
    allowedHosts: server.allowedHosts || [],
    publicOrigins: [],
  };
}

// Settings that refuse everything: used when config.yaml was never usable.
const REFUSE_ALL = { enabled: true, apiKey: '', hasApi: true, host: undefined, allowedHosts: [], publicOrigins: [] };

// Reads the settings from config.yaml on each call (the file can change while
// running). Settings that cannot be used never switch protection off: the last
// good ones stay in force. Only the very first read may fall back to "no
// authentication" (no config.yaml yet).
//
// `seed` is the config start-up already loaded and checked: it is the "last good"
// from the first request on, so there is no window in which an empty or missing
// file could be taken for "no authentication".
function createAuthSource({ read = configHandler.readRawConfig, logger = console, seed } = {}) {
  let lastGood = seed === undefined ? null : parseSettings(seed).settings || null;
  let lastProblem = null;
  return () => {
    let outcome;
    try {
      outcome = parseSettings(read(), lastGood);
    } catch (error) {
      outcome = { problem: error.message };
    }
    if (outcome.settings) {
      lastGood = outcome.settings;
      lastProblem = null;
    } else if (outcome.problem !== lastProblem) {
      lastProblem = outcome.problem;
      logger.error?.(`[Security] ${outcome.problem}; ${lastGood
        ? 'keeping the last good security settings'
        : 'refusing every request until it is fixed'}`);
    }
    return lastGood || REFUSE_ALL;
  };
}

// Problems that must stop TaskServer from starting, each naming the config key
// and why. Empty when it is safe.
function listenProblems(config) {
  const parsed = parseSettings(config);
  const problems = [];
  if (parsed.problem) problems.push(parsed.problem);
  const enabled = Boolean(parsed.settings?.enabled);
  const exposure = [];
  if (!isLoopbackHost(config.server?.host)) exposure.push(`server.host is ${config.server?.host}, not a loopback address`);
  if (config.cloudflare?.enabled) exposure.push('cloudflare.enabled is true');
  if (exposure.length && !enabled) {
    problems.push(`${exposure.join(' and ')}, so the dashboard is reachable from other machines: `
      + `set api.authEnabled: true and an api.apiKey of at least ${MIN_KEY_LENGTH} characters in config.yaml`);
  }
  return problems;
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

// Only a path on this site: no other host, no protocol-relative link, and not
// the sign-in page itself.
function localPath(value, fallback = '/scripts') {
  const text = typeof value === 'string' ? value : '';
  return /^\/(?![/\\])/.test(text) && !/[\r\n]/.test(text) && !text.startsWith('/login') ? text : fallback;
}

const isLoopbackAddress = address => /^(127(\.\d{1,3}){3}|::1|::ffff:127(\.\d{1,3}){3})$/.test(String(address || ''));

// Failed-key bookkeeping per client address: { count, last, blockedUntil, seen }
// where `seen` holds short hashes of the last few wrong keys. The table is
// capped: the entry touched longest ago goes first (an update re-inserts the
// entry at the end), and stale entries are swept at most once a minute.
function createThrottle(now, freeFailures, { maxClients = MAX_CLIENTS } = {}) {
  const clients = new Map();
  let swept = now();
  const sweep = time => {
    if (time - swept < SWEEP_MS) return;
    swept = time;
    for (const [key, entry] of clients) if (time - entry.last > FORGET_MS) clients.delete(key);
  };
  return {
    // Seconds to wait, or 0.
    wait(client) {
      const entry = clients.get(client);
      return entry && entry.blockedUntil > now() ? Math.ceil((entry.blockedUntil - now()) / 1000) : 0;
    },
    // A wrong key. `maxPauseMs` caps the pause for this client.
    fail(client, key, maxPauseMs = MAX_PAUSE_MS) {
      const time = now();
      sweep(time);
      let entry = clients.get(client);
      if (!entry || time - entry.last > FORGET_MS) entry = { count: 0, last: time, blockedUntil: 0, seen: new Set() };
      const tag = sha256(key).toString('hex').slice(0, 16);
      if (entry.seen.has(tag)) return; // the same wrong key again: nothing new was guessed
      entry.seen.add(tag);
      if (entry.seen.size > REMEMBERED_WRONG_KEYS) entry.seen.delete(entry.seen.values().next().value);
      entry.count += 1;
      entry.last = time;
      if (entry.count >= freeFailures) {
        entry.blockedUntil = time + Math.min(BASE_PAUSE_MS * 2 ** (entry.count - freeFailures), maxPauseMs);
      }
      clients.delete(client);
      clients.set(client, entry);
      while (clients.size > maxClients) clients.delete(clients.keys().next().value);
    },
    // A right key outside a pause.
    succeed(client) {
      const entry = clients.get(client);
      if (entry && entry.blockedUntil <= now()) {
        entry.count = 0;
        entry.blockedUntil = 0;
      }
    },
    size: () => clients.size,
  };
}

function createSecurity({
  loadAuth = createAuthSource(),
  csrfSecret = crypto.randomBytes(32),
  now = Date.now,
  freeFailures = FREE_FAILURES,
} = {}) {
  const throttle = createThrottle(now, freeFailures);
  const clientOf = req => req.socket?.remoteAddress || 'unknown';
  const pauseCapFor = (req, auth) => (isLoopbackAddress(clientOf(req)) && auth.publicOrigins.length === 0
    && !PROXY_HEADERS.some(name => req.headers[name] !== undefined) ? LOOPBACK_PAUSE_MS : MAX_PAUSE_MS);

  // One read of config.yaml per request, shared by every check.
  const settingsFor = req => {
    if (!req.securitySettings) {
      req.securitySettings = loadAuth();
      if (!req.securitySettings.enabled && sessions.size) sessions.clear(); // auth switched off: forget every session
    }
    return req.securitySettings;
  };

  const keyMatches = (auth, given) => auth.apiKey !== '' && typeof given === 'string'
    && crypto.timingSafeEqual(sha256(given), sha256(auth.apiKey));

  // Live sessions: id -> { expires, key }. `key` is a hash of the API key the
  // session was made with, so changing the key ends every session.
  const sessions = new Map();
  const keyTag = auth => sha256(auth.apiKey).toString('hex');
  const newSession = auth => {
    const time = now();
    for (const [id, session] of sessions) if (session.expires <= time) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, { expires: time + SESSION_MS, key: keyTag(auth) });
    return id;
  };
  const sessionValid = (auth, id) => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session) return false;
    if (session.expires <= now()) {
      sessions.delete(id);
      return false;
    }
    return auth.apiKey !== '' && session.key === keyTag(auth);
  };

  const csrfFor = session => hmac(csrfSecret, `csrf|${session || ''}`);

  const sessionCookie = (req, value, maxAgeMs) => {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`;
  };

  function headers(req, res, next) {
    res.set({
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  }

  // With authentication off, only loopback names are served.
  function hostGuard(req, res, next) {
    const auth = settingsFor(req);
    if (auth.enabled) return next();
    const header = String(req.headers.host || '');
    const name = (header.startsWith('[') ? header.slice(0, header.indexOf(']') + 1) : header.replace(/:\d*$/, ''))
      .replace(/^\[|\]$/g, '').toLowerCase();
    const allowed = isLoopbackHost(name)
      || auth.allowedHosts.some(entry => entry.toLowerCase() === name)
      || (auth.host && !['0.0.0.0', '::'].includes(auth.host) && auth.host.toLowerCase() === name);
    if (!allowed) return res.status(403).type('text/plain').send('Host not allowed');
    next();
  }

  const wantsPage = req => req.method === 'GET' && !req.path.startsWith('/api/')
    && String(req.headers.accept || '').includes('text/html');

  const tooMany = (res, seconds) => res.set('Retry-After', String(seconds)).status(429)
    .json({ error: 'Too Many Requests', message: 'Too many wrong keys; wait and try again' });

  function authenticate(req, res, next) {
    const auth = settingsFor(req);
    req.authMode = 'off';
    res.locals.authEnabled = auth.enabled;
    res.locals.csrfToken = csrfFor('');
    if (!auth.enabled) return next();

    const given = req.headers['x-api-key'];
    if (given !== undefined) {
      const seconds = throttle.wait(clientOf(req));
      if (seconds) return tooMany(res, seconds);
      if (keyMatches(auth, given)) {
        throttle.succeed(clientOf(req));
        req.authMode = 'key';
        return next();
      }
      throttle.fail(clientOf(req), given, pauseCapFor(req, auth));
    } else {
      const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (sessionValid(auth, id)) {
        req.authMode = 'session';
        req.sessionId = id;
        res.locals.csrfToken = csrfFor(id);
        req.csrfToken = res.locals.csrfToken;
        return next();
      }
    }
    if (wantsPage(req)) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return res.status(401).json({ error: 'Unauthorized', message: 'Valid API key required' });
  }

  // Does the request come from a page of this site? Sec-Fetch-Site "none" (the
  // user typing the address) is not accepted: nobody types in a POST.
  function fromThisSite(req, auth) {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      try {
        const url = new URL(origin);
        return url.host === req.headers.host || auth.publicOrigins.includes(url.origin);
      } catch (error) {
        return false;
      }
    }
    return req.headers['sec-fetch-site'] === 'same-origin';
  }

  function csrfGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method) || req.authMode === 'key') return next();
    const browser = req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined
      || req.authMode === 'session';
    if (!browser) return next();
    if (!fromThisSite(req, settingsFor(req))) {
      return res.status(403).type('text/plain').send('Cross-site request refused');
    }
    const token = req.body?._csrf ?? req.headers['x-csrf-token'];
    const expected = req.authMode === 'session' ? req.csrfToken : csrfFor('');
    if (typeof token !== 'string' || !safeEqual(token, expected)) {
      return res.status(403).type('text/plain').send('Missing or invalid CSRF token. Reload the page and try again.');
    }
    next();
  }

  // Sign in with the API key. Mounted before authenticate.
  const loginRouter = express.Router();
  loginRouter.use('/login', express.urlencoded({ extended: false, limit: '4kb' }));
  loginRouter.get('/login', (req, res) => {
    const auth = settingsFor(req);
    const next = localPath(req.query.next);
    if (!auth.enabled || sessionValid(auth, parseCookies(req.headers.cookie)[SESSION_COOKIE])) return res.redirect(next);
    res.render('login', { next, error: null });
  });
  loginRouter.post('/login', (req, res) => {
    const auth = settingsFor(req);
    const next = localPath(req.body?.next);
    if (!auth.enabled) return res.redirect(next);
    if (req.headers.origin !== undefined && !fromThisSite(req, auth)) {
      return res.status(403).type('text/plain').send('Cross-site request refused');
    }
    const seconds = throttle.wait(clientOf(req));
    if (seconds) {
      return res.set('Retry-After', String(seconds)).status(429)
        .render('login', { next, error: `Too many wrong keys. Wait ${seconds} s and try again.` });
    }
    if (!keyMatches(auth, req.body?.apiKey)) {
      throttle.fail(clientOf(req), String(req.body?.apiKey ?? ''), pauseCapFor(req, auth));
      return res.status(401).render('login', { next, error: 'That key is not correct.' });
    }
    throttle.succeed(clientOf(req));
    res.set('Set-Cookie', sessionCookie(req, newSession(auth), SESSION_MS));
    res.redirect(next);
  });

  // Mounted after csrfGuard. Signing out forgets the session on the server, so a
  // copy of the cookie stops working too.
  const sessionRouter = express.Router();
  sessionRouter.post('/logout', (req, res) => {
    if (req.sessionId) sessions.delete(req.sessionId);
    res.set('Set-Cookie', sessionCookie(req, '', 0));
    res.redirect('/login');
  });

  return { headers, hostGuard, authenticate, csrfGuard, loginRouter, sessionRouter, csrfFor };
}

module.exports = {
  createSecurity,
  createAuthSource,
  createThrottle,
  parseSettings,
  listenProblems,
  isLoopbackHost,
  localPath,
  CONTENT_SECURITY_POLICY,
  SESSION_COOKIE,
  MIN_KEY_LENGTH,
};
