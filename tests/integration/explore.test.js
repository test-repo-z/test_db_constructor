// Every claim made by `npm run explore` (and repeated in docs/mariadb-13-findings.md) is asserted here
// against the real MariaDB server, so a server upgrade that changes the behaviour fails the build.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from '../../src/db/pool.js';
import { EXPERIMENTS, runExperiments } from '../../src/explore/experiments.js';
import { resetTestDatabase, TEST_DB } from '../helpers/db.js';

let conn;
let reports;
before(async () => {
  await resetTestDatabase();
  conn = await createConnection({ database: TEST_DB });
  reports = await runExperiments(conn);
});
after(() => conn?.end());

for (const e of EXPERIMENTS) {
  test(`explore: ${e.title}`, () => {
    const r = reports.find((x) => x.id === e.id);
    assert.ok(r.claims.length > 0, 'experiment made claims');
    for (const c of r.claims) assert.ok(c.ok, `${c.text} — observed: ${JSON.stringify(c.observed)}`);
  });
}

test('explore: no scratch tables are left behind', async () => {
  const rows = await conn.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'explore\\_%'");
  assert.deepEqual(rows, []);
});
