const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// The code leans on pieces of the pm2 package that are not public API
// (Client.executeRemote and the daemon's method names), and on what PM2 stores
// for a process. These tests fail when a pm2 upgrade changes any of that.

test('the installed pm2 exposes the client calls and daemon methods TaskServer uses', () => {
  const pm2 = require('pm2');
  const client = new pm2.custom();
  for (const method of ['connect', 'disconnect', 'list', 'start', 'stop', 'restart', 'delete']) {
    assert.equal(typeof client[method], 'function', method);
  }
  assert.equal(typeof client.Client.executeRemote, 'function');
  // (method, args, callback)
  assert.equal(client.Client.executeRemote.length, 3);
  const daemon = fs.readFileSync(require.resolve('pm2/lib/Daemon.js'), 'utf8');
  assert.match(daemon, /deleteProcessId\s*:\s*God\.deleteProcessId/);
  assert.match(daemon, /getVersion\s*:\s*God\.getVersion/);
  // Reading the source: loading God itself starts daemon timers that keep node alive.
  const actions = fs.readFileSync(require.resolve('pm2/lib/God/ActionMethods.js'), 'utf8');
  assert.match(actions, /God\.deleteProcessId\s*=\s*function\s*\(\s*id\s*,\s*cb\s*\)/);
  assert.match(actions, /God\.getVersion\s*=\s*function\s*\(\s*env\s*,\s*cb\s*\)/);
  // runCleanup treats exactly this message as "already gone".
  assert.match(actions, /id \+ ' : id unknown'/);
  // The kill timeout PM2 uses is the one stored on the running process, and the
  // kill signal comes from PM2_KILL_SIGNAL; the stop logic is built on both.
  const methods = fs.readFileSync(require.resolve('pm2/lib/God/Methods.js'), 'utf8');
  assert.match(methods, /pm2_env\.kill_timeout/);
  assert.match(require('fs').readFileSync(require.resolve('pm2/constants.js'), 'utf8'), /PM2_KILL_SIGNAL/);
});

test('package.json pins pm2 exactly, and the installed version is that one', () => {
  const pkg = require('../package.json');
  assert.match(pkg.dependencies.pm2, /^\d+\.\d+\.\d+$/, 'no range for pm2');
  assert.equal(require('pm2/package.json').version, pkg.dependencies.pm2);
});

test('against a real PM2 core: the service calls work and the stored fields match what reconcile compares', async () => {
  const probe = path.join(__dirname, '../test-support/pm2ContractProbe.js');
  const env = { ...process.env, SHELL: '/bin/sh' };
  delete env.PM2_HOME;
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, [probe], { env, timeout: 90000 }, (error, out, err) => {
      if (!/RESULT /.test(out)) return reject(new Error(`probe failed: ${error?.message}\n${out}\n${err}`));
      resolve(out);
    });
  });
  const result = JSON.parse(stdout.slice(stdout.lastIndexOf('RESULT ') + 7));
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.daemonVersion, result.libraryVersion);
  assert.equal(result.status, 'online');
  assert.ok(Object.values(result.fields).every(Boolean), JSON.stringify(result.fields));
  assert.deepEqual(result.diffAgainstRealPm2, [], 'a process started from a config compares equal to that config');
  assert.deepEqual(result.changedCommandDiff, ['args']);
  assert.deepEqual(result.changedEnvDiff, ['env.CONTRACT_N']);
  assert.equal(result.killTimeoutStored, 12345);
  // PM2 rewrites some shapes (a script with a space runs as `bash -c`, a bare
  // command is looked up on PATH): they must still compare equal to their config,
  // or every deploy would restart them.
  for (const [name, shape] of Object.entries(result.shapes)) {
    assert.equal(shape.status, 'online', name);
    assert.deepEqual(shape.diff, [], `${name} compares equal to its own config`);
    assert.equal(shape.changedDiff, true, `${name} still notices a real change`);
  }
  assert.equal(result.shapes['contract-spaced'].storedArgs, 2, 'PM2 stored bash -c <script>, not the configured args');
  assert.equal(result.cronCwdExpanded, true);
  assert.equal(result.cronRanInCwd, true, 'a cron run with a ~ cwd containing spaces ran in that directory');
  assert.equal(result.afterStop, 'stopped');
  assert.equal(result.afterRestart, 'online');
  assert.equal(result.afterDeleteById, 0);
  assert.equal(result.unknownIdError, result.unknownIdExpected);
});
