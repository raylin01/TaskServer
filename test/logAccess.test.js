const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, request, job } = require('../test-support/httpApp');

const SECRET = 'tunnel-token-do-not-leak';

// A config with something worth stealing next to the logs folder, and logs for
// two jobs whose names share a prefix.
async function bootWithLogs(t, scripts = [job('Example Job'), job('Example Job 2')], extra = {}) {
  const app = await boot(t, { scripts, extra: { cloudflare: { enabled: false, tunnelToken: SECRET }, ...extra } });
  fs.writeFileSync(path.join(app.logsDir, 'Example Job-out-1.log'), 'line one\nline two\n');
  fs.writeFileSync(path.join(app.logsDir, 'Example Job-error-1.log'), 'an error\n');
  fs.writeFileSync(path.join(app.logsDir, 'Example Job 2-out-1.log'), 'other job output\n');
  fs.writeFileSync(path.join(app.dir, 'notes.txt'), 'outside the logs folder\n');
  return app;
}

const enc = encodeURIComponent;

test('the log viewer refuses every file that is not one of the job\'s own logs', async t => {
  const { base, logsDir, dir } = await bootWithLogs(t);
  fs.symlinkSync(path.join(dir, 'config.yaml'), path.join(logsDir, 'Example Job-out-9.log'));
  fs.linkSync(path.join(dir, 'config.yaml'), path.join(logsDir, 'Example Job-out-8.log'));
  const refused = [
    '../config.yaml',
    '..%2Fconfig.yaml',
    '%2e%2e%2fconfig.yaml',
    path.join(dir, 'config.yaml'),
    'config.yaml',
    'notes.txt',
    'Example Job-out-/../../config.yaml',
    'Example Job-out-..\\..\\config.yaml',
    'Example Job-out-1.log\0.png',
    'Example Job 2-out-1.log',              // another job's log
    'Example Job-out-9.log',                // a symbolic link to the config
    'Example Job-out-8.log',                // a hard link to the config
    'Example Job-out-link.log',             // not a log name at all
    'Example Job',                          // the prefix alone is not a log
  ];
  for (const file of refused) {
    const query = `file=${file.includes('%') ? file : enc(file)}`;
    const urls = [
      `/logs/${enc('Example Job')}?${query}`,
      `/api/logs/${enc('Example Job')}?${query}`,
      `/api/logs/${enc('Example Job')}/chunk?${query}`,
      `/api/logs/${enc('Example Job')}/download?${query}`,
    ];
    for (const url of urls) {
      const res = await request(base, 'GET', url);
      assert.ok([400, 403, 404].includes(res.status) && res.status !== 200, `${url} -> ${res.status}`);
      assert.doesNotMatch(res.text, new RegExp(SECRET), url);
      assert.doesNotMatch(res.text, /outside the logs folder/, url);
      assert.doesNotMatch(res.text, /other job output/, url);
    }
  }
  assert.equal((await request(base, 'GET', `/logs/${enc('Example Job')}?file=${enc('../config.yaml')}`)).status, 403);
  assert.equal((await request(base, 'GET', `/api/logs/${enc('Example Job')}/chunk`)).status, 400, 'no file named');
});

test('deleting a log only removes the job\'s own log files', async t => {
  const { base, logsDir, dir } = await bootWithLogs(t);
  for (const file of ['../config.yaml', 'Example Job 2-out-1.log', 'notes.txt', '../notes.txt']) {
    const res = await request(base, 'DELETE', `/api/logs/${enc('Example Job')}/delete?file=${enc(file)}`);
    assert.equal(res.status, 403, file);
    assert.deepEqual(res.json(), { success: false, error: 'Access denied' });
  }
  assert.ok(fs.existsSync(path.join(dir, 'config.yaml')));
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')));
  assert.ok(fs.existsSync(path.join(logsDir, 'Example Job 2-out-1.log')));

  assert.equal((await request(base, 'DELETE', `/api/logs/${enc('Example Job')}/delete?file=${enc('Example Job-error-1.log')}`)).status, 200);
  assert.equal(fs.existsSync(path.join(logsDir, 'Example Job-error-1.log')), false);
  assert.equal((await request(base, 'DELETE', `/api/logs/${enc('Example Job')}/delete?file=${enc('Example Job-error-1.log')}`)).status, 404);
});

test('a job\'s own logs can be listed, read, chunked and downloaded; another job\'s logs are not listed with it', async t => {
  const { base } = await bootWithLogs(t);
  const list = (await request(base, 'GET', `/api/logs/${enc('Example Job')}`)).json();
  assert.deepEqual(list.logs.map(l => l.name).sort(), ['Example Job-error-1.log', 'Example Job-out-1.log']);
  const chunk = (await request(base, 'GET', `/api/logs/${enc('Example Job')}/chunk?file=${enc('Example Job-out-1.log')}`)).json();
  assert.match(chunk.content, /line one\nline two/);
  const download = await request(base, 'GET', `/api/logs/${enc('Example Job')}/download?file=${enc('Example Job-out-1.log')}`);
  assert.equal(download.status, 200);
  assert.match(download.headers['content-disposition'], /attachment; filename="Example Job-out-1.log"/);
  assert.equal(download.text, 'line one\nline two\n');
  const stats = (await request(base, 'GET', `/api/logs/${enc('Example Job')}/stats`)).json();
  assert.equal(stats.count, 2);
});

test('log file names with + & # % and spaces are encoded in every link and open', async t => {
  const name = 'Tom+Jerry & Co #1 100%';
  const { base, logsDir } = await bootWithLogs(t, [job(name)]);
  const files = [`${name}-out-2026-10-25.log`, `${name}-error-2026-10-25.log`];
  files.forEach((file, i) => fs.writeFileSync(path.join(logsDir, file), `content of file ${i}\n`));

  const page = await request(base, 'GET', `/logs/${enc(name)}`);
  assert.equal(page.status, 200);
  const hrefs = [...page.text.matchAll(/<a href="([^"]*\?file=[^"]*)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
  assert.equal(hrefs.length, 2);
  for (const file of files) {
    const expected = `/logs/${enc(name)}?file=${enc(file)}`;
    assert.ok(hrefs.includes(expected), `${expected} is linked`);
  }
  for (const href of hrefs) {
    const opened = await request(base, 'GET', href);
    assert.equal(opened.status, 200, href);
    assert.match(opened.text, /content of file [01]/);
  }
  // The same file named without encoding is not the file: `+` is a space.
  const plain = await request(base, 'GET', `/api/logs/${enc(name)}/chunk?file=${files[0]}`);
  assert.notEqual(plain.status, 200);
  const encoded = await request(base, 'GET', `/api/logs/${enc(name)}/chunk?file=${enc(files[0])}`);
  assert.equal(encoded.status, 200);
  assert.equal(encoded.json().content.trim(), 'content of file 0');
});

test('a log file that does not exist is "not found", not an empty log', async t => {
  const { base } = await bootWithLogs(t);
  const missing = enc('Example Job-out-999.log');
  const page = await request(base, 'GET', `/logs/${enc('Example Job')}?file=${missing}`);
  assert.equal(page.status, 404);
  assert.match(page.text, /Log file not found/);
  assert.doesNotMatch(page.text, /No log content/);
  const api = await request(base, 'GET', `/api/logs/${enc('Example Job')}/chunk?file=${missing}`);
  assert.equal(api.status, 404);
  assert.deepEqual(api.json(), { success: false, error: 'Log file not found' });
  assert.equal((await request(base, 'GET', `/api/logs/${enc('Example Job')}/download?file=${missing}`)).status, 404);
});

test('a job with no logs shows an empty page, not an error', async t => {
  const { base } = await bootWithLogs(t, [job('Quiet')]);
  const page = await request(base, 'GET', '/logs/Quiet');
  assert.equal(page.status, 200);
  assert.match(page.text, /No log files found/);
});

test('only <job>-(out|error)-<stamp>.log belongs to a job: job "foo" cannot reach the logs of "foo-out-bar"', async t => {
  const { base, logsDir } = await bootWithLogs(t, [job('foo'), job('foo-out-bar')]);
  fs.writeFileSync(path.join(logsDir, 'foo-out-1.log'), 'foo log\n');
  fs.writeFileSync(path.join(logsDir, 'foo-out-bar-out-2026-10-25T10-00-00-000Z.log'), 'bar log\n');
  fs.writeFileSync(path.join(logsDir, 'foo-out-bar-error-1792800000000.log'), 'bar error\n');
  fs.writeFileSync(path.join(logsDir, 'foo-out-bar.log'), 'not a log shape\n');
  fs.writeFileSync(path.join(logsDir, 'foo-out-1.txt'), 'wrong extension\n');
  const names = async job => (await request(base, 'GET', `/api/logs/${enc(job)}`)).json().logs.map(l => l.name).sort();
  assert.deepEqual(await names('foo'), ['foo-out-1.log']);
  assert.deepEqual(await names('foo-out-bar'), ['foo-out-bar-error-1792800000000.log', 'foo-out-bar-out-2026-10-25T10-00-00-000Z.log']);
  for (const file of ['foo-out-bar-out-2026-10-25T10-00-00-000Z.log', 'foo-out-bar.log', 'foo-out-1.txt']) {
    assert.equal((await request(base, 'GET', `/api/logs/foo/chunk?file=${enc(file)}`)).status, 403, file);
    assert.equal((await request(base, 'DELETE', `/api/logs/foo/delete?file=${enc(file)}`)).status, 403, file);
  }
  assert.equal((await request(base, 'GET', `/api/logs/foo-out-bar/chunk?file=${enc('foo-out-bar-error-1792800000000.log')}`)).status, 200);
});

test('a log file name that is a symbolic link, a hard link or a named pipe is not opened, read or deleted', async t => {
  const { base, logsDir, dir } = await bootWithLogs(t);
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'the secret\n');
  fs.symlinkSync(secret, path.join(logsDir, 'Example Job-out-20.log'));
  fs.linkSync(secret, path.join(logsDir, 'Example Job-out-21.log'));
  const files = ['Example Job-out-20.log', 'Example Job-out-21.log'];
  if (process.platform !== 'win32') {
    require('child_process').execFileSync('mkfifo', [path.join(logsDir, 'Example Job-out-22.log')]);
    files.push('Example Job-out-22.log');
  }
  for (const file of files) {
    for (const url of [`/api/logs/Example%20Job/chunk?file=${enc(file)}`, `/api/logs/Example%20Job/download?file=${enc(file)}`, `/logs/Example%20Job?file=${enc(file)}`]) {
      const res = await request(base, 'GET', url);
      assert.equal(res.status, 403, url);
      assert.doesNotMatch(res.text, /the secret/);
    }
    assert.equal((await request(base, 'DELETE', `/api/logs/Example%20Job/delete?file=${enc(file)}`)).status, 403, file);
  }
  assert.equal(fs.readFileSync(secret, 'utf8'), 'the secret\n');
  for (const file of files) assert.ok(fs.lstatSync(path.join(logsDir, file)), `${file} still there`);
  // The listing does not offer them either.
  const listed = (await request(base, 'GET', '/api/logs/Example%20Job')).json().logs.map(l => l.name);
  assert.ok(!listed.includes('Example Job-out-20.log'));
});

test('a log swapped for a link after the name was checked is still not followed', async t => {
  const { logsDir, dir } = await bootWithLogs(t);
  const logViewer = require('../utils/logViewer');
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'the secret\n');
  const log = path.join(logsDir, 'Example Job-out-30.log');
  fs.writeFileSync(log, 'plain log\n');
  assert.equal(logViewer.readLog('Example Job', 'Example Job-out-30.log'), 'plain log\n');
  // The swap happens between the name check and the open: the open itself refuses a link.
  const realOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...rest) => {
    if (file === log) { fs.unlinkSync(log); fs.symlinkSync(secret, log); }
    return realOpen(file, ...rest);
  });
  assert.throws(() => logViewer.readLog('Example Job', 'Example Job-out-30.log'), { status: 403 });
});

test('a download streams the checked file with its length, including an empty one', async t => {
  const { base, logsDir } = await bootWithLogs(t);
  fs.writeFileSync(path.join(logsDir, 'Example Job-out-40.log'), '');
  fs.writeFileSync(path.join(logsDir, 'Example Job-out-41.log'), 'x'.repeat(100000));
  const empty = await request(base, 'GET', `/api/logs/Example%20Job/download?file=${enc('Example Job-out-40.log')}`);
  assert.equal(empty.status, 200);
  assert.equal(empty.text, '');
  const big = await request(base, 'GET', `/api/logs/Example%20Job/download?file=${enc('Example Job-out-41.log')}`);
  assert.equal(big.headers['content-length'], '100000');
  assert.equal(big.text.length, 100000);
});

test('a download whose client goes away releases the file', async t => {
  const { base, logsDir } = await bootWithLogs(t);
  fs.writeFileSync(path.join(logsDir, 'Example Job-out-50.log'), Buffer.alloc(64 * 1024 * 1024, 'x'));
  const streams = [];
  const real = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (...args) => {
    const stream = real(...args);
    streams.push({ stream, closed: new Promise(resolve => stream.once('close', resolve)) });
    return stream;
  });
  const http = require('http');
  await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/logs/Example%20Job/download?file=${enc('Example Job-out-50.log')}`, { agent: false }, res => {
      res.once('data', () => { res.destroy(); resolve(); });
    });
    req.on('error', () => {});
    setTimeout(() => reject(new Error('no response')), 5000).unref();
  });
  assert.equal(streams.length, 1);
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('the file was not released')), 5000).unref());
  await Promise.race([streams[0].closed, timeout]);
  assert.equal(streams[0].stream.destroyed, true);
  // And the server still serves.
  assert.equal((await request(base, 'GET', '/api/logs/Example%20Job/stats')).status, 200);
});
