# Article resolution and ingestion

## 1. Resolution (`npm run resolve-articles`)

`data/articles.json` is the editorial source of truth: 200 titles in 10 domains (20 each). It is validated
(count, structure, case-insensitive duplicate titles) but never modified. Titles are human-chosen, so they may
be redirects, renamed pages, disambiguation pages or missing pages; they cannot be used blindly as page
identifiers.

The resolver batches 50 titles per `action=query` request (the API maximum for anonymous clients: 4 requests
in total) with `redirects=1&prop=info|pageprops&inprop=url&ppprop=disambiguation`, and classifies each title
deterministically (`src/wikipedia/resolution.js`):

1. apply `normalized` (e.g. first-letter case, underscores);
2. follow `redirects` until a real page (cycles → `error`); keep a `#fragment` if the redirect targets a section;
3. look the page up: `missing` → **missing**; `invalid` or a non-article namespace → **error**;
4. `pageprops.disambiguation` → **disambiguation**;
5. otherwise **redirect** (if a redirect was followed) or **resolved**;
6. the canonical URL is the API's `canonicalurl`; it is never assembled from the requested title;
7. second pass: when several titles resolve to the same `page_id`, exactly one owns the page, namely the title
   that *is* the canonical title, or else the first in curated order. The others become **duplicate**
   with `duplicate_of`. They are reported and stored, not dropped.

The result is written to `data/articles.resolved.json` (generated; do not edit), including the requested
title, domain, canonical title, page id, URL, status, flags, redirect chain and reason.

Statuses `resolved` and `redirect` are ingested (`config/project.json → dataset.ingestStatuses`).

## 2. Ingestion (`npm run ingest`)

```text
resolve titles ─► sync `articles` (only real changes are UPDATEd) ─► for each step (12 months):
    for each usable article:
        metadata pages  (prop=revisions, rvprop=ids|timestamp|flags|user|userid|comment|size|sha1, rvlimit=500,
                         rvdir=newer, rvstart/rvend, follow continue.rvcontinue until absent)
        + baseline      (first sync only: rvdir=older, rvstart=window start, rvlimit=1)
        skip rev_ids already stored
        content         (revids=…, rvprop=content|sha1, only for SHA-1 digests not stored yet,
                         20 per request; revisions missing from a truncated response are re-queued with a
                         smaller batch)
        verify          sha1(downloaded text) == SHA-1 reported by Wikipedia, else the article step fails
        compress        consecutive texts → Brotli chunks (≤ 8 MiB raw, 16 MiB window)
        ONE TRANSACTION chunks + texts + revisions (INSERT IGNORE)
                        + timeline plan (DELETE … FOR PORTION OF trims, deletes, inserts)
                        + article_sync_state
    commit checkpoint (synced_through, completed_at)
─► validation suite
```

### Politeness towards Wikipedia

* One request at a time, at least 300 ms apart (`minRequestIntervalMs`).
* `maxlag=5`: when Wikipedia's database replicas lag, the API answers with a `maxlag` error, and the client backs off.
* Retries only for transient failures (network errors, HTTP 429/5xx, `maxlag`, `ratelimited`, `internal_api_error_*`, e.g. a `DBConnectionError` inside MediaWiki, which happened once during the real run), up to 6 times
  with exponential backoff and jitter (1 s → 30 s cap), honouring `Retry-After`. Client errors are not retried.
* A descriptive User-Agent with a contact URL (`WIKI_USER_AGENT_CONTACT` to override), as Wikimedia's policy asks.
* Requests are minimised: metadata is fetched without content (500 revisions per request); a text is
  downloaded once per SHA-1 (reverts reuse an existing text); already-synchronised ranges are not re-fetched.

### Idempotency and restart safety

* `revisions.rev_id` (Wikipedia's revision id) and `revision_texts.sha1` are primary keys; inserts are
  `INSERT IGNORE`. Running the ingestion twice cannot duplicate a revision.
* The timeline is not "inserted"; it is **planned** from all known revisions of the article and only the
  difference is applied (`planTimelineChanges`). Re-running with nothing new is a no-op (no DML, hence no
  spurious system-history rows).
* Each article step is a single transaction. A crash or an API outage loses at most the article in progress;
  `article_sync_state` records how far each article got, and the next run continues from there.
  Boundary seconds are re-fetched and de-duplicated, so revisions saved exactly at a cutoff are never missed.
* A MariaDB advisory lock (`GET_LOCK(CONCAT(DATABASE(), '.ingest'))`) prevents two concurrent writers;
  runs left in `running` state by a killed process are marked `failed` by the next run.
* All of this is tested against real MariaDB in `tests/integration/ingestion.test.js` (outage mid-run, SHA-1
  corruption, forced re-fetch, lock, pagination).

### Extending the window

Edit `dataset.window` in `config/project.json` and run `npm run ingest` again:

* **later end:** every article continues from its `synced_through`; the open-ended intervals are closed by
  `FOR PORTION OF` (system history records the change of knowledge);
* **earlier start:** the missing range and a new baseline are fetched; `planTimelineChanges` inserts the older
  revisions before the existing ones.

`--from` / `--to` on the command line can only *narrow* the configured window (e.g. to stage a sync).

## 3. Known limitations of the Wikipedia API and of this import strategy

* **Revision deletion:** Wikipedia can hide a revision's text, editor or comment. Such revisions keep their
  place on the timeline with `content_status = 'hidden'` (and `editor_hidden` / `comment_hidden`). A revision
  hidden *after* our import is not re-checked: the ingestion never re-downloads stored texts.
* **Page moves and merges:** pages are tracked by `page_id`, which survives renames. History merges and
  imports can, rarely, insert old revisions into a page's history; the timeline planner handles insertions, but
  only for ranges that are (re-)synchronised.
* **Deleted / re-created pages:** a page deleted and re-created gets a new `page_id`; re-resolution would point
  the article at the new page while old revisions stay attached to the article. Not observed in this dataset.
* **Rendering fidelity:** templates, Lua modules, references and math are not expanded offline (see
  `README.md`, "Content storage and rendering").
* **Throughput:** content download is limited by Wikipedia's response time (about 0.5–1 MB of wikitext per
  second for serial requests in our runs), so a full import of the 5-year window takes hours. It is resumable,
  and `--articles` / `--limit` allow small reproducible subsets.
* **Moving target:** Wikipedia keeps changing; a later re-run may resolve titles differently (renames, new
  redirects). The `articles` table is system-versioned precisely to keep such changes auditable.
