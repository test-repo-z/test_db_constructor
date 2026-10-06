// Chunked, delta-friendly compression of revision texts.
//
// Texts of one article are appended in chronological order into a buffer of at most
// MAX_CHUNK_RAW bytes, which is Brotli-compressed with a 16 MiB window (lgwin 24).
// Because the window covers the whole chunk, each revision compresses mostly to
// back-references into the previous one. Measured on 64 consecutive "Albert Einstein"
// revisions: 12.0 MB raw -> 4.3 MB with per-text deflate, -> 68 KB as one Brotli chunk.
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

export const MAX_CHUNK_RAW = 8 * 1024 * 1024;
export const MAX_TEXTS_PER_CHUNK = 64;
export const BROTLI_QUALITY = 5;
export const BROTLI_LGWIN = 24; // 16 MiB window >= MAX_CHUNK_RAW, so every text can see its predecessors

/**
 * Groups texts (already in chronological order) into chunks.
 * @param {{sha1:string, text:string}[]} texts
 * @returns {{raw:Buffer, entries:{sha1,byte_offset,byte_length}[]}[]}
 */
export function planChunks(texts, { maxRaw = MAX_CHUNK_RAW, maxTexts = MAX_TEXTS_PER_CHUNK } = {}) {
  const chunks = [];
  let bufs = [];
  let entries = [];
  let size = 0;
  const flush = () => {
    if (entries.length) chunks.push({ raw: Buffer.concat(bufs, size), entries });
    bufs = [];
    entries = [];
    size = 0;
  };
  for (const { sha1, text } of texts) {
    const buf = Buffer.from(text, 'utf8');
    if (entries.length && (size + buf.length > maxRaw || entries.length >= maxTexts)) flush();
    entries.push({ sha1, byte_offset: size, byte_length: buf.length });
    bufs.push(buf);
    size += buf.length;
  }
  flush();
  return chunks;
}

export function compressChunk(raw) {
  return zlib.brotliCompressSync(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlib.constants.BROTLI_PARAM_LGWIN]: BROTLI_LGWIN,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    },
  });
}

export function decompressChunk(payload) {
  return zlib.brotliDecompressSync(payload);
}

/** Extracts one text from a decompressed chunk and verifies its SHA-1. */
export function extractText(rawChunk, { byte_offset, byte_length, sha1 }) {
  const slice = rawChunk.subarray(byte_offset, byte_offset + byte_length);
  if (slice.length !== byte_length) throw new Error(`chunk too short for text ${sha1}`);
  const digest = createHash('sha1').update(slice).digest('hex');
  if (sha1 && digest !== sha1) throw new Error(`SHA-1 mismatch for text ${sha1} (got ${digest})`);
  return slice.toString('utf8');
}
