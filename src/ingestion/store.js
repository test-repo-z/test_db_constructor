// All SQL used by the ingestion pipeline. Every statement is parameterised.
import { chunk } from '../wikipedia/resolution.js';

const IN_BATCH = 1000;

/** Returns the subset of `ids` already present in `revisions`. */
export async function existingRevisionIds(conn, ids) {
  const found = new Set();
  for (const part of chunk(ids, IN_BATCH)) {
    if (!part.length) continue;
    const rows = await conn.query(`SELECT rev_id FROM revisions WHERE rev_id IN (${part.map(() => '?').join(',')})`, part);
    for (const r of rows) found.add(r.rev_id);
  }
  return found;
}

/** Returns the subset of SHA-1 digests whose text is already stored. */
export async function existingTextShas(conn, shas) {
  const found = new Set();
  for (const part of chunk(shas, IN_BATCH)) {
    if (!part.length) continue;
    const rows = await conn.query(`SELECT sha1 FROM revision_texts WHERE sha1 IN (${part.map(() => '?').join(',')})`, part);
    for (const r of rows) found.add(r.sha1);
  }
  return found;
}

export async function loadArticleRevisionKeys(conn, articleId) {
  const rows = await conn.query('SELECT rev_id, rev_timestamp AS ts FROM revisions WHERE article_id = ?', [articleId]);
  return rows;
}

/** Current (system-time "now") application-time timeline of one article. */
export async function loadCurrentTimeline(conn, articleId) {
  return conn.query(
    'SELECT rev_id, valid_from, valid_to FROM article_history WHERE article_id = ? ORDER BY valid_from',
    [articleId]);
}

export async function getSyncState(conn, articleId) {
  const rows = await conn.query('SELECT synced_from, synced_through FROM article_sync_state WHERE article_id = ?', [articleId]);
  return rows[0] ?? null;
}

export async function insertChunk(conn, articleId, { payload, raw, entries }) {
  const res = await conn.query(
    `INSERT INTO content_chunks (article_id, codec, text_count, raw_bytes, stored_bytes, payload)
     VALUES (?, 'brotli', ?, ?, ?, ?)`,
    [articleId, entries.length, raw.length, payload.length, payload]);
  const chunkId = res.insertId;
  await conn.batch(
    'INSERT IGNORE INTO revision_texts (sha1, chunk_id, byte_offset, byte_length) VALUES (?, ?, ?, ?)',
    entries.map((e) => [e.sha1, chunkId, e.byte_offset, e.byte_length]));
  return chunkId;
}

export async function insertRevisions(conn, rows, runId) {
  if (!rows.length) return 0;
  const res = await conn.batch(
    `INSERT IGNORE INTO revisions
       (rev_id, article_id, parent_rev_id, rev_timestamp, editor, editor_id, editor_hidden,
        comment, comment_hidden, is_minor, size_bytes, sha1, content_status, is_baseline, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rows.map((r) => [r.rev_id, r.article_id, r.parent_rev_id, r.rev_timestamp_sql, r.editor, r.editor_id,
      r.editor_hidden, r.comment, r.comment_hidden, r.is_minor, r.size_bytes,
      r.content_status === 'available' ? r.sha1 : null, r.content_status, r.is_baseline, runId]));
  return Array.isArray(res) ? res.reduce((s, x) => s + x.affectedRows, 0) : res.affectedRows;
}

/**
 * Applies a plan from planTimelineChanges(). Order matters for WITHOUT OVERLAPS:
 * shrink/remove existing intervals first, then insert the new ones into the freed time.
 */
export async function applyTimelinePlan(conn, articleId, plan) {
  for (const d of plan.deletes) {
    // The interval became empty (same-second successor). System versioning keeps the old row.
    await conn.query('DELETE FROM article_history WHERE article_id = ? AND rev_id = ?', [articleId, d.rev_id]);
  }
  for (const t of plan.trims) {
    // SQL:2011 application-time DML: remove the portion [portion_from, portion_to) of this
    // revision's validity. MariaDB rewrites [a, old_end) into [a, portion_from) and, because
    // the table is system-versioned, keeps the superseded belief as a history row.
    await conn.query(
      'DELETE FROM article_history FOR PORTION OF valid_period FROM ? TO ? WHERE article_id = ? AND rev_id = ?',
      [t.portion_from, t.portion_to, articleId, t.rev_id]);
  }
  if (plan.inserts.length) {
    await conn.batch(
      'INSERT INTO article_history (article_id, rev_id, valid_from, valid_to) VALUES (?, ?, ?, ?)',
      plan.inserts.map((v) => [articleId, v.rev_id, v.valid_from, v.valid_to]));
  }
}

export async function upsertSyncState(conn, articleId, from, through, runId) {
  await conn.query(
    `INSERT INTO article_sync_state (article_id, synced_from, synced_through, last_run_id) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE synced_from = LEAST(synced_from, VALUES(synced_from)),
                             synced_through = GREATEST(synced_through, VALUES(synced_through)),
                             last_run_id = VALUES(last_run_id)`,
    [articleId, from, through, runId]);
}

export async function createRun(conn, { windowStart, windowEnd, options }) {
  const res = await conn.query(
    'INSERT INTO ingestion_runs (window_start, window_end, options) VALUES (?, ?, ?)',
    [windowStart, windowEnd, JSON.stringify(options)]);
  return res.insertId;
}

export async function updateRunCounters(conn, runId, c) {
  await conn.query(
    `UPDATE ingestion_runs SET articles_total = ?, articles_failed = ?, revisions_seen = ?, revisions_inserted = ?,
       revisions_skipped = ?, texts_inserted = ?, raw_text_bytes = ?, stored_text_bytes = ?, api_requests = ?, api_retries = ?
     WHERE run_id = ?`,
    [c.articlesTotal, c.articlesFailed, c.revisionsSeen, c.revisionsInserted, c.revisionsSkipped, c.textsInserted,
      c.rawBytes, c.storedBytes, c.apiRequests, c.apiRetries, runId]);
}

export async function finishRun(conn, runId, status, errorSummary = null) {
  await conn.query(
    'UPDATE ingestion_runs SET status = ?, finished_at = CURRENT_TIMESTAMP(6), error_summary = ? WHERE run_id = ?',
    [status, errorSummary, runId]);
}

/** Runs left in 'running' state by a crashed process are marked failed (we hold the ingest lock). */
export async function markAbandonedRuns(conn) {
  const res = await conn.query(
    "UPDATE ingestion_runs SET status = 'failed', finished_at = CURRENT_TIMESTAMP(6), error_summary = 'abandoned (process stopped before finishing)' WHERE status = 'running'");
  return res.affectedRows;
}

export async function insertCheckpoint(conn, runId, through, articlesSynced) {
  await conn.query(
    'INSERT INTO sync_checkpoints (run_id, synced_through, articles_synced) VALUES (?, ?, ?)',
    [runId, through, articlesSynced]);
}

// MariaDB advisory (named) lock: only one writer (ingestion or mirror replay) per database.
// Named locks are server-wide, so the name is scoped by the current database.
const LOCK_NAME = "CONCAT(DATABASE(), '.ingest')";

export async function acquireIngestLock(conn) {
  const [{ ok }] = await conn.query(`SELECT GET_LOCK(${LOCK_NAME}, 0) AS ok`);
  return ok === 1;
}

export async function releaseIngestLock(conn) {
  await conn.query(`SELECT RELEASE_LOCK(${LOCK_NAME})`);
}
