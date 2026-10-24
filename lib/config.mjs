import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** config.json is the single source of truth for thresholds; the Methodology page prints these same values. */
export function loadConfig(file = path.join(ROOT, 'config.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
