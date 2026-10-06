#!/usr/bin/env node
// npm run migrate [-- --database=name]
import { config } from '../src/config/index.js';
import { createConnection } from '../src/db/pool.js';
import { migrate } from '../src/db/migrator.js';
import { createLogger } from '../src/lib/logger.js';
import { isMain, parseArgs } from '../src/lib/cli.js';

const log = createLogger('migrate');

export async function runMigrations(database = config.db.database) {
  const conn = await createConnection({ database, multipleStatements: true });
  try {
    const applied = await migrate(conn, { log });
    log.info(applied.length ? `applied ${applied.length} migration(s)` : 'schema is up to date', { database });
    return applied;
  } finally {
    await conn.end();
  }
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  runMigrations(args.database || config.db.database).catch((err) => {
    log.error(err.message);
    process.exit(1);
  });
}
