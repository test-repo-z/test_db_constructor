#!/usr/bin/env node
// Blocks until MariaDB accepts connections (used by the app container and by CI-style runs).
import { createConnection } from '../src/db/pool.js';
import { createLogger } from '../src/lib/logger.js';

const log = createLogger('wait-db');
const deadline = Date.now() + Number(process.env.DB_WAIT_SECONDS ?? 120) * 1000;

for (let attempt = 1; ; attempt++) {
  try {
    const conn = await createConnection();
    const [{ v }] = await conn.query('SELECT VERSION() AS v');
    await conn.end();
    log.info('database is ready', { version: v, attempt });
    process.exit(0);
  } catch (err) {
    if (Date.now() > deadline) {
      log.error('database did not become ready in time', { error: err.message });
      process.exit(1);
    }
    log.info('waiting for database...', { attempt, error: err.code ?? err.message });
    await new Promise((r) => setTimeout(r, 2000));
  }
}
