// Timestamp handling. Every timestamp in this project is UTC.
//
// Formats:
//   ISO   '2023-04-01T12:34:56Z'   — API boundaries, URLs, JSON
//   SQL   '2023-04-01 12:34:56'    — DATETIME parameters/results (session time_zone is +00:00)
// SQL-format strings of equal precision compare correctly as plain strings, which the
// pure timeline code relies on.
import { config } from '../config/index.js';

export const INFINITY = config.temporal.logicalInfinity; // '9999-12-31 23:59:59'

export class TimestampError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Date -> 'YYYY-MM-DD HH:MM:SS' (UTC, whole seconds; sub-second part must be zero). */
export function toSql(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** 'YYYY-MM-DD HH:MM:SS[.ffffff]' -> 'YYYY-MM-DDTHH:MM:SS[.ffffff]Z' (no precision lost). */
export function sqlToIso(sql) {
  if (sql == null) return null;
  if (sql === INFINITY) return null; // logical infinity is reported as "open-ended"
  return sql.replace(' ', 'T') + 'Z';
}

/** MediaWiki '2023-04-01T12:34:56Z' -> SQL. */
export function apiToSql(ts) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})Z$/.exec(ts);
  if (!m) throw new Error(`unexpected MediaWiki timestamp ${ts}`);
  return `${m[1]} ${m[2]}`;
}

export const sqlToDate = (sql) => new Date(sqlToIso(sql));

const USER_TS = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Strictly parses a user-supplied instant.
 * Accepted: YYYY-MM-DD, YYYY-MM-DDTHH:MM, YYYY-MM-DDTHH:MM:SS, optionally followed by Z or ±HH:MM.
 * Without an offset the value is interpreted as UTC. Fractional seconds are rejected because
 * Wikipedia revision timestamps have one-second resolution. Impossible calendar dates are rejected.
 * Returns { date, sql, iso }.
 */
export function parseInstant(input, name = 'timestamp') {
  if (typeof input !== 'string' || input.length === 0) throw new TimestampError(`${name} is required`);
  if (input.length > 40) throw new TimestampError(`${name} is too long`);
  const m = USER_TS.exec(input.trim());
  if (!m) {
    throw new TimestampError(`${name} must look like 2023-05-01, 2023-05-01T14:30 or 2023-05-01T14:30:00Z (UTC); fractional seconds are not supported`);
  }
  const [, y, mo, d, h = '00', mi = '00', s = '00', off] = m;
  const [Y, M, D, H, MI, S] = [y, mo, d, h, mi, s].map(Number);
  if (M < 1 || M > 12 || D < 1 || D > 31 || H > 23 || MI > 59 || S > 59) throw new TimestampError(`${name} is not a valid date/time`);
  let ms = Date.UTC(Y, M - 1, D, H, MI, S);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== Y || check.getUTCMonth() !== M - 1 || check.getUTCDate() !== D) {
    throw new TimestampError(`${name} is not a valid calendar date`);
  }
  if (off && off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    const [oh, om] = off.slice(1).split(':').map(Number);
    if (oh > 14 || om > 59) throw new TimestampError(`${name} has an invalid UTC offset`);
    ms -= sign * (oh * 60 + om) * 60_000;
  }
  const date = new Date(ms);
  if (date.getUTCFullYear() < 1000 || date.getUTCFullYear() > 9998) throw new TimestampError(`${name} is out of range`);
  return { date, sql: toSql(date), iso: date.toISOString().replace('.000Z', 'Z') };
}

/** Dataset coverage from configuration (application time). */
export function datasetCoverage() {
  const { windowStart, windowEnd } = config.dataset;
  return {
    start: windowStart,
    end: windowEnd,
    startSql: toSql(windowStart),
    endSql: toSql(windowEnd),
    startIso: windowStart.toISOString().replace('.000Z', 'Z'),
    endIso: windowEnd.toISOString().replace('.000Z', 'Z'),
  };
}

/** Throws a 422-style error if the instant lies outside [start, end] of the imported dataset. */
export function assertWithinCoverage(parsed, coverage = datasetCoverage(), name = 'timestamp') {
  if (parsed.date < coverage.start || parsed.date > coverage.end) {
    const err = new TimestampError(
      `${name} ${parsed.iso} is outside the imported dataset, which covers ${coverage.startIso} to ${coverage.endIso}. ` +
      'The database contains no claim about Wikipedia outside this window.');
    err.status = 422;
    err.code = 'OUT_OF_COVERAGE';
    throw err;
  }
  return parsed;
}

/** Adds whole calendar months in UTC (clamping the day, e.g. Jan 31 + 1 month = Feb 28/29). */
export function addMonthsUtc(date, months) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * Sync cutoffs: start+step, start+2*step, ..., always ending exactly at `end`.
 * An intermediate cutoff less than one day before `end` is merged into the final step
 * (so a 5-year window with 12-month steps yields exactly 5 checkpoints).
 */
export function syncCutoffs(start, end, stepMonths) {
  if (!(stepMonths > 0)) return [end];
  const out = [];
  for (let k = 1; ; k++) {
    const c = addMonthsUtc(start, k * stepMonths);
    if (end.getTime() - c.getTime() < 86_400_000) break;
    out.push(c);
  }
  out.push(end);
  return out;
}
