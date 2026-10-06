#!/usr/bin/env node
// npm run validate [-- --sample-texts=N --sample-instants=N --json]
// Exit code 1 if any check of level "error" fails.
import { createPool } from '../src/db/pool.js';
import { runAllChecks } from '../src/validation/checks.js';
import { isMain, parseArgs } from '../src/lib/cli.js';
import { createLogger } from '../src/lib/logger.js';

const log = createLogger('validate');

export async function runValidation(pool, opts = {}) {
  return runAllChecks(pool, opts);
}

export function printReport(report) {
  console.log('\nValidation report');
  for (const c of report.checks) {
    const mark = c.ok ? 'PASS' : (c.level === 'error' ? 'FAIL' : 'WARN');
    console.log(`  [${mark}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  const failed = report.checks.filter((c) => !c.ok && c.level === 'error').length;
  const warned = report.checks.filter((c) => !c.ok && c.level !== 'error').length;
  console.log(report.ok ? `\nVALIDATION PASSED (${warned} warning(s))` : `\nVALIDATION FAILED: ${failed} error(s), ${warned} warning(s)`);
}

if (isMain(import.meta.url)) {
  const args = parseArgs();
  const pool = createPool({ connectionLimit: 2 });
  runValidation(pool, {
    sampleTexts: args['sample-texts'] ? Number(args['sample-texts']) : undefined,
    sampleInstants: args['sample-instants'] ? Number(args['sample-instants']) : undefined,
  })
    .then((report) => {
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else printReport(report);
      process.exitCode = report.ok ? 0 : 1;
    })
    .catch((err) => { log.error(err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
