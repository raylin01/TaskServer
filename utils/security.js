'use strict';

// Who may talk to TaskServer, and from where.
//
// One check sits in front of every route (only the login page and the static
// files in public/ are open):
//
//  - With `api.authEnabled: true` a request must carry the API key in the
//    `X-API-Key` header (scripts and other programs) or a signed session
//    cookie (the dashboard, after signing in at /login with the same key).
//    The key is never accepted in a URL, and is compared in constant time.
//  - A state-changing request from a browser must come from this site: its
//    Origin (or Sec-Fetch-Site) has to say so, and it has to carry the CSRF
//    token the dashboard pages embed. A request with a valid API key header
//    is exempt: a web page cannot add that header to a cross-site request.
//    Programs that send neither an Origin nor a cookie are not browsers and
//    are only let through when authentication is off.
//  - With authentication off, only loopback host names (and `server.allowedHosts`)
//    are served, so a page cannot reach TaskServer through DNS rebinding.
//  - If config.yaml cannot be read, the last good settings stay in force, and
//    with none, every request is refused.

const crypto = require('crypto');
const express = require('express');
const configHandler = require('./configHandler');

const SESSION_COOKIE = 'taskserver_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

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

function authSettings(config) {
  return {
    enabled: config.api?.authEnabled === true,
    apiKey: typeof config.api?.apiKey === 'string' ? config.api.apiKey : '',
    host: config.server?.host,
    allowedHosts: Array.isArray(config.server?.allowedHosts) ? config.server.allowedHosts.map(String) : [],
  };
}

// Settings that refuse everything: used when config.yaml was never readable.
const REFUSE_ALL = { enabled: true, apiKey: '', host: undefined, allowedHosts: [] };

// Reads the settings from config.yaml on each call (the file can change while
// running). A file that cannot be parsed does not switch protection off: the
// last good settings are used instead.
function createAuthSource({ load = configHandler.loadConfigStrict, logger = console } = {}) {
  let lastGood = null;
  let failing = false;
  return () => {
    try {
      lastGood = authSettings(load());
      failing = false;
    } catch (error) {
      if (!failing) {
        failing = true;
        logger.error?.(`[Security] ${error.message}; ${lastGood
          ? 'keeping the last good security settings'
          : 'refusing every request until it is fixed'}`);
      }
    }
    return lastGood || REFUSE_ALL;
  };
}

// Problems that must stop TaskServer from starting. Empty when it is safe.
function listenProblems(config) {
  const auth = authSettings(config);
  const problems = [];
  const keyMissing = auth.enabled && auth.apiKey.trim() === '';
  if (keyMissing) problems.push('api.authEnabled is true but api.apiKey is empty');
  const exposure = [];
  if (!isLoopbackHost(config.server?.host)) exposure.push(`server.host is ${config.server?.host}, not a loopback address`);
  if (config.cloudflare?.enabled) exposure.push('the Cloudflare Tunnel is enabled');
  if (exposure.length && !(auth.enabled && !keyMissing)) {
    problems.push(`${exposure.join(' and ')}, so the dashboard is reachable from other machines: `
      + 'set api.authEnabled: true and an api.apiKey in config.yaml');
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

// Only a path on this site: no other host, no protocol-relative link.
function localPath(value, fallback = '/scripts') {
  const text = typeof value === 'string' ? value : '';
  return /^\/(?![/\\])/.test(text) && !/[\r\n]/.test(text) ? text : fallback;
}

function createSecurity({
  loadAuth = createAuthSource(),
  csrfSecret = crypto.randomBytes(32),
  now = Date.now,
} = {}) {
  const keyMatches = (auth, given) => auth.apiKey !== '' && typeof given === 'string'
    && crypto.timingSafeEqual(sha256(given), sha256(auth.apiKey));

  const sign = (auth, expires) => hmac(auth.apiKey, `session|${expires}`);
  const newSession = auth => {
    const expires = now() + SESSION_MS;
    return `${expires}.${sign(auth, expires)}`;
  };
  const sessionValid = (auth, value) => {
    if (auth.apiKey === '' || typeof value !== 'string') return false;
    const [expires, signature = ''] = value.split('.');
    return /^\d+$/.test(expires) && Number(expires) > now() && safeEqual(signature, sign(auth, expires));
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
    const auth = loadAuth();
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

  function authenticate(req, res, next) {
    const auth = loadAuth();
    req.authMode = 'off';
    res.locals.authEnabled = auth.enabled;
    res.locals.csrfToken = csrfFor('');
    if (!auth.enabled) return next();

    const given = req.headers['x-api-key'];
    if (given !== undefined) {
      if (keyMatches(auth, given)) {
        req.authMode = 'key';
        return next();
      }
    } else {
      const session = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (sessionValid(auth, session)) {
        req.authMode = 'session';
        res.locals.csrfToken = csrfFor(session);
        req.csrfToken = res.locals.csrfToken;
        return next();
      }
    }
    if (wantsPage(req)) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return res.status(401).json({ error: 'Unauthorized', message: 'Valid API key required' });
  }

  // Does the request come from a page of this site?
  function fromThisSite(req) {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      try {
        return new URL(origin).host === req.headers.host;
      } catch (error) {
        return false;
      }
    }
    const site = req.headers['sec-fetch-site'];
    return site === 'same-origin' || site === 'none';
  }

  function csrfGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method) || req.authMode === 'key') return next();
    const browser = req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined
      || req.authMode === 'session';
    if (!browser) return next();
    if (!fromThisSite(req)) {
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
    const auth = loadAuth();
    const next = localPath(req.query.next);
    if (!auth.enabled || sessionValid(auth, parseCookies(req.headers.cookie)[SESSION_COOKIE])) return res.redirect(next);
    res.render('login', { next, error: null });
  });
  loginRouter.post('/login', (req, res) => {
    const auth = loadAuth();
    const next = localPath(req.body?.next);
    if (!auth.enabled) return res.redirect(next);
    if (req.headers.origin !== undefined && !fromThisSite(req)) {
      return res.status(403).type('text/plain').send('Cross-site request refused');
    }
    if (!keyMatches(auth, req.body?.apiKey)) {
      return res.status(401).render('login', { next, error: 'That key is not correct.' });
    }
    res.set('Set-Cookie', sessionCookie(req, newSession(auth), SESSION_MS));
    res.redirect(next);
  });

  // Mounted after csrfGuard.
  const sessionRouter = express.Router();
  sessionRouter.post('/logout', (req, res) => {
    res.set('Set-Cookie', sessionCookie(req, '', 0));
    res.redirect('/login');
  });

  return { headers, hostGuard, authenticate, csrfGuard, loginRouter, sessionRouter, csrfFor };
}

module.exports = {
  createSecurity,
  createAuthSource,
  listenProblems,
  isLoopbackHost,
  localPath,
  CONTENT_SECURITY_POLICY,
  SESSION_COOKIE,
};
