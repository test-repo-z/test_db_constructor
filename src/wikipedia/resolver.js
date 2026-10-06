// Network side of article resolution: batches curated titles into `action=query` calls.
import { buildIndexes, classify, markDuplicateTargets, chunk } from './resolution.js';

/**
 * Resolves curated entries against the live MediaWiki API.
 * Batching 50 titles per request (the API maximum for non-bots) keeps this to 4 requests for 200 titles.
 */
export async function resolveArticles(client, entries, { titlesPerQuery = 50, log } = {}) {
  const resolvedAt = new Date().toISOString();
  const records = [];
  const batches = chunk(entries, titlesPerQuery);
  for (const [i, batch] of batches.entries()) {
    log?.info(`resolving batch ${i + 1}/${batches.length}`, { titles: batch.length });
    let indexes;
    try {
      const body = await client.query({
        action: 'query',
        titles: batch.map((e) => e.title).join('|'),
        redirects: '1',
        prop: 'info|pageprops',
        inprop: 'url',
        ppprop: 'disambiguation',
      });
      indexes = buildIndexes(body);
    } catch (err) {
      // Whole batch failed after retries: record every entry as an error instead of dropping it.
      for (const e of batch) {
        records.push({ ...classify(e, buildIndexes({}), { resolvedAt }), reason: `api_failure: ${err.message}` });
      }
      continue;
    }
    for (const e of batch) records.push(classify(e, indexes, { resolvedAt }));
  }
  return markDuplicateTargets(records);
}
