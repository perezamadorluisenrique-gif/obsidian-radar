#!/usr/bin/env node
// Fetch the Obsidian directory + stats + GitHub metadata and write data/snapshots/<week>.json.gz.
//
//   node scripts/fetch.mjs [--week 2026-W43] [--out data/snapshots] [--cache data/cache]
//        [--releases <url|dir>] [--transport graphql|rest|none] [--budget N]
//        [--graphql-url URL] [--rest-url URL] [--batch N]
//
// Env: GITHUB_TOKEN (or GH_TOKEN), RADAR_NOW (pin the clock), RADAR_RELEASES_BASE, RADAR_GRAPHQL_URL, RADAR_REST_URL.
// A rate limit or missing token never fails the run: progress is saved and the next run continues.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../lib/config.mjs';
import { now as clock, weekId, isWeekId } from '../lib/week.mjs';
import { buildSnapshot } from '../lib/fetcher.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const cfg = loadConfig();
if (opt('batch')) cfg.fetch.batchSize = Number(opt('batch'));
const now = clock();
const week = opt('week', weekId(now));
if (!isWeekId(week)) { console.error(`bad --week ${week}`); process.exit(2); }

const releases = opt('releases', process.env.RADAR_RELEASES_BASE ?? cfg.sources.releasesBase);
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const transport = opt('transport', 'graphql');
const budget = opt('budget') ? Number(opt('budget')) : undefined;

const log = (m) => console.log(`[fetch] ${m}`);
log(`week ${week}, transport ${transport}${token ? '' : ' (no token)'}, releases from ${releases}`);
try {
  const { snapshot, file, stats } = await buildSnapshot({
    week, now, cfg, releases: /^https?:/.test(releases) ? releases : abs(releases),
    snapshotsDir: abs(opt('out', 'data/snapshots')), cacheDir: abs(opt('cache', 'data/cache')),
    transport, token, budget, log,
    graphqlUrl: opt('graphql-url', process.env.RADAR_GRAPHQL_URL ?? cfg.sources.graphqlUrl),
    restUrl: opt('rest-url', process.env.RADAR_REST_URL ?? cfg.sources.restUrl),
  });
  const r = snapshot.refresh;
  const line = `${snapshot.plugins} plugins; GitHub metadata for ${r.withMeta} (${((100 * r.withMeta) / snapshot.plugins).toFixed(1)}%), refreshed ${r.refreshed} this run via ${r.transport}; state=${r.state}`;
  log(`wrote ${path.relative(ROOT, file)}: ${line}`);
  log(`${stats.batches} GraphQL batches, ${stats.repoLookups} repo lookups, ${stats.gone} repos not found, ${stats.errors} transient errors${r.note ? `\n[fetch] note: ${r.note}` : ''}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Fetch ${week}\n- ${line}\n- ${stats.repoLookups} repo lookups in ${stats.batches} batches\n${r.note ? `- ${r.note}\n` : ''}`);
  }
} catch (e) {
  console.error(`[fetch] FAILED: ${e.stack || e.message}`);
  process.exit(1);
}
