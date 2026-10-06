// SQL-building rules of this project:
//
//   * VALUES are always bound with `?` placeholders, never interpolated into SQL text.
//   * IDENTIFIERS (table, column, partition names) cannot be bound as parameters in SQL. The few places that must
//     name a table or column dynamically pass it through ident(): the name must match a strict pattern and, when a
//     list is given, belong to that whitelist; it is then back-quoted.
//   * The only numbers that end up in SQL text (e.g. the size of MariaDB's seq_0_to_N sequence table) go through
//     boundedInt() first.
//
// Everything else in SQL strings is literal text written in this repository.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export class UnsafeSqlError extends Error {}

/** Validates an identifier (pattern + optional whitelist) and returns it back-quoted. */
export function ident(name, allowed) {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new UnsafeSqlError(`unsafe SQL identifier: ${JSON.stringify(name)}`);
  if (allowed && !allowed.includes(name)) throw new UnsafeSqlError(`SQL identifier not allowed here: ${name}`);
  return `\`${name}\``;
}

/** Validates an integer that has to appear in SQL text (where a placeholder is not possible). */
export function boundedInt(value, min, max, what = 'value') {
  // Number('') and Number(null) are 0: accept only real numbers and plain digit strings.
  const n = typeof value === 'number' ? value : (typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : NaN);
  if (!Number.isInteger(n) || n < min || n > max) throw new UnsafeSqlError(`${what} must be an integer between ${min} and ${max}`);
  return n;
}
