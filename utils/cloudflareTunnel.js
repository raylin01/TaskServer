// Cloudflare Tunnel utility
const { spawn } = require('child_process');
const path = require('path');

let tunnelProcess = null;
let tunnelUrl = null;

/**
 * Local origin the tunnel should forward to, from `server.address()`.
 * Wildcard binds (0.0.0.0, ::) are reached through loopback, and IPv6 hosts
 * are bracketed.
 * @param {{address: string, port: number}} address - Result of server.address()
 * @returns {string} - e.g. http://127.0.0.1:3000 or http://[::1]:3000
 */
function localOrigin({ address, port }) {
  let host = address;
  if (host === '0.0.0.0') host = '127.0.0.1';
  else if (host === '::') host = '::1';
  if (host.includes(':')) host = `[${host.replace('%', '%25')}]`;
  return `http://${host}:${port}`;
}

/**
 * Origin URL for startTunnel: a URL is used as given; a bare port (number or
 * numeric string such as "3000") means the loopback address.
 */
function tunnelOrigin(origin) {
  return /^\d+$/.test(String(origin)) ? `http://127.0.0.1:${origin}` : String(origin);
}

/**
 * Start a Cloudflare Tunnel with the provided token
 * @param {string} tunnelToken - The Cloudflare Tunnel token
 * @param {string|number} origin - Local origin URL to expose, e.g. from
 *   localOrigin(server.address()); a bare port means 127.0.0.1 (default: 3000)
 * @returns {Promise<string>} - Resolves with the tunnel URL
 */
function startTunnel(tunnelToken, origin = 3000) {
  return new Promise((resolve, reject) => {
    if (!tunnelToken || tunnelToken.trim() === '') {
      return reject(new Error('Cloudflare tunnel token is required'));
    }

    console.log('Starting Cloudflare Tunnel...');
    const originUrl = tunnelOrigin(origin);
    
    // Use cloudflared from node_modules
    const binaryName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const cloudflaredPath = path.join(__dirname, '..', 'node_modules', 'cloudflared', 'bin', binaryName);
    
    // Start cloudflared tunnel with token
    tunnelProcess = spawn(cloudflaredPath, [
      'tunnel',
      '--no-autoupdate',
      'run',
      '--token',
      tunnelToken,
      '--url',
      originUrl
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    let urlFound = false;

    tunnelProcess.stdout.on('data', (data) => {
      const str = data.toString().split(tunnelToken).join('[redacted]');
      output += str;
      console.log(`[Cloudflare Tunnel] ${str.trim()}`);
      
      // Look for the tunnel URL in the output
      // Cloudflared typically outputs: "Your quick tunnel is available at: https://..."
      const urlMatch = str.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !urlFound) {
        tunnelUrl = urlMatch[0];
        urlFound = true;
        console.log(`\n🌐 Cloudflare Tunnel URL: ${tunnelUrl}\n`);
        resolve(tunnelUrl);
      }
    });

    tunnelProcess.stderr.on('data', (data) => {
      const str = data.toString().split(tunnelToken).join('[redacted]');
      console.error(`[Cloudflare Tunnel Error] ${str.trim()}`);
      
      // Also check stderr for URL (cloudflared sometimes outputs here)
      const urlMatch = str.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !urlFound) {
        tunnelUrl = urlMatch[0];
        urlFound = true;
        console.log(`\n🌐 Cloudflare Tunnel URL: ${tunnelUrl}\n`);
        resolve(tunnelUrl);
      }
    });

    tunnelProcess.on('error', (error) => {
      console.error('Failed to start Cloudflare Tunnel:', error.message.split(tunnelToken).join('[redacted]'));
      reject(error);
    });

    tunnelProcess.on('exit', (code, signal) => {
      console.log(`Cloudflare Tunnel process exited with code ${code}, signal ${signal}`);
      tunnelProcess = null;
      tunnelUrl = null;
    });

    // Set a timeout in case URL is never found
    setTimeout(() => {
      if (!urlFound) {
        console.log('Cloudflare Tunnel started but URL not detected in output');
        resolve(null);
      }
    }, 15000); // Wait up to 15 seconds for URL
  });
}

/**
 * Stop the Cloudflare Tunnel
 */
function stopTunnel() {
  if (tunnelProcess) {
    console.log('Stopping Cloudflare Tunnel...');
    tunnelProcess.kill('SIGTERM');
    tunnelProcess = null;
    tunnelUrl = null;
  }
}

/**
 * Get the current tunnel URL
 * @returns {string|null} - The tunnel URL or null if not running
 */
function getTunnelUrl() {
  return tunnelUrl;
}

/**
 * Check if tunnel is running
 * @returns {boolean} - True if tunnel is running
 */
function isTunnelRunning() {
  return tunnelProcess !== null;
}

module.exports = {
  localOrigin,
  tunnelOrigin,
  startTunnel,
  stopTunnel,
  getTunnelUrl,
  isTunnelRunning
};
