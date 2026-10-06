// Replays the stored revision events into page_mirror, in global chronological order, with the
// session clock set to each revision's Wikipedia timestamp:
//
//     SET timestamp = <unix time of the revision>;
//     INSERT INTO page_mirror (...) VALUES (...) ON DUPLICATE KEY UPDATE ...;   -- an UPDATE for edits
//
// MariaDB stamps the new row version with row_start = @@timestamp and closes the previous version
// with row_end = @@timestamp, so after the replay
//
//     SELECT * FROM page_mirror FOR SYSTEM_TIME AS OF TIMESTAMP '2023-05-01 12:00:00'
//
// returns the article states of that moment. This is a SIMULATION of a database that had been
// live on Wikipedia — not the real system history of this project's database (that is what
// article_history's row_start/row_end record). See db/migrations/003_page_mirror.sql.
import { createLogger } from '../lib/logger.js';
import { acquireIngestLock, releaseIngestLock } from './store.js';
import { sqlToDate } from '../temporal/time.js';

const log = createLogger('replay');
const BATCH = 500; // statements per transaction (fewer commits; each statement still gets its own timestamp)

export async function replayMirror(conn) {
  const [{ secure }] = await conn.query('SELECT @@GLOBAL.secure_timestamp AS secure');
  if (secure !== 'NO') {
    throw new Error(`secure_timestamp = ${secure}: this server refuses forged session timestamps, so system time cannot be ` +
      'replayed. Set secure_timestamp = NO (see db/conf/time-machine.cnf) or skip the page_mirror simulation.');
  }
  if (!(await acquireIngestLock(conn))) throw new Error('an ingestion is running; replay later');
  const t0 = Date.now();
  let replayId;
  try {
    replayId = (await conn.query('INSERT INTO mirror_replays () VALUES ()')).insertId;

    // Rebuild from scratch: the mirror is a deterministic projection of `revisions`.
    await conn.query('DELETE FROM page_mirror');
    await conn.query('DELETE HISTORY FROM page_mirror'); // MariaDB-specific: purge system history (needs DELETE HISTORY privilege)

    const revs = await conn.query(
      'SELECT rev_id, article_id, rev_timestamp, sha1, COALESCE(size_bytes, 0) AS size_bytes FROM revisions ORDER BY rev_timestamp, rev_id');
    log.info(`replaying ${revs.length} revisions in chronological order`);

    let applied = 0;
    for (let i = 0; i < revs.length; i += BATCH) {
      await conn.beginTransaction();
      try {
        for (const r of revs.slice(i, i + BATCH)) {
          await conn.query('SET timestamp = ?', [sqlToDate(r.rev_timestamp).getTime() / 1000]);
          await conn.query(
            `INSERT INTO page_mirror (article_id, rev_id, rev_timestamp, sha1, size_bytes) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE rev_id = VALUES(rev_id), rev_timestamp = VALUES(rev_timestamp),
                                     sha1 = VALUES(sha1), size_bytes = VALUES(size_bytes)`,
            [r.article_id, r.rev_id, r.rev_timestamp, r.sha1, r.size_bytes]);
          applied++;
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        await conn.query('SET timestamp = DEFAULT');
      }
      if ((i / BATCH) % 20 === 0) log.info(`replayed ${applied}/${revs.length}`);
    }
    await conn.query('ANALYZE TABLE page_mirror');
    const last = revs.at(-1)?.rev_timestamp ?? null;
    await conn.query(
      "UPDATE mirror_replays SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP(6), revisions_applied = ?, replayed_through = ? WHERE replay_id = ?",
      [applied, last, replayId]);
    log.info('replay finished', { replayId, applied, seconds: ((Date.now() - t0) / 1000).toFixed(1) });
    return { replayId, applied, seconds: (Date.now() - t0) / 1000 };
  } catch (err) {
    if (replayId) await conn.query("UPDATE mirror_replays SET status = 'failed', finished_at = CURRENT_TIMESTAMP(6) WHERE replay_id = ?", [replayId]).catch(() => {});
    throw err;
  } finally {
    await conn.query('SET timestamp = DEFAULT').catch(() => {});
    await releaseIngestLock(conn).catch(() => {});
  }
}
