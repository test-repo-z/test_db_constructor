// Helpers shared by the scripts/ command-line entry points.
import { pathToFileURL } from 'node:url';

/** True when the module whose import.meta.url is given was executed directly (`node file.js`). */
export const isMain = (metaUrl) => process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href;

/** Parses `--key=value` / `--flag` arguments into an object. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unrecognised argument ${a}`);
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
