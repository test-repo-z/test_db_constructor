// HTTP entry point. Uses the least-privilege web account when configured (SELECT only).
import { config } from './config/index.js';
import { createPool } from './db/pool.js';
import { createApp } from './app.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('server');
const pool = createPool({ user: config.db.webUser, password: config.db.webPassword, connectionLimit: 10 });
const app = createApp({ pool });

const server = app.listen(config.http.port, () => {
  log.info(`Wikipedia Time Machine listening on http://localhost:${config.http.port}`, { dbUser: config.db.webUser, database: config.db.database });
});

async function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
