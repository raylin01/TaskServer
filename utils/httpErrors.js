'use strict';

// Async route wrapper, the global error middleware and process-level error
// logging. Nothing here prints a request body, a config object or a stack
// message: those can carry commands, env values and tokens.

const { errorText, isUnavailable } = require('./processService');

// Express 4 does not catch a rejected promise from a handler.
function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };
}

function wantsJson(req) {
  return req.path.startsWith('/api/');
}

// Must be registered after the routes (four arguments make it an error handler).
function errorMiddleware(logger = console) {
  // eslint-disable-next-line no-unused-vars
  return (error, req, res, next) => {
    logger.error?.(`[HTTP] ${req.method} ${req.path} failed: ${errorText(error)}`);
    if (res.headersSent) return res.end();
    const status = error?.status && error.status >= 400 && error.status < 600
      ? error.status
      : (isUnavailable(error) ? 503 : 500);
    const message = status === 503 ? 'PM2 is not reachable right now' : errorText(error);
    if (wantsJson(req)) return res.status(status).json({ success: false, error: message });
    return res.status(status).type('text/plain').send(message);
  };
}

// Log the problem without secrets: the first line of the message and the code
// locations of the stack, nothing else.
function describeError(error) {
  const where = String(error?.stack || '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 5);
  return [`${error?.name || 'Error'}: ${errorText(error)}`, ...where].join('\n');
}

function installProcessHandlers({ logger = console, onFatal } = {}) {
  const rejection = reason => logger.error?.(`[Process] Unhandled rejection: ${describeError(reason)}`);
  const exception = error => {
    logger.error?.(`[Process] Uncaught exception: ${describeError(error)}`);
    if (onFatal) onFatal(error);
  };
  process.on('unhandledRejection', rejection);
  process.on('uncaughtException', exception);
  return () => {
    process.off('unhandledRejection', rejection);
    process.off('uncaughtException', exception);
  };
}

module.exports = { asyncHandler, errorMiddleware, installProcessHandlers, describeError };
