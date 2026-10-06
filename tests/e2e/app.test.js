// End-to-end smoke tests: the real Express app on an ephemeral port, real HTTP requests,
// real MariaDB (fixture data), connecting with the least-privilege web account when configured.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config/index.js';
import { createApp } from '../../src/app.js';
import { resetTestDatabase, testPool, loadFixture, articleIdByPage } from '../helpers/db.js';
import { replayMirror } from '../../src/ingestion/replay.js';
import { ALPHA } from '../fixtures/dataset.js';

let server;
let base;
let writerPool;
let webPool;
let alpha;

before(async () => {
  await resetTestDatabase();
  writerPool = testPool();
  await loadFixture(writerPool);
  const conn = await writerPool.getConnection();
  try { await replayMirror(conn); } finally { conn.release(); }
  alpha = await articleIdByPage(writerPool, ALPHA);
  webPool = testPool({ user: config.db.webUser, password: config.db.webPassword });
  const app = createApp({ pool: webPool, rateLimitPerMinute: 1000, logRequests: false });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server?.close(r));
  await webPool?.end();
  await writerPool?.end();
});

const get = (path, headers = {}) => fetch(base + path, { headers, redirect: 'manual' });

test('application starts and reports healthy', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'ok' });
});

test('article list loads with domains and coverage', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Alpha/);
  assert.match(html, /2021-09-22T00:00:00Z/);
  const api = await (await get('/api/articles')).json();
  assert.equal(api.articles.length, 3);
  assert.deepEqual(api.domains.sort(), ['Astronomy', 'Biology', 'Chemistry', 'Physics']);
  const filtered = await (await get('/api/articles?domain=Biology')).json();
  assert.deepEqual(filtered.articles.map((a) => a.canonical_title), ['Gamma']);
});

test('historical article loads (HTML and JSON) with revision metadata and the SQL used', async () => {
  const r = await get(`/articles/${alpha}/as-of?t=2023-03-15T10:30:05Z`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /150/);
  assert.match(html, /same revision ✓/);
  const j = await (await get(`/api/articles/${alpha}/as-of?t=2023-03-15T10:30:04Z`)).json();
  assert.equal(j.revision.rev_id, 140);
  assert.equal(j.revision.valid_to, '2023-03-15T10:30:05Z');
  assert.equal(j.next_rev_id, 150);
  assert.match(j.query.sql, /valid_from <= \?/);
  assert.equal(j.system_time_cross_check.agrees, true);
});

test('diff loads', async () => {
  const r = await get(`/articles/${alpha}/diff?a=2022-01-01&b=2023-04-01`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /4<\/strong> edits were saved between/);
  const j = await (await get(`/api/articles/${alpha}/diff?a=2023-04-01&b=2023-12-01`)).json();
  assert.equal(j.same_revision, true);
});

test('invalid and out-of-coverage dates are rejected with useful errors', async () => {
  const cases = [
    [`/articles/${alpha}/as-of?t=2018-03-15`, 422, /outside the imported dataset/],
    [`/api/articles/${alpha}/as-of?t=2026-09-23`, 422, /OUT_OF_COVERAGE/],
    [`/api/articles/${alpha}/as-of?t=2023-02-30`, 400, /valid calendar date/],
    [`/api/articles/${alpha}/as-of?t=1%27%20OR%201=1`, 400, /must look like/],
    [`/api/articles/${alpha}/diff?a=2023-01-01`, 400, /required/],
    ['/api/articles/abc/as-of?t=2023-01-01', 400, /positive integer/],
    ['/api/articles/424242', 404, /not found/],
    ['/definitely/not/here', 404, /not found/],
  ];
  for (const [path, status, body] of cases) {
    const r = await get(path);
    assert.equal(r.status, status, path);
    assert.match(await r.text(), body, path);
  }
});

test('security headers: CSP without inline scripts/styles, no X-Powered-By, rate-limit headers', async () => {
  const r = await get(`/articles/${alpha}/as-of?t=2026-06-01`);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.headers.get('ratelimit'));
  const html = await r.text();
  // the stored revision 180 contains <script>alert(1)</script>; only our own script tag may appear
  assert.deepEqual(html.match(/<script[^>]*>/g), ['<script src="/static/js/app.js" defer>']);
  assert.doesNotMatch(html, /onerror=/);
});

test('history, temporal lab and about pages load', async () => {
  for (const p of [`/articles/${alpha}`, `/articles/${alpha}/history?from=2023-01-01&to=2023-12-31`, `/articles/${alpha}/temporal?t=2024-06-01`, '/about']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
  }
  const lab = await (await get(`/articles/${alpha}/temporal?t=2024-06-01`)).text();
  assert.match(lab, /FOR SYSTEM_TIME ALL/);
  assert.match(lab, /FOR SYSTEM_TIME BETWEEN/);
  assert.match(lab, /FOR SYSTEM_TIME AS OF/);
});

test('the web tier cannot write (least privilege), when a dedicated web account is configured', async (t) => {
  if (config.db.webUser === config.db.user) return t.skip('no separate DB_WEB_USER configured');
  await assert.rejects(webPool.query('DELETE FROM revisions'), (e) => e.code === 'ER_TABLEACCESS_DENIED_ERROR');
  await assert.rejects(webPool.query('DELETE HISTORY FROM article_history'), (e) => /denied/i.test(e.message));
});
