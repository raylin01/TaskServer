'use strict';

// The one PM2 client for this process.
//
// Everything that talks to PM2 (routes, boot reconcile, cron launches, the run
// cleanup) goes through here. There is a single long-lived connection, never
// opened or closed per request. Reads (`list`) run straight away. Anything that
// changes PM2 state is queued and runs one operation at a time. Every call has
// a timeout, and a connection that stops answering is thrown away and replaced.

const pm2 = require('pm2');

// First line only and bounded, so logs never carry a config object or command.
function errorText(error) {
  const text = String(error?.message ?? error).split('\n')[0];
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

// A timeout means "no reply", which is not the same as "the daemon said no".
function timeoutError(message) {
  return Object.assign(new Error(message), { timeout: true, code: 'PM2_UNAVAILABLE' });
}

function unavailableError(error) {
  const wrapped = new Error(`PM2 is not reachable: ${errorText(error)}`);
  wrapped.code = 'PM2_UNAVAILABLE';
  return wrapped;
}

function isUnavailable(error) {
  return error?.code === 'PM2_UNAVAILABLE';
}

// The daemon says this for an id that is no longer in its table.
function isUnknownId(error, id) {
  return error?.message === `${id} : id unknown`;
}

// Names the service exposes to `exclusive()` work and how each one reaches PM2.
// `deleteById` and the others below call the daemon's own methods through the
// client's `Client.executeRemote` (private to the pm2 package; the contract
// test in test/pm2Contract.test.js pins it).
//  - deleteById: pm2.delete(id) first looks the number up as a process name and
//    as a namespace, and would delete a process named like the number. The
//    daemon method deletes exactly this numeric pm_id.
//  - version: the daemon's own version.
const REMOTE = {
  deleteById: (client, id, reply) => client.Client.executeRemote('deleteProcessId', id, reply),
  version: (client, reply) => client.Client.executeRemote('getVersion', {}, reply),
};

function createProcessService({
  // Makes a client. It must reach the default daemon (a plain `new pm2.custom()`).
  createClient = () => new pm2.custom(),
  connectTimeoutMs = 15000,
  // One call to the daemon. Stop/delete pass a larger limit of their own.
  rpcTimeoutMs = 60000,
  // A whole queued operation (several calls).
  operationTimeoutMs = 120000,
  disconnectTimeoutMs = 5000,
  logger = console,
} = {}) {
  let client = null;
  let connecting = null;
  let queue = Promise.resolve();
  let closed = false;

  function disconnect(target) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(limit);
        resolve();
      };
      const limit = setTimeout(finish, disconnectTimeoutMs);
      try {
        target.disconnect(finish);
      } catch (error) {
        finish();
      }
    });
  }

  // Drop a connection that cannot be trusted any more. The next call connects
  // a new one. Late replies from the old one are ignored.
  function abandon(target, reason) {
    if (client === target) {
      client = null;
      logger.warn?.(`[PM2] Dropping the PM2 connection (${reason}); the next call reconnects`);
    }
    disconnect(target).catch(() => {});
  }

  function connectedClient() {
    if (closed) return Promise.reject(new Error('PM2 service is closed'));
    if (client) return Promise.resolve(client);
    if (!connecting) {
      const fresh = createClient();
      connecting = new Promise((resolve, reject) => {
        let settled = false;
        const limit = setTimeout(() => {
          if (settled) return;
          settled = true;
          abandon(fresh, 'connect timed out');
          reject(timeoutError('PM2 connect timed out'));
        }, connectTimeoutMs);
        try {
          fresh.connect(error => {
            if (settled) {
              // Connected after we gave up: close it again.
              if (!error) disconnect(fresh).catch(() => {});
              return;
            }
            settled = true;
            clearTimeout(limit);
            if (error) {
              disconnect(fresh).catch(() => {});
              return reject(unavailableError(error));
            }
            if (closed) {
              disconnect(fresh).catch(() => {});
              return reject(new Error('PM2 service is closed'));
            }
            client = fresh;
            resolve(fresh);
          });
        } catch (error) {
          if (settled) return;
          settled = true;
          clearTimeout(limit);
          reject(unavailableError(error));
        }
      }).finally(() => { connecting = null; });
    }
    return connecting;
  }

  // One call with its own timeout. A reply that arrives later is ignored.
  function rpc(op, method, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (op.dead) return reject(new Error(`PM2 ${method} cancelled`));
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(limit);
        fn(value);
      };
      const limit = setTimeout(() => {
        op.timedOut = true;
        finish(reject, timeoutError(`PM2 ${method} timed out`));
      }, timeoutMs ?? rpcTimeoutMs);
      const reply = (err, result) => err
        ? finish(reject, err instanceof Error ? err : new Error(String(err)))
        : finish(resolve, result);
      try {
        if (REMOTE[method]) REMOTE[method](op.client, ...args, reply);
        else op.client[method](...args, reply);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function makeCall(op, timeoutMs) {
    return (method, ...args) => rpc(op, method, args, timeoutMs);
  }

  // Reads do not wait behind a slow stop.
  async function read(method, ...args) {
    const op = { dead: false, client: await connectedClient(), timedOut: false };
    try {
      return await rpc(op, method, args);
    } finally {
      op.dead = true;
      if (op.timedOut) abandon(op.client, `${method} timed out`);
    }
  }

  async function runOperation(work, { timeoutMs, rpcTimeoutMs: callTimeoutMs }) {
    const op = { dead: false, client: await connectedClient(), timedOut: false };
    let deadline;
    try {
      const body = (async () => work(makeCall(op, callTimeoutMs)))();
      body.catch(() => {});
      const expired = new Promise((resolve, reject) => {
        deadline = setTimeout(() => {
          op.timedOut = true;
          reject(timeoutError('PM2 operation timed out'));
        }, timeoutMs);
      });
      return await Promise.race([body, expired]);
    } catch (error) {
      if (error?.timeout) op.timedOut = true;
      throw error;
    } finally {
      // Stop further calls from this operation. After a timeout an abandoned
      // call could still complete late, so the connection is replaced.
      op.dead = true;
      clearTimeout(deadline);
      if (op.timedOut) abandon(op.client, 'operation timed out');
    }
  }

  // Operations run strictly one after another and none can hold the queue
  // forever.
  function exclusive(work, { timeoutMs = operationTimeoutMs, rpcTimeoutMs: callTimeoutMs } = {}) {
    const operation = queue.then(() => runOperation(work, { timeoutMs, rpcTimeoutMs: callTimeoutMs }));
    queue = operation.catch(() => {});
    return operation;
  }

  // A stop, delete or restart can take as long as the job's kill timeout.
  function limits(options) {
    if (!options?.timeoutMs) return {};
    return { timeoutMs: options.timeoutMs + 5000, rpcTimeoutMs: options.timeoutMs };
  }

  async function close() {
    closed = true;
    const target = client;
    client = null;
    if (target) await disconnect(target);
  }

  return {
    list: () => read('list'),
    start: (config, options) => exclusive(call => call('start', config), limits(options)),
    stop: (name, options) => exclusive(call => call('stop', name), limits(options)),
    restart: (name, options) => exclusive(call => call('restart', name), limits(options)),
    delete: (name, options) => exclusive(call => call('delete', name), limits(options)),
    deleteById: (id, options) => exclusive(call => call('deleteById', id), limits(options)),
    // The daemon's own version, read straight away like `list`.
    daemonVersion: () => read('version'),
    exclusive,
    close,
  };
}

module.exports = {
  createProcessService,
  errorText,
  timeoutError,
  isUnavailable,
  isUnknownId,
};
