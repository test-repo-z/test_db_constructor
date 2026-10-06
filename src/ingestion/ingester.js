// Ingestion orchestrator.
//
// The window is synchronised in STEPS (default: 12 months). After each step every article is
// known up to the step's cutoff and a checkpoint is committed. This mirrors a periodically
// running sync job, and it is what gives MariaDB's system history real content: each step
// closes the previously open-ended interval of every edited article, and the superseded
// belief ("this revision is current until further notice") is preserved as a history row.
//
// Per article and step, a single transaction writes: content chunks, revision events,
// timeline changes and the sync state. A crash therefore loses at most the article being
// processed; re-running continues from article_sync_state. Revision ids (PRIMARY KEY) and
// text digests (PRIMARY KEY) make every insert idempotent.
import { createHash } from 'node:crypto';
import { createLogger } from '../lib/logger.js';
import { withTransaction } from '../db/pool.js';
import { apiToSql, toSql, sqlToDate, syncCutoffs } from '../temporal/time.js';
import { planTimelineChanges } from '../temporal/timeline.js';
import { planChunks, compressChunk } from '../content/chunks.js';
import { fetchRevisionMetadata, fetchBaselineRevision, fetchRevisionContents } from '../wikipedia/revisions.js';
import * as store from './store.js';

const log = createLogger('ingest');
const sha1 = (s) => createHash('sha1').update(s, 'utf8').digest('hex');
const mb = (n) => (n / 1e6).toFixed(2);

export class IngestionCounters {
  constructor() {
    Object.assign(this, { articlesTotal: 0, articlesFailed: 0, revisionsSeen: 0, revisionsInserted: 0,
      revisionsSkipped: 0, textsInserted: 0, rawBytes: 0, storedBytes: 0, apiRequests: 0, apiRetries: 0,
      historyTrims: 0, historyDeletes: 0, historyInserts: 0, shadowed: 0 });
  }
}

/**
 * Synchronises one article up to `cutoff` (Date). Returns per-article stats.
 * Network work happens first (no open transaction while waiting for Wikipedia).
 */
export async function syncArticle({ pool, client, article, windowStart, cutoff, runId, includeBaseline, counters, contentBatchSize, pageSize }) {
  const t0 = Date.now();
  const conn = await pool.getConnection();
  try {
    const state = await store.getSyncState(conn, article.article_id);
    const wsSql = toSql(windowStart);
    const cutSql = toSql(cutoff);
    const ranges = [];
    let wantBaseline = false;
    if (!state) {
      ranges.push([windowStart, cutoff]);
      wantBaseline = includeBaseline;
    } else {
      if (wsSql < state.synced_from) { ranges.push([windowStart, sqlToDate(state.synced_from)]); wantBaseline = includeBaseline; }
      // Overlap by the boundary second on purpose: revisions saved in the cutoff second are
      // re-fetched and deduplicated by rev_id, so nothing on a boundary can be missed.
      if (state.synced_through < cutSql) ranges.push([sqlToDate(state.synced_through), cutoff]);
    }
    if (!ranges.length) return { skipped: true };

    // ---- 1. metadata (paginated) -------------------------------------------------------
    const fetched = [];
    if (wantBaseline) {
      const b = await fetchBaselineRevision(client, article.page_id, { start: windowStart });
      if (b) fetched.push({ ...b, is_baseline: true });
    }
    for (const [from, to] of ranges) {
      fetched.push(...(await fetchRevisionMetadata(client, article.page_id, { start: from, end: to, pageSize })));
    }
    const byId = new Map();
    for (const r of fetched) if (!byId.has(r.rev_id) || r.is_baseline) byId.set(r.rev_id, r);
    const metadata = [...byId.values()];
    counters.revisionsSeen += metadata.length;

    const known = await store.existingRevisionIds(conn, metadata.map((r) => r.rev_id));
    const fresh = metadata.filter((r) => !known.has(r.rev_id));
    counters.revisionsSkipped += metadata.length - fresh.length;

    // ---- 2. content, only for texts we do not have yet ----------------------------------
    const wantedSha = [...new Set(fresh.filter((r) => !r.content_hidden && r.sha1).map((r) => r.sha1))];
    const haveSha = await store.existingTextShas(conn, wantedSha);
    const firstRevBySha = new Map();
    for (const r of [...fresh].sort((a, b) => (a.rev_timestamp < b.rev_timestamp ? -1 : 1))) {
      if (r.sha1 && !r.content_hidden && !haveSha.has(r.sha1) && !firstRevBySha.has(r.sha1)) firstRevBySha.set(r.sha1, r);
    }
    const contents = firstRevBySha.size
      ? await fetchRevisionContents(client, [...firstRevBySha.values()].map((r) => r.rev_id), { batchSize: contentBatchSize })
      : new Map();

    const texts = [];
    const hiddenNow = new Set();
    for (const [digest, r] of firstRevBySha) {
      const c = contents.get(r.rev_id);
      if (!c || c.hidden) { hiddenNow.add(digest); continue; } // hidden between metadata and content fetch
      const actual = sha1(c.content);
      if (actual !== digest) {
        throw new Error(`SHA-1 mismatch for rev ${r.rev_id}: Wikipedia reports ${digest}, downloaded text hashes to ${actual}`);
      }
      texts.push({ sha1: digest, text: c.content });
    }
    const chunks = planChunks(texts).map((c) => ({ ...c, payload: compressChunk(c.raw) }));

    const rows = fresh.map((r) => {
      const available = r.sha1 && !r.content_hidden && !hiddenNow.has(r.sha1);
      return { ...r, article_id: article.article_id, rev_timestamp_sql: apiToSql(r.rev_timestamp),
        content_status: available ? 'available' : 'hidden', is_baseline: Boolean(r.is_baseline) };
    });

    // ---- 3. one transaction: content + events + timeline + progress ---------------------
    const result = await withTransaction(conn, async (tx) => {
      let raw = 0;
      let stored = 0;
      for (const c of chunks) {
        await store.insertChunk(tx, article.article_id, c);
        raw += c.raw.length;
        stored += c.payload.length;
      }
      const inserted = await store.insertRevisions(tx, rows, runId);
      const allRevs = await store.loadArticleRevisionKeys(tx, article.article_id);
      const current = await store.loadCurrentTimeline(tx, article.article_id);
      const plan = planTimelineChanges(current, allRevs);
      await store.applyTimelinePlan(tx, article.article_id, plan);
      const from = state ? (wsSql < state.synced_from ? wsSql : state.synced_from) : wsSql;
      await store.upsertSyncState(tx, article.article_id, from, cutSql, runId);
      return { inserted, raw, stored, plan };
    });

    counters.revisionsInserted += result.inserted;
    counters.textsInserted += texts.length;
    counters.rawBytes += result.raw;
    counters.storedBytes += result.stored;
    counters.historyTrims += result.plan.trims.length;
    counters.historyDeletes += result.plan.deletes.length;
    counters.historyInserts += result.plan.inserts.length;
    return {
      skipped: false,
      fetched: metadata.length,
      inserted: result.inserted,
      texts: texts.length,
      rawMB: mb(result.raw),
      storedMB: mb(result.stored),
      trims: result.plan.trims.length,
      shadowed: result.plan.shadowed.length,
      ms: Date.now() - t0,
    };
  } finally {
    conn.release();
  }
}

/**
 * Full ingestion run over `articles` (rows from the articles table: article_id, page_id, canonical_title).
 */
export async function runIngestion({ pool, client, articles, windowStart, windowEnd, stepMonths, includeBaseline,
  contentBatchSize = 20, pageSize = 500, options = {} }) {
  const counters = new IngestionCounters();
  counters.articlesTotal = articles.length;
  const lockConn = await pool.getConnection();
  let runId;
  try {
    if (!(await store.acquireIngestLock(lockConn))) {
      throw new Error('another ingestion is running (MariaDB advisory lock is held)');
    }
    const abandoned = await store.markAbandonedRuns(lockConn);
    if (abandoned) log.warn(`marked ${abandoned} abandoned run(s) as failed`);
    runId = await store.createRun(lockConn, { windowStart: toSql(windowStart), windowEnd: toSql(windowEnd), options });
    const cutoffs = syncCutoffs(windowStart, windowEnd, stepMonths);
    log.info('ingestion run started', { runId, articles: articles.length, steps: cutoffs.length,
      window: [windowStart.toISOString(), windowEnd.toISOString()] });

    const failed = new Map();
    for (const [si, cutoff] of cutoffs.entries()) {
      log.info(`=== step ${si + 1}/${cutoffs.length}: synchronising up to ${cutoff.toISOString()} ===`);
      let synced = 0;
      for (const [ai, article] of articles.entries()) {
        if (failed.has(article.article_id)) continue; // later steps would only fail again
        const label = `[step ${si + 1}/${cutoffs.length}] [${ai + 1}/${articles.length}] ${article.canonical_title}`;
        try {
          const r = await syncArticle({ pool, client, article, windowStart, cutoff, runId, includeBaseline, counters, contentBatchSize, pageSize });
          synced++;
          if (r.skipped) log.debug(`${label}: already synchronised`);
          else log.info(`${label}: ${r.fetched} revisions fetched, ${r.inserted} new, ${r.texts} texts ` +
            `(${r.rawMB} MB -> ${r.storedMB} MB), ${r.trims} interval(s) closed` +
            `${r.shadowed ? `, ${r.shadowed} same-second revision(s) shadowed` : ''}, ${(r.ms / 1000).toFixed(1)}s`);
        } catch (err) {
          failed.set(article.article_id, `${article.canonical_title}: ${err.message}`);
          counters.articlesFailed = failed.size;
          log.error(`${label}: FAILED — will be retried by the next run`, { error: err.message });
        }
        counters.apiRequests = client.stats.requests;
        counters.apiRetries = client.stats.retries;
        if (ai % 10 === 9) await store.updateRunCounters(lockConn, runId, counters);
      }
      await store.updateRunCounters(lockConn, runId, counters);
      await store.insertCheckpoint(lockConn, runId, toSql(cutoff), synced);
      log.info(`checkpoint committed: ${synced}/${articles.length} articles known up to ${cutoff.toISOString()}`);
    }
    const status = failed.size === 0 ? 'succeeded' : (failed.size < articles.length ? 'partial' : 'failed');
    await store.finishRun(lockConn, runId, status, failed.size ? [...failed.values()].join('\n').slice(0, 60000) : null);
    return { runId, status, counters, failures: [...failed.values()] };
  } catch (err) {
    if (runId) await store.finishRun(lockConn, runId, 'failed', err.message).catch(() => {});
    throw err;
  } finally {
    await store.releaseIngestLock(lockConn).catch(() => {});
    lockConn.release();
  }
}
