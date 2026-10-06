#!/usr/bin/env node
// npm run setup-env
// Creates .env from .env.example, replacing every `change-me-…` placeholder with a random password.
// Never overwrites an existing .env. Used by `npm run demo` and by CI.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, '.env');

if (fs.existsSync(target)) {
  console.log('.env already exists — left unchanged');
} else {
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const env = template.replace(/change-me-[a-z-]+/g, () => randomBytes(16).toString('hex'));
  fs.writeFileSync(target, env, { mode: 0o600 });
  console.log('.env created from .env.example with random passwords');
}
