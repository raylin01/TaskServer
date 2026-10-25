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

// Like loadConfig, but a config file that cannot be read or parsed is an error
// instead of an empty config. A missing file is still the defaults. The
// security checks use this, so a typo can never switch authentication off.
function loadConfigStrict() {
  let file;
  try {
    file = fs.readFileSync(getConfigPath(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return DEFAULT_CONFIG;
    throw new Error(`Could not read config.yaml: ${error.code || 'read error'}`);
  }
  try {
    return withDefaults(yaml.load(file) || {});
  } catch (error) {
    throw new Error(`config.yaml is not valid YAML: ${describeParseError(error)}`);
  }
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

function writeConfig(config) {
  try {
    fs.writeFileSync(getConfigPath(), yaml.dump(config));
  } catch (e) {
    console.error('Failed to write config.yaml:', e);
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

module.exports = { loadConfig, loadConfigStrict, writeConfig, ensureLogDir, getLogsDir, getSelfName };
