const path = require('path');

function isAbsolutePath(value) {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function resolveScriptCwd(script) {
  if (!script.cwd || !String(script.cwd).trim()) {
    return process.cwd();
  }

  const cwd = String(script.cwd).trim();
  return isAbsolutePath(cwd) ? cwd : path.resolve(process.cwd(), cwd);
}

function getShellExecutable() {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe';
  }

  return process.env.SHELL || '/bin/sh';
}

function getShellArgs(command) {
  const mergedCommand = `${command} 2>&1`;

  if (process.platform === 'win32') {
    return ['/d', '/s', '/c', mergedCommand];
  }

  return ['-lc', mergedCommand];
}

function applyScriptExecution(pm2Config, script) {
  pm2Config.cwd = resolveScriptCwd(script);

  if (script.command) {
    pm2Config.script = getShellExecutable();
    pm2Config.args = getShellArgs(script.command);
  } else {
    pm2Config.script = script.path;
    pm2Config.args = script.args || [];
  }

  return pm2Config;
}

module.exports = {
  applyScriptExecution,
  resolveScriptCwd,
};
