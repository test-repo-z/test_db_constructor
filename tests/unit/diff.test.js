import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffTexts, buildHunks, flatten, toSentenceLines } from '../../src/services/diffService.js';
import { diffLines } from 'diff';

test('identical texts produce no hunks', () => {
  const d = diffTexts('a\nb\n', 'a\nb\n');
  assert.equal(d.identical, true);
  assert.equal(d.hunks.length, 0);
});

test('line diff with word-level highlighting of a changed line', () => {
  const d = diffTexts('x\nthe quick brown fox\ny\n', 'x\nthe quick red fox\ny\n');
  assert.deepEqual(d.stats, { added: 1, removed: 1, oldLines: 3, newLines: 3 });
  const [h] = d.hunks;
  const del = h.lines.find((l) => l.type === 'del');
  const add = h.lines.find((l) => l.type === 'add');
  assert.deepEqual(del.parts.filter((p) => p.changed).map((p) => p.text), ['brown']);
  assert.deepEqual(add.parts.filter((p) => p.changed).map((p) => p.text), ['red']);
  assert.equal(del.parts.map((p) => p.text).join(''), 'the quick brown fox');
});

test('distant changes form separate hunks; context is bounded; line numbers are correct', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const b = a.replace('line 3\n', 'line three\n').replace('line 27\n', 'line twenty-seven\n');
  const hunks = buildHunks(flatten(diffLines(a, b)), 2);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].oldStart, 1);
  assert.ok(hunks[0].lines.length <= 2 + 2 + 2);
  const del27 = hunks[1].lines.find((l) => l.type === 'del');
  assert.equal(del27.oldNo, 27);
});

test('nearby changes merge into one hunk', () => {
  const a = 'a\nb\nc\nd\ne\nf\n';
  const b = 'A\nb\nc\nD\ne\nf\n';
  assert.equal(buildHunks(flatten(diffLines(a, b)), 2).length, 1);
});

test('sentence splitting for the readable-text mode', () => {
  assert.equal(toSentenceLines('One. Two! Three?\n\nFour (five).'), 'One.\nTwo!\nThree?\nFour (five).');
});
