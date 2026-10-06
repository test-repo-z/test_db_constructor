// A deterministic, in-memory imitation of the parts of the MediaWiki Action API used by the
// ingestion (prop=revisions by page with rvstart/rvend/rvdir/rvlimit + continuation, and by revids).
// Only the EXTERNAL API is faked; every test that involves temporal semantics runs on real MariaDB.
import { createHash } from 'node:crypto';

export const sha1 = (s) => createHash('sha1').update(s, 'utf8').digest('hex');

export class FakeWikipedia {
  /**
   * @param pages Map(pageId -> [{revid, timestamp:'YYYY-MM-DDTHH:MM:SSZ', text, user?, comment?, hidden?}])
   */
  constructor(pages, { failContentFor = new Set(), corruptSha1For = new Set() } = {}) {
    this.pages = pages;
    this.failContentFor = failContentFor;     // revids whose content request throws (simulated outage)
    this.corruptSha1For = corruptSha1For;     // revids whose reported sha1 is wrong
    this.stats = { requests: 0, retries: 0, bytes: 0 };
    this.log = [];
  }

  #meta(pageId, r) {
    const base = { revid: r.revid, parentid: r.parentid ?? 0, timestamp: r.timestamp, size: Buffer.byteLength(r.text ?? '') };
    if (r.minor) base.minor = true;
    base.user = r.user ?? 'Tester';
    base.userid = 1;
    base.comment = r.comment ?? `edit ${r.revid}`;
    if (r.hidden) { base.sha1hidden = true; base.texthidden = true; } else base.sha1 = this.corruptSha1For.has(r.revid) ? '0'.repeat(40) : sha1(r.text);
    return base;
  }

  async query(params) {
    this.stats.requests++;
    this.log.push(params);
    if (params.revids) {
      const ids = params.revids.split('|').map(Number);
      if (ids.some((id) => this.failContentFor.has(id))) throw new Error('simulated API outage');
      const byPage = new Map();
      for (const [pageId, revs] of this.pages) {
        for (const r of revs) {
          if (!ids.includes(r.revid)) continue;
          const m = this.#meta(pageId, r);
          const out = { revid: m.revid, parentid: m.parentid, sha1: m.sha1, slots: { main: r.hidden ? { texthidden: true } : { contentmodel: 'wikitext', content: r.text } } };
          if (r.hidden) out.sha1hidden = true;
          if (!byPage.has(pageId)) byPage.set(pageId, []);
          byPage.get(pageId).push(out);
        }
      }
      return { query: { pages: [...byPage].map(([pageid, revisions]) => ({ pageid, ns: 0, revisions })) } };
    }
    const pageId = Number(params.pageids);
    const revs = [...(this.pages.get(pageId) ?? [])].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.revid - b.revid));
    if (!this.pages.has(pageId)) return { query: { pages: [{ pageid: pageId, missing: true }] } };
    let selected;
    const limit = Number(params.rvlimit);
    if (params.rvdir === 'older') {
      selected = revs.filter((r) => r.timestamp <= params.rvstart).reverse();
    } else {
      selected = revs.filter((r) => r.timestamp >= params.rvstart && r.timestamp <= params.rvend);
    }
    const offset = params.rvcontinue ? Number(params.rvcontinue) : 0;
    const page = selected.slice(offset, offset + limit);
    const body = { query: { pages: [{ pageid: pageId, ns: 0, title: `Page ${pageId}`, revisions: page.map((r) => this.#meta(pageId, r)) }] } };
    if (params.rvdir !== 'older' && offset + limit < selected.length) body.continue = { rvcontinue: String(offset + limit), continue: '||' };
    return body;
  }
}

/** Builds a manifest (articles.resolved.json shape) for fixture pages. */
export function fixtureManifest(entries) {
  return entries.map((e) => ({
    requested_title: e.title,
    domain: e.domain ?? 'Physics',
    canonical_title: e.canonical ?? e.title,
    page_id: e.pageId ?? null,
    namespace: 0,
    url: e.pageId ? `https://en.wikipedia.org/wiki/${encodeURIComponent((e.canonical ?? e.title).replace(/ /g, '_'))}` : null,
    status: e.status ?? 'resolved',
    is_redirect: e.status === 'redirect',
    is_disambiguation: e.status === 'disambiguation',
    normalized_from: null,
    redirect_chain: [],
    redirect_fragment: null,
    duplicate_of: e.duplicateOf ?? null,
    latest_rev_id: null,
    reason: e.reason ?? null,
  }));
}
