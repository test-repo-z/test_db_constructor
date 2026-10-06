import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ident, boundedInt, UnsafeSqlError } from '../../src/db/sql.js';

test('ident back-quotes plain identifiers', () => {
  assert.equal(ident('article_history'), '`article_history`');
  assert.equal(ident('p0'), '`p0`');
  assert.equal(ident('seq_0_to_15'), '`seq_0_to_15`');
});

test('ident refuses anything that is not a plain identifier', () => {
  for (const bad of ['', 'a b', 'a;DROP TABLE articles', 'x`y', "t' OR '1'='1", 'a.b', '1abc', 'tab\n', 'x'.repeat(65), null, undefined, 42]) {
    assert.throws(() => ident(bad), UnsafeSqlError, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('ident enforces a whitelist when one is given', () => {
  const allowed = ['bench_stress_none', 'bench_stress_year'];
  assert.equal(ident('bench_stress_year', allowed), '`bench_stress_year`');
  assert.throws(() => ident('articles', allowed), /not allowed/);
});

test('boundedInt accepts only integers inside the range', () => {
  assert.equal(boundedInt('15', 0, 999), 15);
  assert.equal(boundedInt(0, 0, 999), 0);
  for (const bad of [-1, 1000, 1.5, 'NaN', '1; DROP TABLE x', '', null]) {
    assert.throws(() => boundedInt(bad, 0, 999, 'scale'), UnsafeSqlError, `should refuse ${JSON.stringify(bad)}`);
  }
});
