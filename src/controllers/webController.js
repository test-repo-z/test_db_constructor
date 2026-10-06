// HTML pages. Controllers only translate HTTP <-> service calls; no SQL here.
export function webController(service) {
  return {
    async home(req, res) {
      const [{ articles, domains }, summary] = await Promise.all([service.listArticles(), service.datasetSummary()]);
      res.render('index', { title: 'Wikipedia Time Machine', articles, domains, summary });
    },

    async article(req, res) {
      const o = await service.overview(req.params.id);
      res.render('article', { title: o.article.canonical_title, ...o });
    },

    async asOf(req, res) {
      const { t, checkpoint } = req.query;
      if (!t) return res.redirect(303, `/articles/${encodeURIComponent(req.params.id)}`);
      const r = await service.asOf(req.params.id, String(t), { checkpoint: checkpoint ? String(checkpoint) : undefined });
      const checkpoints = await service.checkpoints();
      res.render('as-of', { title: `${r.article.canonical_title} — ${r.t.iso}`, view: req.query.view === 'wikitext' ? 'wikitext' : 'rendered', checkpoints, ...r });
    },

    async diff(req, res) {
      const { a, b, mode } = req.query;
      if (!a || !b) {
        const o = await service.overview(req.params.id);
        return res.render('diff-form', { title: `Compare — ${o.article.canonical_title}`, ...o, a: a ?? '', b: b ?? '' });
      }
      const r = await service.diff(req.params.id, String(a), String(b), { mode: mode ? String(mode) : 'wikitext' });
      res.render('diff', { title: `Diff — ${r.article.canonical_title}`, ...r });
    },

    async history(req, res) {
      const r = await service.historyPage(req.params.id, {
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
        page: req.query.page ? String(req.query.page) : '1',
      });
      res.render('history', { title: `History — ${r.article.canonical_title}`, ...r });
    },

    async temporal(req, res) {
      const r = await service.temporalLab(req.params.id, { t: req.query.t ? String(req.query.t) : undefined });
      res.render('temporal', { title: `Temporal lab — ${r.article.canonical_title}`, ...r });
    },

    async about(req, res) {
      const [summary, curated] = await Promise.all([service.datasetSummary(), service.articles.listAllCurated()]);
      res.render('about', { title: 'Dataset & model', summary, curated });
    },
  };
}
