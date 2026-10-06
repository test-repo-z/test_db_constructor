// Executes the temporal queries of temporalQueries.js.
import * as Q from './temporalQueries.js';

export class HistoryRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async revisionAt(articleId, tSql) {
    const rows = await this.pool.query(Q.SQL_REVISION_AT, [articleId, tSql, tSql]);
    return rows[0] ?? null;
  }

  async revisionAtKnownAt(articleId, tSql, systemTs) {
    const rows = await this.pool.query(Q.SQL_REVISION_AT_KNOWN_AT, [systemTs, articleId, tSql, tSql]);
    return rows[0] ?? null;
  }

  async mirrorAsOf(articleId, tSql) {
    const rows = await this.pool.query(Q.SQL_MIRROR_AS_OF, [tSql, articleId]);
    return rows[0] ?? null;
  }

  async historyOverlapping(articleId, fromSql, toSql, { limit, offset }) {
    const [rows, [count]] = await Promise.all([
      this.pool.query(Q.SQL_HISTORY_OVERLAPPING, [articleId, toSql, fromSql, limit, offset]),
      this.pool.query(Q.SQL_HISTORY_OVERLAPPING_COUNT, [articleId, toSql, fromSql]),
    ]);
    return { rows, total: count.n };
  }

  async editsBetween(articleId, aSql, bSql) {
    const [r] = await this.pool.query(Q.SQL_EDITS_BETWEEN, [articleId, aSql, bSql]);
    return r.n;
  }

  async editsPerMonth(articleId, fromSql, toSql) {
    return this.pool.query(Q.SQL_EDITS_PER_MONTH, [articleId, fromSql, toSql]);
  }

  async timelineBounds(articleId) {
    const [r] = await this.pool.query(Q.SQL_ARTICLE_TIMELINE_BOUNDS, [articleId, articleId]);
    return r;
  }

  async systemAll(articleId, limit) {
    return this.pool.query(Q.SQL_SYSTEM_ALL_FOR_ARTICLE, [articleId, limit]);
  }

  async systemAsOfTimeline(articleId, systemTs, limit) {
    return this.pool.query(Q.SQL_SYSTEM_AS_OF_TIMELINE, [systemTs, articleId, limit]);
  }

  async systemBetween(articleId, s1, s2, limit) {
    return this.pool.query(Q.SQL_SYSTEM_BETWEEN, [s1, s2, articleId, limit]);
  }

  async mirrorBetween(articleId, a, b) {
    return this.pool.query(Q.SQL_MIRROR_BETWEEN, [a, b, articleId]);
  }

  async mirrorGrowth() {
    return this.pool.query(Q.SQL_MIRROR_GROWTH);
  }

  async articleAudit(articleId) {
    return this.pool.query(Q.SQL_ARTICLES_AUDIT, [articleId]);
  }

  async lastReplay() {
    const rows = await this.pool.query(
      "SELECT replay_id, finished_at, revisions_applied, replayed_through FROM mirror_replays WHERE status = 'succeeded' ORDER BY replay_id DESC LIMIT 1");
    return rows[0] ?? null;
  }
}
