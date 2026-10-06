import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WikipediaClient, backoffDelay } from '../../src/wikipedia/client.js';
import { setLogLevel } from '../../src/lib/logger.js';

setLogLevel('silent');

const response = (status, body, headers = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

function client(sequence, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); const next = sequence.shift(); if (next instanceof Error) throw next; return next; };
  const c = new WikipediaClient({ apiUrl: 'https://example.test/w/api.php', userAgent: 'Test/1.0 (contact)', minRequestIntervalMs: 0,
    maxRetries: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 5, maxlagSeconds: 5, fetchImpl, ...opts });
  return { c, calls };
}

test('sends User-Agent, format=json, formatversion=2 and maxlag', async () => {
  const { c, calls } = client([response(200, { query: {} })]);
  await c.query({ action: 'query', titles: 'A' });
  assert.equal(calls[0].init.headers['User-Agent'], 'Test/1.0 (contact)');
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get('format'), 'json');
  assert.equal(u.searchParams.get('formatversion'), '2');
  assert.equal(u.searchParams.get('maxlag'), '5');
});

test('retries transient failures (network, 503, 429, maxlag) and then succeeds', async () => {
  const { c, calls } = client([
    new Error('ECONNRESET'),
    response(503, 'busy'),
    response(429, 'slow down', { 'retry-after': '0' }),
    response(200, { query: { ok: 1 } }),
  ], { maxRetries: 5 });
  const body = await c.query({ action: 'query' });
  assert.deepEqual(body, { query: { ok: 1 } });
  assert.equal(calls.length, 4);
  assert.equal(c.stats.retries, 3);
  const { c: c2 } = client([response(200, { errors: [{ code: 'maxlag', text: 'lagged' }] }), response(200, { query: {} })]);
  await c2.query({});
  assert.equal(c2.stats.retries, 1);
  // observed in the real run: MediaWiki's database layer failing transiently
  const { c: c4 } = client([response(200, { errors: [{ code: 'internal_api_error_DBConnectionError', text: 'Caught exception' }] }), response(200, { query: {} })]);
  await c4.query({});
  assert.equal(c4.stats.retries, 1);
});

test('gives up after maxRetries, and never retries permanent errors', async () => {
  const { c, calls } = client([response(500, ''), response(500, ''), response(500, ''), response(500, ''), response(500, '')]);
  await assert.rejects(c.query({}), /HTTP 500/);
  assert.equal(calls.length, 4); // 1 + 3 retries
  const { c: c2, calls: calls2 } = client([response(404, 'nope')]);
  await assert.rejects(c2.query({}), /HTTP 404/);
  assert.equal(calls2.length, 1);
  const { c: c3, calls: calls3 } = client([response(200, { errors: [{ code: 'badvalue', text: 'bad' }] })]);
  await assert.rejects(c3.query({}), /badvalue/);
  assert.equal(calls3.length, 1);
});

test('requests are serialised and spaced by minRequestIntervalMs', async () => {
  const times = [];
  const fetchImpl = async () => { times.push(Date.now()); return response(200, {}); };
  const c = new WikipediaClient({ apiUrl: 'https://x.test', userAgent: 'T', minRequestIntervalMs: 40, fetchImpl });
  await Promise.all([c.query({}), c.query({}), c.query({})]);
  assert.ok(times[1] - times[0] >= 35 && times[2] - times[1] >= 35, `gaps ${times[1] - times[0]}, ${times[2] - times[1]}`);
});

test('backoff delay is bounded and grows exponentially', () => {
  assert.equal(backoffDelay(1, 1000, 30000, () => 0), 500);
  assert.equal(backoffDelay(3, 1000, 30000, () => 1), 4000);
  assert.equal(backoffDelay(20, 1000, 30000, () => 1), 30000);
});
