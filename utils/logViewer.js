// Utility for reading and listing log files
const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '../logs');

function listLogs(scriptName) {
  if (!fs.existsSync(logsDir)) return [];
  
  return fs.readdirSync(logsDir)
    .filter(f => f.startsWith(scriptName))
    .map(f => {
      const stats = fs.statSync(path.join(logsDir, f));
      return {
        name: f,
        mtime: stats.mtime,
        size: stats.size,
        sizeFormatted: formatBytes(stats.size)
      };
    })
    // Sort by modification time (newest first)
    .sort((a, b) => b.mtime - a.mtime);
}

function readLog(filename, lines = 500) {
  const filePath = path.join(logsDir, filename);
  if (!fs.existsSync(filePath)) return '';
  const data = fs.readFileSync(filePath, 'utf8');
  // Return last N lines
  const allLines = data.split('\n');
  return allLines.slice(-lines).join('\n');
}

function getLogStats(scriptName) {
  const logs = listLogs(scriptName);
  return {
    count: logs.length,
    totalSize: logs.reduce((sum, log) => sum + log.size, 0),
    newest: logs.length > 0 ? logs[0] : null,
    oldest: logs.length > 0 ? logs[logs.length - 1] : null
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

module.exports = { listLogs, readLog, getLogStats };
