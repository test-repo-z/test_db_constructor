// MariaDB connection handling.
// Conventions enforced for EVERY connection:
//   * session time_zone '+00:00' — DATETIME application-time values and TIMESTAMP system-time
//     values are both read and written as UTC;
//   * dateStrings — temporal values come back as strings, so microsecond system timestamps
//     (row_start / row_end) are never truncated by JavaScript Date (millisecond precision);
//   * bigIntAsNumber — revision ids (~1.4e9) and counts are well below 2^53.
import mariadb from 'mariadb';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('db');

export function connectionOptions({ database = config.db.database, user = config.db.user,
  password = config.db.password, multipleStatements = false } = {}) {
  return {
    host: config.db.host,
    port: config.db.port,
    user,
    password,
    database,
    multipleStatements,
    dateStrings: true,
    bigIntAsNumber: true,
    insertIdAsNumber: true,
    decimalAsNumber: true,
    checkDuplicate: false,
    initSql: ["SET time_zone = '+00:00'"],
    connectTimeout: 10_000,
  };
}

export function createPool(opts = {}) {
  const pool = mariadb.createPool({ ...connectionOptions(opts), connectionLimit: opts.connectionLimit ?? 8, acquireTimeout: 15_000 });
  pool.on('error', (err) => log.error('pool error', { error: err.message }));
  return pool;
}

export async function createConnection(opts = {}) {
  return mariadb.createConnection(connectionOptions(opts));
}

/** Runs fn(conn) inside a transaction; commits on success, rolls back on any error. */
export async function withTransaction(poolOrConn, fn) {
  const isPool = typeof poolOrConn.getConnection === 'function';
  const conn = isPool ? await poolOrConn.getConnection() : poolOrConn;
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection may be gone */ }
    throw err;
  } finally {
    if (isPool) conn.release();
  }
}
