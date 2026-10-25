const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { afterReply } = require('../utils/afterReply');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('runs after the reply is finished, once even if the socket then closes', async () => {
  const res = new EventEmitter();
  let runs = 0;
  afterReply(res, () => { runs += 1; }, { delayMs: 10 });
  await sleep(30);
  assert.equal(runs, 0, 'not before the reply is out');
  res.emit('finish');
  res.emit('close');
  await sleep(50);
  assert.equal(runs, 1);
});

test('runs when only close arrives (the client hung up early)', async () => {
  const res = new EventEmitter();
  let runs = 0;
  afterReply(res, () => { runs += 1; }, { delayMs: 10 });
  res.emit('close');
  res.emit('close');
  await sleep(50);
  assert.equal(runs, 1);
});
