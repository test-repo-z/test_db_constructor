// MariaDB 13.0.2 temporal features exercised directly on the project schema.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase, testPool } from '../helpers/db.js';

let pool;
before(async () => {
  await resetTestDatabase();
  pool = testPool();
  await pool.query("INSERT INTO domains (name) VALUES ('Physics')");
  await pool.query(`INSERT INTO articles (article_id, requested_title, curated_position, domain_id, resolution_status, canonical_title, page_id, canonical_url)
                    VALUES (1, 'A', 0, 1, 'resolved', 'A', 10, 'https://en.wikipedia.org/wiki/A')`);
  await pool.query("INSERT INTO ingestion_runs (run_id, window_start, window_end) VALUES (1, '2021-09-22', '2026-09-22')");
  for (const [rev, ts] of [[1, '2022-01-01 00:00:00'], [2, '2022-02-01 00:00:00'], [3, '2022-03-01 00:00:00']]) {
    await pool.query("INSERT INTO revisions (rev_id, article_id, rev_timestamp, content_status, run_id) VALUES (?, 1, ?, 'hidden', 1)", [rev, ts]);
  }
});
after(() => pool?.end());

test('server is MariaDB 13.0.2', async () => {
  const [{ v }] = await pool.query('SELECT VERSION() AS v');
  assert.match(v, /^13\.0\.2-MariaDB/);
});

test('system versioning and the application-time period are declared', async () => {
  const rows = await pool.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'SYSTEM VERSIONED' ORDER BY 1");
  assert.deepEqual(rows.map((r) => r.t).sort(), ['article_history', 'article_sync_state', 'articles', 'page_mirror']);
  const [{ ddl }] = await pool.query("SELECT 1").then(async () => {
    const r = await pool.query('SHOW CREATE TABLE article_history');
    return [{ ddl: r[0]['Create Table'] }];
  });
  assert.match(ddl, /PERIOD FOR `valid_period` \(`valid_from`, `valid_to`\)/);
  assert.match(ddl, /`valid_period` WITHOUT OVERLAPS/);
  assert.match(ddl, /WITH SYSTEM VERSIONING/);
});

test('WITHOUT OVERLAPS rejects overlapping validity but accepts touching half-open intervals', async () => {
  await pool.query("INSERT INTO article_history (article_id, rev_id, valid_from, valid_to) VALUES (1, 1, '2022-01-01 00:00:00', '2022-02-01 00:00:00')");
  await pool.query("INSERT INTO article_history (article_id, rev_id, valid_from, valid_to) VALUES (1, 2, '2022-02-01 00:00:00', '9999-12-31 23:59:59')");
  await assert.rejects(
    pool.query("INSERT INTO article_history (article_id, rev_id, valid_from, valid_to) VALUES (1, 3, '2022-01-15 00:00:00', '2022-01-20 00:00:00')"),
    (e) => e.code === 'ER_DUP_ENTRY');
});

test('the period implies valid_from < valid_to (no empty or reversed intervals)', async () => {
  for (const [f, t] of [['2022-03-01 00:00:00', '2022-03-01 00:00:00'], ['2022-03-02 00:00:00', '2022-03-01 00:00:00']]) {
    await assert.rejects(pool.query('INSERT INTO article_history (article_id, rev_id, valid_from, valid_to) VALUES (1, 3, ?, ?)', [f, t]),
      (e) => e.errno === 4025); // ER_CONSTRAINT_FAILED on the implicit `valid_period` check
  }
});

test('DELETE ... FOR PORTION OF trims the open interval and system versioning keeps the old belief', async () => {
  await pool.query("DELETE FROM article_history FOR PORTION OF valid_period FROM '2022-03-01 00:00:00' TO '9999-12-31 23:59:59' WHERE article_id = 1 AND rev_id = 2");
  await pool.query("INSERT INTO article_history (article_id, rev_id, valid_from, valid_to) VALUES (1, 3, '2022-03-01 00:00:00', '9999-12-31 23:59:59')");
  const cur = await pool.query('SELECT rev_id, valid_from, valid_to FROM article_history ORDER BY valid_from');
  assert.deepEqual(cur.map((r) => [r.rev_id, r.valid_to]), [[1, '2022-02-01 00:00:00'], [2, '2022-03-01 00:00:00'], [3, '9999-12-31 23:59:59']]);
  const all = await pool.query('SELECT rev_id, valid_to, row_start, row_end FROM article_history FOR SYSTEM_TIME ALL WHERE rev_id = 2 ORDER BY row_start');
  assert.equal(all.length, 2, 'one current + one history row');
  assert.equal(all[0].valid_to, '9999-12-31 23:59:59');
  assert.equal(all[1].valid_to, '2022-03-01 00:00:00');
  assert.equal(all[0].row_end, all[1].row_start, 'the superseded version ends exactly when the new one starts');
  assert.equal(all[1].row_end, '2106-02-07 06:28:15.999999', 'current rows end at the maximum TIMESTAMP (2106, not 2038)');

  // AS OF just before the trim sees the old belief; AS OF now sees the new one.
  const asOfOld = await pool.query('SELECT valid_to FROM article_history FOR SYSTEM_TIME AS OF TIMESTAMP ? WHERE rev_id = 2', [all[0].row_start]);
  assert.equal(asOfOld[0].valid_to, '9999-12-31 23:59:59');
  const [{ n }] = await pool.query('SELECT COUNT(*) AS n FROM article_history FOR SYSTEM_TIME BETWEEN TIMESTAMP ? AND TIMESTAMP ? WHERE rev_id = 2', [all[0].row_start, all[1].row_start]);
  assert.equal(n, 2, 'BETWEEN sees both versions');
});

test('application-time lookup is a plain predicate (MariaDB has no SELECT ... FOR <app period> AS OF)', async () => {
  await assert.rejects(pool.query("SELECT * FROM article_history FOR valid_period AS OF '2022-01-10'"), (e) => e.code === 'ER_PARSE_ERROR');
  const [r] = await pool.query("SELECT rev_id FROM article_history WHERE article_id = 1 AND valid_from <= '2022-02-01 00:00:00' AND valid_to > '2022-02-01 00:00:00'");
  assert.equal(r.rev_id, 2);
});

test('owned_page_id: only one usable article may own a Wikipedia page; duplicates are still recorded', async () => {
  await assert.rejects(pool.query(`INSERT INTO articles (requested_title, curated_position, domain_id, resolution_status, canonical_title, page_id, canonical_url)
                                   VALUES ('A alias', 1, 1, 'redirect', 'A', 10, 'https://en.wikipedia.org/wiki/A')`), (e) => e.code === 'ER_DUP_ENTRY');
  await pool.query(`INSERT INTO articles (requested_title, curated_position, domain_id, resolution_status, canonical_title, page_id, canonical_url, duplicate_of_article_id)
                    VALUES ('A alias', 1, 1, 'duplicate', 'A', 10, 'https://en.wikipedia.org/wiki/A', 1)`);
});

test('CHECK constraints protect revision content status and duplicate pointers', async () => {
  await assert.rejects(pool.query("INSERT INTO revisions (rev_id, article_id, rev_timestamp, content_status, run_id) VALUES (99, 1, '2022-05-01', 'available', 1)"), (e) => e.errno === 4025);
  await assert.rejects(pool.query("INSERT INTO articles (requested_title, curated_position, domain_id, resolution_status) VALUES ('B', 2, 1, 'duplicate')"), (e) => e.errno === 4025);
});

test('MariaDB 13.0.2: even a no-op UPDATE on a versioned table writes a history row — so catalog sync only updates real changes', async () => {
  const count = async () => (await pool.query('SELECT COUNT(*) AS n FROM articles FOR SYSTEM_TIME ALL WHERE article_id = 1'))[0].n;
  const before = await count();
  const res = await pool.query("UPDATE articles SET canonical_title = canonical_title WHERE article_id = 1");
  assert.equal(res.affectedRows, 1, 'versioned tables report the no-op row as affected');
  assert.equal(await count(), before + 1, 'and keep an (identical) history version');

  const { syncCatalog } = await import('../../src/ingestion/catalog.js');
  const record = { requested_title: 'A', domain: 'Physics', status: 'resolved', canonical_title: (await pool.query('SELECT canonical_title FROM articles WHERE article_id = 1'))[0].canonical_title,
    page_id: 10, url: 'https://en.wikipedia.org/wiki/A', is_redirect: false, is_disambiguation: false, redirect_fragment: null, reason: null };
  const conn = await pool.getConnection();
  try {
    const stats = await syncCatalog(conn, [record]);
    assert.equal(stats.unchanged, 1);
    assert.equal(await count(), before + 1, 'an unchanged resolution produces no new history');
    await syncCatalog(conn, [{ ...record, canonical_title: 'A (renamed on Wikipedia)' }]);
    assert.equal(await count(), before + 2, 'a real rename is kept in history for free');
  } finally { conn.release(); }
});

test('ALTER on a system-versioned table is refused by default (system_versioning_alter_history = ERROR)', async () => {
  await assert.rejects(pool.query('ALTER TABLE article_history ADD COLUMN note INT'), (e) => /system.versioned|history/i.test(e.message));
});

test('foreign keys protect only CURRENT rows: a parent referenced only by system history can be deleted', async () => {
  await pool.query('CREATE TABLE _fk_parent (id INT PRIMARY KEY)');
  await pool.query('CREATE TABLE _fk_child (id INT PRIMARY KEY, pid INT, FOREIGN KEY (pid) REFERENCES _fk_parent (id)) WITH SYSTEM VERSIONING');
  try {
    await pool.query('INSERT INTO _fk_parent VALUES (1), (2)');
    await pool.query('INSERT INTO _fk_child VALUES (10, 1)');
    await pool.query('UPDATE _fk_child SET pid = 2 WHERE id = 10'); // the history version still points at parent 1
    const res = await pool.query('DELETE FROM _fk_parent WHERE id = 1');
    assert.equal(res.affectedRows, 1, 'history references do not block the delete');
    await assert.rejects(pool.query('DELETE FROM _fk_parent WHERE id = 2'), (e) => e.code === 'ER_ROW_IS_REFERENCED_2');
  } finally {
    await pool.query('DROP TABLE _fk_child, _fk_parent');
  }
});

test('application-time period tables cannot be TEMPORARY', async () => {
  await assert.rejects(pool.query('CREATE TEMPORARY TABLE tmp_p (a DATETIME NOT NULL, b DATETIME NOT NULL, PERIOD FOR p(a, b))'),
    (e) => e.code === 'ER_PERIOD_TEMPORARY_NOT_ALLOWED');
});

test('page_mirror: session-clock replay, BETWEEN vs FROM..TO, and partition pruning', async () => {
  const conn = await pool.getConnection();
  try {
    const at = async (ts, sql, params) => { await conn.query('SET timestamp = UNIX_TIMESTAMP(?)', [ts]); await conn.query(sql, params); };
    await at('2022-01-01 00:00:00', 'INSERT INTO page_mirror (article_id, rev_id, rev_timestamp) VALUES (1, 1, ?)', ['2022-01-01 00:00:00']);
    await at('2022-02-01 00:00:00', 'UPDATE page_mirror SET rev_id = 2 WHERE article_id = 1');
    await at('2022-02-01 00:00:00', 'UPDATE page_mirror SET rev_id = 22 WHERE article_id = 1'); // same second
    await at('2023-03-01 00:00:00', 'UPDATE page_mirror SET rev_id = 3 WHERE article_id = 1');
    await conn.query('SET timestamp = DEFAULT');
    const all = await conn.query('SELECT rev_id, row_start, row_end FROM page_mirror FOR SYSTEM_TIME ALL ORDER BY row_start');
    assert.deepEqual(all.map((r) => r.rev_id), [1, 22, 3], 'the same-second version (rev 2) leaves no zero-length history row');
    const asOf = async (ts) => (await conn.query('SELECT rev_id FROM page_mirror FOR SYSTEM_TIME AS OF TIMESTAMP ?', [ts]))[0]?.rev_id;
    assert.equal(await asOf('2022-01-31 23:59:59'), 1);
    assert.equal(await asOf('2022-02-01 00:00:00'), 22, 'AS OF is half-open: at row_start the new version is visible');
    assert.equal(await asOf('2021-12-31 23:59:59'), undefined);
    const between = await conn.query("SELECT rev_id FROM page_mirror FOR SYSTEM_TIME BETWEEN TIMESTAMP '2022-01-15 00:00:00' AND TIMESTAMP '2023-03-01 00:00:00' ORDER BY row_start");
    const fromTo = await conn.query("SELECT rev_id FROM page_mirror FOR SYSTEM_TIME FROM TIMESTAMP '2022-01-15 00:00:00' TO TIMESTAMP '2023-03-01 00:00:00' ORDER BY row_start");
    assert.deepEqual(between.map((r) => r.rev_id), [1, 22, 3], 'BETWEEN includes a version starting exactly at the upper bound');
    assert.deepEqual(fromTo.map((r) => r.rev_id), [1, 22], 'FROM ... TO excludes it');
    const plan = await conn.query('EXPLAIN PARTITIONS SELECT * FROM page_mirror WHERE article_id = 1');
    assert.equal(plan[0].partitions, 'pn', 'current-state queries touch only the CURRENT partition');
    const plan2 = await conn.query("EXPLAIN PARTITIONS SELECT * FROM page_mirror FOR SYSTEM_TIME AS OF TIMESTAMP '2023-06-01 00:00:00' WHERE article_id = 1");
    assert.ok(!plan2[0].partitions.split(',').includes('p0'), `history partitions ending before T are pruned (got ${plan2[0].partitions})`);
  } finally {
    await conn.query('SET timestamp = DEFAULT');
    conn.release();
  }
});
