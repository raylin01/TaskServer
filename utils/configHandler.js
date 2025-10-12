// Utility for loading and writing config.yaml
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const configPath = path.join(__dirname, '../config.yaml');

function loadConfig() {
  try {
    const file = fs.readFileSync(configPath, 'utf8');
    return yaml.load(file);
  } catch (e) {
    console.error('Failed to load config.yaml:', e);
    return { scripts: [] };
  }
}

function writeConfig(config) {
  try {
    fs.writeFileSync(configPath, yaml.dump(config));
  } catch (e) {
    console.error('Failed to write config.yaml:', e);
  }
}

function ensureLogDir() {
  const logDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
  }
}

module.exports = { loadConfig, writeConfig, ensureLogDir };
