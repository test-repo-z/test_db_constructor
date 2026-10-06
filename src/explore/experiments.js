// Self-checking experiments on the parts of MariaDB's temporal feature set that the time machine itself does
// not need: transaction-precise history, column exclusion, system_versioning_asof, UPDATE … FOR PORTION OF,
// ADD/DROP SYSTEM VERSIONING, TRUNCATE, and same-timestamp DML. Each experiment records the statements it ran,
// what came back, and claims that are checked against the server. `npm run explore` prints them;
// tests/integration/explore.test.js asserts every claim, so the documentation cannot drift from the server.
//
// Every experiment creates its own `explore_*` table and drops it afterwards.

import { ident } from '../db/sql.js';

const SCRATCH_TABLES = Object.freeze(['explore_trx', 'explore_ts', 'explore_col', 'explore_asof', 'explore_upd', 'explore_add', 'explore_tr', 'explore_zero']);

class Recorder {
  constructor(conn, id, title, why) {
    Object.assign(this, { conn, id, title, why, steps: [], claims: [] });
  }

  async run(sql, params = []) {
    try {
      const r = await this.conn.query(sql, params);
      const result = Array.isArray(r) ? r : { affectedRows: r.affectedRows };
      this.steps.push({ sql, params, result });
      return result;
    } catch (e) {
      const error = { errno: e.errno, code: e.code, message: e.sqlMessage ?? e.message.split('\n')[0] };
      this.steps.push({ sql, params, error });
      return { error };
    }
  }

  claim(text, ok, observed) {
    this.claims.push({ text, ok: Boolean(ok), observed });
  }

  report() {
    const { id, title, why, steps, claims } = this;
    return { id, title, why, steps, claims };
  }
}

const count = async (rec, sql) => Number((await rec.run(sql))[0]?.n);

export const EXPERIMENTS = [
  {
    id: 'trx-precise',
    title: 'Transaction-precise history (BIGINT UNSIGNED row start/end)',
    why: 'Timestamp versioning stamps every statement; transaction-precise versioning stamps the commit, so a version is what another transaction could actually see.',
    async run(rec) {
      await rec.run(`CREATE TABLE explore_trx (id INT PRIMARY KEY, v INT,
        trx_start BIGINT UNSIGNED GENERATED ALWAYS AS ROW START,
        trx_end   BIGINT UNSIGNED GENERATED ALWAYS AS ROW END,
        PERIOD FOR SYSTEM_TIME (trx_start, trx_end)) ENGINE=InnoDB WITH SYSTEM VERSIONING`);
      await rec.run('INSERT INTO explore_trx (id, v) VALUES (1, 10)');
      await rec.conn.beginTransaction();
      await rec.run('UPDATE explore_trx SET v = 11 WHERE id = 1');
      await rec.run('UPDATE explore_trx SET v = 12 WHERE id = 1');
      await rec.conn.commit();
      const versions = await rec.run('SELECT v, trx_start, trx_end FROM explore_trx FOR SYSTEM_TIME ALL ORDER BY trx_start');
      rec.claim('two UPDATEs inside one transaction produce ONE history version (v=11 is never recorded)',
        versions.length === 2 && versions.map((r) => r.v).join(',') === '10,12', versions.map((r) => r.v));

      // Same experiment on a TIMESTAMP-versioned table for contrast.
      await rec.run('CREATE TABLE explore_ts (id INT PRIMARY KEY, v INT) WITH SYSTEM VERSIONING');
      await rec.run('INSERT INTO explore_ts VALUES (1, 10)');
      await rec.conn.beginTransaction();
      await rec.run('UPDATE explore_ts SET v = 11 WHERE id = 1');
      await rec.run('UPDATE explore_ts SET v = 12 WHERE id = 1');
      await rec.conn.commit();
      const tsVersions = await rec.run('SELECT v FROM explore_ts FOR SYSTEM_TIME ALL ORDER BY row_start');
      rec.claim('the same two UPDATEs on a TIMESTAMP-versioned table produce a version per statement (10, 11, 12)',
        tsVersions.map((r) => r.v).join(',') === '10,11,12', tsVersions.map((r) => r.v));

      const asOf = await rec.run('SELECT v FROM explore_trx FOR SYSTEM_TIME AS OF TRANSACTION ?', [versions[1].trx_start]);
      rec.claim('FOR SYSTEM_TIME AS OF TRANSACTION <id> returns the state committed by that transaction', asOf[0]?.v === 12, asOf);

      const part = await rec.run('ALTER TABLE explore_trx PARTITION BY SYSTEM_TIME (PARTITION ph HISTORY, PARTITION pc CURRENT)');
      rec.claim('PARTITION BY SYSTEM_TIME is refused for transaction-precise tables (error 4110)', part.error?.errno === 4110, part.error);

      await rec.run("SET timestamp = UNIX_TIMESTAMP('2020-01-01 00:00:00')");
      await rec.run('UPDATE explore_trx SET v = 14 WHERE id = 1');
      await rec.run('SET timestamp = DEFAULT');
      const [forgedVersion] = await rec.run('SELECT trx_start FROM explore_trx');
      const reg = await rec.run(
        'SELECT transaction_id, commit_timestamp FROM mysql.transaction_registry WHERE transaction_id IN (?, ?) ORDER BY transaction_id',
        [versions[1].trx_start, forgedVersion.trx_start]);
      if (reg.error) {
        rec.claim('mysql.transaction_registry is readable (needs GRANT SELECT ON mysql.transaction_registry, see db/init)', false, reg.error);
      } else {
        const [earlier, forged] = reg;
        rec.claim('AS OF TIMESTAMP on a transaction-precise table goes through mysql.transaction_registry, which records the SESSION clock: '
          + 'a transaction run under SET timestamp = 2020-01-01 is registered as committed in 2020, after a transaction registered today',
          forged?.commit_timestamp?.startsWith('2020-01-01') && forged.transaction_id > earlier.transaction_id
          && earlier.commit_timestamp > forged.commit_timestamp, reg);
      }
      await rec.run('DROP TABLE explore_trx, explore_ts');
    },
  },
  {
    id: 'column-exclusion',
    title: 'Excluding a column from versioning (WITHOUT SYSTEM VERSIONING)',
    why: 'A hot counter on a versioned row would otherwise copy the whole row on every increment.',
    async run(rec) {
      await rec.run('CREATE TABLE explore_col (id INT PRIMARY KEY, title VARCHAR(50), views INT WITHOUT SYSTEM VERSIONING) WITH SYSTEM VERSIONING');
      await rec.run("INSERT INTO explore_col VALUES (1, 'a', 0)");
      await rec.run('UPDATE explore_col SET views = views + 1 WHERE id = 1');
      const afterViews = await count(rec, 'SELECT COUNT(*) AS n FROM explore_col FOR SYSTEM_TIME ALL');
      rec.claim('updating only the excluded column creates no history version', afterViews === 1, afterViews);
      await rec.run("UPDATE explore_col SET title = 'b' WHERE id = 1");
      const all = await rec.run('SELECT title, views FROM explore_col FOR SYSTEM_TIME ALL ORDER BY row_start');
      rec.claim('a versioned-column update creates a version, and the history copy carries whatever the excluded column held then (its own history is lost)',
        all.length === 2 && all[0].views === 1, all);
      await rec.run('DROP TABLE explore_col');
    },
  },
  {
    id: 'asof-variable',
    title: 'system_versioning_asof: an implicit AS OF for every SELECT',
    why: 'Handy for exploring a past state with unchanged queries — and a trap if it stays set.',
    async run(rec) {
      await rec.run('CREATE TABLE explore_asof (id INT PRIMARY KEY) WITH SYSTEM VERSIONING');
      await rec.run('INSERT INTO explore_asof VALUES (1)');
      await rec.run("SET @@system_versioning_asof = '2000-01-01 00:00:00'");
      const plain = await count(rec, 'SELECT COUNT(*) AS n FROM explore_asof');
      rec.claim('with the variable set, a plain SELECT silently sees the past (here: no rows)', plain === 0, plain);
      const explicit = await count(rec, 'SELECT COUNT(*) AS n FROM explore_asof FOR SYSTEM_TIME ALL');
      rec.claim('an explicit FOR SYSTEM_TIME clause overrides it', explicit === 1, explicit);
      const dml = await rec.run('UPDATE explore_asof SET id = 1 WHERE id = 1');
      rec.claim('DML is not affected (it still sees and changes the current row)', dml.affectedRows === 1, dml);
      const quoted = await rec.run("SET @@session.system_versioning_asof = 'DEFAULT'");
      rec.claim("documentation says to reset the session value with the quoted string 'DEFAULT'; on 13.0.2 that is rejected (error 1231) and the old value stays",
        quoted.error?.errno === 1231, quoted.error);
      const stillPast = await count(rec, 'SELECT COUNT(*) AS n FROM explore_asof');
      rec.claim('after the failed reset, current rows are still invisible', stillPast === 0, stillPast);
      await rec.run('SET @@system_versioning_asof = DEFAULT');
      const back = await count(rec, 'SELECT COUNT(*) AS n FROM explore_asof');
      rec.claim('the unquoted keyword DEFAULT (= the global value) is what restores normal behaviour', back === 1, back);
      await rec.run('DROP TABLE explore_asof');
    },
  },
  {
    id: 'update-portion',
    title: 'UPDATE … FOR PORTION OF on an application-time period',
    why: 'Changing a value for part of a validity interval splits the row; on a versioned table the original survives in history.',
    async run(rec) {
      await rec.run('CREATE TABLE explore_upd (id INT, v VARCHAR(10), f DATE NOT NULL, t DATE NOT NULL, PERIOD FOR p (f, t)) WITH SYSTEM VERSIONING');
      await rec.run("INSERT INTO explore_upd VALUES (1, 'a', '2022-01-01', '2022-12-31')");
      await rec.run("UPDATE explore_upd FOR PORTION OF p FROM '2022-04-01' TO '2022-06-01' SET v = 'b' WHERE id = 1");
      const cur = await rec.run('SELECT v, f, t FROM explore_upd ORDER BY f');
      rec.claim('one row becomes three: [Jan, Apr) a, [Apr, Jun) b, [Jun, Dec) a',
        cur.map((r) => `${r.v}:${r.f}..${r.t}`).join(' ') === 'a:2022-01-01..2022-04-01 b:2022-04-01..2022-06-01 a:2022-06-01..2022-12-31', cur);
      const hist = await count(rec, "SELECT COUNT(*) AS n FROM explore_upd FOR SYSTEM_TIME ALL WHERE row_end < TIMESTAMP'2106-02-07 06:28:15.999999'");
      rec.claim('the original full-year row is kept as one system-history version', hist === 1, hist);
      await rec.run('DROP TABLE explore_upd');
    },
  },
  {
    id: 'add-drop',
    title: 'ALTER TABLE … ADD / DROP SYSTEM VERSIONING',
    why: 'Versioning can be switched on for an existing table — and switching it off is the bluntest way to discard history.',
    async run(rec) {
      await rec.run('CREATE TABLE explore_add (id INT PRIMARY KEY, v INT)');
      await rec.run('INSERT INTO explore_add VALUES (1, 1)');
      await rec.run('ALTER TABLE explore_add ADD SYSTEM VERSIONING');
      await rec.run('UPDATE explore_add SET v = 2');
      const v = await count(rec, 'SELECT COUNT(*) AS n FROM explore_add FOR SYSTEM_TIME ALL');
      rec.claim('ADD SYSTEM VERSIONING on an existing table starts recording from that moment', v === 2, v);
      await rec.run('ALTER TABLE explore_add DROP SYSTEM VERSIONING');
      const rows = await rec.run('SELECT * FROM explore_add');
      rec.claim('DROP SYSTEM VERSIONING keeps only the current rows: all history is gone', rows.length === 1 && rows[0].v === 2, rows);
      await rec.run('DROP TABLE explore_add');
    },
  },
  {
    id: 'truncate',
    title: 'TRUNCATE on a system-versioned table',
    why: 'The documentation says both that TRUNCATE "drops all historical records" and that it raises error 4137.',
    async run(rec) {
      await rec.run('CREATE TABLE explore_tr (id INT PRIMARY KEY, v INT) WITH SYSTEM VERSIONING');
      await rec.run('INSERT INTO explore_tr VALUES (1, 1)');
      await rec.run('UPDATE explore_tr SET v = 2');
      const t = await rec.run('TRUNCATE TABLE explore_tr');
      rec.claim('TRUNCATE is refused with error 4137 (the "drops all historical records" sentence does not hold)', t.error?.errno === 4137, t.error);
      const n = await count(rec, 'SELECT COUNT(*) AS n FROM explore_tr FOR SYSTEM_TIME ALL');
      rec.claim('history is intact after the refused TRUNCATE; DELETE HISTORY is the way to purge it', n === 2, n);
      await rec.run('DROP TABLE explore_tr');
    },
  },
  {
    id: 'same-timestamp',
    title: 'INSERT, UPDATE and DELETE at the same session timestamp',
    why: 'Matters to any replay: which zero-length versions does MariaDB keep?',
    async run(rec) {
      await rec.run('CREATE TABLE explore_zero (id INT PRIMARY KEY, v INT) WITH SYSTEM VERSIONING');
      await rec.run("SET timestamp = UNIX_TIMESTAMP('2024-01-01 00:00:00')");
      await rec.run('INSERT INTO explore_zero VALUES (1, 1)');
      await rec.run('UPDATE explore_zero SET v = 2');
      await rec.run('DELETE FROM explore_zero');
      await rec.run('SET timestamp = DEFAULT');
      const all = await rec.run('SELECT v, row_start, row_end FROM explore_zero FOR SYSTEM_TIME ALL');
      rec.claim('the same-timestamp UPDATE left no zero-length version for v=1 …', !all.some((r) => r.v === 1), all.map((r) => r.v));
      rec.claim('… but the same-timestamp DELETE kept v=2 as a zero-length version (row_start = row_end)',
        all.length === 1 && all[0].v === 2 && all[0].row_start === all[0].row_end, all);
      await rec.run('DROP TABLE explore_zero');
    },
  },
];

/** Runs all experiments on `conn` (a dedicated connection; session variables are changed). */
export async function runExperiments(conn, { only } = {}) {
  const reports = [];
  for (const e of EXPERIMENTS) {
    if (only && !only.includes(e.id)) continue;
    const rec = new Recorder(conn, e.id, e.title, e.why);
    try {
      await e.run(rec);
    } catch (err) {
      rec.claim(`experiment completed without an unexpected error`, false, err.message);
    } finally {
      await conn.query('SET timestamp = DEFAULT').catch(() => {});
      await conn.query('SET @@system_versioning_asof = DEFAULT').catch(() => {});
      for (const t of SCRATCH_TABLES) {
        await conn.query(`DROP TABLE IF EXISTS ${ident(t, SCRATCH_TABLES)}`).catch(() => {});
      }
    }
    reports.push(rec.report());
  }
  return reports;
}
