const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const { localOrigin, tunnelOrigin } = require('../utils/cloudflareTunnel');

test('tunnel origin maps wildcard binds to loopback and brackets IPv6', () => {
  for (const [address, expected] of [
    ['127.0.0.1', 'http://127.0.0.1:3911'],
    ['0.0.0.0', 'http://127.0.0.1:3911'],
    ['::', 'http://[::1]:3911'],
    ['::1', 'http://[::1]:3911'],
    ['192.168.1.20', 'http://192.168.1.20:3911'],
    ['fd00::20', 'http://[fd00::20]:3911'],
    ['fe80::1%en0', 'http://[fe80::1%25en0]:3911'],
  ]) {
    assert.equal(localOrigin({ address, port: 3911 }), expected, address);
  }
});

function listen(host) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => res.end('ok'));
    server.once('error', reject);
    server.listen(0, host, () => resolve(server));
  });
}

async function reachable(t, host) {
  let server;
  try {
    server = await listen(host);
  } catch (error) {
    t.diagnostic(`skipped ${host}: ${error.code}`);
    return;
  }
  t.after(() => server.close());
  const origin = localOrigin(server.address());
  const body = await new Promise((resolve, reject) => {
    http.get(origin, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data)); }).on('error', reject);
  });
  assert.equal(body, 'ok', `${host} -> ${origin}`);
}

test('the derived origin reaches a server bound to the default, wildcard and IPv6 hosts', async t => {
  for (const host of ['127.0.0.1', '0.0.0.0', '::', '::1']) await reachable(t, host);
});

test('the derived origin reaches a server bound to a specific interface address', async t => {
  const external = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal);
  if (!external) return t.skip('no non-loopback IPv4 address');
  await reachable(t, external.address);
});

test('a bare port, as a number or numeric string, means loopback; a URL is kept', () => {
  assert.equal(tunnelOrigin(3000), 'http://127.0.0.1:3000');
  assert.equal(tunnelOrigin('3000'), 'http://127.0.0.1:3000');
  assert.equal(tunnelOrigin('http://[::1]:3000'), 'http://[::1]:3000');
});
