// Forward-only SQL migrations: db/migrations/NNN_name.sql applied in lexical order and
// recorded in schema_migrations. Never destructive; safe to run on every start-up.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT_DIR } from '../config/index.js';

export const MIGRATIONS_DIR = path.join(ROOT_DIR, 'db', 'migrations');

export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return { version: file.slice(0, 3), file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/** Applies pending migrations using a connection opened with multipleStatements=true. */
export async function migrate(conn, { log, dir } = {}) {
  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    CHAR(3)      NOT NULL PRIMARY KEY,
    file       VARCHAR(255) NOT NULL,
    checksum   CHAR(64)     NOT NULL,
    applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
  ) ENGINE=InnoDB`);
  const applied = new Map((await conn.query('SELECT version, checksum, file FROM schema_migrations')).map((r) => [r.version, r]));
  const done = [];
  for (const m of listMigrations(dir)) {
    const prev = applied.get(m.version);
    if (prev) {
      if (prev.checksum !== m.checksum) {
        throw new Error(`migration ${m.file} was modified after being applied (checksum mismatch); write a new migration instead`);
      }
      continue;
    }
    log?.info(`applying ${m.file}`);
    // MariaDB DDL commits implicitly, so a migration is not atomic; each file is written so
    // that a failure leaves an obvious state, and the version row is recorded only on success.
    await conn.query(m.sql);
    await conn.query('INSERT INTO schema_migrations (version, file, checksum) VALUES (?, ?, ?)', [m.version, m.file, m.checksum]);
    done.push(m.file);
  }
  return done;
}
