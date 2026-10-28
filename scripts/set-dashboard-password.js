#!/usr/bin/env node
'use strict';

// npm run set-dashboard-password
//
// Asks for the dashboard password twice (hidden), and stores only a scrypt hash
// of it, with its salt and parameters, as auth.dashboardPasswordHash in
// config.yaml (written atomically, mode 600). The password is never printed or
// stored. It does not turn authentication on: set auth.required yourself (see
// "Authentication" in the README).

const configHandler = require('../utils/configHandler');
const { readHidden } = require('../utils/hiddenPrompt');
const { hashPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } = require('../utils/passwordHash');

// `prompt` and the streams are for tests; the command line uses the real terminal.
async function main({ prompt = readHidden, stdout = process.stdout, stderr = process.stderr } = {}) {
  const config = configHandler.readRawConfig() ?? {};
  if (typeof config !== 'object' || Array.isArray(config)) {
    stderr.write('config.yaml must be a mapping of settings. Nothing was changed.\n');
    return 1;
  }
  const password = await prompt(`New dashboard password (at least ${MIN_PASSWORD_LENGTH} characters): `);
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    stderr.write(`The password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters. Nothing was changed.\n`);
    return 1;
  }
  if (password !== await prompt('Type it again: ')) {
    stderr.write('The two passwords are not the same. Nothing was changed.\n');
    return 1;
  }

  const dashboardPasswordHash = await hashPassword(password);
  // Re-read the file now: it may have changed while the prompts were open.
  configHandler.setAuthValues({ dashboardPasswordHash });
  stdout.write(`Dashboard password saved to ${configHandler.getConfigPath()}. Everyone signed in to the dashboard has to sign in again.\n`);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
