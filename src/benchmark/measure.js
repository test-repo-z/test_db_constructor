// Measurement primitives for the benchmark: deterministic randomness, latency statistics,
// server-side handler counters ("rows touched" proxy) and query plans.

/** Deterministic PRNG (mulberry32) so that every run uses the same query workload. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(latenciesMs) {
  const s = [...latenciesMs].sort((a, b) => a - b);
  const mean = s.reduce((x, y) => x + y, 0) / (s.length || 1);
  const r = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  return { n: s.length, min: r(s[0]), median: r(percentile(s, 50)), p95: r(percentile(s, 95)), p99: r(percentile(s, 99)), max: r(s.at(-1)), mean: r(mean) };
}

const HANDLER_KEYS = ['Handler_read_first', 'Handler_read_key', 'Handler_read_last', 'Handler_read_next', 'Handler_read_prev', 'Handler_read_rnd', 'Handler_read_rnd_next'];

export async function handlerCounters(conn) {
  const rows = await conn.query("SHOW SESSION STATUS WHERE Variable_name LIKE 'Handler_read%'");
  const m = Object.fromEntries(rows.map((r) => [r.Variable_name, Number(r.Value)]));
  return Object.fromEntries(HANDLER_KEYS.map((k) => [k, m[k] ?? 0]));
}

const diff = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - a[k]]));
const total = (d) => Object.values(d).reduce((x, y) => x + y, 0);

/**
 * Runs `sql` once per parameter set, `reps` times (after one un-timed warm-up pass), on one connection
 * using the binary protocol (server-side prepared statement, cached by the connector).
 * Returns latency stats, the result of the first pass (for correctness checks) and handler-read deltas
 * per execution (corrected for the cost of reading the counters themselves).
 */
export async function measure(conn, sql, paramSets, { reps = 3, warmup = true } = {}) {
  if (warmup) for (const p of paramSets) await conn.execute(sql, p);
  const c0 = await handlerCounters(conn);
  const c1 = await handlerCounters(conn); // calibration: cost of SHOW STATUS itself
  const overhead = diff(c0, c1);
  const lat = [];
  const firstResults = [];
  const h0 = await handlerCounters(conn);
  for (let r = 0; r < reps; r++) {
    for (const p of paramSets) {
      const t = process.hrtime.bigint();
      const rows = await conn.execute(sql, p);
      lat.push(Number(process.hrtime.bigint() - t) / 1e6);
      if (r === 0) firstResults.push(rows);
    }
  }
  const h1 = await handlerCounters(conn);
  const d = diff(h0, h1);
  for (const k of Object.keys(d)) d[k] -= overhead[k];
  const execs = reps * paramSets.length;
  return {
    latency: summarize(lat),
    executions: execs,
    handlerReadsPerQuery: Math.round((total(d) / execs) * 100) / 100,
    handlerBreakdownPerQuery: Object.fromEntries(Object.entries(d).filter(([, v]) => v > 0).map(([k, v]) => [k, Math.round((v / execs) * 100) / 100])),
    firstResults,
  };
}

/** EXPLAIN (traditional) + ANALYZE FORMAT=JSON for one representative parameter set. */
export async function plans(conn, sql, params) {
  const explain = await conn.query(`EXPLAIN PARTITIONS ${sql}`, params).catch(() => conn.query(`EXPLAIN ${sql}`, params));
  const analyze = await conn.query(`ANALYZE FORMAT=JSON ${sql}`, params);
  const json = JSON.parse(Object.values(analyze[0])[0]);
  const tables = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.table && node.table.table_name) {
      const t = node.table;
      tables.push({ table: t.table_name, partitions: t.partitions ?? null, access_type: t.access_type, key: t.key ?? null,
        r_loops: t.r_loops, rows_estimate: t.rows ?? null, r_rows: t.r_rows, r_total_time_ms: t.r_table_time_ms ?? t.r_total_time_ms ?? null, filtered: t.filtered, r_filtered: t.r_filtered });
    }
    for (const v of Object.values(node)) if (typeof v === 'object') walk(v);
  })(json);
  return {
    explain: explain.map((r) => ({ table: r.table, partitions: r.partitions ?? null, type: r.type, key: r.key, rows: r.rows, Extra: r.Extra })),
    analyze: { query_time_ms: json.query_block?.r_total_time_ms ?? null, tables },
  };
}
