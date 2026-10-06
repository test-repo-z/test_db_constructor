-- 003_page_mirror.sql
-- "What if Wikipedia's own `page` table had been system-versioned?"
--
-- page_mirror holds ONE row per article: the revision that is current. Every edit is
-- an UPDATE, and MariaDB moves the previous row version into history by itself —
-- exactly the "history for free" design the project brief asks about.
--
-- It is filled by `npm run replay-mirror`, which replays all stored revisions in
-- global chronological order and, before each statement, sets the session clock
-- (SET timestamp = <Wikipedia revision time>). That makes SYSTEM time equal to
-- Wikipedia time, i.e. it SIMULATES a database that had been running live on
-- Wikipedia since the baseline. This is a deliberate, documented simulation:
--   * it needs secure_timestamp = NO (the MariaDB default); with YES the replay is refused;
--   * it is a derived projection of `revisions` and can be rebuilt at any time;
--   * the application's authoritative reconstruction uses article_history's
--     application time; `npm run validate` checks that both mechanisms agree.
--
-- Partitioned BY SYSTEM_TIME: current rows (one per article) live in partition `pn`;
-- historical row versions are routed by row_end into yearly partitions created on
-- demand (AUTO). Queries on current data touch only `pn`; AS OF queries prune the
-- history partitions whose rows all ended before the requested time.
--
-- Limitation (MariaDB/InnoDB): partitioned tables cannot have FOREIGN KEYs, which is
-- one reason the FK-protected article_history is not the partitioned table.
-- Text is referenced by SHA-1 (revision_texts) rather than copied into every row
-- version; docs/benchmarking.md measures what inline text would cost.
CREATE TABLE page_mirror (
  article_id    INT UNSIGNED    NOT NULL,
  rev_id        BIGINT UNSIGNED NOT NULL,
  rev_timestamp DATETIME        NOT NULL,
  sha1          CHAR(40)        CHARACTER SET ascii COLLATE ascii_bin NULL,
  size_bytes    INT UNSIGNED    NOT NULL DEFAULT 0,
  row_start     TIMESTAMP(6) GENERATED ALWAYS AS ROW START,
  row_end       TIMESTAMP(6) GENERATED ALWAYS AS ROW END,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  PRIMARY KEY (article_id)
) ENGINE=InnoDB WITH SYSTEM VERSIONING
  PARTITION BY SYSTEM_TIME INTERVAL 1 YEAR STARTS TIMESTAMP '2021-01-01 00:00:00' AUTO;

CREATE TABLE mirror_replays (
  replay_id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  started_at        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at       TIMESTAMP(6) NULL,
  status            ENUM('running','succeeded','failed') NOT NULL DEFAULT 'running',
  revisions_applied INT UNSIGNED NOT NULL DEFAULT 0,
  replayed_through  DATETIME     NULL,
  PRIMARY KEY (replay_id)
) ENGINE=InnoDB;
