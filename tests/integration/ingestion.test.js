// The real ingestion pipeline against real MariaDB; only the Wikipedia API is simulated.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config/index.js';
import { resetTestDatabase, testPool, loadFixture, articleIdByPage, usableArticles } from '../helpers/db.js';
import { FakeWikipedia } from '../fixtures/fakeWikipedia.js';
import { fixturePages, ALPHA, BETA, GAMMA } from '../fixtures/dataset.js';
import { runIngestion } from '../../src/ingestion/ingester.js';
import { replayMirror } from '../../src/ingestion/replay.js';
import { databaseChecks } from '../../src/validation/checks.js';
import { fixtureManifest } from '../fixtures/fakeWikipedia.js';
import { fixtureEntries } from '../fixtures/dataset.js';

const INF = '9999-12-31 23:59:59';
let pool;

const timeline = async (pageId) => pool.query(
  `SELECT h.rev_id, h.valid_from, h.valid_to FROM article_history h JOIN articles a ON a.article_id = h.article_id
   WHERE a.page_id = ? AND a.resolution_status IN ('resolved','redirect') ORDER BY h.valid_from`, [pageId]);
const counts = async () => (await pool.query(`SELECT (SELECT COUNT(*) FROM revisions) AS revisions, (SELECT COUNT(*) FROM article_history) AS current_rows,
  (SELECT COUNT(*) FROM article_history FOR SYSTEM_TIME ALL) AS all_rows, (SELECT COUNT(*) FROM revision_texts) AS texts`))[0];
const ingestAgain = (wiki, extra = {}) => usableArticles(pool).then((articles) => runIngestion({
  pool, client: wiki, articles, windowStart: config.dataset.windowStart, windowEnd: config.dataset.windowEnd,
  stepMonths: 12, includeBaseline: true, contentBatchSize: 3, pageSize: 2, ...extra }));

const EXPECTED_ALPHA = [
  [100, '2020-05-01 10:00:00', '2021-10-01 12:00:00'],
  [110, '2021-10-01 12:00:00', '2022-06-15 08:30:00'],
  [130, '2022-06-15 08:30:00', '2023-03-15 10:30:00'],
  [140, '2023-03-15 10:30:00', '2023-03-15 10:30:05'],
  [150, '2023-03-15 10:30:05', '2024-01-10 00:00:00'],
  [160, '2024-01-10 00:00:00', '2025-02-01 09:00:00'],
  [170, '2025-02-01 09:00:00', '2026-05-05 05:05:05'],
  [180, '2026-05-05 05:05:05', INF],
];

describe('clean ingestion of the fixture', () => {
  let result;
  before(async () => {
    await resetTestDatabase();
    pool = testPool();
    ({ result } = await loadFixture(pool));
  });

  test('run succeeds, with 5 yearly checkpoints and paginated metadata requests', async () => {
    assert.equal(result.status, 'succeeded');
    const cps = await pool.query('SELECT synced_through FROM sync_checkpoints ORDER BY checkpoint_id');
    assert.deepEqual(cps.map((c) => c.synced_through), ['2022-09-22 00:00:00', '2023-09-22 00:00:00', '2024-09-22 00:00:00', '2025-09-22 00:00:00', '2026-09-22 23:59:59']);
  });

  test('catalogue: all curated entries recorded; only resolved/redirect are ingested', async () => {
    const rows = await pool.query('SELECT requested_title, resolution_status, duplicate_of_article_id FROM articles ORDER BY curated_position');
    assert.deepEqual(rows.map((r) => r.resolution_status), ['resolved', 'redirect', 'resolved', 'duplicate', 'missing', 'disambiguation']);
    assert.ok(rows[3].duplicate_of_article_id);
    const ingested = await pool.query('SELECT DISTINCT article_id FROM revisions');
    assert.equal(ingested.length, 3);
  });

  test('application time = Wikipedia time; same-second revision 120 is shadowed by 130; last interval open-ended', async () => {
    assert.deepEqual((await timeline(ALPHA)).map((r) => [r.rev_id, r.valid_from, r.valid_to]), EXPECTED_ALPHA);
    const [shadow] = await pool.query('SELECT rev_id, rev_timestamp FROM revisions WHERE rev_id = 120');
    assert.equal(shadow.rev_timestamp, '2022-06-15 08:30:00', 'the shadowed revision is still stored as an event');
  });

  test('article created inside the window has no baseline; article never edited has only its baseline', async () => {
    assert.deepEqual((await timeline(BETA)).map((r) => r.rev_id), [200, 210]);
    assert.equal((await timeline(BETA))[0].valid_from, '2022-03-01 00:00:00');
    assert.deepEqual((await timeline(GAMMA)).map((r) => [r.rev_id, r.valid_from, r.valid_to]), [[300, '2019-01-01 00:00:00', INF]]);
  });

  test('system history records each closed interval (bitemporal knowledge growth)', async () => {
    const c = await counts();
    assert.equal(c.revisions, 12);
    assert.equal(c.current_rows, 11);
    assert.equal(c.all_rows - c.current_rows, 5, 'Alpha closed 4 open intervals across steps, Beta 1');
    const superseded = await pool.query(`SELECT rev_id, valid_to FROM article_history FOR SYSTEM_TIME ALL
      WHERE row_end < TIMESTAMP'2106-02-07 06:28:15.999999' ORDER BY rev_id`);
    assert.ok(superseded.every((r) => r.valid_to === INF), 'every superseded belief was an open-ended interval');
    assert.deepEqual(superseded.map((r) => r.rev_id), [130, 150, 160, 170, 200]);
  });

  test('content: deduplicated by SHA-1, hidden revision stored without text', async () => {
    const c = await counts();
    assert.equal(c.texts, 10, 'revert 170 reuses the text of 110; hidden 160 has none');
    const [r170, r110] = await pool.query('SELECT sha1 FROM revisions WHERE rev_id IN (110, 170) ORDER BY rev_id');
    assert.equal(r170.sha1, r110.sha1);
    const [hidden] = await pool.query('SELECT content_status, sha1 FROM revisions WHERE rev_id = 160');
    assert.deepEqual(hidden, { content_status: 'hidden', sha1: null });
  });

  test('re-running is a no-op (no duplicates, no new history, no API calls)', async () => {
    const before = await counts();
    const wiki = new FakeWikipedia(fixturePages());
    const r = await ingestAgain(wiki);
    assert.equal(r.status, 'succeeded');
    assert.equal(wiki.stats.requests, 0);
    assert.deepEqual(await counts(), before);
  });

  test('forced re-fetch (sync state lost) inserts nothing twice', async () => {
    const before = await counts();
    await pool.query('DELETE FROM article_sync_state');
    const wiki = new FakeWikipedia(fixturePages());
    const r = await ingestAgain(wiki);
    assert.equal(r.counters.revisionsInserted, 0);
    assert.equal(r.counters.revisionsSkipped, 12);
    assert.equal(r.counters.textsInserted, 0);
    assert.deepEqual(await counts(), before);
  });

  test('validation passes, and the system-time replay agrees with application time', async () => {
    const conn = await pool.getConnection();
    try { await replayMirror(conn); } finally { conn.release(); }
    const checks = await databaseChecks(pool, { manifest: { articles: fixtureManifest(fixtureEntries()) }, curated: fixtureEntries() });
    const failed = checks.filter((c) => !c.ok && c.level === 'error');
    assert.deepEqual(failed, []);
    assert.ok(checks.find((c) => c.name.includes('replay agree')).ok);
  });

  after(() => pool.end());
});

describe('failure handling', () => {
  before(async () => {
    await resetTestDatabase();
    pool = testPool();
  });
  after(() => pool.end());

  test('an outage mid-run leaves consistent data; re-running completes to the exact same final state', async () => {
    const flaky = new FakeWikipedia(fixturePages(), { failContentFor: new Set([140]) });
    const { result } = await loadFixture(pool, { wiki: flaky });
    assert.equal(result.status, 'partial');
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /simulated API outage/);
    const partial = await timeline(ALPHA);
    assert.deepEqual(partial.map((r) => r.rev_id), [100, 110, 130], 'Alpha stays at its last committed step');
    assert.equal(partial.at(-1).valid_to, INF);
    const [state] = await pool.query('SELECT synced_through FROM article_sync_state s JOIN articles a USING (article_id) WHERE a.page_id = ? AND a.resolution_status = "resolved"', [ALPHA]);
    assert.equal(state.synced_through, '2022-09-22 00:00:00');

    const r2 = await ingestAgain(new FakeWikipedia(fixturePages()));
    assert.equal(r2.status, 'succeeded');
    assert.deepEqual((await timeline(ALPHA)).map((r) => [r.rev_id, r.valid_from, r.valid_to]), EXPECTED_ALPHA);
    const runs = await pool.query('SELECT status FROM ingestion_runs ORDER BY run_id');
    assert.deepEqual(runs.map((r) => r.status), ['partial', 'succeeded']);
  });

  test('a SHA-1 mismatch between metadata and downloaded text fails the article loudly', async () => {
    await resetTestDatabase();
    const corrupt = new FakeWikipedia(fixturePages(), { corruptSha1For: new Set([200]) });
    const { result } = await loadFixture(pool, { wiki: corrupt });
    assert.equal(result.status, 'partial');
    assert.match(result.failures.join('\n'), /SHA-1 mismatch/);
    const [{ n }] = await pool.query('SELECT COUNT(*) AS n FROM revisions WHERE rev_id = 200');
    assert.equal(n, 0, 'nothing of the failed article step was committed');
  });

  test('only one ingestion at a time (MariaDB advisory lock); abandoned runs are marked failed', async () => {
    const holder = await pool.getConnection();
    try {
      await holder.query("SELECT GET_LOCK(CONCAT(DATABASE(), '.ingest'), 0)");
      await assert.rejects(ingestAgain(new FakeWikipedia(fixturePages())), /another ingestion is running/);
    } finally {
      await holder.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), '.ingest'))");
      holder.release();
    }
    await pool.query("INSERT INTO ingestion_runs (window_start, window_end, status) VALUES ('2021-09-22', '2026-09-22', 'running')");
    await ingestAgain(new FakeWikipedia(fixturePages()));
    const [{ n }] = await pool.query("SELECT COUNT(*) AS n FROM ingestion_runs WHERE status = 'running'");
    assert.equal(n, 0);
  });

  test('metadata pagination follows rvcontinue until exhausted', async () => {
    const wiki = new FakeWikipedia(fixturePages());
    await resetTestDatabase();
    await loadFixture(pool, { wiki, pageSize: 1, stepMonths: 0 });
    const alphaRequests = wiki.log.filter((p) => p.pageids === String(ALPHA) && p.rvdir === 'newer');
    assert.ok(alphaRequests.length >= 8, `expected one request per revision with rvlimit=1, got ${alphaRequests.length}`);
    assert.ok(alphaRequests.some((p) => p.rvcontinue));
    assert.equal((await timeline(ALPHA)).length, 8);
    assert.equal(await articleIdByPage(pool, ALPHA) > 0, true);
  });
});

describe('extending the window', () => {
  before(async () => {
    await resetTestDatabase();
    pool = testPool();
  });
  after(() => pool.end());

  test('narrow window first, then the full window: older revisions are inserted before existing ones, end state identical', async () => {
    const narrowStart = new Date('2023-01-01T00:00:00Z');
    const narrowEnd = new Date('2024-06-01T00:00:00Z');
    const { syncCatalog } = await import('../../src/ingestion/catalog.js');
    const { withTransaction } = await import('../../src/db/pool.js');
    await withTransaction(pool, (conn) => syncCatalog(conn, fixtureManifest(fixtureEntries())));

    const r1 = await ingestAgain(new FakeWikipedia(fixturePages()), { windowStart: narrowStart, windowEnd: narrowEnd, stepMonths: 0 });
    assert.equal(r1.status, 'succeeded');
    assert.deepEqual((await timeline(ALPHA)).map((r) => r.rev_id), [130, 140, 150, 160], 'baseline for the narrow window is 130');
    assert.equal((await timeline(ALPHA)).at(-1).valid_to, INF);

    const r2 = await ingestAgain(new FakeWikipedia(fixturePages()));
    assert.equal(r2.status, 'succeeded');
    assert.deepEqual((await timeline(ALPHA)).map((r) => [r.rev_id, r.valid_from, r.valid_to]), EXPECTED_ALPHA);
    const [{ dup }] = await pool.query('SELECT COUNT(*) - COUNT(DISTINCT rev_id) AS dup FROM revisions');
    assert.equal(dup, 0);
    const [state] = await pool.query(`SELECT synced_from, synced_through FROM article_sync_state s JOIN articles a USING (article_id)
      WHERE a.page_id = ? AND a.resolution_status = 'resolved'`, [ALPHA]);
    assert.deepEqual(state, { synced_from: '2021-09-22 00:00:00', synced_through: '2026-09-22 23:59:59' });
  });
});
