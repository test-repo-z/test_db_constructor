// Data-integrity validation. Each check returns { name, level, ok, detail }.
//   level 'error' -> a failed check makes the whole validation fail (non-zero exit code)
//   level 'warn'  -> reported, does not fail
// SQL checks deliberately recompute invariants that constraints already enforce:
// validation must also catch corruption that bypassed the application.
import fs from 'node:fs';
import { config, resolvePath } from '../config/index.js';
import { validateCuratedList, summarize as summarizeManifest, USABLE_STATUSES } from '../wikipedia/resolution.js';
import { INFINITY, datasetCoverage, toSql, sqlToDate } from '../temporal/time.js';
import { decompressChunk, extractText } from '../content/chunks.js';

export const SYSTEM_MAX = '2106-02-07 06:28:15.999999'; // row_end of current rows in MariaDB >= 11.5 (64-bit TIMESTAMP)

const check = (name, level, ok, detail) => ({ name, level, ok: Boolean(ok), detail });

export function sourceChecks() {
  const out = [];
  const curated = JSON.parse(fs.readFileSync(resolvePath(config.sources.articles), 'utf8'));
  const problems = validateCuratedList(curated, config.sources.expectedArticleCount);
  out.push(check('curated list: structure, count and unique titles', 'error', problems.length === 0,
    problems.length ? problems.join('; ') : `${curated.length} curated articles, no duplicate titles`));

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(resolvePath(config.sources.resolved), 'utf8'));
  } catch {
    out.push(check('resolution manifest exists', 'error', false, `${config.sources.resolved} missing — run npm run resolve-articles`));
    return { out, curated, manifest };
  }
  const sameOrder = manifest.articles.length === curated.length &&
    manifest.articles.every((a, i) => a.requested_title === curated[i].title && a.domain === curated[i].domain);
  out.push(check('manifest covers every curated title, same order and domain (curated list not altered)', 'error', sameOrder,
    sameOrder ? 'ok' : 'manifest and curated list differ — re-run npm run resolve-articles'));
  const s = summarizeManifest(manifest.articles);
  out.push(check('resolution status counts', 'warn', s.missing + s.error === 0,
    `requested ${s.requested}: resolved ${s.resolved}, redirect ${s.redirect}, missing ${s.missing}, ` +
    `disambiguation ${s.disambiguation}, duplicate ${s.duplicate}, error ${s.error}; usable ${s.usable}`));
  const usable = manifest.articles.filter((a) => USABLE_STATUSES.includes(a.status));
  const pageIds = usable.map((a) => a.page_id);
  out.push(check('no duplicate page ids among usable articles', 'error', new Set(pageIds).size === pageIds.length,
    `${pageIds.length} usable articles, ${new Set(pageIds).size} distinct page ids`));
  return { out, curated, manifest };
}

async function one(pool, sql, params = []) {
  const rows = await pool.query(sql, params);
  return rows[0];
}

export async function databaseChecks(pool, { curated, manifest, sampleTexts = 200, sampleInstants = 400 } = {}) {
  const out = [];
  const add = (...a) => out.push(check(...a));

  // --- system versioning metadata -----------------------------------------------------
  const versioned = await pool.query(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'SYSTEM VERSIONED' ORDER BY 1");
  const vset = new Set(versioned.map((r) => r.t));
  const expectedVersioned = ['article_history', 'article_sync_state', 'articles', 'page_mirror'];
  add('system versioning enabled on expected tables', 'error', expectedVersioned.every((t) => vset.has(t)),
    `SYSTEM VERSIONED: ${[...vset].join(', ')}`);
  const periods = await pool.query(
    "SELECT TABLE_NAME AS t, PERIOD_NAME AS p FROM information_schema.PERIODS WHERE TABLE_SCHEMA = DATABASE() ORDER BY 1, 2").catch(() => null);
  if (periods) {
    const hasApp = periods.some((r) => r.t === 'article_history' && r.p === 'valid_period');
    add('application-time period valid_period declared on article_history', 'error', hasApp,
      periods.map((r) => `${r.t}.${r.p}`).join(', '));
  }
  const parts = await pool.query(
    "SELECT PARTITION_NAME AS p, PARTITION_DESCRIPTION AS d, TABLE_ROWS AS n FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'page_mirror' ORDER BY PARTITION_ORDINAL_POSITION");
  add('page_mirror partitioned BY SYSTEM_TIME (history + current partitions)', 'error',
    parts.length >= 2 && parts.some((p) => p.d === 'CURRENT'), parts.map((p) => `${p.p}(${p.d})`).join(' '));

  // --- articles -----------------------------------------------------------------------
  const art = await one(pool, `SELECT COUNT(*) AS n,
      SUM(resolution_status IN ('resolved','redirect')) AS usable,
      SUM(resolution_status IN ('resolved','redirect') AND (page_id IS NULL OR canonical_url IS NULL)) AS incomplete
    FROM articles`);
  if (curated) add('every curated title has an articles row', 'error', art.n === curated.length, `${art.n} rows for ${curated.length} curated titles`);
  if (manifest) {
    const rows = await pool.query('SELECT requested_title, resolution_status, page_id FROM articles');
    const byTitle = new Map(rows.map((r) => [r.requested_title, r]));
    const mismatch = manifest.articles.filter((a) => byTitle.get(a.requested_title)?.resolution_status !== a.status);
    add('articles table matches resolution manifest', 'error', mismatch.length === 0,
      mismatch.length ? `differs for: ${mismatch.slice(0, 5).map((m) => m.requested_title).join(', ')}` : `${rows.length} rows consistent`);
  }
  add('usable articles have page id and canonical URL', 'error', !art.incomplete, `${art.usable} usable, ${art.incomplete ?? 0} incomplete`);
  const dupPages = await one(pool, `SELECT COUNT(*) AS n FROM (SELECT owned_page_id FROM articles WHERE owned_page_id IS NOT NULL GROUP BY owned_page_id HAVING COUNT(*) > 1) d`);
  add('no duplicate page ids in articles', 'error', dupPages.n === 0, `${dupPages.n} duplicated page ids`);

  // --- revisions ----------------------------------------------------------------------
  const rev = await one(pool, `SELECT COUNT(*) AS n, COUNT(DISTINCT rev_id) AS distinct_ids, COUNT(DISTINCT article_id) AS articles,
      SUM(content_status = 'available') AS available, SUM(content_status = 'hidden') AS hidden, SUM(is_baseline) AS baselines,
      MIN(rev_timestamp) AS first_ts, MAX(rev_timestamp) AS last_ts FROM revisions`);
  add('revision count', 'warn', rev.n > 0,
    `${rev.n} revisions of ${rev.articles} articles (${rev.available} with text, ${rev.hidden} hidden by Wikipedia, ${rev.baselines} baseline); ${rev.first_ts} .. ${rev.last_ts}`);
  add('no duplicate revision ids', 'error', rev.n === rev.distinct_ids, `${rev.n} rows, ${rev.distinct_ids} distinct`);
  const cov = datasetCoverage();
  const outOfWindow = await one(pool,
    'SELECT COUNT(*) AS n FROM revisions WHERE is_baseline = FALSE AND (rev_timestamp < ? OR rev_timestamp > ?)', [cov.startSql, cov.endSql]);
  add('non-baseline revisions lie inside the configured window', 'error', outOfWindow.n === 0, `${outOfWindow.n} outside`);
  const orphanRev = await one(pool, 'SELECT COUNT(*) AS n FROM revisions r LEFT JOIN articles a ON a.article_id = r.article_id WHERE a.article_id IS NULL');
  add('foreign keys: revisions -> articles', 'error', orphanRev.n === 0, `${orphanRev.n} orphans`);
  const orphanText = await one(pool, `SELECT COUNT(*) AS n FROM revisions r LEFT JOIN revision_texts t ON t.sha1 = r.sha1
    WHERE r.content_status = 'available' AND t.sha1 IS NULL`);
  add('content availability: every available revision has a stored text', 'error', orphanText.n === 0, `${orphanText.n} missing texts`);
  const usableNoRev = await one(pool, `SELECT COUNT(*) AS n FROM articles a WHERE a.resolution_status IN ('resolved','redirect')
    AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.article_id = a.article_id)`);
  add('every usable article has revisions', 'warn', usableNoRev.n === 0, `${usableNoRev.n} usable articles without revisions (not ingested yet?)`);

  // --- application-time timeline (current system time) ---------------------------------
  const tl = await one(pool, `
    WITH t AS (
      SELECT article_id, rev_id, valid_from, valid_to,
             LEAD(valid_from) OVER (PARTITION BY article_id ORDER BY valid_from) AS next_from
      FROM article_history)
    SELECT COUNT(*) AS rows_total,
           SUM(valid_from >= valid_to) AS empty_or_reversed,
           SUM(next_from IS NOT NULL AND valid_to > next_from) AS overlaps,
           SUM(next_from IS NOT NULL AND valid_to < next_from) AS gaps,
           SUM(next_from IS NULL AND valid_to <> ?) AS last_not_open,
           SUM(next_from IS NOT NULL AND valid_to = ?) AS open_not_last
    FROM t`, [INFINITY, INFINITY]);
  add('application time: valid_from < valid_to', 'error', !tl.empty_or_reversed, `${tl.empty_or_reversed ?? 0} bad of ${tl.rows_total}`);
  add('application time: no overlapping intervals per article', 'error', !tl.overlaps, `${tl.overlaps ?? 0} overlaps`);
  add('application time: no gaps between consecutive intervals', 'error', !tl.gaps, `${tl.gaps ?? 0} gaps`);
  add('application time: last interval open-ended (logical infinity), only the last', 'error',
    !tl.last_not_open && !tl.open_not_last, `${tl.last_not_open ?? 0} last-not-open, ${tl.open_not_last ?? 0} open-not-last`);

  const fromMismatch = await one(pool, `SELECT COUNT(*) AS n FROM article_history h JOIN revisions r ON r.rev_id = h.rev_id
    WHERE h.valid_from <> r.rev_timestamp OR h.article_id <> r.article_id`);
  add('valid_from equals the Wikipedia revision timestamp (application time = Wikipedia time)', 'error', fromMismatch.n === 0, `${fromMismatch.n} mismatches`);

  const toMismatch = await one(pool, `
    WITH t AS (SELECT h.rev_id, h.valid_to,
                 LEAD(h.valid_from) OVER (PARTITION BY h.article_id ORDER BY h.valid_from) AS next_from
               FROM article_history h)
    SELECT COUNT(*) AS n FROM t WHERE next_from IS NOT NULL AND valid_to <> next_from`);
  add('valid_to equals the next revision timestamp (temporal ordering)', 'error', toMismatch.n === 0, `${toMismatch.n} mismatches`);

  const unaccounted = await one(pool, `SELECT COUNT(*) AS n FROM revisions r
    WHERE NOT EXISTS (SELECT 1 FROM article_history h WHERE h.rev_id = r.rev_id)
      AND NOT EXISTS (SELECT 1 FROM revisions r2 WHERE r2.article_id = r.article_id
                       AND r2.rev_timestamp = r.rev_timestamp AND r2.rev_id > r.rev_id)`);
  const shadowed = await one(pool, `SELECT COUNT(*) AS n FROM revisions r
    WHERE NOT EXISTS (SELECT 1 FROM article_history h WHERE h.rev_id = r.rev_id)`);
  add('every revision is on the timeline or shadowed by a same-second successor', 'error', unaccounted.n === 0,
    `${unaccounted.n} unaccounted; ${shadowed.n} shadowed (empty interval at 1 s resolution)`);

  const coverage = await one(pool, `SELECT COUNT(*) AS articles, SUM(first_from > ?) AS start_late FROM
      (SELECT article_id, MIN(valid_from) AS first_from FROM article_history GROUP BY article_id) f`, [cov.startSql]);
  add('every ingested article has a revision valid at the window start', 'warn', !coverage.start_late,
    `${coverage.articles} articles; ${coverage.start_late ?? 0} created after the window start`);

  // --- system time ----------------------------------------------------------------------
  const sys = await one(pool, `SELECT SUM(row_end = ?) AS current_rows, SUM(row_end < ?) AS history_rows,
      SUM(row_start >= row_end) AS bad FROM article_history FOR SYSTEM_TIME ALL`, [SYSTEM_MAX, SYSTEM_MAX]);
  add('system time: row_start < row_end for every row version of article_history', 'error', !sys.bad,
    `${sys.current_rows} current rows, ${sys.history_rows} history rows (superseded beliefs)`);
  const curCount = await one(pool, 'SELECT COUNT(*) AS n FROM article_history');
  add('system time: current rows equal FOR SYSTEM_TIME ALL rows with row_end = max', 'error', curCount.n === sys.current_rows,
    `${curCount.n} vs ${sys.current_rows}`);
  const histOrphan = await one(pool, `SELECT COUNT(*) AS n FROM article_history FOR SYSTEM_TIME ALL h
    LEFT JOIN revisions r ON r.rev_id = h.rev_id WHERE r.rev_id IS NULL`);
  add('system history references existing revisions', 'error', histOrphan.n === 0, `${histOrphan.n} orphans`);
  const cps = await pool.query('SELECT checkpoint_id, synced_through, completed_at FROM sync_checkpoints ORDER BY checkpoint_id');
  const cpOk = cps.every((c, i) => i === 0 || c.completed_at >= cps[i - 1].completed_at);
  add('sync checkpoints are ordered in system time', 'error', cpOk, `${cps.length} checkpoints`);

  const sync = await one(pool, `SELECT COUNT(*) AS n, SUM(s.synced_through IS NULL OR s.synced_through < ?) AS behind FROM articles a
    LEFT JOIN article_sync_state s ON s.article_id = a.article_id WHERE a.resolution_status IN ('resolved','redirect')`, [cov.endSql]);
  add('all usable articles synchronised to the window end', 'warn', !sync.behind, `${sync.behind ?? 0} of ${sync.n} behind`);

  // --- content integrity (sampled) ------------------------------------------------------
  const sample = await pool.query(`SELECT t.sha1, t.byte_offset, t.byte_length, t.chunk_id FROM revision_texts t
     ORDER BY CRC32(t.sha1) LIMIT ?`, [sampleTexts]);
  let bad = 0;
  const cache = new Map();
  for (const s of sample) {
    try {
      if (!cache.has(s.chunk_id)) {
        const [{ payload }] = await pool.query('SELECT payload FROM content_chunks WHERE chunk_id = ?', [s.chunk_id]);
        cache.clear();
        cache.set(s.chunk_id, decompressChunk(payload));
      }
      extractText(cache.get(s.chunk_id), s);
    } catch { bad++; }
  }
  add(`content integrity: ${sample.length} sampled texts decompress and match their SHA-1`, 'error', bad === 0, `${bad} corrupt`);

  // --- cross-check: application time vs. replayed system time --------------------------
  const replay = await one(pool, "SELECT replay_id, finished_at FROM mirror_replays WHERE status = 'succeeded' ORDER BY replay_id DESC LIMIT 1");
  if (!replay) {
    add('page_mirror replay agrees with article_history', 'warn', false, 'no successful replay yet — run npm run replay-mirror');
  } else {
    const probes = await pool.query(`SELECT h.article_id, h.valid_from AS t FROM article_history h
       WHERE h.valid_from >= ? ORDER BY CRC32(CONCAT(h.article_id, '-', h.rev_id)) LIMIT ?`, [cov.startSql, sampleInstants]);
    let disagree = 0;
    for (const p of probes) {
      // Probe exactly on an interval boundary (the strictest case) and one second before it.
      for (const instant of [p.t, toSql(new Date(sqlToDate(p.t).getTime() - 1000))]) {
        const [a] = await pool.query(
          'SELECT rev_id FROM article_history WHERE article_id = ? AND valid_from <= ? AND valid_to > ?',
          [p.article_id, instant, instant]);
        const [b] = await pool.query(
          'SELECT rev_id FROM page_mirror FOR SYSTEM_TIME AS OF TIMESTAMP ? WHERE article_id = ?', [instant, p.article_id]);
        if ((a?.rev_id ?? null) !== (b?.rev_id ?? null)) disagree++;
      }
    }
    add(`application-time lookup and system-time replay agree on ${probes.length * 2} probes`, 'error', disagree === 0,
      `${disagree} disagreements (replay #${replay.replay_id})`);
  }
  return out;
}

export async function runAllChecks(pool, opts = {}) {
  const { out, curated, manifest } = sourceChecks();
  const db = await databaseChecks(pool, { curated, manifest, ...opts });
  const checks = [...out, ...db];
  return { ok: checks.every((c) => c.ok || c.level !== 'error'), checks };
}
