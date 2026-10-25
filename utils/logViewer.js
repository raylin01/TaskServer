// Utility for reading and listing log files.
//
// A log file is only ever reached through a job name and a bare file name that
// belongs to that job (`<job>-out-...` or `<job>-error-...`), and only inside
// the logs folder. Anything else is refused before the disk is touched.
const fs = require('fs');
const path = require('path');

const configHandler = require('./configHandler');

class LogAccessError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'LogAccessError';
    this.status = status;
  }
}

// Log files are named `<job>-out-<stamp>.log` and `<job>-error-<stamp>.log`.
function belongsTo(scriptName, filename) {
  return typeof scriptName === 'string' && scriptName.length > 0
    && (filename.startsWith(`${scriptName}-out-`) || filename.startsWith(`${scriptName}-error-`));
}

// The absolute path of a log file that belongs to `scriptName`, or a
// LogAccessError: 400 for a missing name, 403 for a name that is not one of the
// job's log files, 404 when the file does not exist.
function resolveLogFile(scriptName, filename) {
  if (typeof filename !== 'string' || filename === '') throw new LogAccessError(400, 'No file specified');
  if (filename.includes('\0') || filename.includes('/') || filename.includes('\\')
    || filename !== path.basename(filename) || !belongsTo(scriptName, filename)) {
    throw new LogAccessError(403, 'Access denied');
  }
  const logsDir = path.resolve(configHandler.getLogsDir());
  const filePath = path.join(logsDir, filename);
  if (path.dirname(filePath) !== logsDir) throw new LogAccessError(403, 'Access denied');
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw new LogAccessError(404, 'Log file not found');
    throw error;
  }
  // A link could point anywhere, so only plain files are served.
  if (!stats.isFile()) throw new LogAccessError(403, 'Access denied');
  return filePath;
}

function listLogs(scriptName) {
  const logsDir = configHandler.getLogsDir();
  if (!fs.existsSync(logsDir)) return [];

  return fs.readdirSync(logsDir)
    .filter(f => belongsTo(scriptName, f))
    .map(f => ({ name: f, stats: fs.lstatSync(path.join(logsDir, f)) }))
    .filter(({ stats }) => stats.isFile())
    .map(({ name, stats }) => ({
      name,
      mtime: stats.mtime,
      size: stats.size,
      sizeFormatted: formatBytes(stats.size)
    }))
    // Sort by modification time (newest first)
    .sort((a, b) => b.mtime - a.mtime);
}

function readLog(scriptName, filename, lines = 500) {
  const data = fs.readFileSync(resolveLogFile(scriptName, filename), 'utf8');
  // Return last N lines
  const allLines = data.split('\n');
  return allLines.slice(-lines).join('\n');
}

function readLogChunk(scriptName, filename, options = {}) {
  const data = fs.readFileSync(resolveLogFile(scriptName, filename), 'utf8');
  const allLines = data.split('\n');
  const totalLines = allLines.length;

  const { offset = 0, limit = 500, fromEnd = true } = options;

  let lines, startIndex, endIndex, hasMore;

  if (fromEnd) {
    // Reading from end (tail mode)
    startIndex = Math.max(0, totalLines - offset - limit);
    endIndex = totalLines - offset;
    lines = allLines.slice(startIndex, endIndex);
    hasMore = startIndex > 0;
  } else {
    // Reading from beginning
    startIndex = offset;
    endIndex = Math.min(totalLines, offset + limit);
    lines = allLines.slice(startIndex, endIndex);
    hasMore = endIndex < totalLines;
  }

  return {
    content: lines.join('\n'),
    totalLines,
    startLine: startIndex,
    endLine: endIndex,
    hasMore,
    loadedLines: lines.length
  };
}

function deleteLog(scriptName, filename) {
  fs.unlinkSync(resolveLogFile(scriptName, filename));
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

module.exports = { LogAccessError, resolveLogFile, listLogs, readLog, readLogChunk, deleteLog, getLogStats };
