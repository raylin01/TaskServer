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

// Log files are named `<job>-out-<stamp>.log` and `<job>-error-<stamp>.log`,
// where the stamp starts with a digit (a time or a run id) and does not itself
// contain "-out-" or "-error-". So job `foo` does not match the logs of a job
// called `foo-out-bar`.
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function belongsTo(scriptName, filename) {
  if (typeof scriptName !== 'string' || scriptName.length === 0) return false;
  return new RegExp(`^${escapeRegExp(scriptName)}-(?:out|error)-\\d(?:(?!-(?:out|error)-)[\\w.-])*\\.log$`).test(filename);
}

// Open the log file for reading and return { fd, size, path, stats }; the caller
// closes the fd. Errors are LogAccessErrors: 400 for a missing name, 403 for a name that is
// not one of the job's log files or a file that is not a plain, unlinked-once
// file, 404 when the file does not exist.
//
// The checks are made on the open descriptor, not on the path, so there is no
// gap between checking and reading: O_NOFOLLOW refuses a symbolic link, and
// fstat then has to say "regular file with one name" (a hard link to some other
// file, such as the config, has two). O_NONBLOCK keeps a named pipe from
// blocking the open. Not covered: a directory in the path of the logs folder
// being replaced by a link while the server runs (that needs write access to
// the folders above the logs folder).
function openLog(scriptName, filename) {
  if (typeof filename !== 'string' || filename === '') throw new LogAccessError(400, 'No file specified');
  if (filename.includes('\0') || filename.includes('/') || filename.includes('\\')
    || filename !== path.basename(filename) || !belongsTo(scriptName, filename)) {
    throw new LogAccessError(403, 'Access denied');
  }
  const logsDir = path.resolve(configHandler.getLogsDir());
  const filePath = path.join(logsDir, filename);
  if (path.dirname(filePath) !== logsDir) throw new LogAccessError(403, 'Access denied');
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (error) {
    if (error.code === 'ENOENT') throw new LogAccessError(404, 'Log file not found');
    if (['ELOOP', 'EMLINK', 'EISDIR', 'ENXIO', 'EACCES'].includes(error.code)) throw new LogAccessError(403, 'Access denied');
    throw error;
  }
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.nlink !== 1) throw new LogAccessError(403, 'Access denied');
    return { fd, size: stats.size, path: filePath, stats };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readWhole(scriptName, filename) {
  const { fd } = openLog(scriptName, filename);
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function listLogs(scriptName) {
  const logsDir = configHandler.getLogsDir();
  if (!fs.existsSync(logsDir)) return [];

  return fs.readdirSync(logsDir)
    .filter(f => belongsTo(scriptName, f))
    .map(f => ({ name: f, stats: fs.lstatSync(path.join(logsDir, f)) }))
    .filter(({ stats }) => stats.isFile() && stats.nlink === 1)
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
  const data = readWhole(scriptName, filename);
  // Return last N lines
  const allLines = data.split('\n');
  return allLines.slice(-lines).join('\n');
}

function readLogChunk(scriptName, filename, options = {}) {
  const data = readWhole(scriptName, filename);
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

// Delete one of the job's log files. The file is opened and checked first, and
// checked again by path right before the unlink to be sure the name still
// refers to the file that was checked. unlink never follows a link, so the worst
// a swap in the last instant can do is remove another name in the logs folder;
// that gap cannot be closed without unlinkat(2), which Node does not have.
function deleteLog(scriptName, filename) {
  const { fd, path: filePath, stats } = openLog(scriptName, filename);
  try {
    const again = fs.lstatSync(filePath);
    if (!again.isFile() || again.ino !== stats.ino || again.dev !== stats.dev || again.nlink !== 1) {
      throw new LogAccessError(403, 'Access denied');
    }
    fs.unlinkSync(filePath);
  } finally {
    fs.closeSync(fd);
  }
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

module.exports = { LogAccessError, openLog, listLogs, readLog, readLogChunk, deleteLog, getLogStats };
