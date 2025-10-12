// Example forever script that crashes every 5 minutes to test PM2 auto-restart
const fs = require('fs');
const path = require('path');

const startTime = Date.now();
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(__dirname, `../logs/exampleForever-custom-${timestamp}.log`);

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(logMessage.trim());
  fs.appendFileSync(logFile, logMessage);
}

log('=== exampleForever.js started ===');
log(`Process ID: ${process.pid}`);

// Simulate some work every 10 seconds
const interval = setInterval(() => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  log(`Still running... Uptime: ${uptime} seconds`);
  
  // Crash after 5 minutes (300 seconds)
  if (uptime >= 300) {
    log('!!! INTENTIONAL CRASH after 5 minutes !!!');
    clearInterval(interval);
    // Force crash
    throw new Error('Intentional crash to test PM2 auto-restart!');
  }
}, 10000);

// Handle graceful shutdown
process.on('SIGINT', () => {
  log('Received SIGINT, shutting down gracefully...');
  clearInterval(interval);
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down gracefully...');
  clearInterval(interval);
  process.exit(0);
});

log('Script initialized. Will crash in 5 minutes to test auto-restart.');
