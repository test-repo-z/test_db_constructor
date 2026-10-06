// The temporal SQL of the project, in one place. Every query is parameterised; every
// parameter is a validated 'YYYY-MM-DD HH:MM:SS' UTC string or an integer id.
//
// Two time dimensions appear below — keep them apart:
//   APPLICATION time  article_history.valid_from / valid_to   "when was this the text on Wikipedia?"
//   SYSTEM time       row_start / row_end, FOR SYSTEM_TIME    "when did the database hold this row?"

/**
 * Q1 — Application-time lookup (the main "time machine" query).
 * "Which revision was the visible version of article A on Wikipedia at instant T?"
 * Half-open interval test valid_from <= T < valid_to. ORDER BY ... DESC LIMIT 1 lets the
 * optimizer walk the clustered PRIMARY KEY (article_id, valid_from) backwards from T and stop at
 * the first row: one index entry examined, however long the article's history is.
 */
export const SQL_REVISION_AT = `
SELECT h.valid_from, h.valid_to,
  r.rev_id, r.parent_rev_id, r.rev_timestamp, r.editor, r.editor_hidden, r.comment, r.comment_hidden,
  r.is_minor, r.size_bytes, r.sha1, r.content_status, r.is_baseline
FROM article_history AS h
JOIN revisions AS r ON r.rev_id = h.rev_id
WHERE h.article_id = ?
  AND h.valid_from <= ?
  AND h.valid_to   >  ?
ORDER BY h.valid_from DESC
LIMIT 1`;

/**
 * Q2 — Bitemporal lookup: application time T *as the database knew it* at system time S.
 * FOR SYSTEM_TIME AS OF S rewinds article_history to the row versions current at S; the WHERE
 * clause then applies the application-time predicate to that past belief.
 */
export const SQL_REVISION_AT_KNOWN_AT = `
SELECT h.valid_from, h.valid_to, h.row_start, h.row_end,
  r.rev_id, r.parent_rev_id, r.rev_timestamp, r.editor, r.editor_hidden, r.comment, r.comment_hidden,
  r.is_minor, r.size_bytes, r.sha1, r.content_status, r.is_baseline
FROM article_history FOR SYSTEM_TIME AS OF TIMESTAMP ? AS h
JOIN revisions AS r ON r.rev_id = h.rev_id
WHERE h.article_id = ?
  AND h.valid_from <= ?
  AND h.valid_to   >  ?
ORDER BY h.valid_from DESC
LIMIT 1`;

/**
 * Q3 — System-time lookup on the replayed mirror (system time == Wikipedia time by simulation).
 * No application-time columns at all: MariaDB's own row_start/row_end answer the question.
 */
export const SQL_MIRROR_AS_OF = `
SELECT m.rev_id, m.rev_timestamp, m.row_start, m.row_end
FROM page_mirror FOR SYSTEM_TIME AS OF TIMESTAMP ? AS m
WHERE m.article_id = ?`;

/** Application-time range: revisions whose validity overlaps [from, to]. */
export const SQL_HISTORY_OVERLAPPING = `
SELECT h.valid_from, h.valid_to,
  r.rev_id, r.parent_rev_id, r.rev_timestamp, r.editor, r.editor_hidden, r.comment, r.comment_hidden,
  r.is_minor, r.size_bytes, r.sha1, r.content_status, r.is_baseline
FROM article_history AS h
JOIN revisions AS r ON r.rev_id = h.rev_id
WHERE h.article_id = ?
  AND h.valid_from <= ?
  AND h.valid_to   >  ?
ORDER BY h.valid_from DESC
LIMIT ? OFFSET ?`;

export const SQL_HISTORY_OVERLAPPING_COUNT = `
SELECT COUNT(*) AS n
FROM article_history AS h
WHERE h.article_id = ? AND h.valid_from <= ? AND h.valid_to > ?`;

/** Number of edits saved in (a, b] — "how many revisions happened between the two moments?" */
export const SQL_EDITS_BETWEEN = `
SELECT COUNT(*) AS n FROM revisions WHERE article_id = ? AND rev_timestamp > ? AND rev_timestamp <= ?`;

/** Edits per month (application time) for the timeline histogram. */
export const SQL_EDITS_PER_MONTH = `
SELECT DATE_FORMAT(rev_timestamp, '%Y-%m') AS month, COUNT(*) AS edits
FROM revisions
WHERE article_id = ? AND rev_timestamp >= ? AND rev_timestamp <= ?
GROUP BY month ORDER BY month`;

/** First/last application-time instants known for an article. */
export const SQL_ARTICLE_TIMELINE_BOUNDS = `
SELECT MIN(valid_from) AS first_from, COUNT(*) AS intervals,
       (SELECT COUNT(*) FROM revisions r WHERE r.article_id = ?) AS revisions
FROM article_history WHERE article_id = ?`;

// ---------------------------------------------------------------------------------------
// System-time demonstrations (Temporal lab page). Same shapes as the README examples.
// ---------------------------------------------------------------------------------------

/** FOR SYSTEM_TIME ALL: every row version ever stored, current and superseded. */
export const SQL_SYSTEM_ALL_FOR_ARTICLE = `
SELECT h.rev_id, h.valid_from, h.valid_to, h.row_start, h.row_end,
       h.row_end = TIMESTAMP'2106-02-07 06:28:15.999999' AS is_current
FROM article_history FOR SYSTEM_TIME ALL AS h
WHERE h.article_id = ?
ORDER BY h.valid_from DESC, h.row_start DESC
LIMIT ?`;

/** FOR SYSTEM_TIME AS OF: the timeline as believed at system time S. */
export const SQL_SYSTEM_AS_OF_TIMELINE = `
SELECT h.rev_id, h.valid_from, h.valid_to, h.row_start, h.row_end
FROM article_history FOR SYSTEM_TIME AS OF TIMESTAMP ? AS h
WHERE h.article_id = ?
ORDER BY h.valid_from DESC
LIMIT ?`;

/** FOR SYSTEM_TIME BETWEEN: row versions that were current at some point within [S1, S2]. */
export const SQL_SYSTEM_BETWEEN = `
SELECT h.rev_id, h.valid_from, h.valid_to, h.row_start, h.row_end
FROM article_history FOR SYSTEM_TIME BETWEEN TIMESTAMP ? AND TIMESTAMP ? AS h
WHERE h.article_id = ?
ORDER BY h.row_start DESC, h.valid_from DESC
LIMIT ?`;

/** page_mirror versions that existed during [a, b] — BETWEEN on the simulated system time. */
export const SQL_MIRROR_BETWEEN = `
SELECT m.rev_id, m.rev_timestamp, m.row_start, m.row_end
FROM page_mirror FOR SYSTEM_TIME BETWEEN TIMESTAMP ? AND TIMESTAMP ? AS m
WHERE m.article_id = ?
ORDER BY m.row_start`;

/** History growth of page_mirror, per year of row_end (= per history partition). */
export const SQL_MIRROR_GROWTH = `
SELECT YEAR(m.row_end) AS year_closed, COUNT(*) AS row_versions, SUM(m.size_bytes) AS inline_text_bytes
FROM page_mirror FOR SYSTEM_TIME ALL AS m
WHERE m.row_end < TIMESTAMP'2106-02-07 06:28:15.999999'
GROUP BY YEAR(m.row_end) ORDER BY year_closed`;

export const SQL_ARTICLES_AUDIT = `
SELECT a.article_id, a.requested_title, a.resolution_status, a.canonical_title, a.row_start, a.row_end
FROM articles FOR SYSTEM_TIME ALL AS a
WHERE a.article_id = ?
ORDER BY a.row_start`;
