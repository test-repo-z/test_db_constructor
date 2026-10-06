// JSON API (same services as the HTML pages).
import { sqlToIso } from '../temporal/time.js';

const revisionJson = (r) => r && ({
  rev_id: r.rev_id, parent_rev_id: r.parent_rev_id, rev_timestamp: r.rev_timestamp_iso,
  valid_from: r.valid_from_iso, valid_to: r.valid_to_iso, open_ended: r.open_ended,
  editor: r.editor_hidden ? null : r.editor, editor_hidden: r.editor_hidden,
  comment: r.comment_hidden ? null : r.comment, comment_hidden: r.comment_hidden,
  is_minor: r.is_minor, size_bytes: r.size_bytes, sha1: r.sha1, content_status: r.content_status,
  is_baseline: r.is_baseline, permalink: r.permalink,
});

export function apiController(service) {
  return {
    async coverage(req, res) {
      const s = await service.datasetSummary();
      res.json({
        application_time: { start: s.coverage.startIso, end: s.coverage.endIso, interval: 'closed [start, end]' },
        checkpoints: s.checkpoints.map((c) => ({ id: c.checkpoint_id, synced_through: sqlToIso(c.synced_through), completed_at: sqlToIso(c.completed_at) })),
        stats: s.stats,
      });
    },

    async articles(req, res) {
      const { articles, domains } = await service.listArticles();
      const domain = req.query.domain ? String(req.query.domain) : null;
      res.json({ domains, articles: articles.filter((a) => !domain || a.domain === domain) });
    },

    async article(req, res) {
      const o = await service.overview(req.params.id);
      res.json({ article: o.article, coverage: { start: o.coverage.startIso, end: o.coverage.endIso }, timeline: o.bounds, edits_per_month: o.perMonth });
    },

    async asOf(req, res) {
      const r = await service.asOf(req.params.id, String(req.query.t ?? ''), {
        checkpoint: req.query.checkpoint ? String(req.query.checkpoint) : undefined, render: req.query.render === '1' });
      res.json({
        article: { article_id: r.article.article_id, title: r.article.canonical_title },
        requested_time: r.t.iso,
        revision: revisionJson(r.revision),
        not_yet_created: r.notYetCreated ?? undefined,
        wikitext: req.query.content === '0' ? undefined : r.wikitext,
        html: r.rendered?.html,
        previous_rev_id: r.previous?.rev_id ?? null,
        next_rev_id: r.next?.rev_id ?? null,
        system_time_cross_check: r.mirror,
        known_at: r.knownAt && { checkpoint: r.knownAt.checkpoint.checkpoint_id, system_time: sqlToIso(r.knownAt.checkpoint.completed_at), revision: revisionJson(r.knownAt.revision), agrees: r.knownAt.agrees },
        query: { sql: r.sql, params: r.sqlParams },
      });
    },

    async diff(req, res) {
      const r = await service.diff(req.params.id, String(req.query.a ?? ''), String(req.query.b ?? ''), { mode: req.query.mode ? String(req.query.mode) : 'wikitext' });
      res.json({
        article: { article_id: r.article.article_id, title: r.article.canonical_title },
        earlier: { requested_time: r.a.iso, revision: revisionJson(r.earlier) },
        later: { requested_time: r.b.iso, revision: revisionJson(r.later) },
        swapped: r.swapped, same_revision: r.sameRevision, edits_between: r.editsBetween, mode: r.mode,
        stats: r.diff.stats, hunks: r.diff.hunks,
      });
    },

    async history(req, res) {
      const r = await service.historyPage(req.params.id, { from: req.query.from, to: req.query.to, page: req.query.page ?? '1' });
      res.json({ article_id: r.article.article_id, from: r.from.iso, to: r.to.iso, page: r.page, pages: r.pages, total: r.total, revisions: r.revisions.map(revisionJson) });
    },
  };
}
