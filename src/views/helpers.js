// Formatting helpers exposed to EJS templates (app.locals). EJS escapes <%= %> output;
// these helpers only produce plain strings or numbers.
import { INFINITY } from '../temporal/time.js';

export const SYSTEM_MAX_TS = '2106-02-07 06:28:15.999999';

export function fmtTime(sql) {
  if (sql == null) return '—';
  if (sql === INFINITY) return '∞ (open-ended)';
  if (String(sql).startsWith('2106-02-07 06:28:15')) return 'current (max TIMESTAMP)';
  return `${sql} UTC`;
}

/** 'YYYY-MM-DD HH:MM:SS' -> value usable in <input type="datetime-local" step="1"> and in URLs. */
export function inputValue(sqlOrIso) {
  if (!sqlOrIso) return '';
  return String(sqlOrIso).replace(' ', 'T').replace(/Z$/, '').slice(0, 19);
}

export function fmtNum(n) {
  return n == null ? '—' : Number(n).toLocaleString('en-US');
}

export function fmtBytes(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KiB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MiB`;
  return `${(v / 1024 ** 3).toFixed(2)} GiB`;
}

export function fmtParam(p) {
  return typeof p === 'number' ? String(p) : `'${String(p)}'`;
}

export function q(params) {
  return new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
}

/** Last second of a 'YYYY-MM' month, ISO (used to jump from the histogram to that moment). */
export function monthEnd(month, coverageEndIso) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1) - 1000).toISOString().replace('.000Z', '');
  const end = coverageEndIso.replace('Z', '');
  return d > end ? end : d;
}

/**
 * Geometry for the edits-per-month column chart: one column per month of the coverage window
 * (months without edits included, as zero), y scaled to a clean maximum.
 */
export function monthlyChart(perMonth, coverage, { width = 720, height = 160, padLeft = 36, padBottom = 22, padTop = 8 } = {}) {
  const counts = new Map(perMonth.map((p) => [p.month, Number(p.edits)]));
  const months = [];
  const d = new Date(Date.UTC(coverage.start.getUTCFullYear(), coverage.start.getUTCMonth(), 1));
  while (d <= coverage.end) {
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    months.push({ month: key, edits: counts.get(key) ?? 0 });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  const max = Math.max(1, ...months.map((m) => m.edits));
  const step = niceStep(max / 3);
  const yMax = Math.ceil(max / step) * step;
  const plotW = width - padLeft - 4;
  const plotH = height - padBottom - padTop;
  const slot = plotW / months.length;
  const barW = Math.max(2, Math.min(24, slot - 2)); // 2px gap between neighbours, capped thickness
  const bars = months.map((m, i) => {
    const h = (m.edits / yMax) * plotH;
    return { ...m, x: padLeft + i * slot + (slot - barW) / 2, y: padTop + plotH - h, w: barW, h, slotX: padLeft + i * slot, slotW: slot };
  });
  const ticks = [];
  for (let v = 0; v <= yMax; v += step) ticks.push({ v, y: padTop + plotH - (v / yMax) * plotH });
  const years = bars.filter((b) => b.month.endsWith('-01')).map((b) => ({ label: b.month.slice(0, 4), x: b.slotX }));
  return { width, height, bars, ticks, years, baseline: padTop + plotH, padLeft, max };
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** SVG path for a column with a 4px rounded top, square at the baseline. */
export function columnPath(b) {
  if (b.h <= 0) return '';
  const r = Math.min(4, b.w / 2, b.h);
  const { x, y, w, h } = b;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
