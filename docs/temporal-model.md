# The temporal model

This document explains how the Wikipedia Time Machine models time, and why it needs **two** time
dimensions. The SQL shown is the SQL the application runs (see `src/repositories/temporalQueries.js`).

## 1. Two questions, two clocks

| | **Application time** (valid time) | **System time** (transaction time) |
|---|---|---|
| Question | *When was this revision the live text **on Wikipedia**?* | *When did **this database** store / believe this row?* |
| Source | Wikipedia's revision timestamp (`rev_timestamp`) | MariaDB's clock at the moment of the write |
| Columns | `article_history.valid_from`, `valid_to` | `row_start`, `row_end` (generated) |
| Declared by | `PERIOD FOR valid_period (valid_from, valid_to)` | `PERIOD FOR SYSTEM_TIME (row_start, row_end)` + `WITH SYSTEM VERSIONING` |
| Who writes it | the ingestion, from Wikipedia data | MariaDB, automatically, nobody else |
| Queried with | ordinary predicates `valid_from <= T AND T < valid_to` | `FOR SYSTEM_TIME AS OF / BETWEEN / FROM … TO / ALL` |
| Can be "in the past" when written? | yes: a 2019 edit imported in 2026 is valid from 2019 | no: a row written in 2026 has `row_start` in 2026 |

A table with both is **bitemporal**: `article_history` is one.

### Worked example

Consider the Wikipedia revision saved on **2018-03-15 10:30 UTC** and imported by this project on
**2026-09-20 14:00 UTC**:

```text
application_valid_from = 2018-03-15 10:30:00   -- Wikipedia: from this moment, this text was the article
system row_start       ≈ 2026-09-20 14:00:00   -- MariaDB: from this moment, the database contained the row
```

The two values answer different questions, and neither can be derived from the other:

* "What did the article say on 2019-01-01?" → application time. The answer is this revision if
  `valid_from <= '2019-01-01' < valid_to`. The import date is irrelevant.
* "What did *our database* say about the article on 2026-09-19?" → system time. The answer is "nothing":
  the row did not exist yet (`row_start` is 2026-09-20).

(2018 lies outside this project's default 5-year window; the window, not the model, is what limits
the dataset. See §6.)

### Why import time is the wrong clock for history

A naive design stores one row per article, `UPDATE`s it for every revision during import, and relies on
`FOR SYSTEM_TIME AS OF` to go back in time. If the import runs today, every row version gets today's
`row_start`: asking for the article "as of 2023" returns *nothing* (nothing was stored in 2023), and
asking "as of five minutes ago" returns some arbitrary intermediate state of the import. System time
records the history of the **database**, not the history of **Wikipedia**. The real history must be
carried explicitly, as application time.

## 2. Events and states

The schema separates two kinds of facts:

* **`revisions` — events.** "Revision 1145344668 of *Thermochemistry* was saved at 2023-03-18 17:12:30."
  Immutable, one row per Wikipedia revision, keyed by Wikipedia's `rev_id`. A point in time.
* **`article_history` — states.** "Revision 1145344668 was the visible text from 2023-03-18 17:12:30 until
  2023-12-19 19:12:26." An interval, *derived* from the ordered events, which changes when new events
  become known.

Because events never change, `revisions` is **not** system-versioned (it would never produce a history
row). The derived intervals do change, so `article_history` **is**.

## 3. Constructing application-time intervals

For the revisions of one article ordered by `(rev_timestamp, rev_id)`:

```text
revision A at T1, B at T2, C at T3   ⟹   A: [T1, T2)   B: [T2, T3)   C: [T3, +∞)
```

Rules (implemented in `src/temporal/timeline.js`, unit-tested in `tests/unit/timeline.test.js`):

1. **Half-open intervals.** `[valid_from, valid_to)`: at exactly `T2`, A is no longer valid and B is.
2. **No gaps, no overlaps.** Consecutive intervals touch exactly (`A.valid_to = B.valid_from`).
3. **Open end.** The newest revision has `valid_to = '9999-12-31 23:59:59'` (logical infinity):
   valid "until further notice".
4. **Same-second edits.** Wikipedia timestamps have 1-second resolution. If several revisions of one
   article share a timestamp, only the one with the highest `rev_id` was ever observable at that resolution;
   the others would have the empty interval `[T, T)`. MariaDB forbids empty periods (see §5), so these
   *shadowed* revisions stay in `revisions` (as events) but get no `article_history` row.
   The real dataset contains such a pair; `npm run validate` checks that every revision is either on the
   timeline or shadowed by a same-second successor.
5. **Baseline.** To know the article's state at the window start, the ingestion also fetches the last
   revision saved *before* the window (`rvdir=older&rvlimit=1`). Its `valid_from` is its real (pre-window)
   timestamp: application time is never clipped to the import window.

### Boundary semantics, explicitly

With A valid `[2023-03-15 10:30:00, 2023-03-15 10:30:05)` and B valid from `2023-03-15 10:30:05`:

| Requested instant | Result | Why |
|---|---|---|
| `10:30:04` | A | `10:30:00 <= T < 10:30:05` |
| `10:30:05` (exactly B's timestamp) | **B** | half-open: A's interval excludes its end |
| `10:30:06` | B | |
| before the article's first revision | none: "the article did not exist yet" | |
| before the window start / after the window end | **rejected** (HTTP 422) | no claim outside the dataset |

These cases are covered by `tests/integration/temporal.test.js` (real MariaDB).

## 4. The main query

```sql
-- Q1: which revision was live on Wikipedia at instant T?
SELECT h.valid_from, h.valid_to, r.*
FROM article_history AS h
JOIN revisions AS r ON r.rev_id = h.rev_id
WHERE h.article_id = ?
  AND h.valid_from <= ?          -- T
  AND h.valid_to   >  ?          -- T
ORDER BY h.valid_from DESC
LIMIT 1;
```

* There is **no** `FOR SYSTEM_TIME` clause: the query reads the *current* knowledge (system time = now)
  and filters on *application* time.
* MariaDB has no `SELECT … FOR <application period> AS OF` syntax (verified: it is a parse error).
  Application-time *queries* are plain predicates; the period declaration buys constraints and DML
  (`FOR PORTION OF`), not query syntax.
* `ORDER BY valid_from DESC LIMIT 1` lets the optimizer walk the clustered primary key
  `(article_id, valid_from)` backwards from `T` and stop at the first entry: one index read per lookup,
  regardless of how many revisions the article has. Without it, MariaDB scans every interval that started
  before `T` (measured in `docs/benchmarking.md`).

## 5. What MariaDB enforces for us

```sql
CREATE TABLE article_history (
  article_id  INT UNSIGNED    NOT NULL,
  rev_id      BIGINT UNSIGNED NOT NULL,
  valid_from  DATETIME        NOT NULL,
  valid_to    DATETIME        NOT NULL,
  PERIOD FOR valid_period (valid_from, valid_to),                         -- application time
  row_start   TIMESTAMP(6) GENERATED ALWAYS AS ROW START,
  row_end     TIMESTAMP(6) GENERATED ALWAYS AS ROW END,
  PERIOD FOR SYSTEM_TIME (row_start, row_end),                             -- system time
  PRIMARY KEY (article_id, valid_from),
  UNIQUE KEY uq_article_history_rev (rev_id),
  UNIQUE KEY uq_article_history_no_overlap (article_id, valid_period WITHOUT OVERLAPS),
  FOREIGN KEY (article_id) REFERENCES articles (article_id),
  FOREIGN KEY (rev_id) REFERENCES revisions (rev_id)
) WITH SYSTEM VERSIONING;
```

* `PERIOD FOR valid_period` adds an implicit `CHECK (valid_from < valid_to)` (constraint name `valid_period`,
  error 4025 on violation) and forces both columns `NOT NULL`.
* `WITHOUT OVERLAPS` makes MariaDB reject any two overlapping intervals of the same article
  (`ER_DUP_ENTRY`), while accepting touching half-open intervals. The no-overlap invariant is enforced by
  the database, not merely by application code.
* `WITH SYSTEM VERSIONING` keeps every superseded row version.

## 6. How system time records the evolution of knowledge

The ingestion synchronises the window in **steps** (default: 12 months, `config/project.json`), as a
periodic sync job would. After step 1 the database knows Wikipedia up to 2022-09-22; for an article last
edited in May 2022 it believes:

```text
rev 1088096854   valid [2022-05-16 05:00:53, ∞)       -- "current, until further notice"
```

Step 2 learns about the next edit (2023-03-18) and closes that interval with SQL:2011 application-time DML:

```sql
DELETE FROM article_history
  FOR PORTION OF valid_period FROM '2023-03-18 17:12:30' TO '9999-12-31 23:59:59'
WHERE article_id = ? AND rev_id = 1088096854;
INSERT INTO article_history (article_id, rev_id, valid_from, valid_to)
VALUES (?, 1145344668, '2023-03-18 17:12:30', '9999-12-31 23:59:59');
```

MariaDB rewrites the row to `[2022-05-16 05:00:53, 2023-03-18 17:12:30)` and, because the table is
system-versioned, keeps the old belief `[…, ∞)` as a history row with `row_end` = the moment of the update.
Each committed step is recorded in `sync_checkpoints (synced_through, completed_at)`, which links the
knowledge horizon (application time) to the system time at which it became visible.

That enables genuinely **bitemporal** questions:

```sql
-- Q2: "Which revision was live on Wikipedia at T, according to what the database knew at system time S?"
SELECT h.valid_from, h.valid_to, h.row_start, h.row_end, r.*
FROM article_history FOR SYSTEM_TIME AS OF TIMESTAMP ? AS h      -- S: rewinds the database
JOIN revisions AS r ON r.rev_id = h.rev_id
WHERE h.article_id = ? AND h.valid_from <= ? AND h.valid_to > ?   -- T: Wikipedia time
ORDER BY h.valid_from DESC LIMIT 1;
```

For `T = 2024-06-01` and `S` = the end of sync step 1, the answer is revision 1088096854 with an open end
(the database did not know about later edits yet); with today's knowledge it is a later revision. The UI
exposes this through the "Database knowledge" selector on the as-of page and in the Temporal lab.

The predicate on each axis controls exactly one dimension:

| Clause | Dimension | Meaning |
|---|---|---|
| `FOR SYSTEM_TIME AS OF S` | system | which *row versions* (beliefs) are visible: those current at S |
| `valid_from <= T AND valid_to > T` | application | which of those beliefs describe Wikipedia at T |

## 7. The replayed mirror: system time = Wikipedia time, by simulation

The project brief asks what happens if "the database itself is responsible for maintaining history".
`page_mirror` answers this directly: one row per article holding the current revision, updated in place,
history kept by MariaDB. `npm run replay-mirror` rebuilds it by replaying every stored revision in global
chronological order while setting the **session clock** to the revision's Wikipedia timestamp:

```sql
SET timestamp = UNIX_TIMESTAMP('2023-03-18 17:12:30');
INSERT INTO page_mirror (...) VALUES (...) ON DUPLICATE KEY UPDATE rev_id = VALUES(rev_id), ...;
```

After the replay, MariaDB's own system time is Wikipedia time, and

```sql
-- Q3
SELECT rev_id FROM page_mirror FOR SYSTEM_TIME AS OF TIMESTAMP '2023-06-01 12:00:00' WHERE article_id = ?;
```

reconstructs the article with no application-time columns at all. This is what system versioning would
have given Wikipedia if its `page` table had been versioned from the start.

It is a deliberate, labelled **simulation**:

* it requires `secure_timestamp = NO` (the MariaDB default, stated explicitly in `db/conf/time-machine.cnf`);
  with `secure_timestamp = YES` nobody can forge system time, and the replay refuses to run;
* it is a derived projection of `revisions`, rebuilt from scratch on every replay;
* the application's authoritative answer is always Q1; Q3 is shown as an independent cross-check.
  `npm run validate` probes hundreds of instants, exactly on interval boundaries and one second
  before them, and requires both mechanisms to agree.

Two details observed while building the replay (MariaDB 13.0.2):

* an `UPDATE` executed at the *same* session timestamp as the previous one does **not** leave a
  zero-length history row, so same-second edits behave exactly like the application-time rule in §3;
* `FOR SYSTEM_TIME AS OF T` is half-open in the same way (`row_start <= T < row_end`), and
  `BETWEEN a AND b` includes versions starting exactly at `b` while `FROM a TO b` excludes them.

## 8. What system versioning replaces — and what it does not

**It replaces:**

* hand-written audit tables (`articles_audit`, `…_log`) and the triggers that fill them: `articles` and
  `article_sync_state` are versioned, and every change of a resolution or of sync progress is kept automatically;
* ad-hoc "valid_until" bookkeeping of *database* state and periodic snapshot copies;
* application code that copies a row before updating it;
* reconstruction logic for "what did the database contain at time S": `FOR SYSTEM_TIME AS OF S`.

**It does not replace:**

* **the source's own history semantics.** Wikipedia's revision history is application time: it existed
  before this database and is imported from it. System versioning cannot back-date rows (except by the
  replay trick above, which is a simulation and disabled in hardened servers);
* **Wikipedia's revision table itself:** revisions carry meaning (author, comment, parent, minor flag) that
  is not "the previous version of a row";
* **business-validity modelling:** "valid from / until" in the real world (contracts, prices, which text
  was live) must be modelled explicitly (application-time periods);
* **event sourcing in general:** system versioning stores *states*, not the *intent* of a change; there is no
  "why" in `row_start`;
* **domain-specific event logs:** reverts, page moves and protections are events with their own meaning;
* **full content version control:** no branching, merging, diff storage or blame. Each version is a full
  copy of the row (the cost of that is measured in `docs/benchmarking.md`);
* **data-protection workflows:** history is kept until explicitly purged (`DELETE HISTORY`, partition
  drops); a right-to-erasure request must purge history too.

## 9. When a temporal database is not the right tool

* The history *is* the product and needs domain semantics (Git, Wikipedia's revision table, ledgers):
  model the events explicitly.
* Rows change extremely often and history is rarely queried: every update copies the full row, and history
  grows without bound unless it is partitioned and purged.
* History must be portable across systems: system versioning is engine state; dumps need care
  (`system_versioning_insert_history`), and not every tool understands it.
* Large documents change by small edits: full-row copies are expensive (measured: see the inline-text
  experiment in `docs/benchmarking.md`); delta or content-addressed storage is better.
* Legal requirements to forget data: versioning works against you unless retention is designed in.
