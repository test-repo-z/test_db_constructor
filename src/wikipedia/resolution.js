// Deterministic resolution of curated titles to canonical Wikipedia pages.
//
// Input : the curated list (data/articles.json) — never modified.
// Output: one record per requested title, in the same order, describing what Wikipedia says the title is.
//
// Resolution for a requested title t, using one `action=query` response (titles batched, redirects=1):
//   1. title normalisation  (query.normalized: e.g. underscores, first-letter case)
//   2. redirect following   (query.redirects, followed until a non-redirect page; cycles => error)
//   3. page lookup          (query.pages by title)
//   4. classification       missing | error(invalid / non-article namespace) | disambiguation | redirect | resolved
//   5. canonical URL        taken from the API's `canonicalurl` — never hand-built from the requested title.
//
// A second pass (`markDuplicateTargets`) detects several requested titles that resolve to the same page_id.
// Exactly one of them "owns" the page (deterministic rule below); the others get status `duplicate` and a
// `duplicate_of` pointer. They are kept in the manifest and in the database — never silently dropped.

export const STATUSES = Object.freeze(['resolved', 'redirect', 'missing', 'disambiguation', 'duplicate', 'error']);
export const USABLE_STATUSES = Object.freeze(['resolved', 'redirect']);

export function buildIndexes(queryResponse) {
  const q = queryResponse?.query ?? {};
  const normalized = new Map((q.normalized ?? []).map((n) => [n.from, n.to]));
  const redirects = new Map((q.redirects ?? []).map((r) => [r.from, { to: r.to, fragment: r.tofragment ?? null }]));
  const pages = new Map((q.pages ?? []).map((p) => [p.title, p]));
  return { normalized, redirects, pages };
}

/** Classifies one curated entry against the indexes of an API response. Pure function. */
export function classify(entry, indexes, { resolvedAt } = {}) {
  const base = {
    requested_title: entry.title,
    domain: entry.domain,
    canonical_title: null,
    page_id: null,
    namespace: null,
    url: null,
    status: 'error',
    is_redirect: false,
    is_disambiguation: false,
    normalized_from: null,
    redirect_chain: [],
    redirect_fragment: null,
    duplicate_of: null,
    latest_rev_id: null,
    reason: null,
    resolved_at: resolvedAt ?? null,
  };

  let title = entry.title;
  if (indexes.normalized.has(title)) {
    base.normalized_from = title;
    title = indexes.normalized.get(title);
  }

  const seen = new Set([title]);
  while (indexes.redirects.has(title)) {
    const r = indexes.redirects.get(title);
    base.redirect_chain.push(r.to);
    if (r.fragment) base.redirect_fragment = r.fragment;
    title = r.to;
    if (seen.has(title)) return { ...base, reason: 'redirect_cycle' };
    seen.add(title);
  }
  base.is_redirect = base.redirect_chain.length > 0;

  const page = indexes.pages.get(title);
  if (!page) return { ...base, reason: 'page_not_in_response' };
  base.namespace = page.ns ?? null;
  if (page.invalid) return { ...base, canonical_title: title, reason: `invalid_title: ${page.invalidreason ?? 'unknown'}` };
  if (page.missing) return { ...base, status: 'missing', canonical_title: page.title, reason: 'page_does_not_exist' };
  if (page.ns !== 0) return { ...base, canonical_title: page.title, page_id: page.pageid, reason: `not_an_article_namespace_${page.ns}` };

  base.canonical_title = page.title;
  base.page_id = page.pageid;
  base.url = page.canonicalurl ?? page.fullurl ?? null;
  base.latest_rev_id = page.lastrevid ?? null;
  base.is_disambiguation = Boolean(page.pageprops && 'disambiguation' in page.pageprops);
  if (!base.url) return { ...base, reason: 'api_returned_no_url' };

  if (base.is_disambiguation) return { ...base, status: 'disambiguation', reason: 'page_is_a_disambiguation_page' };
  if (base.is_redirect) return { ...base, status: 'redirect' };
  return { ...base, status: 'resolved' };
}

/**
 * Second pass: a Wikipedia page may only be ingested once.
 * Owner of a page = the usable entry whose requested title IS the canonical title (no redirect);
 * if there is none, the first usable entry in curated-list order. Everything else pointing to the same
 * page becomes `duplicate`, keeping its original classification in `duplicate_resolution`.
 */
export function markDuplicateTargets(records) {
  const byPage = new Map();
  records.forEach((r, i) => {
    if (r.page_id == null || !USABLE_STATUSES.includes(r.status)) return;
    if (!byPage.has(r.page_id)) byPage.set(r.page_id, []);
    byPage.get(r.page_id).push(i);
  });
  const owner = new Map();
  for (const [pageId, idxs] of byPage) {
    const direct = idxs.find((i) => records[i].requested_title === records[i].canonical_title);
    owner.set(pageId, direct ?? idxs[0]);
  }
  return records.map((r, i) => {
    if (!owner.has(r.page_id) || !USABLE_STATUSES.includes(r.status) || owner.get(r.page_id) === i) return r;
    const ownerTitle = records[owner.get(r.page_id)].requested_title;
    return { ...r, status: 'duplicate', duplicate_of: ownerTitle, duplicate_resolution: r.status,
      reason: `resolves to the same page as "${ownerTitle}"` };
  });
}

export function summarize(records) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of records) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    requested: records.length,
    ...counts,
    usable: counts.resolved + counts.redirect,
  };
}

/** Validates the curated source list structure. Returns a list of problems (empty if fine). */
export function validateCuratedList(list, expectedCount) {
  const problems = [];
  if (!Array.isArray(list)) return ['articles.json must contain a JSON array'];
  if (expectedCount != null && list.length !== expectedCount) {
    problems.push(`expected ${expectedCount} curated articles, found ${list.length}`);
  }
  const seen = new Map();
  list.forEach((a, i) => {
    if (!a || typeof a.title !== 'string' || a.title.trim() === '') problems.push(`entry ${i}: missing title`);
    if (!a || typeof a.domain !== 'string' || a.domain.trim() === '') problems.push(`entry ${i}: missing domain`);
    if (a && typeof a.title === 'string') {
      const key = a.title.trim().toLowerCase();
      if (seen.has(key)) problems.push(`duplicate title "${a.title}" (entries ${seen.get(key)} and ${i})`);
      else seen.set(key, i);
    }
  });
  return problems;
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
