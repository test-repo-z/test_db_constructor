import { createLogger } from '../lib/logger.js';

const log = createLogger('http');

/** One log line per request with status and latency (query strings included: they contain no secrets). */
export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    log.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
}
