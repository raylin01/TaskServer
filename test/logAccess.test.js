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
  fs.symlinkSync(path.join(dir, 'config.yaml'), path.join(logsDir, 'Example Job-out-link.log'));
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
    'Example Job-out-link.log',             // a link to the config
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
