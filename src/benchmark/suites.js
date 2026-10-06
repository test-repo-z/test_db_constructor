// Benchmark suites. Every number comes from queries executed by this code; nothing is estimated
// except where a value is explicitly labelled as an extrapolation.
import { measure, plans, prng } from './measure.js';
import { datasetCoverage, toSql } from '../temporal/time.js';
import { ContentRepository } from '../repositories/contentRepository.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('bench');
const SYSTEM_MAX = "TIMESTAMP'2106-02-07 06:28:15.999999'";

function randomInstants(rand, n, startMs, endMs) {
  return Array.from({ length: n }, () => toSql(new Date(startMs + Math.floor(rand() * ((endMs - startMs) / 1000)) * 1000)));
}

// ------------------------------------------------------------------------------------------
// Suite 1: "which revision was live at T?" — strategies on the REAL dataset
// ------------------------------------------------------------------------------------------
export const LOOKUP_STRATEGIES = [
  {
    key: 'app_interval_pk_limit1',
    label: 'Application time, interval predicate + ORDER BY valid_from DESC LIMIT 1 (production query)',
    sql: `SELECT h.rev_id FROM article_history h WHERE h.article_id = ? AND h.valid_from <= ? AND h.valid_to > ? ORDER BY h.valid_from DESC LIMIT 1`,
    params: (a, t) => [a, t, t],
  },
  {
    key: 'app_interval_no_limit',
    label: 'Application time, interval predicate only (optimizer free to choose)',
    sql: `SELECT h.rev_id FROM article_history h WHERE h.article_id = ? AND h.valid_from <= ? AND h.valid_to > ?`,
    params: (a, t) => [a, t, t],
  },
  {
    key: 'app_interval_overlap_index',
    label: 'Application time, forced through the WITHOUT OVERLAPS index (article_id, row_end, valid_to, valid_from)',
    sql: `SELECT h.rev_id FROM article_history h FORCE INDEX (uq_article_history_no_overlap) WHERE h.article_id = ? AND h.valid_from <= ? AND h.valid_to > ?`,
    params: (a, t) => [a, t, t],
  },
  {
    key: 'events_latest_before',
    label: 'No intervals: latest revision event with timestamp <= T (MediaWiki-style)',
    sql: `SELECT r.rev_id FROM revisions r WHERE r.article_id = ? AND r.rev_timestamp <= ? ORDER BY r.rev_timestamp DESC, r.rev_id DESC LIMIT 1`,
    params: (a, t) => [a, t],
  },
  {
    key: 'mirror_system_asof_partitioned',
    label: 'System time: page_mirror FOR SYSTEM_TIME AS OF T (partitioned by SYSTEM_TIME, 1 year)',
    sql: `SELECT m.rev_id FROM page_mirror FOR SYSTEM_TIME AS OF TIMESTAMP ? AS m WHERE m.article_id = ?`,
    params: (a, t) => [t, a],
  },
  {
    key: 'mirror_system_asof_unpartitioned',
    label: 'System time: identical history in an unpartitioned table (bench_mirror_flat)',
    sql: `SELECT m.rev_id FROM bench_mirror_flat FOR SYSTEM_TIME AS OF TIMESTAMP ? AS m WHERE m.article_id = ?`,
    params: (a, t) => [t, a],
  },
];

export async function lookupSuite(conn, { queries = 2000, reps = 3, seed = 42 } = {}) {
  const cov = datasetCoverage();
  const articles = (await conn.query('SELECT DISTINCT article_id FROM article_history ORDER BY article_id')).map((r) => r.article_id);
  if (!articles.length) throw new Error('no ingested data: run npm run ingest first');
  const replay = await conn.query("SELECT replay_id FROM mirror_replays WHERE status = 'succeeded' LIMIT 1");
  if (!replay.length) throw new Error('page_mirror has not been replayed: run npm run replay-mirror first');

  // An unpartitioned twin of page_mirror with byte-identical history (row_start/row_end copied).
  await conn.query('DROP TABLE IF EXISTS bench_mirror_flat');
  await conn.query(`CREATE TABLE bench_mirror_flat (
      article_id INT UNSIGNED NOT NULL, rev_id BIGINT UNSIGNED NOT NULL, rev_timestamp DATETIME NOT NULL,
      sha1 CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL, size_bytes INT UNSIGNED NOT NULL DEFAULT 0,
      row_start TIMESTAMP(6) GENERATED ALWAYS AS ROW START, row_end TIMESTAMP(6) GENERATED ALWAYS AS ROW END,
      PERIOD FOR SYSTEM_TIME (row_start, row_end), PRIMARY KEY (article_id)) ENGINE=InnoDB WITH SYSTEM VERSIONING`);
  await conn.query('SET @@system_versioning_insert_history = 1');
  await conn.query(`INSERT INTO bench_mirror_flat (article_id, rev_id, rev_timestamp, sha1, size_bytes, row_start, row_end)
                    SELECT article_id, rev_id, rev_timestamp, sha1, size_bytes, row_start, row_end FROM page_mirror FOR SYSTEM_TIME ALL`);
  await conn.query('SET @@system_versioning_insert_history = 0');
  await conn.query('ANALYZE TABLE article_history, revisions, page_mirror, bench_mirror_flat');

  const rand = prng(seed);
  const instants = randomInstants(rand, queries, cov.start.getTime(), cov.end.getTime());
  const workload = instants.map((t) => ({ a: articles[Math.floor(rand() * articles.length)], t }));

  const results = [];
  let reference = null;
  for (const s of LOOKUP_STRATEGIES) {
    log.info(`lookup: ${s.key}`);
    const m = await measure(conn, s.sql, workload.map((w) => s.params(w.a, w.t)), { reps });
    const answers = m.firstResults.map((rows) => rows[0]?.rev_id ?? null);
    if (!reference) reference = answers;
    const disagreements = answers.filter((x, i) => x !== reference[i]).length;
    const sample = workload[0];
    const p = await plans(conn, s.sql, s.params(sample.a, sample.t));
    delete m.firstResults;
    results.push({ ...s, sql: s.sql, ...m, disagreementsWithProduction: disagreements, plan: p, sampleParams: s.params(sample.a, sample.t) });
  }

  // Bitemporal variant: same production query, rewound to the first sync checkpoint.
  const [cp] = await conn.query('SELECT completed_at FROM sync_checkpoints ORDER BY checkpoint_id LIMIT 1');
  if (cp) {
    const sql = `SELECT h.rev_id FROM article_history FOR SYSTEM_TIME AS OF TIMESTAMP ? AS h WHERE h.article_id = ? AND h.valid_from <= ? AND h.valid_to > ? ORDER BY h.valid_from DESC LIMIT 1`;
    const params = (a, t) => [cp.completed_at, a, t, t];
    const m = await measure(conn, sql, workload.map((w) => params(w.a, w.t)), { reps });
    const answers = m.firstResults.map((rows) => rows[0]?.rev_id ?? null);
    delete m.firstResults;
    results.push({ key: 'bitemporal_known_at_checkpoint1', label: 'Bitemporal: application-time predicate on article_history FOR SYSTEM_TIME AS OF <checkpoint #1>',
      sql, ...m, differsFromToday: answers.filter((x, i) => x !== reference[i]).length,
      plan: await plans(conn, sql, params(workload[0].a, workload[0].t)) });
  }
  return { queries, reps, seed, articles: articles.length, results };
}

// ------------------------------------------------------------------------------------------
// Suite 2: partitioning by SYSTEM_TIME — DERIVED stress dataset (K shifted copies of the real history)
// ------------------------------------------------------------------------------------------
const MIRROR_COLUMNS = `article_id INT UNSIGNED NOT NULL, rev_id BIGINT UNSIGNED NOT NULL, rev_timestamp DATETIME NOT NULL,
  sha1 CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL, size_bytes INT UNSIGNED NOT NULL DEFAULT 0,
  row_start TIMESTAMP(6) GENERATED ALWAYS AS ROW START, row_end TIMESTAMP(6) GENERATED ALWAYS AS ROW END,
  PERIOD FOR SYSTEM_TIME (row_start, row_end), PRIMARY KEY (article_id)`;

export const PARTITION_LAYOUTS = [
  { table: 'bench_stress_none', label: 'not partitioned', ddl: '' },
  { table: 'bench_stress_year', label: 'PARTITION BY SYSTEM_TIME INTERVAL 1 YEAR (8 partitions)',
    ddl: "PARTITION BY SYSTEM_TIME INTERVAL 1 YEAR STARTS TIMESTAMP '2021-01-01 00:00:00' PARTITIONS 8" },
  { table: 'bench_stress_month', label: 'PARTITION BY SYSTEM_TIME INTERVAL 1 MONTH (64 partitions)',
    ddl: "PARTITION BY SYSTEM_TIME INTERVAL 1 MONTH STARTS TIMESTAMP '2021-09-01 00:00:00' PARTITIONS 64" },
];

export async function buildStressTables(conn, scale) {
  for (const l of PARTITION_LAYOUTS) {
    await conn.query(`DROP TABLE IF EXISTS ${l.table}`);
    await conn.query(`CREATE TABLE ${l.table} (${MIRROR_COLUMNS}) ENGINE=InnoDB WITH SYSTEM VERSIONING ${l.ddl}`);
    await conn.query('SET @@system_versioning_insert_history = 1');
    const t = Date.now();
    // seq_0_to_N is MariaDB's SEQUENCE engine: K copies, article ids shifted by k * 1,000,000,
    // timestamps untouched — the temporal distribution of the real data is preserved exactly.
    await conn.query(`INSERT INTO ${l.table} (article_id, rev_id, rev_timestamp, sha1, size_bytes, row_start, row_end)
      SELECT m.article_id + s.seq * 1000000, m.rev_id, m.rev_timestamp, m.sha1, m.size_bytes, m.row_start, m.row_end
      FROM page_mirror FOR SYSTEM_TIME ALL AS m CROSS JOIN seq_0_to_${scale - 1} AS s`);
    await conn.query('SET @@system_versioning_insert_history = 0');
    await conn.query(`ANALYZE TABLE ${l.table}`);
    l.buildSeconds = (Date.now() - t) / 1000;
  }
}

async function tableInfo(conn, table) {
  const [t] = await conn.query(`SELECT TABLE_ROWS AS approx_rows, DATA_LENGTH AS data_length, INDEX_LENGTH AS index_length
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]);
  const [{ versioned }] = await conn.query(`SELECT COUNT(*) AS versioned FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND TABLE_TYPE = 'SYSTEM VERSIONED'`, [table]);
  const [{ total, current }] = versioned
    ? await conn.query(`SELECT COUNT(*) AS total, SUM(row_end = ${SYSTEM_MAX}) AS current FROM ${table} FOR SYSTEM_TIME ALL`)
    : await conn.query(`SELECT COUNT(*) AS total, COUNT(*) AS current FROM ${table}`);
  const parts = await conn.query(`SELECT PARTITION_NAME AS name, PARTITION_DESCRIPTION AS upper_bound, TABLE_ROWS AS approx_rows
    FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND PARTITION_NAME IS NOT NULL ORDER BY PARTITION_ORDINAL_POSITION`, [table]);
  // Real file sizes need the global PROCESS privilege; without it they are reported as n/a.
  const files = await conn.query(`SELECT SUM(FILE_SIZE) AS file_size, SUM(ALLOCATED_SIZE) AS allocated FROM information_schema.INNODB_SYS_TABLESPACES
    WHERE NAME = CONCAT(DATABASE(), '/', ?) OR NAME LIKE CONCAT(DATABASE(), '/', ?, '#P#%')`, [table, table]).catch(() => [{}]);
  return { versioned: Boolean(versioned), rows_total: total, rows_current: current, rows_history: versioned ? total - current : null, ...t, file_size: files[0]?.file_size ?? null,
    allocated_size: files[0]?.allocated ?? null, partitions: parts.length };
}

export async function partitionSuite(conn, { scale = 16, pointQueries = 500, scanQueries = 15, reps = 3, seed = 7, purge = true } = {}) {
  const cov = datasetCoverage();
  log.info(`partition: building derived stress tables (scale ${scale})`);
  await buildStressTables(conn, scale);
  const articles = (await conn.query('SELECT DISTINCT article_id FROM page_mirror ORDER BY article_id')).map((r) => r.article_id);
  const rand = prng(seed);
  const pickArticle = () => articles[Math.floor(rand() * articles.length)] + Math.floor(rand() * scale) * 1000000;
  const early = randomInstants(rand, scanQueries, Date.parse('2021-10-01T00:00:00Z'), Date.parse('2022-09-30T00:00:00Z'));
  const late = randomInstants(rand, scanQueries, Date.parse('2025-10-01T00:00:00Z'), cov.end.getTime());
  const anyT = randomInstants(rand, pointQueries, cov.start.getTime(), cov.end.getTime());
  const points = anyT.map((t) => ({ a: pickArticle(), t }));
  const monthStarts = Array.from({ length: scanQueries }, () => {
    const d = new Date(Date.UTC(2022 + Math.floor(rand() * 4), Math.floor(rand() * 12), 1));
    const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1000);
    return [toSql(d), toSql(e)];
  });

  const QUERIES = [
    { key: 'current_point', label: 'Current state, one article', sql: (t) => `SELECT rev_id FROM ${t} WHERE article_id = ?`, params: points.map((p) => [p.a]) },
    { key: 'current_scan', label: 'Current state, all articles (aggregate)', sql: (t) => `SELECT COUNT(*), SUM(size_bytes) FROM ${t}`, params: Array.from({ length: scanQueries }, () => []) },
    { key: 'asof_point', label: 'AS OF random T, one article', sql: (t) => `SELECT rev_id FROM ${t} FOR SYSTEM_TIME AS OF TIMESTAMP ? WHERE article_id = ?`, params: points.map((p) => [p.t, p.a]) },
    { key: 'asof_scan_early', label: 'AS OF T in 2021-22, all articles', sql: (t) => `SELECT COUNT(*), SUM(size_bytes) FROM ${t} FOR SYSTEM_TIME AS OF TIMESTAMP ?`, params: early.map((x) => [x]) },
    { key: 'asof_scan_late', label: 'AS OF T in 2025-26, all articles', sql: (t) => `SELECT COUNT(*), SUM(size_bytes) FROM ${t} FOR SYSTEM_TIME AS OF TIMESTAMP ?`, params: late.map((x) => [x]) },
    { key: 'between_month', label: 'BETWEEN a 1-month span, all versions', sql: (t) => `SELECT COUNT(*) FROM ${t} FOR SYSTEM_TIME BETWEEN TIMESTAMP ? AND TIMESTAMP ?`, params: monthStarts },
    { key: 'all_scan', label: 'ALL row versions (full history)', sql: (t) => `SELECT COUNT(*) FROM ${t} FOR SYSTEM_TIME ALL`, params: Array.from({ length: Math.min(5, scanQueries) }, () => []) },
  ];

  const tables = [];
  for (const l of PARTITION_LAYOUTS) tables.push({ table: l.table, label: l.label, ddl: l.ddl, buildSeconds: l.buildSeconds, info: await tableInfo(conn, l.table) });

  const results = [];
  for (const q of QUERIES) {
    const perTable = [];
    let reference = null;
    for (const l of PARTITION_LAYOUTS) {
      log.info(`partition: ${q.key} on ${l.table}`);
      const sql = q.sql(l.table);
      const m = await measure(conn, sql, q.params, { reps });
      const answers = JSON.stringify(m.firstResults.map((rows) => Object.values(rows[0] ?? {})));
      if (reference === null) reference = answers;
      delete m.firstResults;
      perTable.push({ table: l.table, ...m, sameAnswersAsUnpartitioned: answers === reference, plan: await plans(conn, sql, q.params[0]) });
    }
    results.push({ key: q.key, label: q.label, sqlTemplate: q.sql('<table>'), perTable });
  }

  // Maintenance: purge history older than 2023-01-01 (retention policy).
  const maintenance = [];
  if (purge) {
    const cutoff = '2023-01-01 00:00:00';
    const run = async (table, label, sql) => {
      const before = (await conn.query(`SELECT COUNT(*) AS n FROM ${table} FOR SYSTEM_TIME ALL`))[0].n;
      const t = process.hrtime.bigint();
      await conn.query(sql);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      const after = (await conn.query(`SELECT COUNT(*) AS n FROM ${table} FOR SYSTEM_TIME ALL`))[0].n;
      maintenance.push({ table, label, sql, ms: Math.round(ms * 10) / 10, rows_removed: before - after });
    };
    log.info('partition: retention purge');
    await run('bench_stress_none', 'row-by-row purge', `DELETE HISTORY FROM bench_stress_none BEFORE SYSTEM_TIME TIMESTAMP '${cutoff}'`);
    await run('bench_stress_year', 'drop whole history partitions', 'ALTER TABLE bench_stress_year DROP PARTITION p0, p1');
    await run('bench_stress_month', 'DELETE HISTORY on a partitioned table', `DELETE HISTORY FROM bench_stress_month BEFORE SYSTEM_TIME TIMESTAMP '${cutoff}'`);
  }
  return { scale, pointQueries, scanQueries, reps, seed, derived: true, tables, results, maintenance };
}

// ------------------------------------------------------------------------------------------
// Suite 3: storage and growth — REAL data, plus a measured inline-text experiment on a subset
// ------------------------------------------------------------------------------------------
export async function storageSuite(conn, pool, { inlineArticles = 5, keepTables = false } = {}) {
  await conn.query('ANALYZE TABLE articles, revisions, article_history, page_mirror, content_chunks, revision_texts');
  const tables = [];
  for (const t of ['articles', 'revisions', 'article_history', 'page_mirror', 'content_chunks', 'revision_texts', 'article_sync_state']) {
    tables.push({ table: t, ...(await tableInfo(conn, t)) });
  }
  const [content] = await conn.query(`SELECT COUNT(*) AS chunks, SUM(text_count) AS texts, SUM(raw_bytes) AS raw_bytes, SUM(stored_bytes) AS stored_bytes FROM content_chunks`);
  const [revs] = await conn.query(`SELECT COUNT(*) AS revisions, SUM(size_bytes) AS sum_revision_sizes FROM revisions`);
  const mirrorPartitions = [];
  for (const p of await conn.query(`SELECT PARTITION_NAME AS name, PARTITION_DESCRIPTION AS upper_bound FROM information_schema.PARTITIONS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'page_mirror' ORDER BY PARTITION_ORDINAL_POSITION`)) {
    // Explicit partition selection returns that partition's rows (history included); MariaDB rejects
    // combining PARTITION (...) with FOR SYSTEM_TIME (error 4142), so no temporal clause here.
    const [{ n, bytes }] = await conn.query(`SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM page_mirror PARTITION (${p.name})`);
    mirrorPartitions.push({ ...p, rows: n, inline_text_bytes_if_stored: bytes });
  }
  const growth = await conn.query(`SELECT YEAR(row_end) AS year, COUNT(*) AS closed_versions FROM page_mirror FOR SYSTEM_TIME ALL
      WHERE row_end < ${SYSTEM_MAX} GROUP BY YEAR(row_end) ORDER BY 1`);
  const ahHistory = await conn.query(`SELECT COUNT(*) AS n FROM article_history FOR SYSTEM_TIME ALL WHERE row_end < ${SYSTEM_MAX}`);

  // Inline-text experiment: the naive "history for free" design stores the full text in the
  // versioned row. Replay real revisions of a few articles (chosen at size quantiles) into two
  // versioned tables — plain MEDIUMTEXT and MEDIUMTEXT COMPRESSED — and measure the files.
  const sizes = await conn.query(`SELECT article_id, SUM(size_bytes) AS bytes, COUNT(*) AS revs FROM revisions GROUP BY article_id ORDER BY bytes`);
  const picks = [...new Set(Array.from({ length: inlineArticles }, (_, i) => sizes[Math.floor(((i + 0.5) / inlineArticles) * sizes.length)]?.article_id))].filter(Boolean);
  const content2 = new ContentRepository(pool, { maxCacheBytes: 64 * 1024 * 1024 });
  const inline = [];
  for (const [table, type] of [['bench_inline_plain', 'MEDIUMTEXT'], ['bench_inline_compressed', 'MEDIUMTEXT COMPRESSED']]) {
    await conn.query(`DROP TABLE IF EXISTS ${table}`);
    await conn.query(`CREATE TABLE ${table} (article_id INT UNSIGNED PRIMARY KEY, rev_id BIGINT UNSIGNED NOT NULL, wikitext ${type} NULL)
      ENGINE=InnoDB WITH SYSTEM VERSIONING`);
  }
  const revRows = await conn.query(`SELECT rev_id, article_id, rev_timestamp, sha1 FROM revisions WHERE article_id IN (${picks.map(() => '?').join(',')})
      ORDER BY rev_timestamp, rev_id`, picks);
  let rawBytes = 0;
  const t0 = Date.now();
  for (const r of revRows) {
    const text = r.sha1 ? await content2.textBySha1(r.sha1) : null;
    rawBytes += text ? Buffer.byteLength(text) : 0;
    await conn.query('SET timestamp = UNIX_TIMESTAMP(?)', [r.rev_timestamp]);
    for (const table of ['bench_inline_plain', 'bench_inline_compressed']) {
      await conn.query(`INSERT INTO ${table} (article_id, rev_id, wikitext) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE rev_id = VALUES(rev_id), wikitext = VALUES(wikitext)`, [r.article_id, r.rev_id, text]);
    }
  }
  await conn.query('SET timestamp = DEFAULT');
  for (const table of ['bench_inline_plain', 'bench_inline_compressed']) {
    await conn.query(`OPTIMIZE TABLE ${table}`).catch(() => {});
    inline.push({ table, ...(await tableInfo(conn, table)) });
  }
  const [chunkBytes] = await conn.query(`SELECT SUM(stored_bytes) AS stored, SUM(raw_bytes) AS raw FROM content_chunks WHERE article_id IN (${picks.map(() => '?').join(',')})`, picks);
  if (!keepTables) for (const table of ['bench_inline_plain', 'bench_inline_compressed']) await conn.query(`DROP TABLE ${table}`);
  const pickInfo = await conn.query(`SELECT a.article_id, a.canonical_title, COUNT(r.rev_id) AS revisions, SUM(r.size_bytes) AS bytes FROM articles a
      JOIN revisions r ON r.article_id = a.article_id WHERE a.article_id IN (${picks.map(() => '?').join(',')}) GROUP BY a.article_id ORDER BY bytes`, picks);
  return {
    tables, content, revisions: revs, articleHistoryHistoryRows: ahHistory[0].n, mirrorPartitions, growth,
    inlineExperiment: { articles: pickInfo, revisionsReplayed: revRows.length, rawTextBytes: rawBytes, seconds: (Date.now() - t0) / 1000,
      tables: inline, chunkStore: { stored_bytes: chunkBytes.stored, raw_distinct_bytes: chunkBytes.raw } },
  };
}
