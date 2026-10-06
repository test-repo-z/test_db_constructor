# Reusable temporal SQL

Plain SQL files with the patterns this project is built on, written to be copied into your own schema.
Every file runs top to bottom with the `mariadb` client. Files 01–04 are **standalone**: they create
`tutorial_*` tables, use them, and drop them again, so they can be run in any database, as often as you like.
File 05 queries the project's own tables (after `npm run demo`).

Column aliases say what each result means (`revision_at_exactly_T2`, `known_at_S`, …), and the comment next to
each query gives the expected value. `tests/integration/sql-files.test.js` runs every file exactly as written and
asserts those values on every CI run.

| File | Shows | Key statements |
|---|---|---|
| [`01_bitemporal_table.sql`](01_bitemporal_table.sql) | a bitemporal table, and "what was valid at T?" with half-open boundaries | `PERIOD FOR`, `WITHOUT OVERLAPS`, `WITH SYSTEM VERSIONING`, the `ORDER BY … DESC LIMIT 1` lookup, `ANALYZE` (1 row read) |
| [`02_closing_intervals_for_portion_of.sql`](02_closing_intervals_for_portion_of.sql) | learning about a newer revision without losing the old belief; changing part of an interval | `DELETE … FOR PORTION OF`, `UPDATE … FOR PORTION OF`, `FOR SYSTEM_TIME ALL` |
| [`03_system_time_queries.sql`](03_system_time_queries.sql) | every system-time query form, with exact boundaries, plus a bitemporal query | `AS OF`, `BETWEEN` vs `FROM … TO`, `ALL`, `system_versioning_asof`, `AS OF S` + application-time predicate |
| [`04_partitioning_and_retention.sql`](04_partitioning_and_retention.sql) | keeping history manageable | `PARTITION BY SYSTEM_TIME INTERVAL … AUTO`, `EXPLAIN PARTITIONS` pruning, `DROP PARTITION`, `DELETE HISTORY` |
| [`05_time_machine_queries.sql`](05_time_machine_queries.sql) | the time machine's own queries on the real data | lookup, bitemporal lookup, mirror cross-check, superseded beliefs, sync checkpoints, history growth |

## Running them

With the project's Docker setup (no password to type, `--table` for readable output):

```bash
docker compose exec -T db sh -c 'mariadb --table -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"' < sql/01_bitemporal_table.sql
```

Against any other MariaDB server (10.11 or later for everything; verified on 13.0.2):

```bash
mariadb --table -u <user> -p <database> < sql/03_system_time_queries.sql
```

File 05 uses the article *Database* and the instant 2023-06-01 unless you set them first:

```bash
( echo "SET @title = 'Black hole', @T = '2024-06-01 00:00:00';"; cat sql/05_time_machine_queries.sql ) \
  | docker compose exec -T db sh -c 'mariadb --table -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE"'
```

## Requirements and caveats

* Files 03 and 04 set the **session clock** (`SET timestamp = …`) so that their system timestamps are reproducible.
  That needs `secure_timestamp = NO`, which is MariaDB's default and is set in `db/conf/time-machine.cnf`. On a server with
  `secure_timestamp = YES` those statements fail, which is the point of that setting.
* `DELETE HISTORY` needs the `DELETE HISTORY` privilege (included in `ALL PRIVILEGES` on a database).
* Current rows end at `2106-02-07 06:28:15.999999` on MariaDB ≥ 11.5. Older servers use `2038-01-19 03:14:07.999999`,
  so adjust the `row_end = …` comparisons there.
* Application time has no `FOR … AS OF` syntax in MariaDB. It is always queried with ordinary predicates.
