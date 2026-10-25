const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProcessService, isUnavailable } = require('../utils/processService');

const quiet = { log() {}, warn() {}, error() {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A callback-style client like the pm2 package's, with hooks to misbehave.
function fakeClient(events, hooks = {}) {
  const client = {
    connect(cb) { events.push('connect'); hooks.connect ? hooks.connect(cb) : cb(null); },
    disconnect(cb) { events.push('disconnect'); cb?.(); },
    list(cb) { events.push('list'); hooks.list ? hooks.list(cb) : cb(null, [{ name: 'a' }]); },
    start(config, cb) { events.push(`start:${config.name}`); hooks.start ? hooks.start(config, cb) : cb(null, [{ name: config.name }]); },
    stop(name, cb) { events.push(`stop:${name}`); hooks.stop ? hooks.stop(name, cb) : cb(null); },
    delete(name, cb) { events.push(`delete:${name}`); cb(null); },
    restart(name, cb) { events.push(`restart:${name}`); cb(null); },
    Client: { executeRemote(method, arg, cb) {
      events.push(`remote:${method}`);
      cb(null, method === 'getVersion' ? '6.0.14' : undefined);
    } },
  };
  return client;
}

function setup(t, hooks, options = {}) {
  const events = [];
  const made = [];
  const service = createProcessService({
    createClient: () => { const c = fakeClient(events, hooks); made.push(c); return c; },
    logger: quiet,
    ...options,
  });
  t.after(() => service.close());
  return { service, events, made };
}

test('many calls share one connection; nothing connects or disconnects per call', async t => {
  const { service, events } = setup(t);
  await service.list();
  await service.start({ name: 'x' });
  await service.stop('x');
  await service.delete('x');
  await service.restart('x');
  await service.deleteById(7);
  assert.equal(await service.daemonVersion(), '6.0.14');
  await Promise.all([service.list(), service.list(), service.list()]);
  assert.equal(events.filter(e => e === 'connect').length, 1);
  assert.equal(events.includes('disconnect'), false);
  assert.ok(events.includes('remote:deleteProcessId'));
});

test('concurrent first calls connect once', async t => {
  const { service, events } = setup(t, { connect: cb => setTimeout(() => cb(null), 20) });
  await Promise.all([service.list(), service.list(), service.start({ name: 'x' })]);
  assert.equal(events.filter(e => e === 'connect').length, 1);
});

test('changes run one at a time, in order, while reads are not held up', async t => {
  const releases = [];
  const { service, events } = setup(t, { stop: (name, cb) => releases.push(cb) });
  const first = service.stop('slow');
  const second = service.start({ name: 'after' });
  await sleep(20);
  assert.deepEqual(events.filter(e => e.startsWith('stop') || e.startsWith('start')), ['stop:slow']);
  // A read goes straight through even though a stop is in progress.
  assert.deepEqual(await service.list(), [{ name: 'a' }]);
  releases.shift()(null);
  await first;
  await second;
  assert.deepEqual(events.filter(e => e.startsWith('stop') || e.startsWith('start')), ['stop:slow', 'start:after']);
});

test('an unreachable PM2 rejects with a recognisable error and the next call reconnects', async t => {
  let fail = true;
  const { service, events } = setup(t, { connect: cb => cb(fail ? new Error('ECONNREFUSED') : null) });
  await assert.rejects(service.list(), error => isUnavailable(error) && /not reachable/.test(error.message));
  await assert.rejects(service.start({ name: 'x' }), isUnavailable);
  fail = false;
  assert.deepEqual(await service.list(), [{ name: 'a' }]);
  assert.equal(events.filter(e => e === 'connect').length, 3);
});

test('a connect that never answers times out instead of hanging', async t => {
  const { service } = setup(t, { connect: () => {} }, { connectTimeoutMs: 20 });
  await assert.rejects(service.list(), error => error.timeout && isUnavailable(error));
});

test('a call that times out drops the connection; the next call uses a new one', async t => {
  let hang = true;
  const { service, made } = setup(t, { list: cb => { if (!hang) cb(null, [{ name: 'b' }]); } }, { rpcTimeoutMs: 25 });
  await assert.rejects(service.list(), /list timed out/);
  hang = false;
  assert.deepEqual(await service.list(), [{ name: 'b' }]);
  assert.equal(made.length, 2);
});

test('a hung change times out, frees the queue, and a late reply changes nothing', async t => {
  const stops = [];
  const { service } = setup(t, { stop: (name, cb) => stops.push(cb) }, { rpcTimeoutMs: 25 });
  await assert.rejects(service.stop('stuck'), /stop timed out/);
  stops[0](null);
  assert.deepEqual(await service.start({ name: 'next' }), [{ name: 'next' }]);
});

test('stop and delete accept a longer limit for slow jobs', async t => {
  const { service } = setup(t, { stop: (name, cb) => setTimeout(() => cb(null), 80) }, { rpcTimeoutMs: 25 });
  await assert.rejects(service.stop('slow'), /timed out/);
  await service.stop('slow', { timeoutMs: 500 });
});

test('daemon errors pass through untouched and are not treated as an outage', async t => {
  const { service, made } = setup(t, { start: (config, cb) => cb(new Error('Script not found: /x')) });
  await assert.rejects(service.start({ name: 'x' }), error => error.message === 'Script not found: /x' && !isUnavailable(error));
  await service.list();
  assert.equal(made.length, 1);
});

test('calls after close are refused', async t => {
  const { service } = setup(t);
  await service.list();
  await service.close();
  await assert.rejects(service.list(), /closed/);
});
