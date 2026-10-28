#!/usr/bin/env node
'use strict';

// npm run set-api-key
//
// Makes a new random API key, stores it as auth.apiKey in config.yaml (written
// atomically, mode 600), and shows it once on the terminal so it can be copied
// into a password manager or the settings of the programs that call /api. It is
// never printed anywhere else and never put in a log or a command line. It does
// not turn authentication on: set auth.required yourself (see "Authentication"
// in the README).

const crypto = require('crypto');
const readline = require('readline');
const configHandler = require('../utils/configHandler');

function confirmWith(input, output) {
  return question => new Promise(resolve => {
    const lines = readline.createInterface({ input, output });
    lines.question(question, answer => {
      lines.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// The parameters are for tests; the command line uses the real terminal.
async function main({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, confirm = confirmWith(stdin, stdout) } = {}) {
  if (!stdin.isTTY || !stdout.isTTY) {
    stderr.write('set-api-key shows the new key once, so it must run in a terminal. Nothing was changed.\n');
    return 1;
  }
  const config = configHandler.readRawConfig() ?? {};
  if (typeof config !== 'object' || Array.isArray(config)) {
    stderr.write('config.yaml must be a mapping of settings. Nothing was changed.\n');
    return 1;
  }
  if (config.auth?.apiKey) {
    const ok = await confirm('An API key is already set. A new one stops the old one working for every program '
      + 'that uses it. Replace it? [y/N] ');
    if (!ok) {
      stdout.write('Nothing was changed.\n');
      return 0;
    }
  }

  const key = crypto.randomBytes(32).toString('base64url');
  // Re-read the file now: it may have changed while the question was open.
  configHandler.setAuthValues({ apiKey: key });

  // The key goes to the terminal and nowhere else, and only here.
  stdout.write(`
New API key (${configHandler.getConfigPath()} now holds it):

    ${key}

This is the only time it is shown. Copy it into a password manager now.
Programs send it in the X-API-Key header. It does not log anyone in to the dashboard.
`);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
