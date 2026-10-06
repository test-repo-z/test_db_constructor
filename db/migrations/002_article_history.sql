-- 002_article_history.sql
-- The central BITEMPORAL table.
--
-- One row = "revision `rev_id` was the visible text of article `article_id` on
-- Wikipedia during [valid_from, valid_to)".
--
--   APPLICATION (valid) time : PERIOD valid_period (valid_from, valid_to)
--       When was this revision the live version ON WIKIPEDIA? Derived from Wikipedia
--       revision timestamps: valid_from = its own timestamp, valid_to = timestamp of
--       the next revision (or logical infinity 9999-12-31 23:59:59 for the latest).
--       Half-open: at exactly valid_to the NEXT revision is the visible one.
--
--   SYSTEM (transaction) time : PERIOD FOR SYSTEM_TIME (row_start, row_end)
--       When did MARIADB believe this row? Maintained automatically by
--       WITH SYSTEM VERSIONING. When a later sync learns about a newer revision, the
--       previously open-ended interval is trimmed (DELETE ... FOR PORTION OF) and the
--       old belief "valid until further notice" is kept as a history row.
--
-- Constraints enforced by MariaDB itself:
--   * valid_from < valid_to                      (implicit CHECK named `valid_period`)
--   * no two intervals of one article overlap    (UNIQUE ... WITHOUT OVERLAPS)
--   * each revision appears at most once         (UNIQUE rev_id)
--
-- Revisions superseded within the same second by a revision with a higher rev_id
-- have an empty validity interval at Wikipedia's 1-second resolution. MariaDB
-- forbids empty periods, so they live only in `revisions`, not here.
CREATE TABLE article_history (
  article_id  INT UNSIGNED    NOT NULL,
  rev_id      BIGINT UNSIGNED NOT NULL,
  valid_from  DATETIME        NOT NULL,
  valid_to    DATETIME        NOT NULL,
  PERIOD FOR valid_period (valid_from, valid_to),
  row_start   TIMESTAMP(6) GENERATED ALWAYS AS ROW START,
  row_end     TIMESTAMP(6) GENERATED ALWAYS AS ROW END,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),
  -- Clustered index: (article_id, valid_from) serves the "stabbing" query
  --   WHERE article_id = ? AND valid_from <= T ORDER BY valid_from DESC LIMIT 1
  PRIMARY KEY (article_id, valid_from),
  UNIQUE KEY uq_article_history_rev (rev_id),
  UNIQUE KEY uq_article_history_no_overlap (article_id, valid_period WITHOUT OVERLAPS),
  CONSTRAINT fk_article_history_article FOREIGN KEY (article_id) REFERENCES articles (article_id),
  CONSTRAINT fk_article_history_revision FOREIGN KEY (rev_id) REFERENCES revisions (rev_id)
) ENGINE=InnoDB WITH SYSTEM VERSIONING;
