import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planChunks, compressChunk, decompressChunk, extractText } from '../../src/content/chunks.js';
import { sha1Hex } from '../../src/wikipedia/revisions.js';

const texts = Array.from({ length: 10 }, (_, i) => {
  const text = `Article text ünïcödé ✓ version ${i}\n` + 'Lorem ipsum dolor sit amet. '.repeat(400);
  return { sha1: sha1Hex(text), text };
});

test('chunks respect the text-count and size limits and keep order', () => {
  const chunks = planChunks(texts, { maxTexts: 4, maxRaw: 1e9 });
  assert.deepEqual(chunks.map((c) => c.entries.length), [4, 4, 2]);
  const bySize = planChunks(texts, { maxRaw: 25_000 });
  assert.ok(bySize.every((c) => c.raw.length <= 25_000 || c.entries.length === 1));
  assert.deepEqual(bySize.flatMap((c) => c.entries.map((e) => e.sha1)), texts.map((t) => t.sha1));
});

test('round trip: compress, decompress and extract every text with SHA-1 verification (UTF-8 safe)', () => {
  const [chunk] = planChunks(texts);
  const payload = compressChunk(chunk.raw);
  assert.ok(payload.length < chunk.raw.length / 20, 'near-duplicate texts compress strongly');
  const raw = decompressChunk(payload);
  chunk.entries.forEach((e, i) => assert.equal(extractText(raw, e), texts[i].text));
});

test('corruption is detected', () => {
  const [chunk] = planChunks(texts.slice(0, 2));
  const raw = decompressChunk(compressChunk(chunk.raw));
  assert.throws(() => extractText(raw, { ...chunk.entries[0], sha1: 'f'.repeat(40) }), /SHA-1 mismatch/);
  assert.throws(() => extractText(raw, { ...chunk.entries[1], byte_length: chunk.entries[1].byte_length + 10 }), /too short|mismatch/);
});
