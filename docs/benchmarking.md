# Benchmark methodology

`npm run benchmark` runs three suites against the ingested database and writes

* `benchmarks/results/<timestamp>.json`: raw results: environment, workload parameters, latency summaries,
  handler counters, `EXPLAIN` and `ANALYZE FORMAT=JSON` output, table sizes, partition layouts;
* `benchmarks/reports/<timestamp>.md` and `benchmarks/reports/latest.md`: the human-readable report, generated
  from the JSON by `src/benchmark/report.js`. No number in the report is typed in by hand.

Options: `--suites=lookup,partition,storage`, `--queries=2000`, `--reps=3`, `--scale=16`,
`--point-queries=500`, `--scan-queries=15`, `--inline-articles=5`, `--keep-tables`.
Run it as a user with the `PROCESS` privilege (e.g. `DB_USER=root DB_PASSWORD=$DB_ROOT_PASSWORD npm run benchmark`)
to include real InnoDB file sizes; otherwise only `information_schema.TABLES` estimates are reported.

## What is measured

| Metric | How |
|---|---|
| Latency (min / median / p95 / p99 / max / mean) | client-side `process.hrtime` around each execution of a **server-side prepared statement** (`conn.execute`, binary protocol) on one dedicated connection |
| Repetitions | each workload is executed once un-timed (warm-up), then `reps` times |
| Rows touched | per-execution delta of the session `Handler_read_*` counters (`read_key`, `read_next`, `read_prev`, `read_first`, `read_last`, `read_rnd`, `read_rnd_next`), corrected for the reads caused by `SHOW STATUS` itself, i.e. the storage-engine reads a query needed. MariaDB has no per-statement "rows examined" status variable outside the slow log and performance schema |
| Plans | `EXPLAIN PARTITIONS` (access type, key, partitions) and `ANALYZE FORMAT=JSON` (`r_rows`, `r_loops`, `r_filtered`, real time) for one representative parameter set per query |
| Correctness | every strategy's answers are compared with the production query's answers on the same workload; partition layouts are compared with the unpartitioned table |
| Sizes | `information_schema.TABLES` (rows, `DATA_LENGTH`, `INDEX_LENGTH` after `ANALYZE TABLE`), `information_schema.INNODB_SYS_TABLESPACES` (`FILE_SIZE`, `ALLOCATED_SIZE`; needs `PROCESS`), exact row counts with `FOR SYSTEM_TIME ALL`, per-partition counts |
| Environment | MariaDB version, buffer pool, page size, `secure_timestamp`, client OS/CPU/RAM, Node version, dataset counts and window |

### Cache conditions

All measurements are **warm-cache**: a warm-up pass precedes every workload, and the whole dataset fits in the
512 MiB buffer pool. Cold-cache behaviour (empty buffer pool, OS page cache) is **not** measured: inside Docker
Desktop the OS cache of the Linux VM cannot be dropped reliably from a test script, and restarting the server
between queries would measure start-up effects instead. This is a stated limitation, not an oversight.

### Workloads

* **Suite 1 (real data):** `--queries` (article, instant) pairs drawn uniformly over the ingested articles and
  over the whole window with a fixed seed (mulberry32, seed 42), so every run and every strategy uses the same
  workload. The strategies are:
  1. the production application-time query (interval predicate + `ORDER BY valid_from DESC LIMIT 1`);
  2. the bare interval predicate (the optimizer chooses the plan);
  3. the interval predicate forced through the `WITHOUT OVERLAPS` index;
  4. no intervals at all: "latest event with `rev_timestamp <= T`" on `revisions` (how MediaWiki answers it);
  5. system time on the partitioned `page_mirror` (`FOR SYSTEM_TIME AS OF T`);
  6. system time on `bench_mirror_flat`, an unpartitioned copy with byte-identical history
     (`system_versioning_insert_history`);
  7. the bitemporal variant: (1) on `article_history FOR SYSTEM_TIME AS OF <checkpoint #1>`.
* **Suite 2 (derived data):** `--scale` copies of the real `page_mirror` history (all row versions), with
  article ids shifted by `k × 1,000,000` using MariaDB's `SEQUENCE` engine (`seq_0_to_N`) and `row_start` /
  `row_end` copied unchanged. **These rows are synthetic** (not real Wikipedia articles), but their temporal
  distribution is that of the real edits. Three tables with identical rows: unpartitioned, `INTERVAL 1 YEAR`
  (8 partitions), `INTERVAL 1 MONTH` (64 partitions). Queries: current point lookup, current-state scan,
  `AS OF` point lookup, `AS OF` scans for early (2021-22) and late (2025-26) instants, a one-month `BETWEEN`,
  `ALL`. Then a retention purge of history before 2023-01-01: `DELETE HISTORY` (unpartitioned), `DROP PARTITION`
  (yearly), `DELETE HISTORY` on the monthly-partitioned table.
* **Suite 3 (real data):** table sizes and row counts, content-store compression, `page_mirror` history per
  partition, and an **inline-text experiment**: the real revisions of 5 articles (chosen at the 10/30/50/70/90 %
  quantiles of total revision bytes) are replayed into two system-versioned tables that store the full text
  in the row (`MEDIUMTEXT`, `MEDIUMTEXT COMPRESSED`), and their sizes are compared with the raw text and with
  this project's chunk store.

## Threats to validity

* One machine, one run: no confidence intervals across runs. Re-run `npm run benchmark` to compare.
* Client-side latency includes the TCP round trip into the Docker Desktop VM (tens to hundreds of
  microseconds); differences smaller than that are not meaningful. Handler counts and `r_rows` are the
  machine-independent signal.
* The stress dataset multiplies articles, not history depth per article; deeper histories would make
  `AS OF` point lookups on unpartitioned tables slower than measured here.
* InnoDB size statistics are page-granular estimates; `ALLOCATED_SIZE` is the real file size.

## Results

See [`benchmarks/reports/latest.md`](../benchmarks/reports/latest.md) for the full generated report and the
summary in the README.
