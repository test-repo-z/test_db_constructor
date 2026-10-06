import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndexes, classify, markDuplicateTargets, summarize, validateCuratedList } from '../../src/wikipedia/resolution.js';

const response = {
  query: {
    normalized: [{ from: 'quantum mechanics', to: 'Quantum mechanics' }],
    redirects: [
      { from: 'Optimization (mathematics)', to: 'Mathematical optimization' },
      { from: 'Loop A', to: 'Loop B' }, { from: 'Loop B', to: 'Loop A' },
      { from: 'Section redirect', to: 'Big topic', tofragment: 'Subtopic' },
    ],
    pages: [
      { pageid: 25202, ns: 0, title: 'Quantum mechanics', canonicalurl: 'https://en.wikipedia.org/wiki/Quantum_mechanics', lastrevid: 1 },
      { pageid: 52033, ns: 0, title: 'Mathematical optimization', canonicalurl: 'https://en.wikipedia.org/wiki/Mathematical_optimization' },
      { ns: 0, title: 'No such article xyz', missing: true },
      { pageid: 19331, ns: 0, title: 'Mercury', canonicalurl: 'https://en.wikipedia.org/wiki/Mercury', pageprops: { disambiguation: '' } },
      { title: 'Bad|title', invalid: true, invalidreason: 'illegal char' },
      { pageid: 7, ns: 4, title: 'Wikipedia:About', canonicalurl: 'https://en.wikipedia.org/wiki/Wikipedia:About' },
      { pageid: 8, ns: 0, title: 'Big topic', canonicalurl: 'https://en.wikipedia.org/wiki/Big_topic' },
    ],
  },
};
const idx = buildIndexes(response);
const c = (title) => classify({ title, domain: 'Physics' }, idx);

test('direct and normalised titles resolve; requested title and domain are preserved', () => {
  const r = c('quantum mechanics');
  assert.equal(r.status, 'resolved');
  assert.equal(r.canonical_title, 'Quantum mechanics');
  assert.equal(r.requested_title, 'quantum mechanics');
  assert.equal(r.normalized_from, 'quantum mechanics');
  assert.equal(r.domain, 'Physics');
  assert.equal(r.page_id, 25202);
  assert.equal(r.url, 'https://en.wikipedia.org/wiki/Quantum_mechanics');
});

test('redirects are followed and flagged; URL comes from the API', () => {
  const r = c('Optimization (mathematics)');
  assert.equal(r.status, 'redirect');
  assert.equal(r.is_redirect, true);
  assert.equal(r.canonical_title, 'Mathematical optimization');
  assert.equal(r.url, 'https://en.wikipedia.org/wiki/Mathematical_optimization');
  assert.equal(c('Section redirect').redirect_fragment, 'Subtopic');
});

test('missing, disambiguation, invalid, non-article namespace and redirect cycles', () => {
  assert.equal(c('No such article xyz').status, 'missing');
  const d = c('Mercury');
  assert.equal(d.status, 'disambiguation');
  assert.equal(d.is_disambiguation, true);
  assert.equal(c('Bad|title').status, 'error');
  assert.match(c('Wikipedia:About').reason, /namespace/);
  assert.equal(c('Loop A').reason, 'redirect_cycle');
  assert.equal(c('Not in response').reason, 'page_not_in_response');
});

test('duplicate targets: the direct title owns the page even if a redirect comes first', () => {
  const recs = [
    { requested_title: 'Materials engineering', canonical_title: 'Materials science', page_id: 1, status: 'redirect' },
    { requested_title: 'Materials science', canonical_title: 'Materials science', page_id: 1, status: 'resolved' },
    { requested_title: 'Materials chemistry', canonical_title: 'Materials science', page_id: 1, status: 'redirect' },
    { requested_title: 'X', canonical_title: 'Y', page_id: 2, status: 'redirect' },
    { requested_title: 'Z', canonical_title: 'Y', page_id: 2, status: 'redirect' },
  ];
  const out = markDuplicateTargets(recs);
  assert.deepEqual(out.map((r) => r.status), ['duplicate', 'resolved', 'duplicate', 'redirect', 'duplicate']);
  assert.equal(out[0].duplicate_of, 'Materials science');
  assert.equal(out[0].duplicate_resolution, 'redirect');
  assert.equal(out[4].duplicate_of, 'X', 'without a direct match, list order decides');
  assert.deepEqual(summarize(out), { requested: 5, resolved: 1, redirect: 1, missing: 0, disambiguation: 0, duplicate: 3, error: 0, usable: 2 });
});

test('curated list validation catches count, structure and case-insensitive duplicates', () => {
  assert.deepEqual(validateCuratedList([{ title: 'A', domain: 'X' }, { title: 'B', domain: 'Y' }], 2), []);
  const p = validateCuratedList([{ title: 'A', domain: 'X' }, { title: 'a', domain: 'X' }, { domain: 'Y' }], 2);
  assert.ok(p.some((x) => x.includes('expected 2')));
  assert.ok(p.some((x) => x.includes('duplicate title')));
  assert.ok(p.some((x) => x.includes('missing title')));
  assert.deepEqual(validateCuratedList({}, 1), ['articles.json must contain a JSON array']);
});
