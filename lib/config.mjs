import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where data/, ideas.json and dist/ live. The repository root, unless RADAR_WORKDIR points elsewhere: the CI dry run uses
 * that to run the weekly workflow's own commands inside a throw-away copy of the data without touching the checkout.
 */
export const WORK = process.env.RADAR_WORKDIR ? path.resolve(process.env.RADAR_WORKDIR) : ROOT;

/** config.json is the single source of truth for thresholds; the Methodology page prints these same values. */
export function loadConfig(file = path.join(ROOT, 'config.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
