// Central error handling. Internal errors are logged with detail and shown generically;
// only errors explicitly marked `expose` reveal their message to the client.
import { createLogger } from '../lib/logger.js';

const log = createLogger('http');

export function notFoundHandler(req, res, next) {
  const err = new Error('page not found');
  err.status = 404;
  err.expose = true;
  next(err);
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = err.expose && status < 500 ? err.message : 'Internal server error';
  if (status >= 500) log.error('request failed', { method: req.method, url: req.originalUrl, error: err.message, stack: err.stack });
  else log.info('request rejected', { method: req.method, url: req.originalUrl, status, code: err.code, error: err.message });
  if (res.headersSent) return;
  res.status(status);
  if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
    return res.json({ error: { status, code: err.code ?? (status === 404 ? 'NOT_FOUND' : status >= 500 ? 'INTERNAL' : 'BAD_REQUEST'), message } });
  }
  return res.render('error', { title: `Error ${status}`, status, message, code: err.code });
}
