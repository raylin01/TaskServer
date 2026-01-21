// Utility for loading and writing config.yaml
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const configPath = path.join(__dirname, '../config.yaml');

const DEFAULT_CONFIG = {
  logManagement: {
    autoDelete: false,
    retentionDays: 7,
    checkInterval: 3600000
  },
  server: {
    port: 3000,
    logsDir: './logs'
  },
  pm2: {
    maxRestarts: 10000,
    autoRestart: true
  },
  scripts: []
};

function loadConfig() {
  try {
    const file = fs.readFileSync(configPath, 'utf8');
    const userConfig = yaml.load(file) || {};
    
    // Deep merge with defaults (simple version for this depth)
    const config = { ...DEFAULT_CONFIG, ...userConfig };
    config.logManagement = { ...DEFAULT_CONFIG.logManagement, ...(userConfig.logManagement || {}) };
    config.server = { ...DEFAULT_CONFIG.server, ...(userConfig.server || {}) };
    config.pm2 = { ...DEFAULT_CONFIG.pm2, ...(userConfig.pm2 || {}) };
    
    // Ensure scripts exists
    config.scripts = userConfig.scripts || [];
    
    return config;
  } catch (e) {
    console.error('Failed to load config.yaml:', e);
    return DEFAULT_CONFIG;
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
    fs.writeFileSync(configPath, yaml.dump(config));
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

module.exports = { loadConfig, writeConfig, ensureLogDir, getLogsDir };
