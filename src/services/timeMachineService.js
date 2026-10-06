// Business logic of the time machine: validation of instants against dataset coverage,
// historical reconstruction, comparison, and the temporal demonstrations.
import { config } from '../config/index.js';
import { parseInstant, assertWithinCoverage, datasetCoverage, toSql, sqlToDate, sqlToIso, INFINITY } from '../temporal/time.js';
import { renderWikitext, plainText } from './renderService.js';
import { diffTexts, toSentenceLines } from './diffService.js';
import { notFound, badRequest, unprocessable } from '../lib/errors.js';
import * as Q from '../repositories/temporalQueries.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('time-machine');
const SYSTEM_MAX = '2106-02-07 06:28:15.999999';

export function parseArticleId(raw) {
  if (!/^\d{1,9}$/.test(String(raw ?? ''))) throw badRequest('article id must be a positive integer');
  return Number(raw);
}

function decorateRevision(rev) {
  if (!rev) return null;
  return {
    ...rev,
    valid_from_iso: sqlToIso(rev.valid_from),
    valid_to_iso: rev.valid_to === INFINITY ? null : sqlToIso(rev.valid_to),
    open_ended: rev.valid_to === INFINITY,
    rev_timestamp_iso: sqlToIso(rev.rev_timestamp),
    permalink: config.wikipedia.permalinkBaseUrl + rev.rev_id,
    editor_hidden: Boolean(rev.editor_hidden),
    comment_hidden: Boolean(rev.comment_hidden),
    is_minor: Boolean(rev.is_minor),
    is_baseline: Boolean(rev.is_baseline),
  };
}

export class TimeMachineService {
  constructor({ articleRepository, historyRepository, contentRepository }) {
    this.articles = articleRepository;
    this.history = historyRepository;
    this.content = contentRepository;
  }

  coverage() {
    return datasetCoverage();
  }

  async listArticles() {
    const [articles, domains] = await Promise.all([this.articles.listUsable(), this.articles.domains()]);
    return { articles, domains: domains.map((d) => d.name) };
  }

  async getArticle(id) {
    const article = await this.articles.findById(parseArticleId(id));
    if (!article || !['resolved', 'redirect'].includes(article.resolution_status)) throw notFound('article');
    return article;
  }

  async checkpoints() {
    return (await this.articles.checkpoints()).map((c) => ({ ...c, synced_through_iso: sqlToIso(c.synced_through) }));
  }

  async overview(id) {
    const article = await this.getArticle(id);
    const cov = this.coverage();
    const [bounds, perMonth, checkpoints] = await Promise.all([
      this.history.timelineBounds(article.article_id),
      this.history.editsPerMonth(article.article_id, cov.startSql, cov.endSql),
      this.checkpoints(),
    ]);
    return { article, coverage: cov, bounds, perMonth, checkpoints };
  }

  /** Resolves a checkpoint id to its system time (completed_at), or null. */
  async #checkpoint(raw) {
    if (raw === undefined || raw === '') return null;
    const id = parseArticleId(raw);
    const cp = (await this.checkpoints()).find((c) => c.checkpoint_id === id);
    if (!cp) throw badRequest(`unknown checkpoint ${raw}`);
    return cp;
  }

  async #textOf(rev) {
    if (!rev || rev.content_status !== 'available') return null;
    return this.content.textBySha1(rev.sha1);
  }

  /**
   * "Show me article A as it was on Wikipedia at instant T" (+ optional bitemporal view).
   */
  async asOf(id, tInput, { checkpoint: checkpointRaw, render = true } = {}) {
    const article = await this.getArticle(id);
    const t = assertWithinCoverage(parseInstant(tInput, 't'));
    const started = process.hrtime.bigint();
    const revision = decorateRevision(await this.history.revisionAt(article.article_id, t.sql));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    log.debug('application-time lookup', { article: article.article_id, t: t.sql, rev: revision?.rev_id, ms: elapsedMs.toFixed(2) });

    const result = {
      article, t, coverage: this.coverage(), revision, sql: Q.SQL_REVISION_AT.trim(), sqlParams: [article.article_id, t.sql, t.sql],
      lookupMs: elapsedMs, notYetCreated: null, wikitext: null, rendered: null, previous: null, next: null, mirror: null, knownAt: null,
    };
    if (!revision) {
      const bounds = await this.history.timelineBounds(article.article_id);
      result.notYetCreated = bounds.first_from ? { first_from_iso: sqlToIso(bounds.first_from) } : null;
      return result;
    }

    const text = await this.#textOf(revision);
    result.wikitext = text;
    result.rendered = text != null && render ? renderWikitext(text) : null;

    // Neighbours on the application-time axis (previous / next revision), if inside coverage.
    const cov = result.coverage;
    const before = toSql(new Date(sqlToDate(revision.valid_from).getTime() - 1000));
    result.previous = before >= cov.startSql ? decorateRevision(await this.history.revisionAt(article.article_id, before)) : null;
    result.next = !revision.open_ended && revision.valid_to <= cov.endSql
      ? decorateRevision(await this.history.revisionAt(article.article_id, revision.valid_to)) : null;

    // Cross-check against the system-time replay (page_mirror FOR SYSTEM_TIME AS OF T).
    const replay = await this.history.lastReplay();
    if (replay) {
      const m = await this.history.mirrorAsOf(article.article_id, t.sql);
      result.mirror = { rev_id: m?.rev_id ?? null, agrees: (m?.rev_id ?? null) === revision.rev_id,
        row_start: m?.row_start, row_end: m?.row_end, sql: Q.SQL_MIRROR_AS_OF.trim() };
    }

    // Bitemporal: what did the database believe at a past system time (sync checkpoint)?
    const cp = await this.#checkpoint(checkpointRaw);
    if (cp) {
      const believed = decorateRevision(await this.history.revisionAtKnownAt(article.article_id, t.sql, cp.completed_at));
      result.knownAt = { checkpoint: cp, revision: believed, sql: Q.SQL_REVISION_AT_KNOWN_AT.trim(),
        agrees: (believed?.rev_id ?? null) === revision.rev_id };
    }
    return result;
  }

  /** Compares the reconstructed versions at two instants. */
  async diff(id, aInput, bInput, { mode = 'wikitext' } = {}) {
    if (!['wikitext', 'text'].includes(mode)) throw badRequest('mode must be "wikitext" or "text"');
    const article = await this.getArticle(id);
    let a = assertWithinCoverage(parseInstant(aInput, 'a'), undefined, 'a');
    let b = assertWithinCoverage(parseInstant(bInput, 'b'), undefined, 'b');
    let swapped = false;
    if (b.date < a.date) { [a, b] = [b, a]; swapped = true; }

    const [ra, rb] = (await Promise.all([
      this.history.revisionAt(article.article_id, a.sql),
      this.history.revisionAt(article.article_id, b.sql),
    ])).map(decorateRevision);
    for (const [rev, inst, label] of [[ra, a, 'earlier'], [rb, b, 'later']]) {
      if (!rev) throw unprocessable(`The article had no revision at the ${label} instant ${inst.iso} (it did not exist yet).`, 'NO_REVISION');
    }
    const base = { article, a, b, swapped, earlier: ra, later: rb, mode, coverage: this.coverage() };
    base.editsBetween = await this.history.editsBetween(article.article_id, a.sql, b.sql);
    if (ra.rev_id === rb.rev_id) return { ...base, sameRevision: true, diff: { identical: true, hunks: [], stats: { added: 0, removed: 0 } } };

    const [ta, tb] = await Promise.all([this.#textOf(ra), this.#textOf(rb)]);
    if (ta == null || tb == null) {
      throw unprocessable('The text of one of the two revisions was hidden by Wikipedia (revision deletion) and cannot be compared.', 'CONTENT_HIDDEN');
    }
    const limit = config.diff.maxInputBytes;
    if (Buffer.byteLength(ta) > limit || Buffer.byteLength(tb) > limit) throw unprocessable('Revisions too large to diff.', 'TOO_LARGE');
    const left = mode === 'text' ? toSentenceLines(plainText(ta)) : ta;
    const right = mode === 'text' ? toSentenceLines(plainText(tb)) : tb;
    return { ...base, sameRevision: false, diff: diffTexts(left, right),
      bytes: { earlier: Buffer.byteLength(ta), later: Buffer.byteLength(tb) } };
  }

  /** Revisions whose application-time validity overlaps [from, to], newest first, paginated. */
  async historyPage(id, { from, to, page = '1', pageSize = 50 } = {}) {
    const article = await this.getArticle(id);
    const cov = this.coverage();
    const f = from ? assertWithinCoverage(parseInstant(from, 'from'), cov, 'from') : { sql: cov.startSql, iso: cov.startIso };
    const t = to ? assertWithinCoverage(parseInstant(to, 'to'), cov, 'to') : { sql: cov.endSql, iso: cov.endIso };
    if (t.sql < f.sql) throw badRequest('"from" must not be after "to"');
    const p = Number(page);
    if (!Number.isInteger(p) || p < 1 || p > 10_000) throw badRequest('page must be a positive integer');
    const { rows, total } = await this.history.historyOverlapping(article.article_id, f.sql, t.sql, { limit: pageSize, offset: (p - 1) * pageSize });
    return { article, from: f, to: t, page: p, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)),
      revisions: rows.map(decorateRevision), coverage: cov };
  }

  /**
   * Live demonstrations of FOR SYSTEM_TIME AS OF / BETWEEN / ALL for one article.
   * Every entry carries the exact SQL and parameters that produced its rows.
   */
  async temporalLab(id, { t: tInput } = {}) {
    const article = await this.getArticle(id);
    const cov = this.coverage();
    const t = tInput ? assertWithinCoverage(parseInstant(tInput, 't')) : parseInstant(new Date((cov.start.getTime() + cov.end.getTime()) / 2).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    const checkpoints = await this.checkpoints();
    const first = checkpoints[0];
    const last = checkpoints.at(-1);
    const LIMIT = 12;
    const demos = [];

    demos.push({
      key: 'app', title: 'Application time: the revision valid on Wikipedia at T',
      explain: 'Plain predicates on the application-time period. MariaDB has no SELECT … FOR <application period> AS OF syntax; the half-open test is written explicitly.',
      sql: Q.SQL_REVISION_AT.trim(), params: [article.article_id, t.sql, t.sql],
      rows: [await this.history.revisionAt(article.article_id, t.sql)].filter(Boolean)
        .map((r) => ({ rev_id: r.rev_id, valid_from: r.valid_from, valid_to: r.valid_to, editor: r.editor })),
    });
    demos.push({
      key: 'all', title: 'FOR SYSTEM_TIME ALL: every row version MariaDB ever stored',
      explain: 'Current rows have row_end = 2106-02-07 06:28:15.999999 (MariaDB’s maximum TIMESTAMP). Rows with an earlier row_end are superseded beliefs: typically the same revision with an open-ended valid_to, closed by a later sync.',
      sql: Q.SQL_SYSTEM_ALL_FOR_ARTICLE.trim(), params: [article.article_id, LIMIT],
      rows: await this.history.systemAll(article.article_id, LIMIT),
    });
    if (first) {
      demos.push({
        key: 'asof', title: `FOR SYSTEM_TIME AS OF checkpoint #${first.checkpoint_id} (${first.completed_at} UTC)`,
        explain: `The timeline as the database believed it right after the first sync step, which knew Wikipedia only up to ${first.synced_through}. The newest revision then known is open-ended: “valid until further notice”.`,
        sql: Q.SQL_SYSTEM_AS_OF_TIMELINE.trim(), params: [first.completed_at, article.article_id, LIMIT],
        rows: await this.history.systemAsOfTimeline(article.article_id, first.completed_at, LIMIT),
      });
      const knownThen = await this.history.revisionAtKnownAt(article.article_id, t.sql, first.completed_at);
      const knownNow = await this.history.revisionAt(article.article_id, t.sql);
      demos.push({
        key: 'bitemporal', title: 'Bitemporal question: application time T, as known at system time S',
        explain: `“Which revision was live on Wikipedia at ${t.iso}?” answered with the knowledge of checkpoint #${first.checkpoint_id} vs. with today’s knowledge. ` +
          (knownThen?.rev_id === knownNow?.rev_id ? 'Here both agree.' : 'They differ: at that system time the database had not yet learned about the later edits.'),
        sql: Q.SQL_REVISION_AT_KNOWN_AT.trim(), params: [first.completed_at, article.article_id, t.sql, t.sql],
        rows: [
          { knowledge: `as of checkpoint #${first.checkpoint_id}`, rev_id: knownThen?.rev_id ?? null, valid_from: knownThen?.valid_from ?? null, valid_to: knownThen?.valid_to ?? null },
          { knowledge: 'current', rev_id: knownNow?.rev_id ?? null, valid_from: knownNow?.valid_from ?? null, valid_to: knownNow?.valid_to ?? null },
        ],
      });
    }
    if (first && last && first !== last) {
      demos.push({
        key: 'between', title: `FOR SYSTEM_TIME BETWEEN checkpoint #${first.checkpoint_id} AND #${last.checkpoint_id}`,
        explain: 'All row versions that were current at any moment of that system-time span (BETWEEN includes rows that start exactly at the upper bound; FROM … TO would exclude them).',
        sql: Q.SQL_SYSTEM_BETWEEN.trim(), params: [first.completed_at, last.completed_at, article.article_id, LIMIT],
        rows: await this.history.systemBetween(article.article_id, first.completed_at, last.completed_at, LIMIT),
      });
    }
    const replay = await this.history.lastReplay();
    if (replay) {
      const yearStart = `${t.sql.slice(0, 4)}-01-01 00:00:00`;
      const yearEnd = `${t.sql.slice(0, 4)}-12-31 23:59:59`;
      demos.push({
        key: 'mirror-asof', title: 'page_mirror FOR SYSTEM_TIME AS OF T (system time = Wikipedia time, by replay)',
        explain: 'In the replayed mirror, MariaDB’s own system time answers the time-machine question with no application-time columns at all.',
        sql: Q.SQL_MIRROR_AS_OF.trim(), params: [t.sql, article.article_id],
        rows: [await this.history.mirrorAsOf(article.article_id, t.sql)].filter(Boolean),
      });
      const between = await this.history.mirrorBetween(article.article_id, yearStart, yearEnd);
      demos.push({
        key: 'mirror-between', title: `page_mirror FOR SYSTEM_TIME BETWEEN ${yearStart} AND ${yearEnd}`,
        explain: `Every version of the article that was live at some moment of ${t.sql.slice(0, 4)}: ${between.length} row versions.`,
        sql: Q.SQL_MIRROR_BETWEEN.trim(), params: [yearStart, yearEnd, article.article_id],
        rows: between.slice(0, LIMIT),
      });
    }
    demos.push({
      key: 'audit', title: 'articles FOR SYSTEM_TIME ALL: resolution audit trail',
      explain: 'The catalogue row of this article and every earlier version of it (a page rename or redirect change would appear here). System time alone is sufficient for this kind of audit.',
      sql: Q.SQL_ARTICLES_AUDIT.trim(), params: [article.article_id],
      rows: await this.history.articleAudit(article.article_id),
    });
    return { article, t, coverage: cov, checkpoints, demos, systemMax: SYSTEM_MAX };
  }

  async datasetSummary() {
    const [stats, checkpoints, run, replay, growth] = await Promise.all([
      this.articles.datasetStats(), this.checkpoints(), this.articles.lastRun(), this.history.lastReplay(),
      this.history.mirrorGrowth().catch(() => []),
    ]);
    return { stats, checkpoints, run, replay, growth, coverage: this.coverage() };
  }
}
