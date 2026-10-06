// Central configuration: merges config/project.json (non-secret, versioned)
// with environment variables (secrets, deployment specifics).
// Every other module reads dates, URLs and limits from here — nothing is duplicated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export class ConfigError extends Error {}

/**
 * Validates and normalises the raw project.json object.
 * Exported separately so it can be unit-tested without touching the file system.
 */
export function parseProjectConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new ConfigError('project config must be an object');
  const win = raw.dataset?.window;
  if (!win || !ISO_UTC.test(win.start ?? '') || !ISO_UTC.test(win.end ?? '')) {
    throw new ConfigError('dataset.window.start/end must be ISO-8601 UTC timestamps like 2021-09-22T00:00:00Z');
  }
  const start = new Date(win.start);
  const end = new Date(win.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new ConfigError('dataset.window contains an invalid calendar date');
  }
  if (!(start < end)) throw new ConfigError('dataset.window.start must be strictly before dataset.window.end');

  const wiki = raw.wikipedia ?? {};
  for (const key of ['apiUrl', 'articleBaseUrl', 'permalinkBaseUrl', 'userAgentProduct']) {
    if (typeof wiki[key] !== 'string' || wiki[key].length === 0) throw new ConfigError(`wikipedia.${key} is required`);
  }
  const positiveInts = ['minRequestIntervalMs', 'maxRetries', 'retryBaseDelayMs', 'retryMaxDelayMs',
    'requestTimeoutMs', 'titlesPerQuery', 'metadataPageSize', 'contentBatchSize'];
  for (const key of positiveInts) {
    if (!Number.isInteger(wiki[key]) || wiki[key] < 0) throw new ConfigError(`wikipedia.${key} must be a non-negative integer`);
  }
  if (wiki.titlesPerQuery > 50) throw new ConfigError('wikipedia.titlesPerQuery cannot exceed the API limit of 50');
  if (wiki.contentBatchSize > 50) throw new ConfigError('wikipedia.contentBatchSize cannot exceed the API limit of 50');

  const statuses = raw.dataset.ingestStatuses ?? ['resolved', 'redirect'];
  const known = new Set(['resolved', 'redirect', 'missing', 'disambiguation', 'duplicate', 'error']);
  for (const s of statuses) if (!known.has(s)) throw new ConfigError(`unknown ingest status ${s}`);

  return Object.freeze({
    dataset: Object.freeze({
      windowStart: start,
      windowEnd: end,
      includeBaselineRevision: raw.dataset.includeBaselineRevision !== false,
      ingestStatuses: Object.freeze([...statuses]),
    }),
    sources: Object.freeze({
      articles: raw.sources?.articles ?? 'data/articles.json',
      resolved: raw.sources?.resolved ?? 'data/articles.resolved.json',
      expectedArticleCount: raw.sources?.expectedArticleCount ?? 200,
    }),
    wikipedia: Object.freeze({ ...wiki }),
    ingestion: Object.freeze({ syncStepMonths: raw.ingestion?.syncStepMonths ?? 12 }),
    temporal: Object.freeze({ logicalInfinity: raw.temporal?.logicalInfinity ?? '9999-12-31 23:59:59' }),
    diff: Object.freeze({ maxInputBytes: raw.diff?.maxInputBytes ?? 2_000_000 }),
    demo: Object.freeze({ articles: Object.freeze([...(raw.demo?.articles ?? [])]) }),
  });
}

function intFromEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`environment variable ${name} must be a non-negative integer`);
  return n;
}

export function loadConfig() {
  const file = path.join(ROOT_DIR, 'config', 'project.json');
  const project = parseProjectConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  const contact = process.env.WIKI_USER_AGENT_CONTACT || project.wikipedia.userAgentContact;
  return Object.freeze({
    ...project,
    userAgent: `${project.wikipedia.userAgentProduct} (${contact}; educational MariaDB temporal-tables project) Node.js/${process.versions.node}`,
    db: Object.freeze({
      host: process.env.DB_HOST || '127.0.0.1',
      port: intFromEnv('DB_PORT', 3306),
      database: process.env.DB_NAME || 'wiki_time_machine',
      testDatabase: process.env.DB_TEST_NAME || 'wiki_time_machine_test',
      user: process.env.DB_USER || 'wtm_app',
      password: process.env.DB_PASSWORD || '',
      // Least-privilege account for the web tier; falls back to the main account.
      webUser: process.env.DB_WEB_PASSWORD ? (process.env.DB_WEB_USER || 'wtm_web') : (process.env.DB_USER || 'wtm_app'),
      webPassword: process.env.DB_WEB_PASSWORD || process.env.DB_PASSWORD || '',
    }),
    http: Object.freeze({
      port: intFromEnv('PORT', 3000),
      rateLimitPerMinute: intFromEnv('RATE_LIMIT_PER_MINUTE', 120),
    }),
    logLevel: process.env.LOG_LEVEL || 'info',
  });
}

export const config = loadConfig();
export const resolvePath = (p) => path.resolve(ROOT_DIR, p);
