// The reusable SQL files in sql/ are executed exactly as written (one multi-statement round trip) and the
// values their comments promise are asserted, so the examples cannot drift from what MariaDB actually does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolvePath } from '../../src/config/index.js';
import { createConnection } from '../../src/db/pool.js';
import { replayMirror } from '../../src/ingestion/replay.js';
import { resetTestDatabase, testPool, loadFixture, TEST_DB } from '../helpers/db.js';

let conn;

before(async () => {
  await resetTestDatabase();
  const pool = testPool();
  try { await loadFixture(pool); } finally { await pool.end(); }
  conn = await createConnection({ database: TEST_DB, multipleStatements: true });
  await replayMirror(conn);
});
after(() => conn?.end());

/** Runs a file and returns { alias -> [values in order] } for every column of every result set. */
async function runFile(name, prefix = '') {
  const results = await conn.query(prefix + fs.readFileSync(resolvePath(`sql/${name}`), 'utf8'));
  const values = {};
  for (const r of Array.isArray(results) ? results : [results]) {
    if (!Array.isArray(r)) continue;
    for (const row of r) for (const [k, v] of Object.entries(row)) (values[k] ??= []).push(v);
  }
  return values;
}

const leftovers = async () => (await conn.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'tutorial\\_%'"))[0].n;

test('sql/01_bitemporal_table.sql: half-open lookups and a one-row plan', async () => {
  const v = await runFile('01_bitemporal_table.sql');
  assert.deepEqual(v.revision_at_exactly_T2, [200]);
  assert.deepEqual(v.revision_one_second_before_T2, [100]);
  assert.deepEqual(v.revision_far_in_the_future, [300]);
  assert.deepEqual(v.revisions_before_first, [0]);
  assert.deepEqual(v.live_during_2023, [100, 200]);
  assert.deepEqual(v.r_rows.map(Number), [1]);
  assert.equal(await leftovers(), 0);
});

test('sql/02_closing_intervals_for_portion_of.sql: DELETE/UPDATE FOR PORTION OF and the superseded belief', async () => {
  const v = await runFile('02_closing_intervals_for_portion_of.sql');
  assert.deepEqual(v.current_rev, [100, 200]);
  assert.deepEqual(v.belief_rev, [100, 100, 200]);
  assert.deepEqual(v.superseded_beliefs, [1]);
  assert.deepEqual(v.note, ['', 'hidden', '']);
  assert.deepEqual(v.rows_for_rev_200, [3]);
  assert.equal(await leftovers(), 0);
});

test('sql/03_system_time_queries.sql: AS OF, BETWEEN vs FROM..TO, ALL, system_versioning_asof, bitemporal', async () => {
  const v = await runFile('03_system_time_queries.sql');
  assert.deepEqual(v.current_rev, [300]);
  assert.deepEqual(v.as_of_2022_01_31, [100]);
  assert.deepEqual(v.as_of_2022_02_01, [200]);
  assert.deepEqual(v.rows_as_of_2021, [0]);
  assert.deepEqual(v.between_versions, ['100,200,300']);
  assert.deepEqual(v.from_to_versions, ['100,200']);
  assert.deepEqual(v.any_version, [100, 200, 300]);
  assert.deepEqual(v.implicit_as_of, [100]);
  assert.deepEqual(v.after_reset, [300]);
  assert.deepEqual(v.known_at_S, [100]);
  assert.deepEqual(v.known_today, [200]);
  assert.equal(await leftovers(), 0);
});

test('sql/04_partitioning_and_retention.sql: partitions, pruning, DROP PARTITION and DELETE HISTORY', async () => {
  const v = await runFile('04_partitioning_and_retention.sql');
  assert.deepEqual(v.partition_name, ['p0', 'p1', 'p2', 'p3', 'pn']);
  assert.deepEqual(v.current_rows, [2]);
  assert.deepEqual(v.partitions, ['pn', 'p3,pn', 'p0,p1,p2,p3,pn'], 'current-only, recent AS OF, old AS OF');
  assert.deepEqual(v.article1_as_of_2022_06, [101]);
  assert.deepEqual(v.versions_before_retention, [6]);
  assert.deepEqual(v.versions_after_drop_partition, [5]);
  assert.deepEqual(v.versions_after_delete_history, [3]);
  assert.equal(await leftovers(), 0);
});

test('sql/05_time_machine_queries.sql: the app, bitemporal and mirror answers agree on the project schema', async () => {
  const v = await runFile('05_time_machine_queries.sql', "SET @title = 'Alpha', @T = '2024-06-01 00:00:00';\n");
  assert.deepEqual(v.live_rev, [160], 'application time');
  assert.deepEqual(v.mirror_rev_at_T, [160], 'replayed system time agrees');
  assert.deepEqual(v.live_rev_as_known_at_S, [130], 'after the first sync the database still believed 130 was current');
  assert.equal(v.revisions_live_that_year[0], v.mirror_versions_that_year[0]);
  assert.ok(v.superseded_belief_rev.length > 0);
});
