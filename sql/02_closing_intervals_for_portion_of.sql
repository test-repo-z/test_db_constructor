-- 02_closing_intervals_for_portion_of.sql — learning about a new revision, declaratively.
--
-- Standalone (tutorial_* tables, dropped at the end). Verified on MariaDB 13.0.2.
-- This is exactly how `npm run ingest` updates article_history (src/ingestion/store.js).
--
-- The database knows revision 100 and believes it is valid "until further notice". Later it learns that
-- revision 200 was saved at T. SQL:2011's FOR PORTION OF removes the portion [T, infinity) from revision
-- 100's validity; because the table is system-versioned, the old belief is not lost: it becomes history.

DROP TABLE IF EXISTS tutorial_timeline;

CREATE TABLE tutorial_timeline (
  article_id INT UNSIGNED    NOT NULL,
  rev_id     BIGINT UNSIGNED NOT NULL,
  valid_from DATETIME        NOT NULL,
  valid_to   DATETIME        NOT NULL,
  note       VARCHAR(20)     NOT NULL DEFAULT '',
  PERIOD FOR valid_period (valid_from, valid_to),
  PRIMARY KEY (article_id, valid_from),
  UNIQUE KEY uq_no_overlap (article_id, valid_period WITHOUT OVERLAPS)
) WITH SYSTEM VERSIONING;

-- First sync: only revision 100 is known.
INSERT INTO tutorial_timeline (article_id, rev_id, valid_from, valid_to) VALUES (1, 100, '2022-05-16 05:00:53', '9999-12-31 23:59:59');

-- Second sync: revision 200 was saved at 2023-03-18 17:12:30.
SET @t = '2023-03-18 17:12:30';
DELETE FROM tutorial_timeline
  FOR PORTION OF valid_period FROM @t TO '9999-12-31 23:59:59'
WHERE article_id = 1 AND rev_id = 100;                 -- [2022-05-16, inf) becomes [2022-05-16, @t)
INSERT INTO tutorial_timeline (article_id, rev_id, valid_from, valid_to) VALUES (1, 200, @t, '9999-12-31 23:59:59');

-- Today's knowledge (current rows):
SELECT rev_id AS current_rev, valid_from, valid_to
FROM tutorial_timeline ORDER BY valid_from;            -- 100 [2022-05-16, 2023-03-18), 200 [2023-03-18, inf)

-- Every belief the database ever held, current and superseded:
SELECT rev_id AS belief_rev, valid_from, valid_to,
       row_end = TIMESTAMP'2106-02-07 06:28:15.999999' AS is_current_belief
FROM tutorial_timeline FOR SYSTEM_TIME ALL
ORDER BY rev_id, row_start;                            -- 100 open-ended (superseded), 100 closed, 200 open

SELECT COUNT(*) AS superseded_beliefs
FROM tutorial_timeline FOR SYSTEM_TIME ALL
WHERE row_end < TIMESTAMP'2106-02-07 06:28:15.999999';  -- 1

-- UPDATE ... FOR PORTION OF changes a value for part of an interval: one row becomes up to three.
-- (Here: pretend revision 200's text was hidden by Wikipedia during January 2024 only.)
UPDATE tutorial_timeline
  FOR PORTION OF valid_period FROM '2024-01-01 00:00:00' TO '2024-02-01 00:00:00'
  SET note = 'hidden'
WHERE article_id = 1 AND rev_id = 200;

SELECT rev_id AS split_rev, valid_from, valid_to, note
FROM tutorial_timeline WHERE rev_id = 200 ORDER BY valid_from;   -- 3 rows: '', 'hidden' (January 2024), ''

SELECT COUNT(*) AS rows_for_rev_200 FROM tutorial_timeline WHERE rev_id = 200;   -- 3

DROP TABLE tutorial_timeline;
