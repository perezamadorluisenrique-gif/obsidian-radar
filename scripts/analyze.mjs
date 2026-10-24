#!/usr/bin/env node
// Deterministic analysis of the snapshots: growth, newcomers, maintainer-wanted. No network, no LLM.
//
//   node scripts/analyze.mjs [--snapshots data/snapshots] [--directory data/cache/directory.json]
//                            [--out build/analysis.json] [--now 2026-10-24T04:00:00Z]
//
// "Now" defaults to the capture time of the newest snapshot, so the same snapshots always give the same analysis.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../lib/config.mjs';
import { listSnapshots, readSnapshot } from '../lib/snapshot.mjs';
import { getJSON } from '../lib/http.mjs';
import { analyzeGrowth } from '../lib/growth.mjs';
import { analyzeAbandonment } from '../lib/abandonment.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const log = (m) => console.log(`[analyze] ${m}`);

async function loadDirectory(file, cfg) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  log(`${path.relative(ROOT, file)} not found, fetching community-plugins.json`);
  try { return await getJSON(process.env.RADAR_RELEASES_BASE ?? cfg.sources.releasesBase, 'community-plugins.json'); } catch (e) { log(`could not fetch it (${e.message}); names will fall back to plugin ids`); return []; }
}

export async function analyze({ snapshotsDir, directoryFile, now, cfg = loadConfig() }) {
  const files = listSnapshots(snapshotsDir);
  if (!files.length) throw new Error(`no snapshots in ${snapshotsDir}; run scripts/fetch.mjs first`);
  const snaps = files.map((f) => readSnapshot(f.file));
  const latest = snaps.at(-1);
  const when = now ?? new Date(latest.capturedAt);
  const directory = await loadDirectory(directoryFile, cfg);
  const growth = analyzeGrowth({ snaps, directory, cfg, now: when });
  const abandonment = analyzeAbandonment({ latest, directory, growth, cfg, now: when });
  return { snaps, directory, analysis: { schema: 1, week: latest.week, asOf: when.toISOString().slice(0, 10), refresh: latest.refresh, growth, abandonment } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const cfg = loadConfig();
    const { analysis } = await analyze({
      snapshotsDir: abs(opt('snapshots', 'data/snapshots')), directoryFile: abs(opt('directory', 'data/cache/directory.json')),
      now: opt('now', process.env.RADAR_NOW) ? new Date(opt('now', process.env.RADAR_NOW)) : undefined, cfg,
    });
    const out = abs(opt('out', 'build/analysis.json'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(analysis));
    const g = analysis.growth, a = analysis.abandonment;
    log(`${analysis.week}: ${g.totals.plugins} plugins, ${g.meta.snapshots} snapshot(s)${g.meta.baseline ? ' (baseline: no previous week to compare yet)' : `, +${g.totals.added} new, -${g.totals.removed} removed, ${g.totals.weeklyDownloads} downloads this week`}`);
    log(`looking for maintainers: ${a.meta.candidates} candidates (${a.meta.verified} verified against GitHub, ${a.meta.provisional} provisional); wrote ${path.relative(ROOT, out)}`);
  } catch (e) {
    console.error(`[analyze] FAILED: ${e.stack || e.message}`);
    process.exit(1);
  }
}
