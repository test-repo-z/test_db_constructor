-- 03_system_time_queries.sql — FOR SYSTEM_TIME AS OF / BETWEEN / FROM ... TO / ALL, and a bitemporal query.
--
-- Standalone (tutorial_* tables, dropped at the end). Verified on MariaDB 13.0.2.
--
-- To get reproducible system timestamps, this script sets the SESSION CLOCK before each change
-- (SET timestamp = ...). That needs secure_timestamp = NO (MariaDB's default) and is exactly the trick
-- `npm run replay-mirror` uses for page_mirror. In normal operation system time is simply "now".

DROP TABLE IF EXISTS tutorial_page;

-- One row per article holding its current revision: the "history for free" design.
CREATE TABLE tutorial_page (
  article_id INT UNSIGNED    NOT NULL PRIMARY KEY,
  rev_id     BIGINT UNSIGNED NOT NULL
) WITH SYSTEM VERSIONING;

SET timestamp = UNIX_TIMESTAMP('2022-01-01 00:00:00');
INSERT INTO tutorial_page VALUES (1, 100);
SET timestamp = UNIX_TIMESTAMP('2022-02-01 00:00:00');
UPDATE tutorial_page SET rev_id = 200 WHERE article_id = 1;
SET timestamp = UNIX_TIMESTAMP('2023-03-01 00:00:00');
UPDATE tutorial_page SET rev_id = 300 WHERE article_id = 1;
SET timestamp = DEFAULT;            -- back to the real clock

-- Plain SELECT: only the current row version.
SELECT rev_id AS current_rev FROM tutorial_page;                                        -- 300

-- AS OF: the row version current at that instant; half-open, row_start <= T < row_end.
SELECT rev_id AS as_of_2022_01_31 FROM tutorial_page FOR SYSTEM_TIME AS OF TIMESTAMP '2022-01-31 23:59:59';   -- 100
SELECT rev_id AS as_of_2022_02_01 FROM tutorial_page FOR SYSTEM_TIME AS OF TIMESTAMP '2022-02-01 00:00:00';   -- 200
SELECT COUNT(*) AS rows_as_of_2021 FROM tutorial_page FOR SYSTEM_TIME AS OF TIMESTAMP '2021-06-01 00:00:00';  -- 0

-- BETWEEN includes versions that START exactly at the upper bound; FROM ... TO excludes them.
SELECT GROUP_CONCAT(rev_id ORDER BY row_start) AS between_versions
FROM tutorial_page FOR SYSTEM_TIME BETWEEN TIMESTAMP '2022-01-15 00:00:00' AND TIMESTAMP '2023-03-01 00:00:00';  -- 100,200,300
SELECT GROUP_CONCAT(rev_id ORDER BY row_start) AS from_to_versions
FROM tutorial_page FOR SYSTEM_TIME FROM TIMESTAMP '2022-01-15 00:00:00' TO TIMESTAMP '2023-03-01 00:00:00';      -- 100,200

-- ALL: every version, with the interval during which it was current.
SELECT rev_id AS any_version, row_start, row_end FROM tutorial_page FOR SYSTEM_TIME ALL ORDER BY row_start;

-- Session-wide time travel: system_versioning_asof gives every SELECT an implicit AS OF.
SET @@system_versioning_asof = '2022-01-15 00:00:00';
SELECT rev_id AS implicit_as_of FROM tutorial_page;                                     -- 100
SET @@system_versioning_asof = DEFAULT;   -- unquoted! On 13.0.2 the documented 'DEFAULT' (quoted) fails with error 1231
SELECT rev_id AS after_reset FROM tutorial_page;                                        -- 300

DROP TABLE tutorial_page;

-- ---------------------------------------------------------------------------------------------------
-- Bitemporal: application time T ("when was it true?") as known at system time S ("when did we know?").
-- ---------------------------------------------------------------------------------------------------
DROP TABLE IF EXISTS tutorial_bitemporal;
CREATE TABLE tutorial_bitemporal (
  article_id INT UNSIGNED NOT NULL, rev_id BIGINT UNSIGNED NOT NULL,
  valid_from DATETIME NOT NULL, valid_to DATETIME NOT NULL,
  PERIOD FOR valid_period (valid_from, valid_to),
  PRIMARY KEY (article_id, valid_from)
) WITH SYSTEM VERSIONING;

SET timestamp = UNIX_TIMESTAMP('2026-01-01 00:00:00');      -- first sync: knows revision 100 only
INSERT INTO tutorial_bitemporal VALUES (1, 100, '2022-05-16 05:00:53', '9999-12-31 23:59:59');
SET timestamp = UNIX_TIMESTAMP('2026-06-01 00:00:00');      -- second sync: learns revision 200 (saved 2023-03-18)
DELETE FROM tutorial_bitemporal FOR PORTION OF valid_period FROM '2023-03-18 17:12:30' TO '9999-12-31 23:59:59' WHERE rev_id = 100;
INSERT INTO tutorial_bitemporal VALUES (1, 200, '2023-03-18 17:12:30', '9999-12-31 23:59:59');
SET timestamp = DEFAULT;

SET @T = '2024-06-01 00:00:00';     -- application time: "what was on Wikipedia then?"
SET @S = '2026-03-01 00:00:00';     -- system time: "according to what we knew on that day"

SELECT rev_id AS known_at_S
FROM tutorial_bitemporal FOR SYSTEM_TIME AS OF TIMESTAMP @S
WHERE article_id = 1 AND valid_from <= @T AND valid_to > @T;                           -- 100 (believed still current)

SELECT rev_id AS known_today
FROM tutorial_bitemporal
WHERE article_id = 1 AND valid_from <= @T AND valid_to > @T;                           -- 200

DROP TABLE tutorial_bitemporal;
