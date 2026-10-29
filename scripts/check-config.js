#!/usr/bin/env node
'use strict';

// npm run check-config
//
// Loads config.yaml with the same strict checks TaskServer runs when it starts,
// prints OK or every problem it finds, and exits with 1 when there is one. It
// does not start the server, touch PM2 or change any file, so it is safe to run
// before an update or a restart, also while TaskServer is running. Problems name
// config keys only, never their values.
//
// TASKSERVER_CONFIG=/path/to/config.yaml npm run check-config   checks another file.

const fs = require('fs');
const configHandler = require('../utils/configHandler');
const { startupCheck } = require('../utils/security');

function main({ stdout = process.stdout, stderr = process.stderr } = {}) {
  const file = configHandler.getConfigPath();
  const { problems } = startupCheck();
  if (problems.length === 0) {
    stdout.write(fs.existsSync(file)
      ? `OK: ${file} passes the start-up checks.\n`
      : `OK: there is no ${file}, so the defaults are used, and they pass the start-up checks.\n`);
    return 0;
  }
  for (const problem of problems) stderr.write(`Problem: ${problem}\n`);
  stderr.write(`${problems.length} problem${problems.length === 1 ? '' : 's'} in ${file}: TaskServer would refuse to start.\n`);
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { main };
