const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { boot, request, job } = require('../test-support/httpApp');

// A name that breaks out of a JS string, an attribute and an element.
const PAYLOAD = `x');alert(1);"><img src=x onerror=alert(1)><script>alert(2)`;
const enc = encodeURIComponent;
const ROOT = path.join(__dirname, '..');

// The page must not contain the payload as markup. The escaped copies of it
// (shown as text or kept in an attribute) are harmless and are left out of the
// handler checks below.
function assertInert(page, where) {
  const html = page.split(ejs.escapeXML(PAYLOAD)).join('NAME').split(enc(PAYLOAD)).join('NAME');
  assert.doesNotMatch(html, /<img src=x/, `${where}: no injected element`);
  assert.doesNotMatch(html, /<script>alert/, `${where}: no injected script`);
  assert.doesNotMatch(html, /"><img/, `${where}: no attribute breakout`);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/, `${where}: the name is shown, escaped`);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${where}: no inline event handler`);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i, `${where}: no inline script`);
  assert.doesNotMatch(html, /javascript:/i, where);
}

test('a job name with markup and quotes is escaped on every page and never becomes script', async t => {
  const { base, logsDir } = await boot(t, { scripts: [job(PAYLOAD, { command: 'echo hi' }), job('Example Cron', { type: 'cron', schedule: '0 * * * *' })] });
  fs.writeFileSync(path.join(logsDir, `${PAYLOAD}-out-1.log`), 'text <b>not bold</b>\n');

  assertInert((await request(base, 'GET', '/scripts')).text, '/scripts');
  assertInert((await request(base, 'GET', `/edit-script/${enc(PAYLOAD)}`)).text, '/edit-script');
  const logs = await request(base, 'GET', `/logs/${enc(PAYLOAD)}`);
  assert.equal(logs.status, 200);
  assertInert(logs.text, '/logs');
});

test('the delete button carries the name as data, so it cannot end the confirm string', async t => {
  const { base } = await boot(t, { scripts: [job(PAYLOAD)] });
  const html = (await request(base, 'GET', '/scripts')).text;
  const form = html.match(/<form[^>]*data-confirm-delete="([^"]*)"[^>]*>/);
  assert.ok(form, 'delete form has the data attribute');
  assert.equal(form[1], PAYLOAD.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;'));
  assert.doesNotMatch(html, /onsubmit/);
  // Links to the job use an encoded name.
  assert.ok(html.includes(`href="/logs/${enc(PAYLOAD).replace(/'/g, '&#39;')}"`) || html.includes(`href="/logs/${enc(PAYLOAD)}"`));
});

test('the log viewer script gets its values from data attributes, not from script source', async t => {
  const { base, logsDir } = await boot(t, { scripts: [job(PAYLOAD)] });
  fs.writeFileSync(path.join(logsDir, `${PAYLOAD}-out-1.log`), 'x\n');
  const html = (await request(base, 'GET', `/logs/${enc(PAYLOAD)}`)).text;
  assert.match(html, /<main[^>]*id="logsApp"[^>]*data-script-name="x&#39;\);alert\(1\);&#34;&gt;/);
  assert.match(html, /<script src="\/logs\.js"><\/script>/);
});

test('page scripts never build HTML from strings or run text as code', () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.js')).map(f => path.join('public', f)),
    ...fs.readdirSync(path.join(ROOT, 'views')).filter(f => f.endsWith('.ejs')).map(f => path.join('views', f)),
    ...fs.readdirSync(path.join(ROOT, 'views/partials')).map(f => path.join('views/partials', f)),
  ];
  assert.ok(files.length > 10);
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, file);
    // views/layout.ejs is not used by any route.
    if (file.endsWith('.ejs') && !file.endsWith('layout.ejs')) {
      assert.doesNotMatch(source, /\son[a-z]+=/i, `${file} has an inline handler`);
      assert.doesNotMatch(source, /<script(?![^>]*\ssrc=)/i, `${file} has an inline script`);
      assert.doesNotMatch(source, /<%-(?!\s*include\()/, `${file} prints unescaped data`);
    }
  }
});

test('markup in a log file is shown as text', async t => {
  const { base, logsDir } = await boot(t, { scripts: [job('Example Job')] });
  fs.writeFileSync(path.join(logsDir, 'Example Job-out-1.log'), '<script>alert(3)</script>\n');
  const page = await request(base, 'GET', '/logs/Example%20Job');
  assert.doesNotMatch(page.text, /<script>alert\(3\)/);
  assert.match(page.text, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
});
