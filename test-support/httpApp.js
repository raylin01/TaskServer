'use strict';

// Boots the real Express app on a free port, with a temporary config.yaml, a
// temporary logs folder and a fake PM2.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { createFakePm2 } = require('./fakePm2');
const { createApp } = require('../server');
const { createSecurity } = require('../utils/security');

const fakeCron = () => ({
  cronRunHistory: {}, cronSuspended: {}, upsertScript() {}, unregisterScript() {}, setSuspended() {}, runNow: async () => {},
});

// `json` is sent as a JSON body, `form` as a urlencoded one, `raw` as given
// (with its own content-type in `headers`).
function request(base, method, url, { headers = {}, json, form, raw } = {}) {
  return new Promise((resolve, reject) => {
    let payload;
    const sent = { ...headers };
    if (json !== undefined) {
      payload = JSON.stringify(json);
      sent['content-type'] = 'application/json';
    } else if (form !== undefined) {
      payload = new URLSearchParams(form).toString();
      sent['content-type'] = 'application/x-www-form-urlencoded';
    } else if (raw !== undefined) {
      payload = raw;
    }
    if (payload !== undefined) sent['content-length'] = Buffer.byteLength(payload);
    const req = http.request(base + url, { method, headers: sent }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function boot(t, { scripts = [], extra = {}, setupPm2, prefix = 'taskserver-http-', securityOptions } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, 'config.yaml');
  const logsDir = path.join(dir, 'logs');
  fs.mkdirSync(logsDir);
  const config = { server: { logsDir }, pm2: { maxRestarts: 10000, autoRestart: true, restartDelay: 1000 }, scripts, ...extra };
  if (extra.server) config.server = { logsDir, ...extra.server };
  const write = value => fs.writeFileSync(file, yaml.dump(value));
  write(config);
  process.env.TASKSERVER_CONFIG = file;
  const pm2 = createFakePm2();
  setupPm2?.(pm2, config);
  const app = createApp({ processService: pm2, cronManager: fakeCron(), ...(securityOptions && { security: createSecurity(securityOptions) }) });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  t.after(() => { delete process.env.TASKSERVER_CONFIG; fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, pm2, app, dir, file, logsDir, config, write, saved: () => yaml.load(fs.readFileSync(file, 'utf8')) };
}

const job = (name, extra = {}) => ({ name, type: 'forever', command: `node ${name}.js`, cwd: os.tmpdir(), ...extra });

module.exports = { boot, request, job, fakeCron };
