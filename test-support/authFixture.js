'use strict';

// Credentials for tests that turn authentication on. The password hash uses the
// smallest scrypt cost the format allows, so signing in costs a millisecond.

const crypto = require('crypto');

const KEY = 'example-key-0123456789-0123456789-abcdef';
const PASSWORD = 'example-dashboard-password';

function lowCostHash(password) {
  const salt = Buffer.alloc(16, 7);
  const hash = crypto.scryptSync(password, salt, 64, { N: 1024, r: 8, p: 1 });
  return `scrypt$1024$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

const HASH = lowCostHash(PASSWORD);
const AUTH = { auth: { required: true, apiKey: KEY, dashboardPasswordHash: HASH } };

module.exports = { KEY, PASSWORD, HASH, AUTH, lowCostHash };
