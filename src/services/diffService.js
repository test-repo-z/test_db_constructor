// Line diff with in-line word highlighting (the familiar "Wikipedia diff" presentation).
//
//  1. diffLines (Myers O(ND), jsdiff) between the two texts; bounded by `timeout` and
//     `maxEditLength` so that a pathological pair cannot monopolise the event loop;
//  2. group the result into hunks with `context` unchanged lines around each change;
//  3. inside a hunk, pair removed/added lines one-to-one and highlight word-level changes
//     with diffWordsWithSpace (only for lines short enough to keep this cheap).
import { diffLines, diffWordsWithSpace } from 'diff';

const MAX_WORD_DIFF_LINE = 6000;

export class DiffTooExpensiveError extends Error {
  constructor() {
    super('The two versions differ too much to compute a line diff within the time budget.');
    this.status = 422;
    this.expose = true;
  }
}

function splitLines(value) {
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Turns jsdiff's change objects into a flat list of {type, text, oldNo, newNo}. */
export function flatten(changes) {
  const out = [];
  let oldNo = 1;
  let newNo = 1;
  for (const c of changes) {
    for (const text of splitLines(c.value)) {
      if (c.added) out.push({ type: 'add', text, oldNo: null, newNo: newNo++ });
      else if (c.removed) out.push({ type: 'del', text, oldNo: oldNo++, newNo: null });
      else out.push({ type: 'same', text, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

function wordPairs(dels, adds) {
  const n = Math.min(dels.length, adds.length);
  for (let i = 0; i < n; i++) {
    const a = dels[i];
    const b = adds[i];
    if (a.text.length > MAX_WORD_DIFF_LINE || b.text.length > MAX_WORD_DIFF_LINE) continue;
    const parts = diffWordsWithSpace(a.text, b.text);
    a.parts = parts.filter((p) => !p.added).map((p) => ({ text: p.value, changed: Boolean(p.removed) }));
    b.parts = parts.filter((p) => !p.removed).map((p) => ({ text: p.value, changed: Boolean(p.added) }));
  }
}

/** Groups flattened lines into hunks with `context` lines of unchanged text around changes. */
export function buildHunks(lines, context = 3) {
  // 1. a window [i - context, i + context] around every changed line, 2. merge overlapping windows
  const ranges = [];
  lines.forEach((line, i) => {
    if (line.type === 'same') return;
    const from = Math.max(0, i - context);
    const to = Math.min(lines.length, i + context + 1);
    const last = ranges.at(-1);
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  });
  return ranges.map(({ from, to }) => {
    const hunkLines = lines.slice(from, to).map((l) => ({ ...l }));
    // pair each run of deletions with the run of additions that follows it, for word highlighting
    for (let i = 0; i < hunkLines.length;) {
      if (hunkLines[i].type !== 'del') { i++; continue; }
      const dels = [];
      while (i < hunkLines.length && hunkLines[i].type === 'del') dels.push(hunkLines[i++]);
      const adds = [];
      while (i < hunkLines.length && hunkLines[i].type === 'add') adds.push(hunkLines[i++]);
      wordPairs(dels, adds);
    }
    return {
      oldStart: hunkLines.find((l) => l.oldNo != null)?.oldNo ?? null,
      newStart: hunkLines.find((l) => l.newNo != null)?.newNo ?? null,
      lines: hunkLines,
    };
  });
}

/**
 * Diffs two texts. Returns { identical, hunks, stats }.
 * @throws DiffTooExpensiveError if the diff exceeds the time/edit budget.
 */
export function diffTexts(oldText, newText, { context = 3, timeoutMs = 2000, maxEditLength = 20000 } = {}) {
  if (oldText === newText) {
    return { identical: true, hunks: [], stats: { added: 0, removed: 0, oldLines: splitLines(oldText).length, newLines: splitLines(newText).length } };
  }
  const changes = diffLines(oldText, newText, { timeout: timeoutMs, maxEditLength });
  if (!changes) throw new DiffTooExpensiveError();
  const lines = flatten(changes);
  const stats = {
    added: lines.filter((l) => l.type === 'add').length,
    removed: lines.filter((l) => l.type === 'del').length,
    oldLines: lines.filter((l) => l.oldNo != null).length,
    newLines: lines.filter((l) => l.newNo != null).length,
  };
  return { identical: false, hunks: buildHunks(lines, context), stats };
}

/** Plain-text mode: one sentence-ish unit per line, so prose changes diff nicely. */
export function toSentenceLines(text) {
  return text
    .replace(/\r/g, '')
    .split(/\n+/)
    .flatMap((para) => para.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/))
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');
}
