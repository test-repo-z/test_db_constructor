import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseProjectConfig, ConfigError, resolvePath } from '../../src/config/index.js';

const base = () => JSON.parse(fs.readFileSync(resolvePath('config/project.json'), 'utf8'));

test('the shipped config/project.json is valid and defines the documented window', () => {
  const c = parseProjectConfig(base());
  assert.equal(c.dataset.windowStart.toISOString(), '2021-09-22T00:00:00.000Z');
  assert.equal(c.dataset.windowEnd.toISOString(), '2026-09-22T23:59:59.000Z');
  assert.deepEqual([...c.dataset.ingestStatuses], ['resolved', 'redirect']);
  assert.equal(c.wikipedia.apiUrl, 'https://en.wikipedia.org/w/api.php');
});

test('the demo set has one curated article per domain', () => {
  const c = parseProjectConfig(base());
  const curated = JSON.parse(fs.readFileSync(resolvePath('data/articles.json'), 'utf8'));
  const byTitle = new Map(curated.map((a) => [a.title, a.domain]));
  assert.ok(c.demo.articles.every((t) => byTitle.has(t)), 'every demo title is in data/articles.json');
  const domains = new Set(c.demo.articles.map((t) => byTitle.get(t)));
  assert.equal(domains.size, new Set(curated.map((a) => a.domain)).size);
  assert.equal(c.demo.articles.length, domains.size);
});

test('invalid windows are rejected', () => {
  const bad = (mut) => { const raw = base(); mut(raw); return () => parseProjectConfig(raw); };
  assert.throws(bad((r) => { r.dataset.window.start = '2021-09-22'; }), ConfigError);
  assert.throws(bad((r) => { r.dataset.window.end = '2020-01-01T00:00:00Z'; }), /before/);
  assert.throws(bad((r) => { r.dataset.window.start = '2021-02-30T00:00:00Z'; r.dataset.window.end = '2021-02-30T00:00:00Z'; }), ConfigError);
  assert.throws(bad((r) => { r.wikipedia.titlesPerQuery = 51; }), /50/);
  assert.throws(bad((r) => { r.wikipedia.minRequestIntervalMs = -1; }), ConfigError);
  assert.throws(bad((r) => { r.dataset.ingestStatuses = ['weird']; }), /unknown ingest status/);
  assert.throws(() => parseProjectConfig(null), ConfigError);
});

test('the window can be extended purely through configuration', () => {
  const raw = base();
  raw.dataset.window.start = '2016-09-22T00:00:00Z';
  assert.equal(parseProjectConfig(raw).dataset.windowStart.getUTCFullYear(), 2016);
});
