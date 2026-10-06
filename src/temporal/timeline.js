// Application-time interval construction — pure functions, no database access.
//
// Given the revisions of ONE article, the article's state on Wikipedia is a step function:
//
//   revision A at T1, B at T2, C at T3   ==>   A: [T1, T2)   B: [T2, T3)   C: [T3, +inf)
//
// Rules (also documented in docs/temporal-model.md):
//   * order revisions by (timestamp, rev_id) — MediaWiki's own ordering;
//   * intervals are half-open [valid_from, valid_to): at exactly T2, A is no longer valid and B is;
//   * several revisions with the SAME timestamp (1 s resolution): only the one with the highest
//     rev_id was ever observable; the others have an empty interval and get no timeline row;
//   * the last visible revision is open-ended (valid_to = logical infinity);
//   * consecutive intervals touch exactly, so there are no gaps and no overlaps by construction.
import { INFINITY } from './time.js';

export function compareRevisions(a, b) {
  if (a.ts < b.ts) return -1;
  if (a.ts > b.ts) return 1;
  return a.rev_id - b.rev_id;
}

/**
 * @param {{rev_id:number, ts:string}[]} revisions  ts in SQL format 'YYYY-MM-DD HH:MM:SS'
 * @returns {{visible:{rev_id,valid_from,valid_to}[], shadowed:number[]}}
 */
export function computeTimeline(revisions, infinity = INFINITY) {
  const sorted = [...revisions].sort(compareRevisions);
  const visible = [];
  const shadowed = [];
  for (const r of sorted) {
    const last = visible[visible.length - 1];
    if (last && last.ts === r.ts) {
      shadowed.push(last.rev_id); // same second, lower rev_id: superseded instantly
      visible[visible.length - 1] = r;
    } else {
      visible.push(r);
    }
  }
  return {
    visible: visible.map((r, i) => ({
      rev_id: r.rev_id,
      valid_from: r.ts,
      valid_to: i + 1 < visible.length ? visible[i + 1].ts : infinity,
    })),
    shadowed,
  };
}

/**
 * Plans the minimal DML that turns the article's CURRENT timeline rows into the timeline implied by
 * `allRevisions` (existing + newly ingested). Adding revisions can only
 *   - shorten an existing interval (a newer revision now starts inside it)       -> trim
 *   - make an existing interval empty (same-second revision with higher rev_id)  -> delete
 *   - add new intervals                                                          -> insert
 * Anything else (an interval growing or moving) means data was lost or corrupted, and we refuse.
 */
export function planTimelineChanges(currentRows, allRevisions, infinity = INFINITY) {
  const { visible, shadowed } = computeTimeline(allRevisions, infinity);
  const target = new Map(visible.map((v) => [v.rev_id, v]));
  const current = new Map(currentRows.map((r) => [r.rev_id, r]));
  const deletes = [];
  const trims = [];
  const inserts = [];

  for (const cur of currentRows) {
    const t = target.get(cur.rev_id);
    if (!t) {
      deletes.push({ rev_id: cur.rev_id, valid_from: cur.valid_from, valid_to: cur.valid_to });
      continue;
    }
    if (t.valid_from !== cur.valid_from) {
      throw new Error(`timeline invariant violated: rev ${cur.rev_id} valid_from would move ${cur.valid_from} -> ${t.valid_from}`);
    }
    if (t.valid_to > cur.valid_to) {
      throw new Error(`timeline invariant violated: rev ${cur.rev_id} interval would grow to ${t.valid_to}; a revision disappeared?`);
    }
    if (t.valid_to < cur.valid_to) {
      // "From t.valid_to until the old end, this revision is no longer the visible one."
      trims.push({ rev_id: cur.rev_id, portion_from: t.valid_to, portion_to: cur.valid_to, new_valid_to: t.valid_to });
    }
  }
  for (const v of visible) if (!current.has(v.rev_id)) inserts.push(v);
  return { deletes, trims, inserts, visible, shadowed };
}

/** Finds the interval containing instant t (SQL string) in a sorted visible timeline. Mirrors the SQL predicate. */
export function intervalAt(visible, t) {
  for (const v of visible) if (v.valid_from <= t && t < v.valid_to) return v;
  return null;
}

/** Checks invariants of a timeline (used by validation and tests). Returns a list of problems. */
export function checkTimeline(rows) {
  const problems = [];
  const sorted = [...rows].sort((a, b) => (a.valid_from < b.valid_from ? -1 : a.valid_from > b.valid_from ? 1 : 0));
  sorted.forEach((r, i) => {
    if (!(r.valid_from < r.valid_to)) problems.push(`rev ${r.rev_id}: empty or reversed interval [${r.valid_from}, ${r.valid_to})`);
    const next = sorted[i + 1];
    if (next) {
      if (r.valid_to > next.valid_from) problems.push(`rev ${r.rev_id} overlaps rev ${next.rev_id}`);
      if (r.valid_to < next.valid_from) problems.push(`gap between rev ${r.rev_id} and rev ${next.rev_id}`);
    }
  });
  return problems;
}
