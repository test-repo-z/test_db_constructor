// Fetching revision metadata and content from the MediaWiki Action API.
//
// Two-pass strategy (keeps traffic low):
//   pass 1  metadata  prop=revisions, rvprop without content -> up to 500 revisions per request, paginated
//                     with `continue.rvcontinue` until exhausted (never assume one response is complete).
//   pass 2  content   prop=revisions&revids=...  only for SHA-1 digests we do not already store
//                     (identical texts — e.g. reverts of vandalism — are downloaded once).
import { createHash } from 'node:crypto';

const META_PROPS = 'ids|timestamp|flags|user|userid|comment|size|sha1';

export const toApiTimestamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Maps one API revision object to our row shape. Hidden (revision-deleted) fields become null + flag. */
export function normalizeRevision(pageId, rev) {
  return {
    rev_id: rev.revid,
    page_id: pageId,
    parent_rev_id: rev.parentid || null,
    rev_timestamp: rev.timestamp, // ISO 8601 UTC, second precision, e.g. 2023-04-01T12:34:56Z
    editor: rev.userhidden ? null : (rev.user ?? null),
    editor_id: rev.userhidden ? null : (rev.userid ?? null),
    editor_hidden: Boolean(rev.userhidden),
    comment: rev.commenthidden ? null : (rev.comment ?? ''),
    comment_hidden: Boolean(rev.commenthidden),
    is_minor: Boolean(rev.minor),
    size_bytes: rev.size ?? null,
    sha1: rev.sha1hidden ? null : (rev.sha1 ?? null),
    content_hidden: Boolean(rev.sha1hidden || rev.texthidden || rev.suppressed),
  };
}

/**
 * All revisions of `pageId` with start <= timestamp <= end, oldest first.
 * The API applies rvstart/rvend inclusively.
 */
export async function fetchRevisionMetadata(client, pageId, { start, end, pageSize = 500, onPage } = {}) {
  const out = [];
  let cont = {};
  for (let page = 1; ; page++) {
    const body = await client.query({
      action: 'query',
      prop: 'revisions',
      pageids: String(pageId),
      rvprop: META_PROPS,
      rvslots: 'main',
      rvdir: 'newer',
      rvstart: toApiTimestamp(start),
      rvend: toApiTimestamp(end),
      rvlimit: String(pageSize),
      ...cont,
    });
    const p = body.query?.pages?.[0];
    if (!p || p.missing) throw new Error(`page ${pageId} not found while fetching revisions`);
    const revs = (p.revisions ?? []).map((r) => normalizeRevision(pageId, r));
    out.push(...revs);
    onPage?.({ page, fetched: revs.length, total: out.length });
    if (!body.continue?.rvcontinue) break;
    cont = { continue: body.continue.continue, rvcontinue: body.continue.rvcontinue };
  }
  return out;
}

/** The revision that was current at `start` (latest revision with timestamp <= start), or null if the page did not exist yet. */
export async function fetchBaselineRevision(client, pageId, { start }) {
  const body = await client.query({
    action: 'query',
    prop: 'revisions',
    pageids: String(pageId),
    rvprop: META_PROPS,
    rvslots: 'main',
    rvdir: 'older',
    rvstart: toApiTimestamp(start),
    rvlimit: '1',
  });
  const r = body.query?.pages?.[0]?.revisions?.[0];
  return r ? normalizeRevision(pageId, r) : null;
}

export const sha1Hex = (text) => createHash('sha1').update(text, 'utf8').digest('hex');

/**
 * Downloads wikitext for the given revision ids. Returns Map(revId -> {content, sha1, hidden}).
 * Responses can be truncated by the API's result-size limit; any revision whose content did not arrive
 * is simply requested again in a later (smaller) batch, so we never depend on partial-continuation details.
 */
export async function fetchRevisionContents(client, revIds, { batchSize = 20, onBatch } = {}) {
  const pending = [...revIds];
  const result = new Map();
  let size = batchSize;
  let stalls = 0;
  while (pending.length) {
    const batch = pending.splice(0, size);
    const body = await client.query({
      action: 'query',
      prop: 'revisions',
      revids: batch.join('|'),
      rvprop: 'ids|sha1|content',
      rvslots: 'main',
    });
    const got = new Set();
    for (const p of body.query?.pages ?? []) {
      for (const r of p.revisions ?? []) {
        const slot = r.slots?.main;
        if (slot && (slot.texthidden || slot.textmissing || r.sha1hidden)) {
          result.set(r.revid, { content: null, sha1: null, hidden: true });
          got.add(r.revid);
        } else if (slot && typeof slot.content === 'string') {
          result.set(r.revid, { content: slot.content, sha1: r.sha1 ?? null, hidden: false, model: slot.contentmodel });
          got.add(r.revid);
        }
      }
    }
    for (const id of body.query?.badrevids ? Object.keys(body.query.badrevids) : []) {
      result.set(Number(id), { content: null, sha1: null, hidden: true, bad: true });
      got.add(Number(id));
    }
    const missing = batch.filter((id) => !got.has(id));
    if (missing.length) {
      // Truncated response: retry the remainder with a smaller batch.
      pending.unshift(...missing);
      size = Math.max(1, Math.floor(size / 2));
      if (got.size === 0 && ++stalls > 5) throw new Error(`content download made no progress for revids ${missing.slice(0, 5).join(',')}...`);
    } else {
      stalls = 0;
      size = Math.min(batchSize, size + 1);
    }
    onBatch?.({ done: result.size, total: revIds.length });
  }
  return result;
}
