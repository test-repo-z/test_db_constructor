-- 01_bitemporal_table.sql — a bitemporal table and the "what was valid at T?" query.
--
-- Standalone: creates tutorial_* tables, uses them, drops them. Runs in any database on MariaDB >= 10.5
-- (verified on 13.0.2). Pattern used by article_history in db/migrations/002_article_history.sql.
--
-- The model: one row = "revision rev_id was the visible text of article article_id during
-- [valid_from, valid_to)". valid_* is APPLICATION time (when it was true in the world); the system period
-- added by WITH SYSTEM VERSIONING is SYSTEM time (when the database believed it).

DROP TABLE IF EXISTS tutorial_history;

CREATE TABLE tutorial_history (
  article_id INT UNSIGNED    NOT NULL,
  rev_id     BIGINT UNSIGNED NOT NULL,
  valid_from DATETIME        NOT NULL,
  valid_to   DATETIME        NOT NULL,
  PERIOD FOR valid_period (valid_from, valid_to),                     -- application time; implies valid_from < valid_to
  PRIMARY KEY (article_id, valid_from),                               -- serves the lookup below
  UNIQUE KEY uq_rev (rev_id),
  UNIQUE KEY uq_no_overlap (article_id, valid_period WITHOUT OVERLAPS) -- MariaDB rejects overlapping validity
) WITH SYSTEM VERSIONING;                                              -- system time, kept by MariaDB

-- Revisions A (T1), B (T2), C (T3) become [T1, T2), [T2, T3), [T3, infinity): half-open, no gaps, no overlaps.
INSERT INTO tutorial_history (article_id, rev_id, valid_from, valid_to) VALUES
  (1, 100, '2023-03-15 10:30:00', '2023-03-15 10:30:05'),   -- A
  (1, 200, '2023-03-15 10:30:05', '2024-01-10 00:00:00'),   -- B
  (1, 300, '2024-01-10 00:00:00', '9999-12-31 23:59:59');   -- C, open-ended: "until further notice"

-- Constraints MariaDB enforces by itself (uncomment one to see the error):
-- INSERT INTO tutorial_history VALUES (1, 400, '2023-06-01 00:00:00', '2023-07-01 00:00:00');  -- ERROR 1062: overlaps B
-- INSERT INTO tutorial_history VALUES (1, 400, '2025-01-01 00:00:00', '2025-01-01 00:00:00');  -- ERROR 4025: empty period

-- "Which revision was live at T?"  Half-open test valid_from <= T < valid_to.
-- ORDER BY valid_from DESC LIMIT 1 turns it into a single backwards step on the primary key.
SET @t = '2023-03-15 10:30:05';     -- exactly B's start

SELECT rev_id AS revision_at_exactly_T2
FROM tutorial_history
WHERE article_id = 1 AND valid_from <= @t AND valid_to > @t
ORDER BY valid_from DESC LIMIT 1;                                    -- 200: at T2, A is over and B is live

SELECT rev_id AS revision_one_second_before_T2
FROM tutorial_history
WHERE article_id = 1 AND valid_from <= @t - INTERVAL 1 SECOND AND valid_to > @t - INTERVAL 1 SECOND
ORDER BY valid_from DESC LIMIT 1;                                    -- 100

SELECT rev_id AS revision_far_in_the_future
FROM tutorial_history
WHERE article_id = 1 AND valid_from <= '2030-01-01' AND valid_to > '2030-01-01'
ORDER BY valid_from DESC LIMIT 1;                                    -- 300 (open-ended)

SELECT COUNT(*) AS revisions_before_first
FROM tutorial_history
WHERE article_id = 1 AND valid_from <= '2020-01-01' AND valid_to > '2020-01-01';   -- 0: the article did not exist yet

-- All intervals overlapping a range (here: everything live during 2023).
SELECT rev_id AS live_during_2023, valid_from, valid_to
FROM tutorial_history
WHERE article_id = 1 AND valid_from <= '2023-12-31 23:59:59' AND valid_to > '2023-01-01 00:00:00'
ORDER BY valid_from;                                                 -- 100, 200

-- The plan, as executed: ANALYZE runs the query and reports r_rows (rows actually read) next to the
-- optimizer's estimate. One backwards step on the PRIMARY KEY: r_rows = 1.
ANALYZE SELECT rev_id FROM tutorial_history
WHERE article_id = 1 AND valid_from <= @t AND valid_to > @t ORDER BY valid_from DESC LIMIT 1;

-- Note: there is no "SELECT ... FOR valid_period AS OF ..." in MariaDB (it is a syntax error);
-- application time is always queried with ordinary predicates like the ones above.

DROP TABLE tutorial_history;
