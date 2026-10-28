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

function withDefaults(userConfig) {
  // Deep merge with defaults (simple version for this depth)
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  config.logManagement = { ...DEFAULT_CONFIG.logManagement, ...(userConfig.logManagement || {}) };
  config.server = { ...DEFAULT_CONFIG.server, ...(userConfig.server || {}) };
  config.server.host = config.server.host || DEFAULT_CONFIG.server.host;
  config.pm2 = { ...DEFAULT_CONFIG.pm2, ...(userConfig.pm2 || {}) };

  // Ensure scripts exists
  config.scripts = userConfig.scripts || [];

  return config;
}

function loadConfig() {
  try {
    const file = fs.readFileSync(getConfigPath(), 'utf8');
    return withDefaults(yaml.load(file) || {});
  } catch (e) {
    console.error('Failed to load config.yaml:', e);
    return DEFAULT_CONFIG;
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

// Like loadConfig, but a config file that cannot be read or parsed is an error
// instead of an empty config. A missing or empty file is still the defaults.
// Start-up uses this, so a typo can never start TaskServer with settings it
// did not read.
function loadConfigStrict() {
  const raw = readRawConfig();
  if (raw === undefined || raw === null) return DEFAULT_CONFIG;
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

module.exports = { getConfigPath, loadConfig, loadConfigStrict, readRawConfig, writeConfig, ensureLogDir, getLogsDir, getSelfName };
