import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTimeline, planTimelineChanges, intervalAt, checkTimeline } from '../../src/temporal/timeline.js';
import { INFINITY } from '../../src/temporal/time.js';

const A = { rev_id: 1, ts: '2022-01-01 00:00:00' };
const B = { rev_id: 2, ts: '2022-02-01 00:00:00' };
const C = { rev_id: 3, ts: '2022-03-01 00:00:00' };

test('A, B, C -> [T1,T2) [T2,T3) [T3,inf)', () => {
  const { visible } = computeTimeline([C, A, B]);
  assert.deepEqual(visible, [
    { rev_id: 1, valid_from: A.ts, valid_to: B.ts },
    { rev_id: 2, valid_from: B.ts, valid_to: C.ts },
    { rev_id: 3, valid_from: C.ts, valid_to: INFINITY },
  ]);
  assert.deepEqual(checkTimeline(visible), []);
});

test('boundary semantics are half-open', () => {
  const { visible } = computeTimeline([A, B, C]);
  assert.equal(intervalAt(visible, '2022-02-01 00:00:00').rev_id, 2, 'exactly at T2 -> B');
  assert.equal(intervalAt(visible, '2022-01-31 23:59:59').rev_id, 1, 'one second before T2 -> A');
  assert.equal(intervalAt(visible, '2022-02-01 00:00:01').rev_id, 2, 'one second after T2 -> B');
  assert.equal(intervalAt(visible, '2022-01-01 00:00:00').rev_id, 1, 'first revision at its own timestamp');
  assert.equal(intervalAt(visible, '2099-01-01 00:00:00').rev_id, 3, 'last revision is open-ended');
  assert.equal(intervalAt(visible, '2021-12-31 23:59:59'), null, 'before the first revision -> nothing');
});

test('same-second revisions: highest rev_id wins, lower ones are shadowed (no empty interval)', () => {
  const B2 = { rev_id: 5, ts: B.ts };
  const { visible, shadowed } = computeTimeline([A, B, B2, C]);
  assert.deepEqual(shadowed, [2]);
  assert.deepEqual(visible.map((v) => v.rev_id), [1, 5, 3]);
  assert.equal(intervalAt(visible, B.ts).rev_id, 5);
  assert.ok(visible.every((v) => v.valid_from < v.valid_to));
});

test('planTimelineChanges: appending closes the open interval (trim) and inserts', () => {
  const current = [{ rev_id: 1, valid_from: A.ts, valid_to: INFINITY }];
  const plan = planTimelineChanges(current, [A, B]);
  assert.deepEqual(plan.deletes, []);
  assert.deepEqual(plan.trims, [{ rev_id: 1, portion_from: B.ts, portion_to: INFINITY, new_valid_to: B.ts }]);
  assert.deepEqual(plan.inserts, [{ rev_id: 2, valid_from: B.ts, valid_to: INFINITY }]);
});

test('planTimelineChanges: inserting in the middle splits an interval', () => {
  const current = [{ rev_id: 1, valid_from: A.ts, valid_to: C.ts }, { rev_id: 3, valid_from: C.ts, valid_to: INFINITY }];
  const plan = planTimelineChanges(current, [A, B, C]);
  assert.deepEqual(plan.trims, [{ rev_id: 1, portion_from: B.ts, portion_to: C.ts, new_valid_to: B.ts }]);
  assert.deepEqual(plan.inserts, [{ rev_id: 2, valid_from: B.ts, valid_to: C.ts }]);
});

test('planTimelineChanges: a later same-second revision removes the shadowed row', () => {
  const current = [{ rev_id: 2, valid_from: B.ts, valid_to: INFINITY }];
  const plan = planTimelineChanges(current, [B, { rev_id: 9, ts: B.ts }]);
  assert.deepEqual(plan.deletes.map((d) => d.rev_id), [2]);
  assert.deepEqual(plan.inserts, [{ rev_id: 9, valid_from: B.ts, valid_to: INFINITY }]);
});

test('planTimelineChanges: no change when nothing new (idempotent)', () => {
  const { visible } = computeTimeline([A, B, C]);
  const plan = planTimelineChanges(visible, [A, B, C]);
  assert.equal(plan.deletes.length + plan.trims.length + plan.inserts.length, 0);
});

test('planTimelineChanges refuses timelines that would grow (lost revision)', () => {
  const current = [{ rev_id: 1, valid_from: A.ts, valid_to: B.ts }, { rev_id: 2, valid_from: B.ts, valid_to: INFINITY }];
  assert.throws(() => planTimelineChanges(current, [A]), /grow|valid_from/);
});

test('checkTimeline reports overlaps, gaps and empty intervals', () => {
  const problems = checkTimeline([
    { rev_id: 1, valid_from: '2022-01-01 00:00:00', valid_to: '2022-02-01 00:00:00' },
    { rev_id: 2, valid_from: '2022-01-15 00:00:00', valid_to: '2022-03-01 00:00:00' },
    { rev_id: 3, valid_from: '2022-04-01 00:00:00', valid_to: '2022-04-01 00:00:00' },
  ]);
  assert.ok(problems.some((p) => p.includes('overlaps')));
  assert.ok(problems.some((p) => p.includes('gap')));
  assert.ok(problems.some((p) => p.includes('empty')));
});
