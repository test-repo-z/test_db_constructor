# MariaDB 13.0.2: verified behaviour and constraints

Everything below was observed on `mariadb:13.0.2` (`13.0.2-MariaDB-ubu2604`, aarch64) while building this
project. Most items are covered by an automated test in `tests/integration/schema.test.js`; the others are
noted as "observed".

## Temporal features

| # | Behaviour | Consequence for this project | Test |
|---|---|---|---|
| 1 | `WITH SYSTEM VERSIONING`, an application-time `PERIOD`, `UNIQUE … WITHOUT OVERLAPS` and `PARTITION BY SYSTEM_TIME` can all be combined on one table. | A true bitemporal table is possible without workarounds. | observed during design |
| 2 | Current rows have `row_end = 2106-02-07 06:28:15.999999` (64-bit TIMESTAMP range since 11.5), **not** `2038-01-19 03:14:07.999999`. | Code and docs that hard-code 2038 are wrong on 13.0.2; a row inserted with `row_end = 2038…` via `system_versioning_insert_history` silently becomes a *history* row. | `DELETE … FOR PORTION OF` test asserts the 2106 value |
| 3 | `PERIOD FOR p (a, b)` forces `a` and `b` to `NOT NULL` (silently, even if declared `NULL`) and adds an implicit `CHECK (a < b)` named after the period (error 4025). | Empty intervals are impossible → same-second revisions cannot be stored with `[T, T)`; they are kept as events only. | "the period implies valid_from < valid_to" |
| 4 | `WITHOUT OVERLAPS` accepts touching half-open intervals (`[a,b)` + `[b,c)`), rejects overlaps with `ER_DUP_ENTRY`. Internally the key is `(article_id, row_end, valid_to, valid_from)` (`SHOW INDEX` shows the column positions 1, 3, 4; `row_end` is the hidden second part). | DB-enforced non-overlap. The index is ordered by `valid_to` first, which matters for query plans. | "WITHOUT OVERLAPS rejects …" |
| 5 | There is no `SELECT … FOR <application period> AS OF …` (parse error). | Application-time lookups are written as predicates. | "application-time lookup is a plain predicate" |
| 6 | `DELETE … FOR PORTION OF valid_period FROM ? TO ?` works with bound parameters and on a system-versioned table; the trimmed original survives as a history row. | Used by the ingestion to close open intervals. | "DELETE … FOR PORTION OF trims …" |
| 7 | Application-time period tables cannot be `TEMPORARY` (`ER_PERIOD_TEMPORARY_NOT_ALLOWED`). | Staging must use regular tables. | "cannot be TEMPORARY" |
| 8 | With TIMESTAMP-based versioning, each **statement** gets its own `row_start` (microseconds apart inside one explicit transaction). Inserting and then modifying a row inside one transaction therefore still creates a (very short) history row. | The ingestion computes final intervals in memory and writes each row once. | observed |
| 9 | An `UPDATE` that sets a column to its **current value** reports 1 affected row **and writes a history row** on a versioned table (on a plain InnoDB table it reports 0). | The catalogue sync compares values and only updates real changes; otherwise every resolver run would pollute the audit history. | "even a no-op UPDATE … writes a history row" |
| 10 | Two updates at the same session timestamp (`SET timestamp`) leave no zero-length history version. | Same-second edits in the replay behave like the application-time rule. | page_mirror test |
| 11 | `AS OF T` is half-open (`row_start <= T < row_end`); `BETWEEN a AND b` includes versions starting at `b`; `FROM a TO b` excludes them. | Documented boundary semantics. | page_mirror test |
| 12 | `ALTER TABLE` on a versioned table fails by default (`system_versioning_alter_history = ERROR`); `SET system_versioning_alter_history = KEEP` is needed for schema changes. | Future migrations on versioned tables must set it explicitly. | "ALTER … is refused by default" |
| 13 | `SET timestamp = …` is honoured for system versioning when `secure_timestamp = NO` (default). `system_versioning_insert_history = 1` lets a normal user with INSERT write explicit `row_start`/`row_end` under the same condition. | Enables the page_mirror simulation and byte-identical copies of history for the benchmark. Hardened servers should use `secure_timestamp = YES`. | replay + benchmark |
| 14 | `TIMESTAMP` placeholders work in prepared statements: `FOR SYSTEM_TIME AS OF TIMESTAMP ?`. | All temporal SQL is parameterised. | used everywhere |
| 15 | FOREIGN KEYs only protect **current** rows: a parent referenced only by system-history versions can be deleted, leaving the history dangling. | `npm run validate` checks that `article_history` history rows still reference existing revisions. | "foreign keys protect only CURRENT rows" |

## Beyond what the time machine needs (`npm run explore`)

`npm run explore` (`src/explore/experiments.js`) runs these experiments on scratch tables, prints every
statement with its result, and checks each claim; `tests/integration/explore.test.js` asserts all of them.

| # | Behaviour on 13.0.2 | Why it matters |
|---|---|---|
| X1 | **Transaction-precise history** (`BIGINT UNSIGNED … AS ROW START/END`): two `UPDATE`s in one transaction leave **one** history version (the intermediate value is never recorded), while a TIMESTAMP-versioned table records one version per statement (finding #8). `FOR SYSTEM_TIME AS OF TRANSACTION <id>` works. | A version becomes "what another transaction could see", not "what a statement wrote". |
| X2 | `PARTITION BY SYSTEM_TIME` on a transaction-precise table → error **4110** (`trx_start must be of type TIMESTAMP(6)`), as the documentation warns. | You choose between commit-precise history and partition-based retention. This project needs retention, so it uses timestamps. |
| X3 | `AS OF TIMESTAMP` on a transaction-precise table is resolved through `mysql.transaction_registry`, which records the **session clock**: a transaction run under `SET timestamp = '2020-01-01'` is registered as committed in 2020, *after* transactions registered in 2026. Answers for such instants then depend on the registry's contents (one probe returned a 2026 row for `AS OF '2020-06-01'`; clean runs return nothing). Reading the registry needs an explicit grant (`db/init`). | Transaction-precise history does not protect against a forged clock either; only `secure_timestamp = YES` does. |
| X4 | A column declared `WITHOUT SYSTEM VERSIONING` can be updated without creating a version; the history copy made by a later versioned update carries whatever value it held then, so its own history is lost. | Keeps hot counters from copying the row on every increment. |
| X5 | `system_versioning_asof` gives every plain `SELECT` an implicit `AS OF` (an explicit `FOR SYSTEM_TIME` overrides it; DML is unaffected). The documentation says to reset the session value with the **quoted** string `'DEFAULT'`; on 13.0.2 that fails with **error 1231** and the old value stays, so current rows remain invisible. The unquoted keyword `DEFAULT` works. | A documentation error that silently hides all current data for the rest of the session. |
| X6 | `UPDATE … FOR PORTION OF` splits one row into up to three (before / changed / after); on a versioned table the original survives as one history version. | The `UPDATE` counterpart of the `DELETE … FOR PORTION OF` the ingestion uses. |
| X7 | `ALTER TABLE … ADD SYSTEM VERSIONING` starts recording from that moment; `DROP SYSTEM VERSIONING` keeps only the current rows. | The bluntest retention tool: all history is discarded. |
| X8 | `TRUNCATE` on a versioned table → error **4137** and the history stays. The documentation also says "TRUNCATE TABLE drops all historical records", which does not hold. | Purge with `DELETE HISTORY` or partition drops instead. |
| X9 | Under one session timestamp: `INSERT` + `UPDATE` leave no zero-length version for the first value, but a following `DELETE` keeps the last value as a zero-length version (`row_start = row_end`). | Replays must expect zero-length versions after deletes, not after updates. |

## Partitioning

| # | Behaviour | Consequence |
|---|---|---|
| P1 | `PARTITION BY SYSTEM_TIME INTERVAL 1 YEAR STARTS … AUTO` creates new history partitions on demand, **also** when the session clock is set into the past (`SET timestamp`); history rows are routed by their `row_end` value, even when the replay order is not chronological. | `page_mirror` gets one partition per year automatically. |
| P2 | Partition pruning: queries without `FOR SYSTEM_TIME` read only the `CURRENT` partition; `AS OF T` prunes history partitions whose upper bound is `<= T` (they only contain rows that ended before `T`). Pruning also happens for prepared statements with a parameter. | Pruning is **asymmetric**: recent instants touch few partitions, old instants touch almost all. Measured in `docs/benchmarking.md`. |
| P3 | Explicit partition selection cannot be combined with a temporal clause: `SELECT … FROM t PARTITION (p0) FOR SYSTEM_TIME ALL` → error 4142 "does not support historical query". `SELECT … FROM t PARTITION (p0)` returns the history rows of that partition. | Used for per-partition row counts. |
| P4 | Partitioned InnoDB tables cannot take part in FOREIGN KEYs: as child → error 1506 "Partitioned tables do not support FOREIGN KEY"; as parent → error 1005 (errno 150 "Foreign key constraint is incorrectly formed"). Verified on `page_mirror`. | The FK-protected `article_history` is not partitioned; `page_mirror` (a rebuildable projection) is. |
| P5 | Unique keys of a table partitioned by SYSTEM_TIME implicitly include `row_end`; `WITHOUT OVERLAPS` still works. | — |
| P6 | Retention: old history can be removed with `DELETE HISTORY … BEFORE SYSTEM_TIME` (row by row) or `ALTER TABLE … DROP PARTITION` (whole files). | Timed in the benchmark. |

## Privileges and operations

* `DELETE HISTORY` is a separate privilege (included in `ALL PRIVILEGES` on a database). The web tier's
  account has only `SELECT`, so it can neither modify data nor purge history (e2e test).
* `information_schema.INNODB_SYS_TABLESPACES` (real file sizes) needs the global `PROCESS` privilege; the
  benchmark reports file sizes only when run with such an account and otherwise falls back to
  `information_schema.TABLES` estimates.
* Named locks (`GET_LOCK`) are server-wide; the ingestion lock is therefore scoped by `DATABASE()`.
