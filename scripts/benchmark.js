#!/usr/bin/env node
// npm run benchmark [-- --suites=lookup,partition,storage --queries=2000 --reps=3 --scale=16 --keep-tables]
//
// Executes real queries against the ingested dataset and writes
//   benchmarks/results/<timestamp>.json   raw results (latency summaries, plans, counters, environment)
//   benchmarks/reports/<timestamp>.md     human-readable report (also copied to benchmarks/reports/latest.md)
// Nothing in the report is typed in by hand.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, ROOT_DIR } from '../src/config/index.js';
import { createConnection, createPool } from '../src/db/pool.js';
import { isMain, parseArgs } from '../src/lib/cli.js';
import { createLogger } from '../src/lib/logger.js';
import { lookupSuite, partitionSuite, storageSuite } from '../src/benchmark/suites.js';
import { renderReport } from '../src/benchmark/report.js';

const log = createLogger('benchmark');

async function environment(conn) {
  const [v] = await conn.query(`SELECT VERSION() AS version, @@innodb_buffer_pool_size AS buffer_pool, @@secure_timestamp AS secure_timestamp,
      @@innodb_page_size AS page_size, @@optimizer_switch AS optimizer_switch, @@version_compile_machine AS machine`);
  const [counts] = await conn.query(`SELECT (SELECT COUNT(*) FROM articles WHERE resolution_status IN ('resolved','redirect')) AS usable_articles,
      (SELECT COUNT(DISTINCT article_id) FROM revisions) AS ingested_articles, (SELECT COUNT(*) FROM revisions) AS revisions,
      (SELECT COUNT(*) FROM article_history) AS timeline_rows,
      (SELECT COUNT(*) FROM article_history FOR SYSTEM_TIME ALL) AS timeline_row_versions,
      (SELECT COUNT(*) FROM page_mirror FOR SYSTEM_TIME ALL) AS mirror_row_versions`);
  return {
    timestamp: new Date().toISOString(),
    mariadb: { version: v.version, innodb_buffer_pool_size: v.buffer_pool, innodb_page_size: v.page_size, secure_timestamp: v.secure_timestamp, machine: v.machine },
    client: { node: process.version, platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model, total_mem_bytes: os.totalmem() },
    connection: { host: config.db.host, port: config.db.port, note: 'client and server on the same machine; MariaDB in Docker Desktop (Linux VM)' },
    dataset: { ...counts, window: [config.dataset.windowStart.toISOString(), config.dataset.windowEnd.toISOString()] },
    cache: 'warm: every workload runs one un-timed warm-up pass first; the whole dataset fits in the InnoDB buffer pool. Cold-cache behaviour is NOT measured.',
  };
}

export async function main(args = parseArgs()) {
  const suites = String(args.suites ?? 'lookup,partition,storage').split(',');
  const conn = await createConnection();
  const pool = createPool({ connectionLimit: 2 });
  const started = Date.now();
  try {
    const out = { environment: await environment(conn), options: args, suites: {} };
    log.info('environment captured', out.environment.dataset);
    if (suites.includes('lookup')) {
      out.suites.lookup = await lookupSuite(conn, { queries: Number(args.queries ?? 2000), reps: Number(args.reps ?? 3) });
    }
    if (suites.includes('partition')) {
      out.suites.partition = await partitionSuite(conn, { scale: Number(args.scale ?? 16), reps: Number(args.reps ?? 3),
        pointQueries: Number(args['point-queries'] ?? 500), scanQueries: Number(args['scan-queries'] ?? 15) });
      // Free the disk space of the derived tables before the storage suite writes its own.
      if (!args['keep-tables']) for (const t of ['bench_stress_none', 'bench_stress_year', 'bench_stress_month']) await conn.query(`DROP TABLE IF EXISTS ${t}`);
    }
    if (suites.includes('storage')) {
      out.suites.storage = await storageSuite(conn, pool, { inlineArticles: Number(args['inline-articles'] ?? 5), keepTables: Boolean(args['keep-tables']) });
    }
    if (!args['keep-tables']) {
      for (const t of ['bench_mirror_flat', 'bench_stress_none', 'bench_stress_year', 'bench_stress_month']) await conn.query(`DROP TABLE IF EXISTS ${t}`);
    }
    out.durationSeconds = (Date.now() - started) / 1000;

    const stamp = out.environment.timestamp.replace(/[:.]/g, '-');
    const resultsDir = path.join(ROOT_DIR, 'benchmarks', 'results');
    const reportsDir = path.join(ROOT_DIR, 'benchmarks', 'reports');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.mkdirSync(reportsDir, { recursive: true });
    const jsonPath = path.join(resultsDir, `${stamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2) + '\n');
    const md = renderReport(out, path.relative(reportsDir, jsonPath));
    fs.writeFileSync(path.join(reportsDir, `${stamp}.md`), md);
    fs.writeFileSync(path.join(reportsDir, 'latest.md'), md);
    log.info('benchmark finished', { seconds: out.durationSeconds, json: path.relative(ROOT_DIR, jsonPath), report: 'benchmarks/reports/latest.md' });
  } finally {
    await conn.query('SET timestamp = DEFAULT').catch(() => {});
    await conn.end();
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => { log.error(err.stack ?? err.message); process.exit(1); });
}
