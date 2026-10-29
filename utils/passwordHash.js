'use strict';

// Dashboard password hashing: scrypt, with a random salt, kept as one string in
// config.yaml:  scrypt$<N>$<r>$<p>$<salt, base64url>$<hash, base64url>
// The parameters travel with the hash, so they can be raised later without
// breaking hashes made earlier.

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const DEFAULT_PARAMS = { N: 65536, r: 8, p: 1 };
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MIN_N = 1024;
const MAX_N = 2 ** 18;
const MAX_R = 16;
const MAX_P = 16;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;

const memoryFor = ({ N, r }) => 256 * N * r; // scrypt needs about 128 * N * r bytes; allow double

// Splits a stored hash into its parts, or returns null when it is not one.
function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  if (!parts.slice(1, 4).every(part => /^\d+$/.test(part))) return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const hash = Buffer.from(parts[5], 'base64url');
  const valid = Number.isInteger(N) && Number.isInteger(r) && Number.isInteger(p)
    && N >= MIN_N && N <= MAX_N && (N & (N - 1)) === 0
    && r >= 1 && r <= MAX_R && p >= 1 && p <= MAX_P
    && salt.length >= SALT_BYTES && hash.length >= 32 && hash.length <= 128
    && parts[4] === salt.toString('base64url') && parts[5] === hash.toString('base64url');
  return valid ? { N, r, p, salt, hash } : null;
}

async function hashPassword(password, params = DEFAULT_PARAMS) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scrypt(String(password), salt, KEY_BYTES, { ...params, maxmem: memoryFor(params) });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

// True when `password` is the one `stored` was made from. Never throws on bad input.
async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  const { N, r, p, salt, hash } = parsed;
  const derived = await scrypt(password, salt, hash.length, { N, r, p, maxmem: memoryFor(parsed) });
  return crypto.timingSafeEqual(derived, hash);
}

module.exports = { hashPassword, verifyPassword, parseHash, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH };
