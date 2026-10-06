// Article catalogue queries (non-temporal metadata).
export class ArticleRepository {
  constructor(pool) {
    this.pool = pool;
  }

  /** Usable (ingestible) articles with revision counts, in curated order. */
  async listUsable() {
    return this.pool.query(`
      SELECT a.article_id, a.requested_title, a.canonical_title, a.page_id, a.canonical_url, a.resolution_status,
             a.is_redirect, d.name AS domain,
             (SELECT COUNT(*) FROM revisions r WHERE r.article_id = a.article_id) AS revisions
      FROM articles a JOIN domains d ON d.domain_id = a.domain_id
      WHERE a.resolution_status IN ('resolved', 'redirect')
      ORDER BY a.curated_position`);
  }

  /** All curated entries, including those that were not ingested (and why). */
  async listAllCurated() {
    return this.pool.query(`
      SELECT a.article_id, a.curated_position, a.requested_title, a.canonical_title, a.resolution_status,
             a.resolution_reason, a.redirect_fragment, d.name AS domain, o.requested_title AS duplicate_of
      FROM articles a JOIN domains d ON d.domain_id = a.domain_id
      LEFT JOIN articles o ON o.article_id = a.duplicate_of_article_id
      ORDER BY a.curated_position`);
  }

  async domains() {
    return this.pool.query('SELECT name FROM domains ORDER BY name');
  }

  async findById(articleId) {
    const rows = await this.pool.query(`
      SELECT a.article_id, a.requested_title, a.canonical_title, a.page_id, a.canonical_url, a.resolution_status,
             a.is_redirect, a.redirect_fragment, a.row_start AS catalog_row_start, d.name AS domain,
             s.synced_from, s.synced_through
      FROM articles a JOIN domains d ON d.domain_id = a.domain_id
      LEFT JOIN article_sync_state s ON s.article_id = a.article_id
      WHERE a.article_id = ?`, [articleId]);
    return rows[0] ?? null;
  }

  async datasetStats() {
    const [s] = await this.pool.query(`
      SELECT (SELECT COUNT(DISTINCT article_id) FROM revisions) AS articles,
             (SELECT COUNT(*) FROM revisions) AS revisions,
             (SELECT COUNT(*) FROM revision_texts) AS texts,
             (SELECT COALESCE(SUM(raw_bytes), 0) FROM content_chunks) AS raw_bytes,
             (SELECT COALESCE(SUM(stored_bytes), 0) FROM content_chunks) AS stored_bytes,
             (SELECT COUNT(*) FROM article_history FOR SYSTEM_TIME ALL WHERE row_end < TIMESTAMP'2106-02-07 06:28:15.999999') AS history_rows`);
    return s;
  }

  async checkpoints() {
    return this.pool.query(`
      SELECT c.checkpoint_id, c.run_id, c.synced_through, c.completed_at, c.articles_synced
      FROM sync_checkpoints c ORDER BY c.checkpoint_id`);
  }

  async lastRun() {
    const rows = await this.pool.query(`
      SELECT run_id, started_at, finished_at, status, window_start, window_end
      FROM ingestion_runs ORDER BY run_id DESC LIMIT 1`);
    return rows[0] ?? null;
  }
}
