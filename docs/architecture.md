# Architecture

```text
                 data/articles.json  (curated, 200 titles — never modified)
                          │
              npm run resolve-articles  ──► MediaWiki API (titles → canonical page, page id, redirect, disambiguation)
                          │
                 data/articles.resolved.json  (GENERATED manifest)
                          │
                    npm run ingest  ──────► MediaWiki API (revision metadata, then wikitext of unseen SHA-1s)
                          │                    serial, rate-limited, retried, paginated
                          ▼
 ┌──────────────────────────────── MariaDB 13.0.2 ────────────────────────────────┐
 │ domains          articles (system-versioned: resolution audit)                 │
 │ ingestion_runs   sync_checkpoints   article_sync_state (system-versioned)      │
 │ revisions        (events: Wikipedia revision metadata, immutable)              │
 │ content_chunks + revision_texts (content-addressed, Brotli-chunked wikitext)   │
 │ article_history  (BITEMPORAL: application period + system versioning)          │
 │ page_mirror      (system-versioned, PARTITION BY SYSTEM_TIME; replay sim.)     │
 └────────────────────────────────────────────────────────────────────────────────┘
                          ▲                               ▲
            npm run replay-mirror               npm run validate / npm run benchmark
                          │
                    Express app (SELECT-only account) ──► browser (server-rendered EJS)
```

## Components

| Layer | Path | Responsibility |
|---|---|---|
| Configuration | `config/project.json`, `src/config/` | dataset window, API etiquette, limits; secrets only from `.env` |
| Wikipedia client | `src/wikipedia/client.js` | serial requests, min interval, `maxlag`, retries with bounded exponential backoff + jitter, `Retry-After`, User-Agent |
| Resolution | `src/wikipedia/resolution.js` (pure), `resolver.js` | normalisation, redirects, missing/disambiguation/namespace detection, duplicate ownership |
| Revision fetching | `src/wikipedia/revisions.js` | metadata pagination, baseline revision, content by revids with truncation-safe re-queueing |
| Temporal core | `src/temporal/time.js`, `timeline.js` (pure) | strict instant parsing, coverage checks, interval construction, DML planning |
| Content | `src/content/chunks.js` | chunking, Brotli (16 MiB window), SHA-1 verification on every read |
| Ingestion | `src/ingestion/` | catalogue sync, per-article transactional sync, checkpoints, advisory lock, mirror replay |
| Repositories | `src/repositories/` | **all SQL of the web app**; `temporalQueries.js` holds the documented temporal SQL |
| Services | `src/services/` | time-machine logic (coverage, reconstruction, bitemporal view), diff, rendering + sanitisation |
| HTTP | `src/routes/`, `src/controllers/`, `src/middleware/`, `src/app.js` | routing, validation errors → HTTP codes, CSP/security headers, rate limiting |
| Views | `src/views/*.ejs`, `src/public/` | server-rendered pages; JS only for list filtering and chart tooltips |
| Validation | `src/validation/checks.js`, `scripts/validate.js` | source, schema, temporal and content invariants |
| Benchmark | `src/benchmark/`, `scripts/benchmark.js` | workloads, measurements, plans, report |

The temporal SQL is never hidden behind an ORM: every query is visible in `src/repositories/temporalQueries.js`
and is shown on the pages that use it.

## Request flow: "article X as of T"

1. `GET /articles/:id/as-of?t=…` → `webController.asOf`.
2. `TimeMachineService.asOf`: validate the id; `parseInstant` (strict format, real calendar date, UTC,
   no fractional seconds) → 400 on error; `assertWithinCoverage` → 422 outside the configured window.
3. `HistoryRepository.revisionAt` runs Q1 (application time) on `article_history`.
4. `ContentRepository.textBySha1` loads the chunk (LRU-cached), decompresses it and verifies the SHA-1.
5. `renderWikitext` parses the wikitext offline and sanitises the HTML.
6. Optional: Q3 cross-check on `page_mirror` (system time), Q2 bitemporal view for a sync checkpoint.
7. EJS renders metadata, the validity band, the SQL used, and the article.

## Database accounts

| Account | Privileges | Used by |
|---|---|---|
| `wtm_app` (`DB_USER`) | `ALL` on the project and test databases | migrations, ingestion, replay, validation, benchmark |
| `wtm_web` (`DB_WEB_USER`) | `SELECT` only | the web server (`src/server.js`); falls back to `DB_USER` if not configured |
| `root` | — | only container initialisation (`db/init/00-create-databases.sh`) |

## Security measures

* **SQL injection:** every value is a bound parameter; identifiers are never built from input. The web tier's
  account is read-only, so even a bug could not modify data or purge history.
* **Input validation:** ids must be integers; instants must match a strict grammar and be real calendar dates;
  ranges are checked; unknown checkpoints and modes are rejected (400/422 with clear messages).
* **XSS:** wikitext is untrusted. The parser's HTML goes through `sanitize-html` with an allow-list (no
  scripts, event handlers, styles, images, iframes; only `http(s)` links, rewritten to `en.wikipedia.org` with
  `rel="nofollow noopener noreferrer"`). All other output is EJS-escaped. A strict Content-Security-Policy
  (`script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'`, no inline styles or
  scripts anywhere) is a second layer. Tested with a fixture revision containing `<script>` and `onerror`.
* **Abuse:** reconstruction, diff and temporal-lab routes are rate-limited per IP; diffs have a time and
  edit-length budget (`DiffTooExpensiveError`) and an input size limit.
* **Errors:** internal errors are logged with detail and returned as a generic message; only validation errors
  expose their text.
* **Secrets:** only in `.env` (git-ignored); `.env.example` documents the variables.
* **Headers:** Helmet (CSP, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, …); `X-Powered-By` disabled.

## Logging

* Ingestion: one line per article and step (revisions fetched/new, texts, MB raw → stored, intervals closed,
  shadowed revisions, seconds), API retries with delay and reason, failures with the article name, final
  summary, checkpoint commits.
* Web: one line per request (method, URL, status, latency); temporal lookups log the article, instant, revision
  and SQL time at `debug` level (`LOG_LEVEL=debug`). No credentials are ever logged.
