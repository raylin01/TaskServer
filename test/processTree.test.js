const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { defaultSignalTree, defaultIsAlive } = require('../utils/jobControl');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error('timed out');
}

// The two helpers the stop logic rests on, run against real processes: a shell
// whose child handles SIGINT (like a sudo wrapper's child) must receive the
// signal when only the shell's pid is given, and a pid that is gone is not alive.
test('real process tree: signalling the shell reaches its child, and liveness follows the pid', { skip: process.platform === 'win32' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskserver-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ready = path.join(dir, 'ready');
  const marker = path.join(dir, 'marker');
  const childFile = path.join(dir, 'child.js');
  fs.writeFileSync(childFile, `
    const fs = require('fs');
    process.on('SIGINT', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'got SIGINT'); process.exit(0); });
    fs.writeFileSync(${JSON.stringify(ready)}, '1');
    setInterval(() => {}, 1000);
  `);
  const shell = spawn('/bin/sh', ['-c', `"${process.execPath}" "${childFile}"; exit 0`], { stdio: 'ignore' });
  const exited = new Promise(resolve => shell.on('exit', resolve));
  t.after(() => { try { shell.kill('SIGKILL'); } catch (error) { /* gone */ } });

  await until(() => fs.existsSync(ready));
  assert.equal(defaultIsAlive(shell.pid), true);
  assert.equal(defaultIsAlive(process.pid), true);

  assert.equal(await defaultSignalTree(shell.pid, 'SIGINT'), true, 'reports that a signal was delivered');
  await Promise.race([exited, sleep(15000)]);

  assert.equal(fs.readFileSync(marker, 'utf8'), 'got SIGINT', 'the child, not only the shell, got the signal');
  await until(() => !defaultIsAlive(shell.pid));
  assert.equal(defaultIsAlive(shell.pid), false);
  // Signalling a pid that is gone does nothing and does not throw.
  assert.equal(await defaultSignalTree(shell.pid, 'SIGINT'), false, 'reports that nothing was delivered');
});
