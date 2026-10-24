const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const configHandler = require('../utils/configHandler');

test('host defaults to loopback for existing configs and respects explicit overrides', t => {
  const read = t.mock.method(fs, 'readFileSync');
  for (const [yaml, expected] of [
    ['scripts: []', '127.0.0.1'],
    ['server:\n  port: 3911', '127.0.0.1'],
    ['server:\n  host:', '127.0.0.1'],
    ['server:\n  host: 0.0.0.0', '0.0.0.0'],
    ['server:\n  host: "::1"', '::1'],
  ]) {
    read.mock.mockImplementation(() => yaml);
    assert.equal(configHandler.loadConfig().server.host, expected);
  }
});
