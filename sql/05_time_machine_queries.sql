-- 05_time_machine_queries.sql — the time machine's own queries, on the project schema.
--
-- Needs ingested data (`npm run demo` or `npm run ingest`, then `npm run replay-mirror`).
-- Read-only: changes nothing. Choose the article and instants by setting the variables before running,
-- otherwise the defaults below are used (Database is part of the demo set).

SET @title = COALESCE(@title, 'Database');
SET @T     = COALESCE(@T, '2023-06-01 00:00:00');          -- application time (Wikipedia)
SET @article = (SELECT article_id FROM articles
                WHERE canonical_title = @title AND resolution_status IN ('resolved', 'redirect'));
SET @S     = (SELECT MIN(completed_at) FROM sync_checkpoints);  -- system time: right after the first sync step

-- Q1. Which revision was live on Wikipedia at @T?  (src/repositories/temporalQueries.js, SQL_REVISION_AT)
SELECT h.rev_id AS live_rev, h.valid_from, h.valid_to, r.editor, r.comment
FROM article_history AS h
JOIN revisions AS r ON r.rev_id = h.rev_id
WHERE h.article_id = @article AND h.valid_from <= @T AND h.valid_to > @T
ORDER BY h.valid_from DESC
LIMIT 1;

-- Q2. The same question, answered with the knowledge the database had at system time @S (bitemporal).
SELECT h.rev_id AS live_rev_as_known_at_S, h.valid_from, h.valid_to, h.row_start, h.row_end
FROM article_history FOR SYSTEM_TIME AS OF TIMESTAMP @S AS h
WHERE h.article_id = @article AND h.valid_from <= @T AND h.valid_to > @T
ORDER BY h.valid_from DESC
LIMIT 1;

-- Q3. Cross-check on the replayed mirror, whose system time equals Wikipedia time (by simulation).
SELECT rev_id AS mirror_rev_at_T FROM page_mirror FOR SYSTEM_TIME AS OF TIMESTAMP @T WHERE article_id = @article;

-- Every revision live at some point of the calendar year of @T (application-time overlap).
SET @y0 = MAKEDATE(YEAR(@T), 1);
SET @y1 = MAKEDATE(YEAR(@T) + 1, 1) - INTERVAL 1 SECOND;
SELECT COUNT(*) AS revisions_live_that_year
FROM article_history WHERE article_id = @article AND valid_from <= @y1 AND valid_to > @y0;

-- The same set via system time on the mirror.
SELECT COUNT(*) AS mirror_versions_that_year
FROM page_mirror FOR SYSTEM_TIME BETWEEN TIMESTAMP @y0 AND TIMESTAMP @y1 WHERE article_id = @article;

-- How the database's knowledge of this article evolved: superseded beliefs (open-ended intervals closed later).
SELECT rev_id AS superseded_belief_rev, valid_from, valid_to, row_start, row_end
FROM article_history FOR SYSTEM_TIME ALL
WHERE article_id = @article AND row_end < TIMESTAMP'2106-02-07 06:28:15.999999'
ORDER BY row_start;

-- Sync checkpoints: application-time knowledge horizon vs. system time it became visible.
SELECT checkpoint_id, synced_through AS knew_wikipedia_up_to, completed_at AS committed_at_system_time
FROM sync_checkpoints ORDER BY checkpoint_id;

-- History growth of the partitioned mirror, per year in which versions were closed.
SELECT YEAR(row_end) AS year_closed, COUNT(*) AS row_versions, ROUND(SUM(size_bytes) / 1048576, 1) AS inline_text_mib_if_stored
FROM page_mirror FOR SYSTEM_TIME ALL
WHERE row_end < TIMESTAMP'2106-02-07 06:28:15.999999'
GROUP BY YEAR(row_end) ORDER BY year_closed;
