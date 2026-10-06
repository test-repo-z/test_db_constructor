#!/usr/bin/env node
// npm run replay-mirror
// Rebuilds page_mirror (system time = Wikipedia time simulation) from the stored revisions.
import { createConnection } from '../src/db/pool.js';
import { replayMirror } from '../src/ingestion/replay.js';
import { createLogger } from '../src/lib/logger.js';
import { isMain } from '../src/lib/cli.js';

const log = createLogger('replay-cli');

if (isMain(import.meta.url)) {
  const conn = await createConnection();
  try {
    const r = await replayMirror(conn);
    const parts = await conn.query(
      `SELECT PARTITION_NAME AS p, PARTITION_DESCRIPTION AS upper_bound, TABLE_ROWS AS approx_rows
       FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'page_mirror'
       ORDER BY PARTITION_ORDINAL_POSITION`);
    console.log(`\nReplay #${r.replayId}: ${r.applied} revisions applied in ${r.seconds.toFixed(1)} s`);
    console.log('page_mirror partitions (history rows are routed by row_end):');
    for (const p of parts) console.log(`  ${p.p.padEnd(4)} ${String(p.upper_bound).padEnd(20)} ~${p.approx_rows} rows`);
  } catch (err) {
    log.error(err.message);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
}
