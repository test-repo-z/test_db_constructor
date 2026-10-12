-- 00_naive_import_time_stamps.sql — option A of README §5.5, and why this project rejects it.
--
-- Standalone (a tutorial_* table, dropped at the end). Verified on MariaDB 13.0.2. No session-clock tricks:
-- this is what happens when Wikipedia revisions are simply loaded, in order, into a system-versioned table.
--
-- "History for free", naively: one row per article, UPDATEd for every revision during the import.

DROP TABLE IF EXISTS tutorial_naive;

CREATE TABLE tutorial_naive (
  article_id         INT UNSIGNED    NOT NULL PRIMARY KEY,
  rev_id             BIGINT UNSIGNED NOT NULL,
  saved_on_wikipedia DATETIME        NOT NULL      -- the real date, carried along as plain data
) WITH SYSTEM VERSIONING;

-- The import: three Wikipedia revisions of one article, replayed in order with the real clock.
INSERT INTO tutorial_naive VALUES (1, 100, '2022-05-16 05:00:53');
UPDATE tutorial_naive SET rev_id = 200, saved_on_wikipedia = '2023-03-18 17:12:30' WHERE article_id = 1;
UPDATE tutorial_naive SET rev_id = 300, saved_on_wikipedia = '2024-02-12 00:11:14' WHERE article_id = 1;

-- "What did the article say on 2023-06-01?"  On Wikipedia the answer is revision 200. System time says that
-- nothing existed then, because nothing had been imported yet.
SELECT COUNT(*) AS rows_as_of_2023_06_01
FROM tutorial_naive FOR SYSTEM_TIME AS OF TIMESTAMP '2023-06-01 00:00:00';                  -- 0

-- All three versions were kept, but each is stamped with the moment of the IMPORT, not its Wikipedia date:
SELECT rev_id AS imported_rev, saved_on_wikipedia, row_start, row_end
FROM tutorial_naive FOR SYSTEM_TIME ALL ORDER BY row_start;

SELECT COUNT(*) AS versions_stamped_today
FROM tutorial_naive FOR SYSTEM_TIME ALL WHERE DATE(row_start) = CURRENT_DATE;             -- 3

SELECT TIMESTAMPDIFF(SECOND, MIN(row_start), MAX(row_start)) <= 5 AS whole_history_within_seconds
FROM tutorial_naive FOR SYSTEM_TIME ALL;                                                   -- 1: two years of edits, seconds apart

-- The only way to answer the question is to ignore system time and filter on the Wikipedia date that was
-- carried as data — which is application time. Doing that properly (intervals, no overlaps, boundaries,
-- indexes) is the bitemporal design of 01_bitemporal_table.sql.
SELECT rev_id AS answer_from_the_data
FROM tutorial_naive FOR SYSTEM_TIME ALL
WHERE saved_on_wikipedia <= '2023-06-01 00:00:00'
ORDER BY saved_on_wikipedia DESC LIMIT 1;                                                  -- 200

DROP TABLE tutorial_naive;
