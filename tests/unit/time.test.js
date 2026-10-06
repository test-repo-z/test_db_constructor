import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstant, assertWithinCoverage, datasetCoverage, syncCutoffs, addMonthsUtc, sqlToIso, apiToSql, toSql, INFINITY } from '../../src/temporal/time.js';

test('parseInstant accepts the documented formats and interprets them as UTC', () => {
  assert.equal(parseInstant('2023-05-01').sql, '2023-05-01 00:00:00');
  assert.equal(parseInstant('2023-05-01T14:30').sql, '2023-05-01 14:30:00');
  assert.equal(parseInstant('2023-05-01T14:30:15').sql, '2023-05-01 14:30:15');
  assert.equal(parseInstant('2023-05-01T14:30:15Z').iso, '2023-05-01T14:30:15Z');
  assert.equal(parseInstant('2023-05-01 14:30:15').sql, '2023-05-01 14:30:15');
});

test('parseInstant converts explicit UTC offsets', () => {
  assert.equal(parseInstant('2023-05-01T16:30:00+02:00').sql, '2023-05-01 14:30:00');
  assert.equal(parseInstant('2023-05-01T00:30:00-01:00').sql, '2023-05-01 01:30:00');
});

test('parseInstant rejects malformed, impossible and over-precise input', () => {
  for (const bad of ['', 'garbage', '2023-13-01', '2023-02-30', '2023-02-29', '2023-05-01T24:00:00', '2023-05-01T10:60',
    '2023-05-01T10:00:00.500Z', '20230501', '2023-5-1', "2023-05-01'; DROP TABLE articles; --", '2023-05-01T10:00:00+15:00']) {
    assert.throws(() => parseInstant(bad), { name: 'Error' }, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseInstant(undefined));
  assert.equal(parseInstant('2024-02-29').sql, '2024-02-29 00:00:00'); // leap day is valid
});

test('coverage check: inclusive window, out-of-range dates (e.g. 2018-03-15) are rejected with 422', () => {
  const cov = datasetCoverage();
  assert.equal(cov.startIso, '2021-09-22T00:00:00Z');
  assert.equal(cov.endIso, '2026-09-22T23:59:59Z');
  assert.doesNotThrow(() => assertWithinCoverage(parseInstant(cov.startIso)));
  assert.doesNotThrow(() => assertWithinCoverage(parseInstant(cov.endIso)));
  for (const outside of ['2018-03-15', '2021-09-21T23:59:59Z', '2026-09-23T00:00:00Z']) {
    assert.throws(() => assertWithinCoverage(parseInstant(outside)), (err) => err.status === 422 && err.code === 'OUT_OF_COVERAGE');
  }
});

test('format conversions round-trip without losing precision', () => {
  assert.equal(apiToSql('2023-04-01T12:34:56Z'), '2023-04-01 12:34:56');
  assert.equal(sqlToIso('2026-10-05 17:51:07.395098'), '2026-10-05T17:51:07.395098Z');
  assert.equal(sqlToIso(INFINITY), null);
  assert.equal(toSql(new Date('2021-09-22T00:00:00Z')), '2021-09-22 00:00:00');
  assert.throws(() => apiToSql('2023-04-01 12:34:56'));
});

test('addMonthsUtc clamps to month end', () => {
  assert.equal(addMonthsUtc(new Date('2023-01-31T00:00:00Z'), 1).toISOString(), '2023-02-28T00:00:00.000Z');
  assert.equal(addMonthsUtc(new Date('2024-01-31T00:00:00Z'), 1).toISOString(), '2024-02-29T00:00:00.000Z');
  assert.equal(addMonthsUtc(new Date('2021-09-22T00:00:00Z'), 12).toISOString(), '2022-09-22T00:00:00.000Z');
});

test('syncCutoffs: yearly steps over the 5-year window give exactly 5 checkpoints ending at the window end', () => {
  const c = syncCutoffs(new Date('2021-09-22T00:00:00Z'), new Date('2026-09-22T23:59:59Z'), 12);
  assert.deepEqual(c.map((d) => d.toISOString()), [
    '2022-09-22T00:00:00.000Z', '2023-09-22T00:00:00.000Z', '2024-09-22T00:00:00.000Z', '2025-09-22T00:00:00.000Z', '2026-09-22T23:59:59.000Z']);
  assert.equal(syncCutoffs(new Date('2021-09-22T00:00:00Z'), new Date('2026-09-22T23:59:59Z'), 0).length, 1);
});
