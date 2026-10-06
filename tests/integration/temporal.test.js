// Historical reconstruction through the service layer, on real MariaDB with the fixture dataset.
// Covers the edge cases of the specification (boundaries, first/last, outside coverage, creation
// inside the window, same-second edits, hidden content, diff corner cases, bitemporal knowledge).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetTestDatabase, testPool, loadFixture, articleIdByPage } from '../helpers/db.js';
import { ALPHA, BETA, GAMMA } from '../fixtures/dataset.js';
import { ArticleRepository } from '../../src/repositories/articleRepository.js';
import { HistoryRepository } from '../../src/repositories/historyRepository.js';
import { ContentRepository } from '../../src/repositories/contentRepository.js';
import { TimeMachineService } from '../../src/services/timeMachineService.js';
import { replayMirror } from '../../src/ingestion/replay.js';

let pool;
let svc;
let alpha;
let beta;
let gamma;
const revAt = async (id, t) => (await svc.asOf(id, t, { render: false })).revision?.rev_id ?? null;

before(async () => {
  await resetTestDatabase();
  pool = testPool();
  await loadFixture(pool);
  const conn = await pool.getConnection();
  try { await replayMirror(conn); } finally { conn.release(); }
  svc = new TimeMachineService({ articleRepository: new ArticleRepository(pool), historyRepository: new HistoryRepository(pool), contentRepository: new ContentRepository(pool) });
  [alpha, beta, gamma] = await Promise.all([ALPHA, BETA, GAMMA].map((p) => articleIdByPage(pool, p)));
});
after(() => pool.end());

test('1-3. exactly at, immediately before and immediately after a revision timestamp', async () => {
  assert.equal(await revAt(alpha, '2023-03-15T10:30:05Z'), 150, 'at T: the new revision');
  assert.equal(await revAt(alpha, '2023-03-15T10:30:04Z'), 140, '1 s before: the previous one');
  assert.equal(await revAt(alpha, '2023-03-15T10:30:06Z'), 150, '1 s after: still the new one');
});

test('4-5. first and last revision; the window start resolves to the baseline revision', async () => {
  assert.equal(await revAt(alpha, '2021-09-22T00:00:00Z'), 100, 'baseline saved in 2020 was live at the window start');
  assert.equal(await revAt(alpha, '2021-10-01T12:00:00Z'), 110, 'first in-window revision');
  assert.equal(await revAt(alpha, '2026-09-22T23:59:59Z'), 180, 'last revision, open-ended');
  const r = await svc.asOf(alpha, '2021-09-22T00:00:00Z', { render: false });
  assert.equal(r.revision.is_baseline, true);
  assert.equal(r.revision.valid_from, '2020-05-01 10:00:00', 'application time keeps the real 2020 timestamp');
  assert.equal(r.previous, null, 'no navigation before the window');
});

test('6-7. instants before / after the dataset coverage are rejected (e.g. 2018-03-15)', async () => {
  for (const t of ['2018-03-15', '2021-09-21T23:59:59Z', '2026-09-23T00:00:00Z']) {
    await assert.rejects(svc.asOf(alpha, t), (e) => e.status === 422 && e.code === 'OUT_OF_COVERAGE');
  }
  await assert.rejects(svc.asOf(alpha, 'not-a-date'), (e) => e.status === 400);
});

test('8. a redirect-resolved article is reconstructed through its canonical page', async () => {
  const article = await svc.getArticle(beta);
  assert.equal(article.resolution_status, 'redirect');
  assert.equal(article.canonical_title, 'Beta');
  assert.equal(await revAt(beta, '2025-01-01'), 210);
});

test('9-10. missing, disambiguation and duplicate entries are not browsable (404) but are recorded', async () => {
  const all = await svc.articles.listAllCurated();
  for (const status of ['missing', 'disambiguation', 'duplicate']) {
    const row = all.find((a) => a.resolution_status === status);
    assert.ok(row, status);
    await assert.rejects(svc.getArticle(row.article_id), (e) => e.status === 404);
  }
});

test('11. several revisions within seconds: same-second edits resolve to the highest rev_id', async () => {
  assert.equal(await revAt(alpha, '2022-06-15T08:30:00Z'), 130);
  assert.equal(await revAt(alpha, '2022-06-15T08:29:59Z'), 110);
  const r = await svc.asOf(alpha, '2023-03-15T10:30:02Z', { render: false });
  assert.equal(r.next.rev_id, 150);
  assert.equal(r.previous.rev_id, 130);
});

test('12. no revision INSIDE the window: Gamma is reconstructed from its pre-window baseline', async () => {
  assert.equal(await revAt(gamma, '2024-01-01'), 300);
});

test('article created inside the window: before creation there is no revision (clear message, not an error)', async () => {
  const r = await svc.asOf(beta, '2022-02-28T23:59:59Z', { render: false });
  assert.equal(r.revision, null);
  assert.equal(r.notYetCreated.first_from_iso, '2022-03-01T00:00:00Z');
  assert.equal(await revAt(beta, '2022-03-01T00:00:00Z'), 200);
});

test('hidden content keeps its place on the timeline but has no text', async () => {
  const r = await svc.asOf(alpha, '2024-06-01');
  assert.equal(r.revision.rev_id, 160);
  assert.equal(r.revision.content_status, 'hidden');
  assert.equal(r.wikitext, null);
});

test('rendered content is sanitised (no script, no event handlers)', async () => {
  const r = await svc.asOf(alpha, '2026-06-01');
  assert.equal(r.revision.rev_id, 180);
  assert.match(r.wikitext, /<script>/, 'the stored wikitext is exact');
  assert.doesNotMatch(r.rendered.html, /<script|onerror|<img|href="javascript:/i);
});

test('system-time replay (page_mirror AS OF) agrees with the application-time answer', async () => {
  for (const t of ['2021-09-22', '2022-06-15T08:30:00Z', '2023-03-15T10:30:04Z', '2024-06-01', '2026-09-22T23:59:59Z']) {
    const r = await svc.asOf(alpha, t, { render: false });
    assert.equal(r.mirror.agrees, true, t);
  }
});

test('bitemporal: as known after the first sync step vs. today', async () => {
  const [cp1] = await svc.checkpoints();
  const r = await svc.asOf(alpha, '2024-06-01', { checkpoint: String(cp1.checkpoint_id), render: false });
  assert.equal(r.revision.rev_id, 160, 'today we know revision 160 was live');
  assert.equal(r.knownAt.revision.rev_id, 130, 'after step 1 the database believed 130 was still current');
  assert.equal(r.knownAt.revision.open_ended, true);
  assert.equal(r.knownAt.agrees, false);
  await assert.rejects(svc.asOf(alpha, '2024-06-01', { checkpoint: '999' }), (e) => e.status === 400);
});

test('13. diff where both instants resolve to the same revision', async () => {
  const d = await svc.diff(alpha, '2023-04-01', '2023-12-01');
  assert.equal(d.sameRevision, true);
  assert.equal(d.earlier.rev_id, 150);
  assert.equal(d.editsBetween, 0);
});

test('diff: chronological order enforced, edits counted, real changes found', async () => {
  const d = await svc.diff(alpha, '2023-04-01', '2022-01-01');
  assert.equal(d.swapped, true);
  assert.equal(d.earlier.rev_id, 110);
  assert.equal(d.later.rev_id, 150);
  assert.equal(d.editsBetween, 4, 'revisions 120, 130, 140, 150 were saved in between');
  assert.equal(d.sameRevision, false);
  assert.ok(d.diff.stats.added > 0 && d.diff.stats.removed > 0);
  const textMode = await svc.diff(alpha, '2022-01-01', '2023-04-01', { mode: 'text' });
  assert.equal(textMode.mode, 'text');
});

test('14. diff with an invalid or out-of-range instant; diff involving hidden text', async () => {
  await assert.rejects(svc.diff(alpha, '2023-01-01', 'yesterday'), (e) => e.status === 400);
  await assert.rejects(svc.diff(alpha, '2017-01-01', '2023-01-01'), (e) => e.status === 422);
  await assert.rejects(svc.diff(beta, '2022-01-01', '2023-01-01'), (e) => e.status === 422 && e.code === 'NO_REVISION');
  await assert.rejects(svc.diff(alpha, '2023-01-01', '2024-06-01'), (e) => e.code === 'CONTENT_HIDDEN');
  await assert.rejects(svc.diff(alpha, '2023-01-01', '2024-01-01', { mode: 'html' }), (e) => e.status === 400);
});

test('history listing: application-time overlap, newest first, paginated', async () => {
  const h = await svc.historyPage(alpha, { from: '2023-01-01', to: '2023-12-31' });
  assert.deepEqual(h.revisions.map((r) => r.rev_id), [150, 140, 130]);
  assert.equal(h.total, 3);
  await assert.rejects(svc.historyPage(alpha, { from: '2024-01-01', to: '2023-01-01' }), (e) => e.status === 400);
});

test('temporal lab runs AS OF, BETWEEN and ALL demonstrations with their SQL', async () => {
  const lab = await svc.temporalLab(alpha, { t: '2024-06-01' });
  const keys = lab.demos.map((d) => d.key);
  for (const k of ['app', 'all', 'asof', 'bitemporal', 'between', 'mirror-asof', 'mirror-between', 'audit']) assert.ok(keys.includes(k), k);
  const all = lab.demos.find((d) => d.key === 'all');
  assert.match(all.sql, /FOR SYSTEM_TIME ALL/);
  assert.ok(all.rows.some((r) => !r.is_current), 'superseded row versions are visible');
  assert.match(lab.demos.find((d) => d.key === 'between').sql, /FOR SYSTEM_TIME BETWEEN/);
  assert.match(lab.demos.find((d) => d.key === 'asof').sql, /FOR SYSTEM_TIME AS OF/);
});
