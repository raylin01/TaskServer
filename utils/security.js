// Who may talk to TaskServer, and from where.
//
// Authentication is opt-in: `auth.required: true` in config.yaml. When it is on,
// one check sits in front of every route, and there are two kinds of caller:
//
//  - Programs call `/api/*` with the API key (`auth.apiKey`) in the `X-API-Key`
//    header and nothing else: not a URL parameter, not Basic auth, not a session
//    cookie. The key is compared in constant time. A refused request gets a
//    fixed 401 and one log line (method, path, address; never the key).
//  - People use the dashboard (every other route). They sign in at /login with
//    the dashboard password, which is a different secret from the API key and is
//    kept in config.yaml only as a scrypt hash (`auth.dashboardPasswordHash`). A
//    session is a random id kept in memory; the key does not open the dashboard.
//
//  Only the login page and the static files in public/ are open. Wrong keys, and
//  wrong passwords, from one address are slowed down (separately).
//
//  - A session is a random 256-bit id kept in memory for 7 days. Signing out
//    removes it, and so does a restart (everyone signs in again). Changing the
//    password ends every session. The CSRF token is made from a random
//    per-process secret and the session, never from a credential.
//  - A state-changing request from a browser must come from this site: its
//    Origin (or, when there is none, its Referer) has to be this server's own
//    host or one of `server.publicOrigins` (with `Origin: null`, Sec-Fetch-Site
//    has to say same-origin), and it has to carry the CSRF token the dashboard
//    pages embed. A request with a valid API key header is exempt: a web page
//    cannot add that header to a cross-site request.
//  - With authentication off, only loopback host names (and `server.allowedHosts`)
//    are served, so a page cannot reach TaskServer through DNS rebinding.
//  - Once settings have been read, a config.yaml that later goes missing, is
//    empty, is cut off, or holds settings that make no sense never replaces
//    them: the last good settings stay in force. With none, every request is
//    refused.

const crypto = require('crypto');
const express = require('express');
const configHandler = require('./configHandler');
const { asyncHandler, isApiPath } = require('./httpErrors');
const { parseHash, verifyPassword, MAX_PASSWORD_LENGTH } = require('./passwordHash');

const SESSION_COOKIE = 'taskserver_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const MIN_KEY_LENGTH = 32;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
// An API key is printable ASCII without spaces: that is what an HTTP header can
// carry unchanged, so the length check and the comparison see the same text.
const KEY_PATTERN = new RegExp(`^[\\x21-\\x7e]{${MIN_KEY_LENGTH},}$`);
// At most this many password checks (scrypt is slow and memory hungry) run at once.
const MAX_VERIFYING = 2;
// Settings that used to live under `api`, replaced by `auth`. A block that only
// says "off" (the old example config) is harmless and counts as absent; anything
// else is refused by name.
const OLD_API_KEYS = {
  authEnabled: { now: 'auth.required', inert: value => value === undefined || value === false },
  apiKey: { now: 'auth.apiKey', inert: value => value === undefined || value === null || value === '' },
  dashboardAuth: { now: null, inert: value => value === undefined || value === true },
};

// Wrong keys (and, separately, wrong passwords): after FREE_FAILURES different
// wrong tries from one address, further wrong tries from it are refused for a
// pause that doubles up to MAX_PAUSE_MS. For the API a right key is always
// accepted (the pause only silences wrong ones); a login is refused during the
// pause whatever the password, because each check costs a lot. The same wrong
// try again counts for nothing against the API (a client that forgot to update
// its key must not be a problem for anyone else), and for logins counts
// REPEAT_FACTOR times less. A right try outside a pause starts the count again.
// Failures are forgotten after FORGET_MS without a new one.
// Clients on the loopback interface (the scripts and the console on the same
// machine, all sharing one address) get a short pause, LOOPBACK_PAUSE_MS, unless a
// proxy or tunnel is configured or announced by its headers.
const FREE_FAILURES = 5;
const REPEAT_FACTOR = 4;
const BASE_PAUSE_MS = 1000;
const MAX_PAUSE_MS = 30000;
const LOOPBACK_PAUSE_MS = 2000;
const FORGET_MS = 10 * 60 * 1000;
const REMEMBERED_WRONG_KEYS = 8;
const MAX_CLIENTS = 10000;
const SWEEP_MS = 60 * 1000;
// Headers a proxy or tunnel adds. Any one of them means the request did not come
// straight from a local client: it gets the long pause for wrong keys.
const PROXY_HEADERS = [
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server',
  'x-real-ip', 'forwarded', 'via', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip', 'x-original-url',
];
const hasProxyHeader = req => PROXY_HEADERS.some(name => req.headers[name] !== undefined);

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

// The host name in a Host header, without port or brackets, lower case.
function hostNameOf(header) {
  const text = String(header || '');
  return (text.startsWith('[') ? text.slice(0, text.indexOf(']') + 1) : text.replace(/:\d*$/, ''))
    .replace(/^\[|\]$/g, '').toLowerCase();
}

const isMapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The old `api` settings in a config that are not just "off", as names, or []
// when there are none (or the block is the harmless old default).
function oldSettingsIn(config) {
  if (config.api === undefined || config.api === null) return [];
  if (!isMapping(config.api)) return ['api'];
  return Object.entries(OLD_API_KEYS)
    .filter(([key, { inert }]) => !inert(config.api[key]))
    .map(([key]) => `api.${key}`);
}

function oldSettingsProblem(names) {
  const moves = names.map(name => {
    const { now } = OLD_API_KEYS[name.slice(4)] || {};
    return now ? `${name} is now ${now}` : `${name} is gone`;
  });
  return `config.yaml still has the old settings ${names.join(', ')}; they were replaced by the auth section `
    + `(${moves.join('; ')}). Move them, and note that auth.required: true also needs auth.dashboardPasswordHash `
    + '(run "npm run set-dashboard-password") and an auth.apiKey of at least '
    + `${MIN_KEY_LENGTH} characters. See "Before you update" in the README`;
}

// The security settings in a config (as YAML gave it, or merged with defaults).
// Returns { settings } or { problem, problems } where each problem names the
// config key and carries nothing from the file. `previous` is what was read last
// time, if anything: settings may not quietly lose their `auth` block.
function parseSettings(config, previous = null) {
  const refuse = problems => ({ problem: problems.join('; '), problems });
  if (config === undefined || config === null) {
    return previous
      ? refuse(['config.yaml is missing or empty'])
      : { settings: settingsOf({}, {}, false) };
  }
  if (!isMapping(config)) return refuse(['config.yaml must be a mapping of settings']);

  const problems = [];
  // The old `api.authEnabled` / `api.apiKey` settings are gone. Ignoring them
  // would quietly leave a server that someone thinks is protected open.
  const old = oldSettingsIn(config);
  if (old.length) problems.push(oldSettingsProblem(old));

  const hasAuth = config.auth !== undefined;
  let auth = {};
  if (previous?.hasAuth && !hasAuth) problems.push('config.yaml no longer has the auth section');
  if (hasAuth && !isMapping(config.auth)) problems.push('auth in config.yaml must be a mapping');
  else if (hasAuth) auth = config.auth;
  if (previous?.required && auth.required === undefined) {
    problems.push('auth.required in config.yaml is missing (it was on); set it to false to turn authentication off');
  }
  const requiredOk = auth.required === undefined || typeof auth.required === 'boolean';
  if (!requiredOk) problems.push('auth.required in config.yaml must be true or false');
  const typeOk = {};
  for (const key of ['apiKey', 'dashboardPasswordHash']) {
    typeOk[key] = auth[key] === undefined || auth[key] === null || typeof auth[key] === 'string';
    if (!typeOk[key]) problems.push(`auth.${key} in config.yaml must be a string`);
  }
  const required = auth.required === true;
  const apiKey = typeof auth.apiKey === 'string' ? auth.apiKey : '';
  const storedHash = typeof auth.dashboardPasswordHash === 'string' ? auth.dashboardPasswordHash : '';
  const hashValid = parseHash(storedHash) !== null;
  if (storedHash !== '' && !hashValid) {
    problems.push('auth.dashboardPasswordHash in config.yaml is not a hash made by "npm run set-dashboard-password"');
  }
  if (required) {
    const missing = [];
    if (typeOk.apiKey && !KEY_PATTERN.test(apiKey)) {
      missing.push(`auth.apiKey (at least ${MIN_KEY_LENGTH} printable characters without spaces; run "npm run set-api-key")`);
    }
    if (typeOk.dashboardPasswordHash && storedHash === '') {
      missing.push('auth.dashboardPasswordHash (run "npm run set-dashboard-password")');
    }
    if (missing.length) problems.push(`auth.required is true in config.yaml but it needs ${missing.join(' and ')}`);
  }

  if (config.server !== undefined && config.server !== null && !isMapping(config.server)) {
    problems.push('server in config.yaml must be a mapping');
  }
  const server = isMapping(config.server) ? config.server : {};
  for (const key of ['allowedHosts', 'publicOrigins']) {
    if (server[key] !== undefined && (!Array.isArray(server[key]) || server[key].some(item => typeof item !== 'string'))) {
      problems.push(`server.${key} in config.yaml must be a list of strings`);
    }
  }
  const publicOrigins = [];
  if (Array.isArray(server.publicOrigins)) {
    for (const entry of server.publicOrigins.filter(item => typeof item === 'string')) {
      try {
        const url = new URL(entry);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
        publicOrigins.push(url.origin);
      } catch (error) {
        problems.push('server.publicOrigins in config.yaml must hold origins such as https://dashboard.example.com');
        break;
      }
    }
  }
  if (problems.length) return refuse(problems);
  return { settings: {
    ...settingsOf(auth, server, hasAuth),
    required,
    apiKey,
    passwordHash: required ? storedHash : '',
    passwordTag: required ? sha256(storedHash).toString('hex') : '',
    publicOrigins,
  } };
}

function settingsOf(auth, server, hasAuth) {
  return {
    required: false,
    apiKey: '',
    passwordHash: '',
    passwordTag: '',
    hasAuth,
    host: typeof server.host === 'string' ? server.host : undefined,
    allowedHosts: server.allowedHosts || [],
    publicOrigins: [],
  };
}

// Settings that refuse everything: used when config.yaml was never usable.
const REFUSE_ALL = { required: true, apiKey: '', passwordHash: '', passwordTag: '', hasAuth: true, host: undefined, allowedHosts: [], publicOrigins: [] };

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
  problems.push(...(parsed.problems || []));
  const required = Boolean(parsed.settings?.required);
  const exposure = [];
  if (!isLoopbackHost(config.server?.host)) exposure.push(`server.host is ${config.server?.host}, not a loopback address`);
  if (config.cloudflare?.enabled) exposure.push('cloudflare.enabled is true');
  if (exposure.length && !required) {
    problems.push(`${exposure.join(' and ')}, so the dashboard is reachable from other machines: `
      + 'turn on authentication with auth.required: true (see "Authentication" in the README)');
  }
  return problems;
}

// What start-up checks before it listens or touches PM2: the config file loaded
// strictly, then listenProblems. `config` is null when the file could not be
// used. Also behind "npm run check-config", so the two cannot disagree.
function startupCheck(load = configHandler.loadConfigStrict) {
  let config;
  try {
    config = load();
  } catch (error) {
    return { config: null, problems: [error.message] };
  }
  return { config, problems: listenProblems(config) };
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

// Failed-attempt bookkeeping per client address: { count, last, blockedUntil, seen }
// where `seen` holds short hashes of the last few wrong tries. The table is
// capped: the entry touched longest ago goes first (an update re-inserts the
// entry at the end), and stale entries are swept at most once a minute.
function createThrottle(now, freeFailures, { maxClients = MAX_CLIENTS, repeatLimit = Infinity } = {}) {
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
    // A wrong try. `maxPauseMs` caps the pause for this client. The same wrong
    // try again counts toward `repeatLimit` (never, by default).
    fail(client, key, maxPauseMs = MAX_PAUSE_MS) {
      const time = now();
      sweep(time);
      let entry = clients.get(client);
      if (!entry || time - entry.last > FORGET_MS) entry = { count: 0, repeats: 0, last: time, blockedUntil: 0, seen: new Set() };
      const tag = sha256(key).toString('hex').slice(0, 16);
      if (entry.seen.has(tag)) {
        if (repeatLimit === Infinity) return; // nothing new was guessed
        entry.repeats += 1;
      } else {
        entry.seen.add(tag);
        if (entry.seen.size > REMEMBERED_WRONG_KEYS) entry.seen.delete(entry.seen.values().next().value);
        entry.count += 1;
      }
      entry.last = time;
      const over = Math.max(entry.count - freeFailures, entry.repeats - repeatLimit);
      if (over >= 0) entry.blockedUntil = time + Math.min(BASE_PAUSE_MS * 2 ** over, maxPauseMs);
      clients.delete(client);
      clients.set(client, entry);
      while (clients.size > maxClients) clients.delete(clients.keys().next().value);
    },
    // A right try outside a pause.
    succeed(client) {
      const entry = clients.get(client);
      if (entry && entry.blockedUntil <= now()) {
        entry.count = 0;
        entry.repeats = 0;
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
  logger = console,
  verify = verifyPassword,
} = {}) {
  // Keys and passwords are counted apart: a locked-out login must not slow down
  // the scripts that call the API from the same address, or the other way round.
  const keyThrottle = createThrottle(now, freeFailures);
  const loginThrottle = createThrottle(now, freeFailures, { repeatLimit: freeFailures * REPEAT_FACTOR });
  let verifying = 0; // password checks running now
  const clientOf = req => req.socket?.remoteAddress || 'unknown';
  const pauseCapFor = (req, auth) => (isLoopbackAddress(clientOf(req)) && auth.publicOrigins.length === 0
    && !hasProxyHeader(req) ? LOOPBACK_PAUSE_MS : MAX_PAUSE_MS);

  // One line per refused request: what was asked and by whom, never a secret,
  // a query string (an old client might put a key there) or a header.
  const logRefusal = (what, req) => {
    const target = String(req.path || '').replace(/[^\x21-\x7e]/g, '?').slice(0, 200);
    logger.warn?.(`TaskServer ${what} refused: ${req.method} ${target} from ${clientOf(req)}`);
  };

  // One read of config.yaml per request, shared by every check.
  const settingsFor = req => {
    if (!req.securitySettings) {
      req.securitySettings = loadAuth();
      if (!req.securitySettings.required && sessions.size) sessions.clear(); // auth switched off: forget every session
    }
    return req.securitySettings;
  };

  const keyMatches = (auth, given) => auth.apiKey !== '' && typeof given === 'string'
    && crypto.timingSafeEqual(sha256(given), sha256(auth.apiKey));

  // Live sessions: sha256(id) -> { expires, tag }. Only a hash of the id is kept.
  // `tag` identifies the password the session was made with, so changing the
  // password ends every session.
  const sessions = new Map();
  const idKey = id => sha256(id).toString('hex');
  const newSession = auth => {
    const time = now();
    for (const [key, session] of sessions) if (session.expires <= time) sessions.delete(key);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const id = crypto.randomBytes(32).toString('base64url');
    sessions.set(idKey(id), { expires: time + SESSION_MS, tag: auth.passwordTag });
    return id;
  };
  const sessionValid = (auth, id) => {
    const session = typeof id === 'string' && id ? sessions.get(idKey(id)) : undefined;
    if (!session) return false;
    if (session.expires <= now()) {
      sessions.delete(idKey(id));
      return false;
    }
    return auth.passwordTag !== '' && session.tag === auth.passwordTag;
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
      'Referrer-Policy': 'same-origin',
    });
    next();
  }

  // With authentication off, only loopback names are served.
  function hostGuard(req, res, next) {
    const auth = settingsFor(req);
    if (auth.required) return next();
    const name = hostNameOf(req.headers.host);
    const allowed = isLoopbackHost(name)
      || auth.allowedHosts.some(entry => entry.toLowerCase() === name)
      || (auth.host && !['0.0.0.0', '::'].includes(auth.host) && auth.host.toLowerCase() === name);
    if (!allowed) return res.status(403).type('text/plain').send('Host not allowed');
    next();
  }

  const wantsPage = req => req.method === 'GET' && !isApiPath(req.path)
    && String(req.headers.accept || '').includes('text/html');

  const tooMany = (res, seconds, message) => res.set('Retry-After', String(seconds)).status(429)
    .json({ error: 'Too Many Requests', message });

  // /api/* takes the X-API-Key header and nothing else.
  function authenticateApi(req, res, next, auth) {
    const given = req.headers['x-api-key'];
    if (given !== undefined) {
      // The key is checked first and a right one always works. A pause only
      // silences clients that keep sending wrong keys.
      if (keyMatches(auth, given)) {
        keyThrottle.succeed(clientOf(req));
        req.authMode = 'key';
        return next();
      }
      const seconds = keyThrottle.wait(clientOf(req));
      if (seconds) {
        logRefusal('API', req);
        return tooMany(res, seconds, 'Too many wrong keys; wait and try again');
      }
      keyThrottle.fail(clientOf(req), given, pauseCapFor(req, auth));
    }
    logRefusal('API', req);
    return res.status(401).json({ error: 'Unauthorized', message: 'Valid API key required' });
  }

  function authenticate(req, res, next) {
    const auth = settingsFor(req);
    req.authMode = 'off';
    res.locals.authRequired = auth.required;
    res.locals.csrfToken = csrfFor('');
    if (!auth.required) return next();
    if (isApiPath(req.path)) return authenticateApi(req, res, next, auth);

    // The dashboard: a session, never the API key.
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sessionValid(auth, id)) {
      req.authMode = 'session';
      req.sessionId = id;
      res.locals.csrfToken = csrfFor(id);
      req.csrfToken = res.locals.csrfToken;
      return next();
    }
    if (wantsPage(req)) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (!SAFE_METHODS.has(req.method)) logRefusal('dashboard', req);
    return res.status(401).json({ error: 'Unauthorized', message: 'Sign in required' });
  }

  // Does the request come from a page of this site? The Origin says so; when
  // there is none, the Referer does. Sec-Fetch-Site "none" (the user typing the
  // address) is not accepted: nobody types in a POST.
  //
  // `Origin: null` is no usable Origin. Browsers send it on a same-origin form
  // post when the Referrer-Policy is no-referrer, but also from sandboxed frames
  // and file:// pages. So it counts only when Sec-Fetch-Site says same-origin.
  function fromThisSite(req, auth) {
    const sameSite = value => {
      try {
        const url = new URL(value);
        return url.host === req.headers.host || auth.publicOrigins.includes(url.origin);
      } catch (error) {
        return false;
      }
    };
    const { origin, referer } = req.headers;
    if (origin !== undefined && origin !== 'null') return sameSite(origin);
    if (origin === undefined && referer !== undefined) return sameSite(referer);
    return req.headers['sec-fetch-site'] === 'same-origin';
  }

  function csrfGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method) || req.authMode === 'key') return next();
    // Without a key or a session in the way, a state change counts as a
    // browser's when it says so; a script that sends neither is let through
    // only while authentication is off (with it on, a session is required).
    const browser = req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined
      || req.authMode === 'session';
    if (!browser) return next();
    if (!fromThisSite(req, settingsFor(req))) {
      logRefusal('cross-site request', req);
      return res.status(403).type('text/plain').send('Cross-site request refused');
    }
    const token = req.body?._csrf ?? req.headers['x-csrf-token'];
    const expected = req.csrfToken ?? csrfFor('');
    if (typeof token !== 'string' || !safeEqual(token, expected)) {
      return res.status(403).type('text/plain').send('Missing or invalid CSRF token. Reload the page and try again.');
    }
    next();
  }

  // Sign in with the dashboard password. Mounted before authenticate.
  const loginRouter = express.Router();
  loginRouter.use('/login', express.urlencoded({ extended: false, limit: '4kb' }));
  loginRouter.get('/login', (req, res) => {
    const auth = settingsFor(req);
    const next = localPath(req.query.next);
    if (!auth.required || sessionValid(auth, parseCookies(req.headers.cookie)[SESSION_COOKIE])) return res.redirect(next);
    res.render('login', { next, error: null });
  });
  loginRouter.post('/login', asyncHandler(async (req, res) => {
    const auth = settingsFor(req);
    const next = localPath(req.body?.next);
    if (!auth.required) return res.redirect(next);
    // A login is a state change like any other: it has to come from this site.
    if (!fromThisSite(req, auth)) {
      logRefusal('cross-site request', req);
      return res.status(403).type('text/plain').send('Cross-site request refused');
    }
    const client = clientOf(req);
    const seconds = loginThrottle.wait(client);
    if (seconds) {
      logRefusal('login', req);
      return res.set('Retry-After', String(seconds)).status(429)
        .render('login', { next, error: `Too many wrong passwords. Wait ${seconds} s and try again.` });
    }
    const given = req.body?.password;
    let ok = false;
    if (typeof given === 'string' && given.length <= MAX_PASSWORD_LENGTH) {
      // Each check takes a lot of CPU and memory: only a few at a time, so a flood
      // of attempts cannot starve the server.
      if (verifying >= MAX_VERIFYING) {
        logRefusal('login', req);
        return res.set('Retry-After', '1').status(429)
          .render('login', { next, error: 'Too many sign-in attempts at once. Try again in a moment.' });
      }
      verifying += 1;
      try {
        ok = await verify(given, auth.passwordHash);
      } finally {
        verifying -= 1;
      }
    }
    if (!ok) {
      loginThrottle.fail(client, String(given ?? ''), pauseCapFor(req, auth));
      logRefusal('login', req);
      return res.status(401).render('login', { next, error: 'That password is not correct.' });
    }
    loginThrottle.succeed(client);
    res.set('Set-Cookie', sessionCookie(req, newSession(auth), SESSION_MS));
    res.redirect(next);
  }));

  // Mounted after csrfGuard. Signing out forgets the session on the server, so a
  // copy of the cookie stops working too.
  const sessionRouter = express.Router();
  sessionRouter.post('/logout', (req, res) => {
    if (req.sessionId) sessions.delete(idKey(req.sessionId));
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
  startupCheck,
  isLoopbackHost,
  localPath,
  PROXY_HEADERS,
  CONTENT_SECURITY_POLICY,
  SESSION_COOKIE,
  MIN_KEY_LENGTH,
};
