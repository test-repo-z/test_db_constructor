// Test database helpers. Integration/e2e tests run against the REAL MariaDB 13.0.2 container,
// in a separate database (DB_TEST_NAME), which is reset from the migrations before each suite.
import { config } from '../../src/config/index.js';
import { createPool, withTransaction } from '../../src/db/pool.js';
import { dropAllTables } from '../../scripts/db-reset.js';
import { runMigrations } from '../../scripts/migrate.js';
import { setLogLevel } from '../../src/lib/logger.js';
import { syncCatalog } from '../../src/ingestion/catalog.js';
import { runIngestion } from '../../src/ingestion/ingester.js';
import { FakeWikipedia, fixtureManifest } from '../fixtures/fakeWikipedia.js';
import { fixturePages, fixtureEntries } from '../fixtures/dataset.js';

export const TEST_DB = config.db.testDatabase;
if (TEST_DB === config.db.database) throw new Error('DB_TEST_NAME must differ from DB_NAME: tests drop all tables');

setLogLevel(process.env.TEST_LOG_LEVEL || 'warn');

export async function resetTestDatabase() {
  await dropAllTables(TEST_DB);
  await runMigrations(TEST_DB);
}

export function testPool(opts = {}) {
  return createPool({ database: TEST_DB, connectionLimit: 4, ...opts });
}

export async function usableArticles(pool) {
  return pool.query(`SELECT article_id, page_id, canonical_title, requested_title FROM articles
    WHERE resolution_status IN ('resolved','redirect') ORDER BY curated_position`);
}

/** Loads the fixture catalogue and ingests the fixture pages through the real pipeline. */
export async function loadFixture(pool, { stepMonths = 12, wiki = new FakeWikipedia(fixturePages()), pageSize = 2 } = {}) {
  const manifest = fixtureManifest(fixtureEntries());
  await withTransaction(pool, (conn) => syncCatalog(conn, manifest));
  const articles = await usableArticles(pool);
  const result = await runIngestion({
    pool, client: wiki, articles,
    windowStart: config.dataset.windowStart, windowEnd: config.dataset.windowEnd,
    stepMonths, includeBaseline: true, contentBatchSize: 3, pageSize,
  });
  return { manifest, articles, result, wiki };
}

export async function articleIdByPage(pool, pageId) {
  const [r] = await pool.query("SELECT article_id FROM articles WHERE page_id = ? AND resolution_status IN ('resolved','redirect')", [pageId]);
  return r.article_id;
}
