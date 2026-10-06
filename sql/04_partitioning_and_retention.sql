-- 04_partitioning_and_retention.sql — keeping a system-versioned table manageable.
--
-- Standalone (tutorial_* tables, dropped at the end). Verified on MariaDB 13.0.2.
-- Pattern used by page_mirror in db/migrations/003_page_mirror.sql; measured in benchmarks/reports/latest.md.
--
-- History partitions are bounded by row_end (when a version STOPPED being current); the CURRENT partition
-- holds one row per key. Session-clock replay (secure_timestamp = NO) makes the dates reproducible.

DROP TABLE IF EXISTS tutorial_mirror;

CREATE TABLE tutorial_mirror (
  article_id INT UNSIGNED    NOT NULL PRIMARY KEY,
  rev_id     BIGINT UNSIGNED NOT NULL
) WITH SYSTEM VERSIONING
  PARTITION BY SYSTEM_TIME INTERVAL 1 YEAR STARTS TIMESTAMP '2021-01-01 00:00:00' AUTO;   -- new partitions on demand

-- Two articles, edited over four years.
SET timestamp = UNIX_TIMESTAMP('2021-03-01 00:00:00'); INSERT INTO tutorial_mirror VALUES (1, 100), (2, 900);
SET timestamp = UNIX_TIMESTAMP('2022-03-01 00:00:00'); UPDATE tutorial_mirror SET rev_id = 101 WHERE article_id = 1;
SET timestamp = UNIX_TIMESTAMP('2023-03-01 00:00:00'); UPDATE tutorial_mirror SET rev_id = 102 WHERE article_id = 1;
SET timestamp = UNIX_TIMESTAMP('2023-09-01 00:00:00'); UPDATE tutorial_mirror SET rev_id = 901 WHERE article_id = 2;
SET timestamp = UNIX_TIMESTAMP('2024-03-01 00:00:00'); UPDATE tutorial_mirror SET rev_id = 103 WHERE article_id = 1;
SET timestamp = DEFAULT;

-- Where did the rows go?  (PARTITION_DESCRIPTION is the upper bound of each history partition.)
SELECT PARTITION_NAME AS partition_name, PARTITION_DESCRIPTION AS upper_bound
FROM information_schema.PARTITIONS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tutorial_mirror'
ORDER BY PARTITION_ORDINAL_POSITION;

SELECT COUNT(*) AS current_rows FROM tutorial_mirror PARTITION (pn);          -- 2: one per article
-- Note: PARTITION (...) cannot be combined with FOR SYSTEM_TIME (error 4142); on its own it returns that
-- partition's rows, history included.

-- Pruning, as the optimizer reports it:
EXPLAIN PARTITIONS SELECT * FROM tutorial_mirror WHERE article_id = 1;                      -- pn only
EXPLAIN PARTITIONS SELECT * FROM tutorial_mirror FOR SYSTEM_TIME AS OF TIMESTAMP '2024-06-01 00:00:00';   -- recent: few partitions
EXPLAIN PARTITIONS SELECT * FROM tutorial_mirror FOR SYSTEM_TIME AS OF TIMESTAMP '2021-06-01 00:00:00';   -- old: all partitions
-- AS OF T can only skip partitions whose versions all ended before T; it cannot prune on row_start.

SELECT rev_id AS article1_as_of_2022_06 FROM tutorial_mirror FOR SYSTEM_TIME AS OF TIMESTAMP '2022-06-01 00:00:00' WHERE article_id = 1;  -- 101

SELECT COUNT(*) AS versions_before_retention FROM tutorial_mirror FOR SYSTEM_TIME ALL;   -- 6 (2 current + 4 history)

-- Retention, option 1: drop whole history partitions (files), oldest first. The CURRENT partition cannot be
-- dropped. p0 (ended before 2022) is empty here; p1 holds the version of article 1 that ended in March 2022.
ALTER TABLE tutorial_mirror DROP PARTITION p0, p1;
SELECT COUNT(*) AS versions_after_drop_partition FROM tutorial_mirror FOR SYSTEM_TIME ALL;  -- 5

-- Retention, option 2: delete old history row by row (needs the DELETE HISTORY privilege). Removes the
-- two versions that ended in 2023 (March for article 1, September for article 2).
DELETE HISTORY FROM tutorial_mirror BEFORE SYSTEM_TIME TIMESTAMP '2024-01-01 00:00:00';
SELECT COUNT(*) AS versions_after_delete_history FROM tutorial_mirror FOR SYSTEM_TIME ALL;  -- 3 (2 current + 1 history)

-- What does NOT work: TRUNCATE on a system-versioned table is refused (error 4137) and history stays.
-- TRUNCATE TABLE tutorial_mirror;

DROP TABLE tutorial_mirror;
