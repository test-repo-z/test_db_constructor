// Synchronises the `articles` table with the resolution manifest.
//
// Rows are only UPDATEd when a resolution fact actually changed. This matters because
// `articles` is system-versioned: an unconditional UPDATE would create a history row on
// every run, burying the genuinely interesting events (a page rename, a new redirect).
import { ident } from '../db/sql.js';

const FIELDS = ['curated_position', 'domain_id', 'resolution_status', 'canonical_title', 'page_id', 'canonical_url',
  'is_redirect', 'is_disambiguation', 'redirect_fragment', 'duplicate_of_article_id', 'resolution_reason'];

const INSERT_COLUMNS = ['requested_title', ...FIELDS];
const norm = (v) => (typeof v === 'boolean' ? Number(v) : v ?? null);

export function desiredRow(record, position, domainId, duplicateOfId) {
  return {
    requested_title: record.requested_title,
    curated_position: position,
    domain_id: domainId,
    resolution_status: record.status,
    canonical_title: record.canonical_title,
    page_id: record.page_id,
    canonical_url: record.url,
    is_redirect: record.is_redirect ? 1 : 0,
    is_disambiguation: record.is_disambiguation ? 1 : 0,
    redirect_fragment: record.redirect_fragment,
    duplicate_of_article_id: duplicateOfId,
    resolution_reason: record.reason,
  };
}

export function changedFields(existing, desired) {
  return FIELDS.filter((f) => norm(existing[f]) !== norm(desired[f]));
}

/**
 * @param conn         open connection (caller manages the transaction)
 * @param records      manifest.articles, in curated order
 * @returns {Promise<{inserted:number, updated:number, unchanged:number, byTitle:Map<string, object>}>}
 */
export async function syncCatalog(conn, records) {
  for (const name of [...new Set(records.map((r) => r.domain))]) {
    await conn.query('INSERT IGNORE INTO domains (name) VALUES (?)', [name]);
  }
  const domainIds = new Map((await conn.query('SELECT domain_id, name FROM domains')).map((d) => [d.name, d.domain_id]));
  const existing = new Map((await conn.query('SELECT * FROM articles')).map((a) => [a.requested_title, a]));
  const stats = { inserted: 0, updated: 0, unchanged: 0 };

  const upsert = async (record, position, duplicateOfId) => {
    const want = desiredRow(record, position, domainIds.get(record.domain), duplicateOfId);
    const have = existing.get(record.requested_title);
    if (!have) {
      const cols = Object.keys(want);
      const res = await conn.query(
        `INSERT INTO articles (${cols.map((c) => ident(c, INSERT_COLUMNS)).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map((c) => want[c]));
      existing.set(record.requested_title, { ...want, article_id: res.insertId });
      stats.inserted++;
      return;
    }
    const diff = changedFields(have, want);
    if (!diff.length) { stats.unchanged++; return; }
    await conn.query(
      `UPDATE articles SET ${diff.map((f) => `${ident(f, FIELDS)} = ?`).join(', ')} WHERE article_id = ?`,
      [...diff.map((f) => want[f]), have.article_id]);
    existing.set(record.requested_title, { ...have, ...want });
    stats.updated++;
  };

  // Pass 1: every non-duplicate (owners must exist before duplicates can point at them).
  for (const [i, r] of records.entries()) if (r.status !== 'duplicate') await upsert(r, i, null);
  // Pass 2: duplicates, pointing at their owner's article_id.
  for (const [i, r] of records.entries()) {
    if (r.status !== 'duplicate') continue;
    const owner = existing.get(r.duplicate_of);
    if (!owner) throw new Error(`duplicate "${r.requested_title}" points to unknown owner "${r.duplicate_of}"`);
    await upsert(r, i, owner.article_id);
  }
  return { ...stats, byTitle: existing };
}
