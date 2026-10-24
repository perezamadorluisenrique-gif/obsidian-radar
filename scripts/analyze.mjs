#!/usr/bin/env node
// Deterministic analysis of the snapshots and the forum data: growth, newcomers, maintainer-wanted, gaps. No network
// (apart from fetching community-plugins.json when the directory cache is missing), no LLM.
//
//   node scripts/analyze.mjs [--snapshots data/snapshots] [--directory data/cache/directory.json]
//                            [--forum data/forum | none] [--out build/analysis.json] [--ideas ideas.json]
//                            [--now 2026-10-24T04:00:00Z]
//
// --ideas writes ideas.json (validated against schemas/ideas.schema.json). It is opt-in so that tests and dry runs
// never touch the committed file; `npm run analyze` passes it.

// "Now" defaults to the capture time of the newest snapshot, so the same snapshots always give the same analysis.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, WORK } from '../lib/config.mjs';
import { listSnapshots, readSnapshot } from '../lib/snapshot.mjs';
import { getJSON } from '../lib/http.mjs';
import { analyzeGrowth } from '../lib/growth.mjs';
import { analyzeAbandonment } from '../lib/abandonment.mjs';
import { analyzeGaps } from '../lib/gaps.mjs';
import { readForum } from '../lib/forum.mjs';
import { buildIdeas } from '../lib/ideas.mjs';
import { validate } from '../lib/schema.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const abs = (p) => (path.isAbsolute(p) ? p : path.join(WORK, p));
const log = (m) => console.log(`[analyze] ${m}`);

async function loadDirectory(file, cfg) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  log(`${path.relative(WORK, file)} not found, fetching community-plugins.json`);
  try { return await getJSON(process.env.RADAR_RELEASES_BASE ?? cfg.sources.releasesBase, 'community-plugins.json'); } catch (e) { log(`could not fetch it (${e.message}); names will fall back to plugin ids`); return []; }
}

export async function analyze({ snapshotsDir, directoryFile, forumDir = null, now, cfg = loadConfig() }) {
  const files = listSnapshots(snapshotsDir);
  if (!files.length) throw new Error(`no snapshots in ${snapshotsDir}; run scripts/fetch.mjs first`);
  const snaps = files.map((f) => readSnapshot(f.file));
  const latest = snaps.at(-1);
  const when = now ?? new Date(latest.capturedAt);
  const directory = await loadDirectory(directoryFile, cfg);
  const growth = analyzeGrowth({ snaps, directory, cfg, now: when });
  const abandonment = analyzeAbandonment({ latest, directory, growth, cfg, now: when });
  // Forum gaps: optional. No forum data (never fetched, or every fetch failed) means no gaps section, not an error.
  const forum = forumDir ? readForum(forumDir) : { topics: null, status: null };
  const gaps = forum.topics?.topics?.length
    ? analyzeGaps({ topics: forum.topics.topics, plugins: directory, downloads: Object.fromEntries(Object.entries(latest.data).map(([id, r]) => [id, r.dl])), cfg })
    : null;
  const analysis = {
    schema: 1, week: latest.week, asOf: when.toISOString().slice(0, 10), refresh: latest.refresh, growth, abandonment,
    forum: forum.status ? { ...forum.status, topics: forum.topics?.topics?.length ?? 0 } : null, gaps,
  };
  return { snaps, directory, analysis };
}

/** ideas.json for an analysis, checked against its schema before anyone gets to see it. */
export function ideasFor(analysis, cfg = loadConfig()) {
  const ideas = buildIdeas({ analysis, cfg });
  const errs = validate(JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'ideas.schema.json'), 'utf8')), ideas);
  if (errs.length) throw new Error(`ideas.json does not match schemas/ideas.schema.json:\n  ${errs.join('\n  ')}`);
  return ideas;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const cfg = loadConfig();
    const { analysis } = await analyze({
      snapshotsDir: abs(opt('snapshots', 'data/snapshots')), directoryFile: abs(opt('directory', 'data/cache/directory.json')),
      forumDir: opt('forum', 'data/forum') === 'none' ? null : abs(opt('forum', 'data/forum')),
      now: opt('now', process.env.RADAR_NOW) ? new Date(opt('now', process.env.RADAR_NOW)) : undefined, cfg,
    });
    const out = abs(opt('out', 'build/analysis.json'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(analysis));
    const g = analysis.growth, a = analysis.abandonment;
    log(`${analysis.week}: ${g.totals.plugins} plugins, ${g.meta.snapshots} snapshot(s)${g.meta.baseline ? ' (baseline: no previous week to compare yet)' : `, +${g.totals.added} new, -${g.totals.removed} removed, ${g.totals.weeklyDownloads} downloads this week`}`);
    log(`looking for maintainers: ${a.meta.candidates} candidates (${a.meta.verified} verified against GitHub, ${a.meta.provisional} provisional)`);
    log(analysis.gaps
      ? `gaps: ${analysis.gaps.meta.topics} forum topics -> ${analysis.gaps.meta.kept} clusters kept, ${analysis.gaps.clusters.filter((c) => c.status === 'likely-gap').length} likely gaps (forum data ${analysis.forum?.state ?? 'unknown'}, fetched ${analysis.forum?.fetchedAt?.slice(0, 10) ?? '?'})`
      : 'gaps: no forum data, skipped (the rest of the site is unaffected)');
    log(`wrote ${path.relative(WORK, out)}`);
    if (opt('ideas')) {
      const ideasFile = abs(opt('ideas'));
      const ideas = ideasFor(analysis, cfg);
      fs.writeFileSync(ideasFile, `${JSON.stringify(ideas, null, 1)}\n`);
      log(`wrote ${path.relative(WORK, ideasFile)}: ${ideas.gaps.length} gaps, ${ideas.maintainersWanted.length} maintainers wanted`);
    }
  } catch (e) {
    console.error(`[analyze] FAILED: ${e.stack || e.message}`);
    process.exit(1);
  }
}
