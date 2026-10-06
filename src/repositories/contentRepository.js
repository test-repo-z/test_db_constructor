// Loads revision texts from the chunked store, with a small LRU cache of decompressed chunks
// (bounded by bytes) so that browsing neighbouring revisions does not re-decompress.
import { decompressChunk, extractText } from '../content/chunks.js';

export class ContentRepository {
  constructor(pool, { maxCacheBytes = 96 * 1024 * 1024 } = {}) {
    this.pool = pool;
    this.maxCacheBytes = maxCacheBytes;
    this.cache = new Map(); // chunk_id -> Buffer, insertion order = recency
    this.cacheBytes = 0;
  }

  async #chunk(chunkId) {
    const hit = this.cache.get(chunkId);
    if (hit) {
      this.cache.delete(chunkId);
      this.cache.set(chunkId, hit);
      return hit;
    }
    const rows = await this.pool.query('SELECT payload FROM content_chunks WHERE chunk_id = ?', [chunkId]);
    if (!rows.length) throw new Error(`content chunk ${chunkId} not found`);
    const raw = decompressChunk(rows[0].payload);
    this.cache.set(chunkId, raw);
    this.cacheBytes += raw.length;
    for (const [id, buf] of this.cache) {
      if (this.cacheBytes <= this.maxCacheBytes || this.cache.size === 1) break;
      this.cache.delete(id);
      this.cacheBytes -= buf.length;
    }
    return raw;
  }

  /** Returns the wikitext for a SHA-1 digest, or null if not stored. Integrity is verified on every read. */
  async textBySha1(sha1) {
    if (!sha1) return null;
    const rows = await this.pool.query(
      'SELECT sha1, chunk_id, byte_offset, byte_length FROM revision_texts WHERE sha1 = ?', [sha1]);
    if (!rows.length) return null;
    return extractText(await this.#chunk(rows[0].chunk_id), rows[0]);
  }
}
