const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const express = require('express');
const { listenWithRetry } = require('../server');
const { asyncHandler, errorMiddleware, describeError } = require('../utils/httpErrors');

function occupy() {
  return new Promise(resolve => {
    const holder = net.createServer();
    holder.listen(0, '127.0.0.1', () => resolve(holder));
  });
}

test('a port that is still held is retried, with a clear message, until it frees up', async t => {
  const holder = await occupy();
  const port = holder.address().port;
  const lines = [];
  const logger = { error: m => lines.push(m) };
  setTimeout(() => holder.close(), 60);
  const server = await listenWithRetry(express(), port, '127.0.0.1', { attempts: 10, baseDelayMs: 20, maxDelayMs: 40, logger });
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(server.address().port, port);
  assert.ok(lines.length >= 1);
  assert.match(lines[0], new RegExp(`Port ${port} on 127\\.0\\.0\\.1 is already in use`));
});

test('after the last attempt the port error is reported once, with what to do', async t => {
  const holder = await occupy();
  t.after(() => new Promise(resolve => holder.close(resolve)));
  const lines = [];
  await assert.rejects(
    listenWithRetry(express(), holder.address().port, '127.0.0.1', { attempts: 3, baseDelayMs: 5, logger: { error: m => lines.push(m) } }),
    { code: 'EADDRINUSE' });
  assert.equal(lines.length, 3, '2 retries, then the final message');
  assert.match(lines.at(-1), /still in use after 3 attempts.*server\.port/);
});

test('shutdown while waiting for the port stops the retries', async t => {
  const holder = await occupy();
  t.after(() => new Promise(resolve => holder.close(resolve)));
  await assert.rejects(
    listenWithRetry(express(), holder.address().port, '127.0.0.1', { attempts: 50, baseDelayMs: 5, isClosed: () => true, logger: { error() {} } }),
    { code: 'EADDRINUSE' });
});

test('a rejected async handler becomes a response, not an unhandled rejection', async t => {
  const app = express();
  app.get('/boom', asyncHandler(async () => { throw new Error('first line\nsecret=abc'); }));
  app.use(errorMiddleware({ error() {} }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  const unhandled = [];
  const listener = reason => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/boom`);
  assert.equal(res.status, 500);
  assert.equal(await res.text(), 'first line');
  assert.deepEqual(unhandled, []);
});

test('error descriptions carry the first message line and code locations only', () => {
  const error = new Error('token=abc\nsecond line');
  const text = describeError(error);
  assert.match(text, /^Error: token=abc/);
  assert.doesNotMatch(text, /second line/);
});
