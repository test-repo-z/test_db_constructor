#!/usr/bin/env node
// npm run demo [-- --limit=N]
// One command from a fresh clone (after `npm install`) to a working time machine:
//   .env (random passwords) → MariaDB 13.0.2 container (healthy) → migrations → resolve titles
//   → ingest the demo set (config/project.json → demo.articles: one article per domain) or, with --limit=N,
//     the first N curated articles → replay page_mirror → validate → web app
// Re-running is safe: every step is idempotent. For the full 196 articles use `npm run ingest`.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/lib/cli.js';
import { config } from '../src/config/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs();
const limit = args.limit === undefined ? null : String(args.limit);
if (limit !== null && (!/^\d+$/.test(limit) || Number(limit) < 1)) throw new Error('--limit must be a positive integer');
const selection = limit ? `--limit=${limit}` : `--articles=${config.demo.articles.join('|')}`;
const what = limit ? `the first ${limit} curated articles` : `the demo set (${config.demo.articles.length} articles, one per domain)`;

function step(title, cmd, cmdArgs) {
  console.log(`\n▶ ${title}\n  $ ${[cmd, ...cmdArgs].join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✖ "${title}" failed (exit ${r.status ?? r.signal}). Fix the problem above and re-run npm run demo — completed steps are not repeated.`);
    process.exit(r.status ?? 1);
  }
}

const node = process.execPath;
step('Create .env (only if missing)', node, ['scripts/setup-env.js']);
step('Start MariaDB 13.0.2 and wait until it is healthy', 'docker', ['compose', 'up', '-d', '--wait', 'db']);
step('Apply schema migrations', node, ['scripts/migrate.js']);
step(`Resolve the 200 curated titles and ingest ${what}: 5 years of revisions`, node, ['scripts/ingest.js', selection]);
step('Replay the revisions into page_mirror (system time = Wikipedia time)', node, ['scripts/replay-mirror.js']);
step('Validate data and temporal invariants', node, ['scripts/validate.js']);
step('Start the web application', 'docker', ['compose', 'up', '-d', '--build', '--wait', 'app']);

const port = dotenv.parse(fs.readFileSync(path.join(root, '.env'))).PORT || '3000';
console.log(`
✔ Done. Open http://localhost:${port} and pick an article.
  Try: an article → "Travel to a moment" → then "Temporal lab" for live AS OF / BETWEEN / ALL queries.
  Full dataset (all 196 articles, a few hours, resumable): npm run ingest`);
