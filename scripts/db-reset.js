#!/usr/bin/env node
// npm run db:reset -- --yes [--database=name]
// DEVELOPMENT ONLY: drops every table of the target database, then re-applies migrations.
// Never run automatically; the application start-up path only ever applies pending migrations.
import { config } from '../src/config/index.js';
import { createConnection } from '../src/db/pool.js';
import { createLogger } from '../src/lib/logger.js';
import { isMain, parseArgs } from '../src/lib/cli.js';
import { runMigrations } from './migrate.js';
import { ident } from '../src/db/sql.js';

const log = createLogger('db-reset');

export async function dropAllTables(database) {
  const conn = await createConnection({ database });
  try {
    const tables = await conn.query(
      "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE','SYSTEM VERSIONED')",
      [database]);
    const views = await conn.query("SELECT TABLE_NAME AS t FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?", [database]);
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    // Names come from information_schema; ident() still refuses anything that is not a plain identifier.
    for (const { t } of views) await conn.query(`DROP VIEW IF EXISTS ${ident(t)}`);
    for (const { t } of tables) await conn.query(`DROP TABLE IF EXISTS ${ident(t)}`);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    return tables.length + views.length;
  } finally {
    await conn.end();
  }
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const database = args.database || config.db.database;
  if (!args.yes) {
    console.error(`This drops ALL tables (and their system-versioned history) in "${database}". Re-run with --yes to confirm.`);
    process.exit(2);
  }
  dropAllTables(database)
    .then((n) => { log.warn(`dropped ${n} tables/views`, { database }); return runMigrations(database); })
    .catch((err) => { log.error(err.message); process.exit(1); });
}
