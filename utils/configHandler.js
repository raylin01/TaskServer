// Utility for loading and writing config.yaml
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

// TASKSERVER_CONFIG points at another file (tests, trial runs). Read on every
// call so it can be set after this module is loaded.
function getConfigPath() {
  return process.env.TASKSERVER_CONFIG || path.join(__dirname, '../config.yaml');
}

const DEFAULT_CONFIG = {
  logManagement: {
    autoDelete: false,
    retentionDays: 7,
    checkInterval: 3600000
  },
  server: {
    port: 3000,
    host: '127.0.0.1',
    logsDir: './logs',
    // The PM2 name TaskServer runs under, for restarting itself.
    selfName: 'taskserver'
  },
  pm2: {
    maxRestarts: 10000,
    autoRestart: true,
    restartDelay: 1000,
    // How long a job may take to exit after being asked to, before PM2
    // force-kills it. A job can set its own `killTimeoutMs`.
    killTimeoutMs: 5000
  },
  scripts: []
};

// A new copy every time: callers change the config they get (add a script,
// set a flag), and that must never change the defaults for the next caller.
const freshDefaults = () => structuredClone(DEFAULT_CONFIG);

function withDefaults(userConfig) {
  const defaults = freshDefaults();
  // Merge with defaults (simple version for this depth)
  const config = { ...defaults, ...userConfig };
  config.logManagement = { ...defaults.logManagement, ...(userConfig.logManagement || {}) };
  config.server = { ...defaults.server, ...(userConfig.server || {}) };
  config.server.host = config.server.host || defaults.server.host;
  config.pm2 = { ...defaults.pm2, ...(userConfig.pm2 || {}) };

  // Ensure scripts exists
  config.scripts = userConfig.scripts || [];

  return config;
}

// For reading: a config file that cannot be used is logged (without its text,
// which can hold secrets) and the defaults are returned. Never use the result
// to write the file back: use loadConfigStrict for that.
function loadConfig() {
  try {
    return loadConfigStrict();
  } catch (e) {
    console.error(`Failed to load config.yaml: ${e.message}`);
    return freshDefaults();
  }
}

// Where a YAML error is, without the offending text: that can hold secrets.
function describeParseError(error) {
  const mark = error?.mark;
  const where = mark ? ` at line ${mark.line + 1}, column ${mark.column + 1}` : '';
  return `${error?.reason || 'invalid YAML'}${where}`;
}

// The config file as YAML gave it (nothing merged in). `undefined` when the
// file does not exist. Anything else that goes wrong is an error whose message
// is safe to log: it never carries text from the file. An empty file is `null`.
function readRawConfig() {
  let file;
  try {
    file = fs.readFileSync(getConfigPath(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Could not read config.yaml: ${error.code || 'read error'}`);
  }
  try {
    return yaml.load(file) ?? null;
  } catch (error) {
    throw new Error(`config.yaml is not valid YAML: ${describeParseError(error)}`);
  }
}

// A config file that cannot be read or parsed is an error instead of an empty
// config. A missing or empty file is still the defaults. Start-up uses this, so
// a typo can never start TaskServer with settings it did not read, and every
// code path that writes the file back uses it, so a file that could not be read
// is never replaced with the defaults.
function loadConfigStrict() {
  const raw = readRawConfig();
  if (raw === undefined || raw === null) return freshDefaults();
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.yaml must be a mapping of settings');
  return withDefaults(raw);
}

function getLogsDir() {
  const config = loadConfig();
  const logsDir = config.server.logsDir || './logs';
  // return absolute path if it starts with /, otherwise resolve relative to CWD (root of project)
  // Assuming CWD is set correctly by PM2/Start script to project root.
  // If logsDir is relative, make it relative to project root (parent of utils)
  if (path.isAbsolute(logsDir)) {
    return logsDir;
  }
  return path.resolve(process.cwd(), logsDir);
}

// Replace the file in one step: the new text goes to a temporary file in the
// same folder, is flushed to disk, is renamed over the old file, and the folder
// is flushed too. The file is always mode 600. A reader (this process's auth
// check, or anything else) sees the whole old file or the whole new one, never
// a half-written one. If the config path is a symbolic link, the file it points
// to is the one replaced.
//
// A failed write is logged (without the file's text) and thrown, so a request
// that changes the config answers with an error instead of reporting a change
// that did not happen. The old file is left as it was.
function writeConfig(config) {
  let target = getConfigPath();
  try {
    target = fs.realpathSync(target);
  } catch (error) {
    // A new file: write at the path as given.
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    // config.yaml holds secrets (the API key, the password hash, tunnel token):
    // owner read/write only, whatever the umask or the old file's mode was.
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, yaml.dump(config));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (closeError) { /* already closed */ }
    }
    try { fs.unlinkSync(temp); } catch (unlinkError) { /* never created */ }
    console.error(`Failed to write config.yaml: ${e.code || e.message}`);
    throw new Error(`Could not write config.yaml: ${e.code || 'write error'}`);
  }
  // Make the rename itself durable. Not every platform can open a folder.
  try {
    const dir = fs.openSync(path.dirname(target), 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch (e) {
    if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(e.code)) {
      console.error(`Could not flush the config folder: ${e.code || e.message}`);
    }
  }
}

// Change the file as it is right now, and only what `change` touches: reads the
// raw settings (no defaults merged in), lets `change` edit them, and writes them
// back at once. Nothing is awaited in between, so a change made to the file while
// a command waited for a password is not lost. An unreadable file is an error.
function updateRawConfig(change) {
  const raw = readRawConfig() ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.yaml must be a mapping of settings');
  change(raw);
  writeConfig(raw);
}

// Set values in the auth section of the file as it is right now (see
// updateRawConfig), leaving everything else, including the rest of auth, alone.
// The section does not have to exist yet, and an old `api` section is left as it is.
function setAuthValues(values) {
  updateRawConfig(raw => {
    if (raw.auth !== undefined && raw.auth !== null && (typeof raw.auth !== 'object' || Array.isArray(raw.auth))) {
      throw new Error('auth in config.yaml must be a mapping');
    }
    raw.auth = { ...(raw.auth || {}), ...values };
  });
}

function ensureLogDir() {
  const logDir = getLogsDir();
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

// The name TaskServer itself runs under in PM2 (`server.selfName`).
function getSelfName(config = loadConfig()) {
  return config.server?.selfName || 'taskserver';
}

module.exports = { getConfigPath, loadConfig, loadConfigStrict, readRawConfig, writeConfig, updateRawConfig, setAuthValues, ensureLogDir, getLogsDir, getSelfName };
