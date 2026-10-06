#!/usr/bin/env node
// npm run ingest [-- options]
//
//   --from=ISO            narrow the window start (must lie inside config/project.json's window)
//   --to=ISO              narrow the window end   (e.g. to stage a sync and extend it later)
//   --step-months=N       sync step size (default from config; 0 = one single step)
//   --articles="A|B"      only these articles (requested or canonical titles, '|'-separated)
//   --limit=N             only the first N usable articles (quick smoke runs)
//   --reuse-manifest      do not call the resolver; use the existing data/articles.resolved.json
//   --skip-validation     do not run the validation suite at the end
//
// Steps: resolve titles -> sync `articles` -> fetch & store revisions step by step -> validate.
import fs from 'node:fs';
import { config, resolvePath } from '../src/config/index.js';
import { createLogger } from '../src/lib/logger.js';
import { isMain, parseArgs } from '../src/lib/cli.js';
import { createPool, withTransaction } from '../src/db/pool.js';
import { parseInstant } from '../src/temporal/time.js';
import { syncCatalog } from '../src/ingestion/catalog.js';
import { runIngestion } from '../src/ingestion/ingester.js';
import { runResolution, printSummary, makeClient, readCuratedList } from './resolve-articles.js';
import { runValidation, printReport } from './validate.js';

const log = createLogger('ingest-cli');

function effectiveWindow(args) {
  let { windowStart: start, windowEnd: end } = config.dataset;
  if (args.from) start = parseInstant(args.from, '--from').date;
  if (args.to) end = parseInstant(args.to, '--to').date;
  if (start < config.dataset.windowStart || end > config.dataset.windowEnd) {
    throw new Error('--from/--to may only narrow the window configured in config/project.json (edit the config to extend it)');
  }
  if (!(start < end)) throw new Error('--from must be before --to');
  return { start, end };
}

export async function main(args = parseArgs()) {
  const t0 = Date.now();
  const window = effectiveWindow(args);

  let manifest;
  if (args['reuse-manifest']) {
    manifest = JSON.parse(fs.readFileSync(resolvePath(config.sources.resolved), 'utf8'));
    readCuratedList(); // still validates the curated source
    log.info('reusing existing resolution manifest', { generated_at: manifest.generated_at });
  } else {
    ({ manifest } = await runResolution());
  }
  printSummary(manifest.summary, manifest.articles);

  const pool = createPool({ connectionLimit: 4 });
  try {
    const catalog = await withTransaction(pool, (conn) => syncCatalog(conn, manifest.articles));
    log.info('article catalog synchronised', { inserted: catalog.inserted, updated: catalog.updated, unchanged: catalog.unchanged });

    let articles = await pool.query(
      `SELECT article_id, page_id, canonical_title, requested_title FROM articles
       WHERE resolution_status IN (${config.dataset.ingestStatuses.map(() => '?').join(',')})
       ORDER BY curated_position`, [...config.dataset.ingestStatuses]);
    if (args.articles) {
      const wanted = new Set(String(args.articles).split('|').map((s) => s.trim()));
      articles = articles.filter((a) => wanted.has(a.canonical_title) || wanted.has(a.requested_title));
      if (!articles.length) throw new Error('--articles matched no usable article');
    }
    if (args.limit) articles = articles.slice(0, Number(args.limit));

    const client = makeClient();
    const stepMonths = args['step-months'] !== undefined ? Number(args['step-months']) : config.ingestion.syncStepMonths;
    const result = await runIngestion({
      pool, client, articles,
      windowStart: window.start, windowEnd: window.end, stepMonths,
      includeBaseline: config.dataset.includeBaselineRevision,
      contentBatchSize: config.wikipedia.contentBatchSize,
      pageSize: config.wikipedia.metadataPageSize,
      options: { ...args, stepMonths },
    });
    const c = result.counters;
    console.log([
      '',
      `Ingestion run #${result.runId}: ${result.status.toUpperCase()} in ${((Date.now() - t0) / 60000).toFixed(1)} min`,
      `  articles processed     ${c.articlesTotal} (failed: ${c.articlesFailed})`,
      `  revisions seen         ${c.revisionsSeen}`,
      `  revisions inserted     ${c.revisionsInserted}`,
      `  revisions skipped      ${c.revisionsSkipped} (already stored)`,
      `  distinct texts stored  ${c.textsInserted}  (${(c.rawBytes / 1e6).toFixed(1)} MB raw -> ${(c.storedBytes / 1e6).toFixed(1)} MB stored)`,
      `  timeline rows          +${c.historyInserts} inserted, ${c.historyTrims} closed (FOR PORTION OF), ${c.historyDeletes} removed`,
      `  Wikipedia API          ${c.apiRequests} requests, ${c.apiRetries} retries`,
    ].join('\n'));
    for (const f of result.failures) console.log(`  FAILED: ${f}`);

    if (!args['skip-validation']) {
      const report = await runValidation(pool);
      printReport(report);
      if (!report.ok) process.exitCode = 1;
    }
    if (result.status !== 'succeeded') process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    log.error(err.message);
    process.exit(1);
  });
}
