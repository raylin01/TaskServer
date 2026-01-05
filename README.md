# TaskServer

**TaskServer** is an always-on Node.js server for running and scheduling scripts with a web-based dashboard. It provides an easy way to manage long-running processes and scheduled cron jobs without the need for a database.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen.svg)

## Features

- **Forever Scripts**: Run long-running scripts that automatically restart on failure
- **Cron Jobs**: Schedule scripts to run at specific intervals
- **Web Dashboard**: Monitor and manage all your scripts from a beautiful web interface
- **Log Management**: View, download, and automatically clean up old logs
- **Cloudflare Tunnel**: Securely access your dashboard from anywhere online
- **Configuration via YAML**: Simple configuration file for all settings
- **No Database Required**: Lightweight and easy to deploy
- **PM2 Integration**: Reliable process management using PM2
- **Modern UI**: Clean and responsive web interface

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Script Types](#script-types)
- [Web Dashboard](#web-dashboard)
- [Cloudflare Tunnel Setup](#cloudflare-tunnel-setup)
- [Log Management](#log-management)
- [API Endpoints](#api-endpoints)
- [Usage Examples](#usage-examples)
- [Troubleshooting](#troubleshooting)

## Installation

### Prerequisites

- Node.js >= 14.0.0
- npm or yarn
- Python 3.x (if you plan to run Python scripts)

### Setup

1. **Clone the repository**:

```bash
git clone https://github.com/raylin01/TaskServer.git
cd TaskServer
```

2. **Install dependencies**:

```bash
npm install
```

3. **Create your configuration file**:

```bash
cp config.example.yaml config.yaml
```

4. **Edit `config.yaml`** to add your scripts and configure settings:

```bash
nano config.yaml  # or use your preferred editor
```

## Quick Start

1. **Configure your scripts** in `config.yaml`:

```yaml
scripts:
  - name: myForeverScript
    path: ./scripts/myScript.js
    type: forever
    args: []
    env: {}
```

2. **Start the server**:

```bash
npm start
```

3. **Open the dashboard**:

Navigate to `http://localhost:3000` in your browser.

## Configuration

All configuration is done in the `config.yaml` file.

### Basic Structure

```yaml
# Log Management Settings
logManagement:
  autoDelete: true              # Enable automatic deletion of old logs
  retentionDays: 7             # Keep logs for 7 days
  checkInterval: 3600000       # Check every hour (in milliseconds)

# Cloudflare Tunnel Settings (Optional)
cloudflare:
  enabled: false                # Set to true to enable Cloudflare Tunnel
  tunnelToken: ""              # Your Cloudflare Tunnel token

# Scripts Configuration
scripts:
  - name: exampleForever
    path: ./scripts/exampleForever.js
    type: forever
    args: []
    env: {}
  
  - name: exampleCron
    path: ./scripts/exampleCron.py
    type: cron
    schedule: '0 * * * *'      # Run every hour (cron syntax)
    count: 5                    # Optional: limit number of runs
    args: ["--foo", "bar"]
    env: {FOO: "bar"}
```

## Script Types

TaskServer uses **PM2** under the hood, which automatically detects and runs scripts based on their file extension:

### Supported Script Types

| Extension | Interpreter | Example |
|-----------|------------|---------|
| `.js`, `.mjs`, `.cjs`, `.ts` | Node.js | `myScript.js` |
| `.py` | Python | `myScript.py` |
| `.sh` | Bash | `myScript.sh` |
| `.rb` | Ruby | `myScript.rb` |
| Any executable | Direct execution | `myBinary` |

**Note:** Make sure the required interpreter (Python, Ruby, etc.) is installed on your system and available in PATH.

### Forever Scripts

Forever scripts are long-running processes that will automatically restart if they crash.

```yaml
scripts:
  - name: myService
    path: ./scripts/service.js
    type: forever
    args: ["--port", "8080"]
    env:
      NODE_ENV: production
      API_KEY: your-api-key
```

**Use cases:**
- Web servers
- Background workers
- Message queue consumers
- Real-time data processors

### Cron Scripts

Cron scripts run on a schedule using cron syntax.

```yaml
scripts:
  - name: dailyBackup
    path: ./scripts/backup.sh
    type: cron
    schedule: '0 2 * * *'      # Run at 2 AM daily
    count: 100                  # Optional: stop after 100 runs
    args: ["--destination", "/backups"]
    env:
      BACKUP_PATH: /data
```

### Command Line Execution

You can run shell commands directly without needing a script file. Use `command` instead of `path`:

```yaml
scripts:
  # Run a webhook every 5 minutes
  - name: apiWebhook
    command: curl -X POST https://api.example.com/webhook -H "Content-Type: application/json"
    type: cron
    schedule: '*/5 * * * *'
    env:
      API_KEY: your-key
  
  # Monitor a service continuously
  - name: healthCheck
    command: ping -c 1 google.com && echo "Service is up"
    type: forever
```

**Common use cases:**
- API webhooks and HTTP requests (`curl`, `wget`)
- System commands (`echo`, `date`, `uptime`)
- Database backups (`mysqldump`, `pg_dump`)
- File operations (`rsync`, `cp`, `mv`)
- Chained commands using `&&` or `||`

**Cron Syntax:**
```
┌───────────── minute (0 - 59)
│ ┌───────────── hour (0 - 23)
│ │ ┌───────────── day of month (1 - 31)
│ │ │ ┌───────────── month (1 - 12)
│ │ │ │ ┌───────────── day of week (0 - 7) (Sunday = 0 or 7)
│ │ │ │ │
* * * * *
```

**Common patterns:**
- `* * * * *` - Every minute
- `0 * * * *` - Every hour
- `0 0 * * *` - Daily at midnight
- `0 0 * * 0` - Weekly on Sunday
- `0 0 1 * *` - Monthly on the 1st

## Web Dashboard

The web dashboard provides a comprehensive interface to manage your scripts.

### Available Pages

#### Scripts Overview (`/scripts`)
- View all configured scripts
- See real-time status (running, stopped, scheduled)
- Start, stop, or restart scripts
- View last run time for cron jobs
- Quick access to logs

#### Logs Viewer (`/logs/:scriptName`)
- View logs for any script
- Auto-refresh capability
- Download individual log files
- Delete old log files
- View log statistics (total size, file count)
- Syntax highlighting for better readability

#### Add Script (`/add-script`)
- Add new scripts through the web interface
- Configure all script parameters
- Choose between forever and cron types

#### Edit Script (`/edit-script/:scriptName`)
- Modify existing script configurations
- Update schedules, arguments, and environment variables

#### Settings (`/settings`)
- Configure log management settings
- Set up Cloudflare Tunnel
- Adjust retention policies

## Cloudflare Tunnel Setup

Access your TaskServer dashboard from anywhere on the internet using Cloudflare Tunnel.

### Step 1: Get a Cloudflare Tunnel Token

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access → Tunnels**
3. Click **Create a tunnel**
4. Choose **Cloudflared** and follow the setup
5. Copy your tunnel token

### Step 2: Configure in `config.yaml`

```yaml
cloudflare:
  enabled: true
  tunnelToken: "your-cloudflare-tunnel-token-here"
```

### Step 3: Start Your Server

```bash
npm start
```

The console will display your public URL:

```
TaskServer running at http://localhost:3000
Starting Cloudflare Tunnel...
Cloudflare Tunnel URL: https://xxx-xxx-xxx.trycloudflare.com
Dashboard accessible online at: https://xxx-xxx-xxx.trycloudflare.com
```

### Benefits

- **Secure Access**: No need to expose ports or configure firewall rules
- **HTTPS by Default**: Automatic SSL/TLS encryption
- **No Static IP Required**: Works from anywhere, even behind NAT
- **Free**: Cloudflare Tunnel is free to use

### Using cloudflared as a Managed Script

You can also run `cloudflared` as a TaskServer forever script to expose **other services** (like [GitSync](https://github.com/raylin01/GitSync) webhooks) to the internet:

```yaml
scripts:
  # Expose a service on port 4000 (e.g., GitSync webhook server)
  - name: my-tunnel
    command: cloudflared tunnel --url http://localhost:4000
    type: forever

  # Or use a named tunnel with a token for a permanent URL
  - name: my-named-tunnel
    command: cloudflared tunnel run --token YOUR_TUNNEL_TOKEN
    type: forever
```

**Quick tunnel** (auto-generated URL):
```bash
cloudflared tunnel --url http://localhost:4000
# Outputs: https://xxx-xxx-xxx.trycloudflare.com
```

**Named tunnel** (permanent custom domain):
1. Create a tunnel in [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Configure routing to your local service
3. Use the token in TaskServer config above

> **Tip**: Running cloudflared via TaskServer gives you auto-restart on failure, log management, and unified control over all your tunnels.

## Log Management

TaskServer automatically manages logs for all your scripts.

### Automatic Log Cleanup

Configure automatic deletion of old logs:

```yaml
logManagement:
  autoDelete: true              # Enable automatic cleanup
  retentionDays: 7             # Keep logs for 7 days
  checkInterval: 3600000       # Check every hour (1 hour = 3600000ms)
```

### Log Files

Logs are stored in the `logs/` directory with the following naming convention:

- **Forever scripts**: `{scriptName}-out-{timestamp}.log` and `{scriptName}-error-{timestamp}.log`
- **Cron scripts**: `{scriptName}-out-{timestamp}.log` and `{scriptName}-error-{timestamp}.log`

### Viewing Logs

- **Web Dashboard**: Navigate to `/logs/:scriptName`
- **Direct File Access**: Check the `logs/` directory

### Managing Logs

- **Download**: Click the download button in the logs viewer
- **Delete**: Click the delete button for individual log files
- **Auto-refresh**: Enable live log viewing in the dashboard

## API Endpoints

TaskServer provides REST API endpoints for programmatic access.

### Scripts (Web UI)

- `GET /scripts` - List all scripts with status
- `GET /add-script` - Show add script form
- `POST /add-script` - Add a new script
- `GET /edit-script/:scriptName` - Show edit form
- `POST /edit-script/:scriptName` - Update a script
- `POST /delete-script/:scriptName` - Delete a script

### JSON API (Programmatic Access)

These endpoints return JSON and support optional API key authentication:

- `GET /api/scripts` - List all scripts with status as JSON
- `POST /api/restart-script/:scriptName` - Restart a forever script
- `POST /api/stop-script/:scriptName` - Stop a forever script
- `POST /api/start-script/:scriptName` - Start a forever script

**Authentication** (optional):

Enable in `config.yaml`:
```yaml
api:
  authEnabled: true
  apiKey: "your-secret-key"
```

Include the API key in requests:
```bash
# Via header
curl -X POST http://localhost:3000/api/restart-script/myScript \
  -H "X-API-Key: your-secret-key"

# Via query parameter
curl -X POST "http://localhost:3000/api/restart-script/myScript?apiKey=your-secret-key"
```

### Logs

- `GET /logs/:scriptName` - View logs page
- `GET /api/logs/:scriptName` - Get logs as JSON
- `GET /api/logs/:scriptName/download?file=filename` - Download log file
- `DELETE /api/logs/:scriptName/delete?file=filename` - Delete log file

### Settings

- `GET /settings` - View settings page
- `POST /settings` - Update settings

## Usage Examples

### Example 1: Forever Script (Node.js)

**Script: `scripts/webServer.js`**

```javascript
const express = require('express');
const app = express();
const port = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('Hello from TaskServer!');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
```

**Configuration:**

```yaml
scripts:
  - name: webServer
    path: ./scripts/webServer.js
    type: forever
    args: []
    env:
      PORT: 8080
      NODE_ENV: production
```

### Example 2: Cron Script (Python)

**Script: `scripts/dataSync.py`**

```python
#!/usr/bin/env python3
import sys
import datetime

def main():
    print(f"Running data sync at {datetime.datetime.now()}")
    # Your sync logic here
    print("Data sync completed!")

if __name__ == "__main__":
    main()
```

**Configuration:**

```yaml
scripts:
  - name: dataSync
    path: ./scripts/dataSync.py
    type: cron
    schedule: '0 */6 * * *'     # Every 6 hours
    args: []
    env: {}
```

### Example 3: Bash Script with Arguments

**Script: `scripts/backup.sh`**

```bash
#!/bin/bash
SOURCE=$1
DEST=$2
echo "Backing up from $SOURCE to $DEST"
tar -czf "$DEST/backup-$(date +%Y%m%d).tar.gz" "$SOURCE"
echo "Backup completed!"
```

**Configuration:**

```yaml
scripts:
  - name: backup
    path: ./scripts/backup.sh
    type: cron
    schedule: '0 3 * * *'       # Daily at 3 AM
    args: ["/data", "/backups"]
    env:
      BACKUP_RETENTION: "30"
```

## Troubleshooting

### Scripts Not Starting

1. **Check script path**: Ensure the path is correct and relative to the TaskServer root
2. **Check permissions**: Make sure scripts are executable (`chmod +x script.sh`)
3. **Check logs**: View logs in the dashboard for error messages
4. **Verify dependencies**: Ensure all required packages are installed

### Cloudflare Tunnel Issues

1. **Token not working**: Verify you copied the complete token from Cloudflare
2. **Tunnel not starting**: Check that `enabled: true` in config.yaml
3. **URL not showing**: Wait up to 15 seconds for the tunnel to establish

### Log Files Growing Too Large

1. Enable automatic log cleanup:
   ```yaml
   logManagement:
     autoDelete: true
     retentionDays: 3
   ```
2. Manually delete logs from the dashboard
3. Implement log rotation in your scripts

### PM2 Connection Errors

1. Restart the server: `npm start`
2. Clear PM2 processes: `pm2 kill` then restart
3. Check PM2 logs: `pm2 logs`

## Project Structure

```
TaskServer/
├── server.js              # Main server entry point
├── config.yaml            # Configuration file
├── package.json           # Dependencies
├── logs/                  # Log files directory
├── public/               # Static assets
│   └── styles.css        # Dashboard styles
├── routes/               # Express routes
│   └── scripts.js        # Script management routes
├── scripts/              # Your scripts go here
│   ├── exampleForever.js
│   └── exampleCron.py
├── utils/                # Utility modules
│   ├── configHandler.js  # Config loading/saving
│   ├── logViewer.js      # Log management
│   ├── logCleanup.js     # Automatic log cleanup
│   └── cloudflareTunnel.js # Cloudflare Tunnel integration
└── views/                # EJS templates
    ├── layout.ejs
    ├── scripts.ejs
    ├── logs.ejs
    ├── add-script.ejs
    ├── edit-script.ejs
    └── settings.ejs
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License.

## Acknowledgments

- Built with [Express.js](https://expressjs.com/)
- Process management by [PM2](https://pm2.keymetrics.io/)
- Scheduling with [node-cron](https://github.com/node-cron/node-cron)
- Cloudflare Tunnel support via [cloudflared](https://github.com/cloudflare/cloudflared)

## Support

If you encounter any issues or have questions, please open an issue on GitHub.
