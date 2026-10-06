-- 001_core_schema.sql
-- Article identity, Wikipedia revision events, content storage and ingestion bookkeeping.
-- All DATETIME columns hold UTC (every connection runs SET time_zone = '+00:00').

-- ---------------------------------------------------------------------------
-- Domains of the curated list (Physics, Biology, ...).
-- ---------------------------------------------------------------------------
CREATE TABLE domains (
  domain_id   SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(64)       NOT NULL,
  PRIMARY KEY (domain_id),
  UNIQUE KEY uq_domains_name (name)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- articles: one row per CURATED title (all 200, including duplicates/missing).
--
-- System-versioned on purpose: this is the classic "audit table" use case where
-- system time alone is enough. If Wikipedia renames a page or a redirect changes,
-- re-running the resolver UPDATEs the row and MariaDB keeps the previous identity
-- in history — no hand-written audit table or trigger needed.
-- ---------------------------------------------------------------------------
CREATE TABLE articles (
  article_id              INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  requested_title         VARCHAR(255)      COLLATE utf8mb4_bin NOT NULL,
  curated_position        SMALLINT UNSIGNED NOT NULL COMMENT '0-based index in data/articles.json',
  domain_id               SMALLINT UNSIGNED NOT NULL,
  resolution_status       ENUM('resolved','redirect','missing','disambiguation','duplicate','error') NOT NULL,
  canonical_title         VARCHAR(255)      COLLATE utf8mb4_bin NULL,
  page_id                 INT UNSIGNED      NULL COMMENT 'Wikipedia page id (stable across renames)',
  canonical_url           VARCHAR(512)      NULL COMMENT 'canonicalurl returned by the API',
  is_redirect             BOOLEAN           NOT NULL DEFAULT FALSE,
  is_disambiguation       BOOLEAN           NOT NULL DEFAULT FALSE,
  redirect_fragment       VARCHAR(255)      NULL,
  duplicate_of_article_id INT UNSIGNED      NULL,
  resolution_reason       VARCHAR(512)      NULL,
  -- Only usable rows "own" their page; a generated column lets a plain UNIQUE index
  -- enforce "each Wikipedia page is ingested at most once" while duplicates stay recorded.
  owned_page_id           INT UNSIGNED AS (IF(resolution_status IN ('resolved','redirect'), page_id, NULL)) PERSISTENT,
  row_start               TIMESTAMP(6) GENERATED ALWAYS AS ROW START,
  row_end                 TIMESTAMP(6) GENERATED ALWAYS AS ROW END,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (article_id),
  UNIQUE KEY uq_articles_requested_title (requested_title),
  UNIQUE KEY uq_articles_owned_page (owned_page_id),
  KEY ix_articles_domain (domain_id),
  CONSTRAINT fk_articles_domain FOREIGN KEY (domain_id) REFERENCES domains (domain_id),
  CONSTRAINT fk_articles_duplicate_of FOREIGN KEY (duplicate_of_article_id) REFERENCES articles (article_id),
  CONSTRAINT ck_articles_usable_complete CHECK (
    resolution_status NOT IN ('resolved','redirect')
    OR (page_id IS NOT NULL AND canonical_title IS NOT NULL AND canonical_url IS NOT NULL)),
  CONSTRAINT ck_articles_duplicate_target CHECK (
    (resolution_status = 'duplicate') = (duplicate_of_article_id IS NOT NULL))
) ENGINE=InnoDB WITH SYSTEM VERSIONING;

-- ---------------------------------------------------------------------------
-- Ingestion bookkeeping.
-- ---------------------------------------------------------------------------
CREATE TABLE ingestion_runs (
  run_id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  started_at         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at        TIMESTAMP(6) NULL,
  status             ENUM('running','succeeded','partial','failed') NOT NULL DEFAULT 'running',
  window_start       DATETIME     NOT NULL,
  window_end         DATETIME     NOT NULL,
  options            JSON         NULL,
  articles_total     INT UNSIGNED NOT NULL DEFAULT 0,
  articles_failed    INT UNSIGNED NOT NULL DEFAULT 0,
  revisions_seen     INT UNSIGNED NOT NULL DEFAULT 0,
  revisions_inserted INT UNSIGNED NOT NULL DEFAULT 0,
  revisions_skipped  INT UNSIGNED NOT NULL DEFAULT 0,
  texts_inserted     INT UNSIGNED NOT NULL DEFAULT 0,
  raw_text_bytes     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  stored_text_bytes  BIGINT UNSIGNED NOT NULL DEFAULT 0,
  api_requests       INT UNSIGNED NOT NULL DEFAULT 0,
  api_retries        INT UNSIGNED NOT NULL DEFAULT 0,
  error_summary      TEXT         NULL,
  PRIMARY KEY (run_id),
  CONSTRAINT ck_runs_window CHECK (window_start < window_end)
) ENGINE=InnoDB;

-- A checkpoint is committed after every article has been synchronised up to
-- `synced_through` (APPLICATION time). `completed_at` is the SYSTEM time at which
-- that knowledge became visible. Joining the two answers bitemporal questions like
-- "what did the database believe after the 2023 sync step?".
CREATE TABLE sync_checkpoints (
  checkpoint_id   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id          INT UNSIGNED NOT NULL,
  synced_through  DATETIME     NOT NULL,
  completed_at    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  articles_synced INT UNSIGNED NOT NULL,
  PRIMARY KEY (checkpoint_id),
  KEY ix_checkpoints_run (run_id),
  CONSTRAINT fk_checkpoints_run FOREIGN KEY (run_id) REFERENCES ingestion_runs (run_id)
) ENGINE=InnoDB;

-- Resumability: how far (in Wikipedia time) each article has been synchronised.
-- System-versioned so the progress of every sync is auditable for free.
CREATE TABLE article_sync_state (
  article_id     INT UNSIGNED NOT NULL,
  synced_from    DATETIME     NOT NULL,
  synced_through DATETIME     NOT NULL,
  last_run_id    INT UNSIGNED NOT NULL,
  row_start      TIMESTAMP(6) GENERATED ALWAYS AS ROW START,
  row_end        TIMESTAMP(6) GENERATED ALWAYS AS ROW END,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (article_id),
  CONSTRAINT fk_sync_state_article FOREIGN KEY (article_id) REFERENCES articles (article_id),
  CONSTRAINT fk_sync_state_run FOREIGN KEY (last_run_id) REFERENCES ingestion_runs (run_id),
  CONSTRAINT ck_sync_state_range CHECK (synced_from <= synced_through)
) ENGINE=InnoDB WITH SYSTEM VERSIONING;

-- ---------------------------------------------------------------------------
-- Content storage (content-addressed + delta-friendly compression).
--
-- Consecutive Wikipedia revisions are near-identical. Compressing them one by one
-- (what a COMPRESSED column or InnoDB page compression does) only reaches ~3x;
-- compressing a run of consecutive texts together with Brotli and a 16 MiB window
-- lets the codec reference the previous revision, reaching ~100-200x on real data.
-- A chunk is therefore a Brotli stream of several consecutive texts of one article;
-- revision_texts maps each distinct text (by SHA-1) to its byte range inside a chunk.
-- Chunks are immutable: new revisions always go into new chunks.
-- ---------------------------------------------------------------------------
CREATE TABLE content_chunks (
  chunk_id     INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  article_id   INT UNSIGNED      NOT NULL,
  codec        ENUM('brotli')    NOT NULL,
  text_count   SMALLINT UNSIGNED NOT NULL,
  raw_bytes    INT UNSIGNED      NOT NULL,
  stored_bytes INT UNSIGNED      NOT NULL,
  payload      LONGBLOB          NOT NULL,
  created_at   TIMESTAMP(6)      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (chunk_id),
  KEY ix_chunks_article (article_id),
  CONSTRAINT fk_chunks_article FOREIGN KEY (article_id) REFERENCES articles (article_id),
  CONSTRAINT ck_chunks_sizes CHECK (stored_bytes = LENGTH(payload) AND text_count > 0)
) ENGINE=InnoDB;

CREATE TABLE revision_texts (
  sha1        CHAR(40)     CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'SHA-1 of the UTF-8 wikitext (as reported by MediaWiki, verified on ingest)',
  chunk_id    INT UNSIGNED NOT NULL,
  byte_offset INT UNSIGNED NOT NULL,
  byte_length INT UNSIGNED NOT NULL,
  PRIMARY KEY (sha1),
  KEY ix_texts_chunk (chunk_id),
  CONSTRAINT fk_texts_chunk FOREIGN KEY (chunk_id) REFERENCES content_chunks (chunk_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- revisions: Wikipedia revision EVENTS (immutable facts).
--
-- `rev_timestamp` is the moment the edit was saved on Wikipedia — application time.
-- It is NOT the time the row was written to MariaDB. Not system-versioned: events
-- never change, so system versioning would only add a row_end column to every key
-- while never producing a single history row.
-- ---------------------------------------------------------------------------
CREATE TABLE revisions (
  rev_id          BIGINT UNSIGNED NOT NULL COMMENT 'Wikipedia revision id: stable identity, makes ingestion idempotent',
  article_id      INT UNSIGNED    NOT NULL,
  parent_rev_id   BIGINT UNSIGNED NULL,
  rev_timestamp   DATETIME        NOT NULL COMMENT 'UTC, 1-second resolution, from MediaWiki',
  editor          VARCHAR(255)    NULL,
  editor_id       INT UNSIGNED    NULL,
  editor_hidden   BOOLEAN         NOT NULL DEFAULT FALSE,
  comment         TEXT            NULL,
  comment_hidden  BOOLEAN         NOT NULL DEFAULT FALSE,
  is_minor        BOOLEAN         NOT NULL DEFAULT FALSE,
  size_bytes      INT UNSIGNED    NULL,
  sha1            CHAR(40)        CHARACTER SET ascii COLLATE ascii_bin NULL,
  content_status  ENUM('available','hidden') NOT NULL,
  is_baseline     BOOLEAN         NOT NULL DEFAULT FALSE COMMENT 'revision that was current at the window start (saved before it)',
  run_id          INT UNSIGNED    NOT NULL,
  PRIMARY KEY (rev_id),
  KEY ix_revisions_article_time (article_id, rev_timestamp, rev_id),
  KEY ix_revisions_sha1 (sha1),
  KEY ix_revisions_run (run_id),
  CONSTRAINT fk_revisions_article FOREIGN KEY (article_id) REFERENCES articles (article_id),
  CONSTRAINT fk_revisions_text FOREIGN KEY (sha1) REFERENCES revision_texts (sha1),
  CONSTRAINT fk_revisions_run FOREIGN KEY (run_id) REFERENCES ingestion_runs (run_id),
  CONSTRAINT ck_revisions_content CHECK ((content_status = 'available') = (sha1 IS NOT NULL))
) ENGINE=InnoDB;
