# TaskServer

**TaskServer** is an always-on Node.js server for running and scheduling scripts with a web-based dashboard. It provides an easy way to manage long-running processes and scheduled cron jobs without the need for a database.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)

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
- [Security](#security)
- [Script Types](#script-types)
- [Web Dashboard](#web-dashboard)
- [Cloudflare Tunnel Setup](#cloudflare-tunnel-setup)
- [Log Management](#log-management)
- [API Endpoints](#api-endpoints)
- [Usage Examples](#usage-examples)
- [Troubleshooting](#troubleshooting)

## Installation

### Prerequisites

- Node.js >= 18
- [Bun](https://bun.sh) (the committed lockfile is `bun.lock`; use `bun install`)
- Python 3.x (if you plan to run Python scripts)

### Setup

1. **Clone the repository**:

```bash
git clone https://github.com/raylin01/TaskServer.git
cd TaskServer
```

2. **Install dependencies**:

```bash
bun install
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
    cwd: .
    args: []
    env: {}
```

2. **Start the server**:

```bash
npm start
```

3. **Open the dashboard**:

Navigate to `http://localhost:3000` in your browser.

## Self-Management & GitSync Integration
TaskServer supports self-updates via GitSync!

To enable this:
1.  **Install PM2**: `npm install -g pm2` (or use `npx pm2`).
2.  **Run with PM2**: You MUST start TaskServer using PM2 with the name `taskserver`.
    ```bash
    pm2 start server.js --name taskserver
    ```
3.  **Configure GitSync**: Add TaskServer to your GitSync config (see GitSync docs).

When updated, GitSync calls `POST /api/restart-script/taskserver` (with the `X-API-Key` header when `api.authEnabled` is on; see [Security](#security)). TaskServer answers first, then asks PM2 to restart it, so the caller always gets a clean reply. The PM2 name it restarts is `server.selfName` (default `taskserver`).

On `SIGINT` or `SIGTERM` TaskServer closes its own listener and exits within a second. It never stops the jobs it manages. If the port is still held by the previous instance it logs that, retries with a growing pause (about 20 s in total), then exits with an error.

## Restarts, Adoption and Slow Shutdowns

PM2 keeps running when TaskServer restarts, so jobs are normally already running at boot. TaskServer compares the config with `pm2 list` and only acts where it has to:

| What PM2 has | What TaskServer does |
|---|---|
| Nothing for this job | Starts it (unless the config says `stopped: true`) |
| `stopped` or `errored` | Starts it (unless `stopped: true`) |
| `online`, same effective config | Leaves it running (adopts it) |
| `online`, effective config changed | Restarts it and logs which fields changed (names only, never values) |
| `launching`, `waiting restart`, `stopping` | Leaves it to PM2 |
| `online`, but the config says `stopped: true` | Leaves it running and logs a warning. The dashboard shows the real state with a "marked stopped in config" note; press Stop to stop it for good |

"Effective config" is compared against the running process itself, in the form PM2 stores it. PM2 rewrites two shapes: a `path:` containing a space runs as `bash -c "<path>"` (any `args` are dropped by PM2), and a bare command such as `path: sleep` is looked up on `PATH`. TaskServer applies the same rewrite before comparing, so these jobs are adopted like any other. The compared fields are the executable, args, working directory, the env keys the job configures (by value), and `autorestart`, `max_restarts` and the restart delay. Log file paths and the kill timeout are ignored. An env key removed from the config is not noticed (PM2 mixes the starter's whole environment into the job's env, so a removed key cannot be told apart from an inherited one); it goes away on the next restart.

### Safety valve and shell differences

- **Too many changes at once.** If more than half of the running jobs, and more than two, look changed at boot, the cause is almost always the environment (the shell, a working directory) and not the config. TaskServer then restarts none of them, adopts them all, and warns with each job's changed field names. Restart a job yourself (or fix the config and reboot TaskServer) to apply its change. `pm2.reconcileMaxRestartFraction` (default `0.5`) sets the limit; `1` turns the check off.
- **Different shell.** A `command:` job runs through TaskServer's `$SHELL`. A job that was started under another shell (for example bash while TaskServer now runs under zsh) is not treated as changed; the log says "shell differs" at info level and the new shell applies at the job's next restart.
- **TaskServer itself.** A config entry named like TaskServer's own PM2 process (`server.selfName`, default `taskserver`) is skipped at boot with a warning, and the dashboard and API refuse to stop, start, restart or delete it (400).

### Stopping jobs that need time to shut down

PM2 signals a job (`SIGINT` by default), waits `kill_timeout`, then `SIGKILL`s it. For a job that needs longer to shut down cleanly (flush a file, close a connection), the default cuts it off. Set how long a job may take:

```yaml
pm2:
  killTimeoutMs: 5000          # default for every job

scripts:
  - name: Tunnel
    command: python3 tunnel.py
    type: forever
    killTimeoutMs: 30000       # this job gets 30 s
    stopCommand: python3 tunnel.py --stop   # optional, see below
```

New processes are started with that `kill_timeout`. PM2 uses the value stored on the *running* process, so for a process started before this setting existed TaskServer itself signals the process tree first, waits up to the job's timeout for it to exit, and only then asks PM2 to stop it. This applies to Stop, Restart, Delete and a config-change restart done from TaskServer. It does not apply to `pm2 stop` typed in a terminal. Changes to one job are applied one at a time (a GitSync restart, a click in the dashboard and the boot reconcile cannot step on each other); other jobs and the dashboard are not held up while a slow job shuts down.

**Jobs wrapped in `sudo` are not protected by `killTimeoutMs`.** TaskServer and PM2 run as a normal user, and a normal user cannot signal `sudo` (it is setuid root): the kernel answers `EPERM`, both for PM2's own signal and for TaskServer's. So for a `sudo`-wrapped job a longer `killTimeoutMs` does nothing, and the root child outlives the stop. When none of a job's processes can be signalled, TaskServer notices, does not wait out the timeout, logs it once, and leaves the stop to PM2. The only things that can stop such a job's root child are a root-side `stopCommand` (a `sudo -n ... --stop` entry allowed in sudoers) or a root runner that handles its own shutdown (for example by watching for its parent to go away). For other jobs, TaskServer signals the whole process tree, children first, the same way PM2 does, and processes it may not signal are skipped.

`stopCommand` (optional) runs through the shell, in the job's directory and env, before the stop. Its output is discarded, it gets the job's timeout, and a failure only logs a warning. Use it when a job needs more than a signal. It is the reliable way to stop a job that runs as root: for example `sudo -n /path/to/helper --stop`, which needs a sudoers entry for exactly that command.

For `pm2 stop` or a PM2 daemon restart from a terminal to be safe too, set `PM2_KILL_SIGNAL` and `PM2_KILL_TIMEOUT` in the environment the PM2 daemon starts with (for macOS, the LaunchAgent plist's `EnvironmentVariables`). If you set `PM2_KILL_SIGNAL`, set it to the same value for TaskServer too: TaskServer sends that signal itself when it stops a job whose stored kill timeout is shorter than the job's, so a mismatch would make the two stop paths behave differently.

## PM2 Client and Errors

All PM2 access goes through one long-lived client (`utils/processService.js`) with a queue for changes and a timeout on every call. If PM2 is unreachable the dashboard still loads (job states show as `unknown`), JSON API calls return `503`, and nothing crashes; at boot the reconcile step retries until PM2 answers. At start TaskServer warns if the `pm2` package version differs from the running daemon's. `package.json` pins `pm2` to the daemon's version for this reason: when you upgrade PM2 itself, change the pin and run `bun install`.

## Configuration

All configuration is done in the `config.yaml` file.

### Basic Structure

```yaml
# Log Management Settings
logManagement:
  autoDelete: true              # Enable automatic deletion of old logs
  retentionDays: 7             # Keep logs for 7 days
  checkInterval: 3600000       # Check every hour (in milliseconds)

# Server Settings (Optional)
server:
  port: 3000                   # Web interface port (default: 3000)
  host: "127.0.0.1"           # Loopback only by default, even when omitted
  logsDir: "./logs"            # Directory to store logs (default: ./logs)
  allowedHosts: []             # Extra Host names to serve when api.authEnabled is off (see Security)
  publicOrigins: []            # Exact origins (https://dashboard.example.com) a browser may post from, for a proxy that rewrites Host

# API Authentication (Optional, see Security)
api:
  authEnabled: false
  apiKey: ""

# PM2 Settings (Optional)
pm2:
  maxRestarts: 10000           # Max restarts before giving up (default: 10000)
  autoRestart: true            # Auto restart on crash (default: true)
  restartDelay: 1000           # Start with a 1 second exponential backoff for crashed forever scripts

# Cloudflare Tunnel Settings (Optional)
cloudflare:
  enabled: false                # Set to true to enable Cloudflare Tunnel
  tunnelToken: ""              # Your Cloudflare Tunnel token

# Scripts Configuration
scripts:
  - name: exampleForever
    path: ./scripts/exampleForever.js
    type: forever
    cwd: .                       # Optional working directory
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

TaskServer binds to `127.0.0.1` by default, including existing configurations
without `server.host`. To allow LAN access, explicitly set `server.host: "0.0.0.0"`
(all IPv4 interfaces); TaskServer then refuses to start unless `api.authEnabled`
is on (see [Security](#security)).

## Security

Anything that can reach TaskServer can run commands on the machine, so it is
locked down in layers.

**One check for every route.** With `api.authEnabled: true` every route needs the
API key, except the sign-in page and the static files in `public/`. Requests that
do not have it get a `401` (browsers are sent to `/login`).

- `api.authEnabled` must be `true` or `false` (not `"true"` or `yes`), and `api.apiKey`
  must be a string of at least 16 characters when auth is on. Generate one with
  `openssl rand -base64 24`.
- Programs send the key in the `X-API-Key` header. The key is **not** accepted in a
  URL (`?apiKey=` no longer works) and is compared in constant time.
- After 5 *different* wrong keys from one address (in the header or at `/login`),
  requests from it are refused with `429` for a pause that doubles from 1 s up to
  30 s, even with the right key (otherwise 429 against 200 would tell a guesser
  which key is right). The same wrong key sent again counts for nothing, so a
  client with an out-of-date key cannot lock anyone else out. A right key outside
  a pause starts the count again, and failures are forgotten after 10 quiet
  minutes. Clients on the loopback interface (scripts and consoles on the same
  machine) get a pause of at most 2 s, unless `server.publicOrigins` is set or the
  request carries proxy headers (`X-Forwarded-For` and similar): behind a proxy or
  tunnel every client has the proxy's address, so they share one count and the
  full 30 s ladder applies.
- The dashboard signs in at `/login` with the same key and then uses a random,
  `HttpOnly`, `SameSite=Strict` session cookie (7 days). Sessions are kept in memory:
  "Log out" ends one at once, and restarting TaskServer ends all of them. Changing
  the key ends them too. The cookie and the CSRF token are not derived from the key.
- The security settings TaskServer checked at start-up are in force from the first
  request. If `config.yaml` goes missing, becomes empty, is cut off, drops
  `api.authEnabled` while auth was on, or gets settings that make no sense while
  TaskServer runs, the last good settings stay in force (turn auth off by setting
  `api.authEnabled: false`, which also ends every session). Config writes are
  atomic (temporary file, flush, rename, flush the folder; a symbolic link is
  followed), and a write that fails is an error response, never a reported success.

**Requests from other web pages.** A page open in the same browser cannot make
TaskServer do anything:

- A state-changing request from a browser must come from the dashboard's own origin
  (its `Origin` is this server's own `Host`, or is listed in `server.publicOrigins`;
  `X-Forwarded-Host` is not used) and carry the CSRF token the dashboard pages embed
  (a hidden `_csrf` form field, or the `X-CSRF-Token` header).
  An `Origin: null` (which some browsers send for same-origin form posts, and
  sandboxed frames and local files always send) counts as no `Origin`: it is only
  accepted when the browser also says `Sec-Fetch-Site: same-origin`. Pages are sent
  with `Referrer-Policy: same-origin`.
- A request with a valid `X-API-Key` header is exempt: a web page cannot add that
  header, and scripts such as GitSync send no `Origin`. A program that sends no
  `Origin` and no cookie is treated as a script and is only let through when
  authentication is off.
- `/api` takes JSON. `POST /api/add-script` answers `415` to anything but
  `application/json`.
- With authentication off, only `localhost`, `127.0.0.1`, `[::1]` and the names in
  `server.allowedHosts` are served (protection against DNS rebinding).
- Pages are sent with a Content-Security-Policy that allows scripts only from
  TaskServer itself, plus `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`.

If TaskServer is behind a proxy that rewrites the `Host` header, list the address
people open in `server.publicOrigins` (for example `https://dashboard.example.com`),
or the dashboard's forms are refused with "Cross-site request refused".

**Logs.** The log viewer only serves files in the logs folder named
`<job>-out-<stamp>.log` or `<job>-error-<stamp>.log` for the job in the URL.
Anything else is refused, for viewing, downloading and deleting. A file is opened
without following links, and has to be a regular file with a single name
(no symbolic link, hard link or named pipe).

Dashboard pages that were open when TaskServer restarted carry an old CSRF token:
reload them before submitting a form.

**Start-up checks.** TaskServer exits instead of starting when `config.yaml`
cannot be parsed, when `api.authEnabled` is not a boolean, when `api.apiKey` is not
a string or (with auth on) is shorter than 16 characters, when `server.publicOrigins`
or `server.allowedHosts` are malformed, or when `server.host` is not a loopback
address or `cloudflare.enabled` is true while `api.authEnabled` is off. The message
names the config key and the reason.

### Recovering from a startup refusal

PM2 keeps restarting a process that exits at start-up and then leaves it
`errored`, so a refusal also stops anything that restarts TaskServer for you
(for example a deploy tool calling `POST /api/restart-script/taskserver`: nothing is
listening to answer it). To recover, on the host:

1. Read the reason: `pm2 logs taskserver --lines 20` shows
   `Refusing to start: ...`, naming the config key.
2. Fix `config.yaml` (the reason says what to change).
3. Run `pm2 restart taskserver` (use your `server.selfName` if you changed it).

Jobs that were already running keep running while TaskServer is down.

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
    cwd: .
    schedule: '*/5 * * * *'
    env:
      API_KEY: your-key
  
  # Monitor a service continuously
  - name: healthCheck
    command: ping -c 1 google.com && echo "Service is up"
    type: forever
    cwd: .
```

### Working Directory

Each script can optionally define `cwd` to control the working directory used by PM2:

```yaml
scripts:
  - name: myBunApp
    command: bun start
    type: forever
    cwd: ~/Documents/test
```

This avoids shell-specific `cd ... && ...` wrappers and works for both file-based scripts and command-based scripts. Relative paths are resolved from the TaskServer process directory, and `~` expands to your home directory.

### Crash Restart Backoff

Forever scripts use PM2 exponential backoff when restarting after a crash. The default starts at `1000ms`, then increases after repeated failures so immediate-exit commands do not create tight crash loops.

You can override it in `config.yaml`:

```yaml
pm2:
  restartDelay: 1000
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

Configure the named tunnel's origin service in Cloudflare as
`http://127.0.0.1:3000` (use your configured port). The built-in local origin follows
the address TaskServer actually bound to: `127.0.0.1` by default, `[::1]` for
`host: "::1"`, loopback for wildcard binds (`0.0.0.0`, `::`), and the configured
address otherwise. The default loopback bind works without LAN exposure.
TaskServer will not start with the tunnel enabled unless `api.authEnabled` is on
with an `api.apiKey`: visitors then sign in with that key (see [Security](#security)).
Cloudflare Access in front of it is still a good idea.

### Step 3: Start Your Server

```bash
npm start
```

The console will display your public URL:

```
TaskServer running at http://127.0.0.1:3000
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

### Finished run cleanup

Cron and manual run processes are removed from PM2 within about a minute after
stopping (the scan interval is 30 seconds). Running processes and forever jobs
are retained. On the first start after this update, TaskServer also removes old
stopped entries whose names match an exact configured job name followed by
`-cron-` or `-manual-` and a 13-digit timestamp. The cleanup log reports only the
number removed, and scan failures log the error message.

The sweep runs in the background and never delays scheduling or launches: cron
jobs are registered at boot, and the sweep itself starts only after the server
is listening and the jobs are reconciled. It works in chunks of 50 entries (at
most 1000 deletions per scan, with follow-up scans about a second apart while a
backlog remains). Each chunk is a separate PM2 operation, and anything already
waiting (a launch, a job restart) runs between chunks, so it waits for at most
one chunk. Inside a chunk the status of each entry is rechecked from a list
that is at most 25 deletes old, so a run someone restarts meanwhile is not killed;
an id that has already disappeared is skipped. Every PM2 call has a timeout, so a
lost reply cannot block launches; after a timeout the PM2 client is replaced with a
fresh one. If `pm2 start` times out, the run may still have started: the error says
so, the launch is never retried automatically, and the run is not recorded until a
later scan sees its process.

The latest run time and trigger of each job (plus the launch id that identifies the
newest run) are saved atomically in `.taskserver-run-history.json` next to
`config.yaml` before deletion. Keep that file writable and retain it across
restarts for the dashboard's last-run time. It contains no job commands or
environment variables. Entries for scripts that are no longer in `config.yaml` are
dropped at the next scan. If the file is empty, truncated or not a JSON object,
TaskServer logs one warning, renames it to `.taskserver-run-history.json.corrupt-<time>`
and starts with empty history. Overlapping runs keep separate log files, and an
older run finishing cannot replace the latest run. Log files remain subject to the
existing retention settings (7 days by default when automatic cleanup is enabled).
Cleanup scans reconnect and retry after PM2 errors, including runs that exit while
TaskServer is down.

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

These endpoints return JSON. When `api.authEnabled` is on they, like every other route, need the API key:

- `GET /api/scripts` - List all scripts with status as JSON
- `POST /api/restart-script/:scriptName` - Restart a forever script
- `POST /api/stop-script/:scriptName` - Stop a forever script
- `POST /api/start-script/:scriptName` - Start a forever script
- `POST /api/add-script` - Add a script (JSON body)

**Authentication** (optional, see [Security](#security)):

Enable in `config.yaml`:
```yaml
api:
  authEnabled: true
  apiKey: "your-secret-key"
```

Send the API key in the `X-API-Key` header (it is not accepted in a URL):
```bash
curl -X POST http://localhost:3000/api/restart-script/myScript \
  -H "X-API-Key: your-secret-key"
```

### Logs

- `GET /logs/:scriptName` - View logs page
- `GET /api/logs/:scriptName` - Get logs as JSON
- `GET /api/logs/:scriptName/chunk?file=filename` - Get a part of one log file
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

1. Restart the server: `npm start`  (TaskServer retries PM2 on its own at boot)
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
│   ├── styles.css        # Dashboard styles
│   └── *.js              # Dashboard scripts (no inline scripts: the CSP forbids them)
├── routes/               # Express routes
│   └── scripts.js        # Script management routes
├── scripts/              # Your scripts go here
│   ├── exampleForever.js
│   └── exampleCron.py
├── utils/                # Utility modules
│   ├── configHandler.js  # Config loading/saving (TASKSERVER_CONFIG overrides the path)
│   ├── processService.js # The one PM2 client: queue, timeouts, reconnect
│   ├── jobSpec.js        # PM2 config for a job; compare config with a running process
│   ├── jobControl.js     # Start/stop/replace jobs, slow-shutdown handling
│   ├── reconcile.js      # Boot-time adoption of running jobs
│   ├── logViewer.js      # Log listing and reading, limited to the job's own log files
│   ├── security.js       # Authentication, sign-in, CSRF and Host checks, start-up checks
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

## Tests

Dependencies are installed with `bun install` (`bun.lock` is the only lockfile). `pm2` is pinned to the daemon version, and `package.json` `overrides` pin patched releases of packages that PM2 and Express pull in; check `bun audit` before changing them.

Run `bun run test` (or `npm test`) with Node.js 18 or newer (uses the built-in `node --test` runner). The PM2 contract test runs a real PM2 core in a private temp directory; it never touches your PM2.
