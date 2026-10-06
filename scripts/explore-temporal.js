#!/usr/bin/env node
// npm run explore [-- --only=trx-precise,truncate --database=name --json]
// Runs the temporal-feature experiments of src/explore/experiments.js against MariaDB and prints every
// statement, its result and the checked claims. Uses the test database by default (scratch tables only,
// all dropped afterwards). Exit code 1 if a claim no longer holds on this server version.
import { config } from '../src/config/index.js';
import { createConnection } from '../src/db/pool.js';
import { runExperiments } from '../src/explore/experiments.js';
import { isMain, parseArgs } from '../src/lib/cli.js';

function show(value) {
  const s = JSON.stringify(value);
  return s.length > 220 ? `${s.slice(0, 217)}...` : s;
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const conn = await createConnection({ database: args.database || config.db.testDatabase });
  try {
    const [{ v }] = await conn.query('SELECT VERSION() AS v');
    const reports = await runExperiments(conn, { only: args.only ? String(args.only).split(',') : undefined });
    if (args.json) {
      console.log(JSON.stringify({ server: v, reports }, null, 2));
    } else {
      console.log(`MariaDB ${v}\n`);
      for (const r of reports) {
        console.log(`━━ ${r.title} ━━\n   ${r.why}\n`);
        for (const s of r.steps) {
          console.log(`   ${s.sql.replace(/\s+/g, ' ')}${s.params.length ? `   -- params: ${show(s.params)}` : ''}`);
          console.log(`     → ${s.error ? `ERROR ${s.error.errno}: ${s.error.message}` : show(s.result)}`);
        }
        console.log('');
        for (const c of r.claims) console.log(`   [${c.ok ? 'HOLDS' : 'FAILS'}] ${c.text}`);
        console.log('');
      }
    }
    const failed = reports.flatMap((r) => r.claims).filter((c) => !c.ok);
    console.log(failed.length ? `${failed.length} claim(s) no longer hold on this server.` : 'All claims hold on this server.');
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await conn.end();
  }
}
