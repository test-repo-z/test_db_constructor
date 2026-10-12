import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeSql, listMigrations } from '../../src/db/migrator.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

test('comments, indentation and blank lines do not change a migration checksum', () => {
  const a = "-- version 1 of the comment\nCREATE TABLE t (\n  a INT -- explains a\n);\n";
  const b = "-- a corrected, longer comment\n-- on two lines\nCREATE TABLE t (\n      a INT    -- explains column a better\n);";
  assert.equal(sha(normalizeSql(a)), sha(normalizeSql(b)));
});

test('any change to the SQL itself still changes the checksum', () => {
  const base = sha(normalizeSql('CREATE TABLE t (a INT);'));
  assert.notEqual(sha(normalizeSql('CREATE TABLE t (a BIGINT);')), base);
  assert.notEqual(sha(normalizeSql("CREATE TABLE t (a INT DEFAULT '--x');")), sha(normalizeSql("CREATE TABLE t (a INT DEFAULT '--y');")),
    'text inside string literals is SQL, not a comment');
});

test('the shipped migrations normalise to non-empty SQL with no comments left', () => {
  const ms = listMigrations();
  assert.deepEqual(ms.map((m) => m.version), ['001', '002', '003']);
  for (const m of ms) {
    const n = normalizeSql(m.sql);
    assert.ok(n.startsWith('CREATE TABLE'), m.file);
    assert.doesNotMatch(n, /(^|\s)-- /, m.file);
  }
});
