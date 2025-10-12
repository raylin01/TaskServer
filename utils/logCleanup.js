// Utility for automatic log cleanup/rotation
const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '../logs');

function cleanupOldLogs(retentionDays) {
  if (!fs.existsSync(logsDir)) return;
  
  const now = Date.now();
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;
  let deletedSize = 0;
  
  try {
    const files = fs.readdirSync(logsDir);
    
    files.forEach(file => {
      const filePath = path.join(logsDir, file);
      const stats = fs.statSync(filePath);
      const age = now - stats.mtime.getTime();
      
      if (age > retentionMs) {
        try {
          fs.unlinkSync(filePath);
          deletedCount++;
          deletedSize += stats.size;
          console.log(`[Log Cleanup] Deleted old log: ${file} (age: ${Math.floor(age / (24 * 60 * 60 * 1000))} days)`);
        } catch (err) {
          console.error(`[Log Cleanup] Failed to delete ${file}:`, err.message);
        }
      }
    });
    
    if (deletedCount > 0) {
      console.log(`[Log Cleanup] Summary: Deleted ${deletedCount} log files, freed ${formatBytes(deletedSize)}`);
    } else {
      console.log(`[Log Cleanup] No old logs to delete (retention: ${retentionDays} days)`);
    }
    
    return { deletedCount, deletedSize };
  } catch (err) {
    console.error('[Log Cleanup] Error during cleanup:', err);
    return { deletedCount: 0, deletedSize: 0, error: err.message };
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function startAutoCleanup(retentionDays, checkInterval) {
  console.log(`[Log Cleanup] Auto-cleanup enabled: retention=${retentionDays} days, check interval=${checkInterval}ms`);
  
  // Run immediately on start
  cleanupOldLogs(retentionDays);
  
  // Then run periodically
  return setInterval(() => {
    cleanupOldLogs(retentionDays);
  }, checkInterval);
}

module.exports = { cleanupOldLogs, startAutoCleanup };
