#!/usr/bin/env node
// Fetch forum feature requests / plugin ideas into data/forum/ (topics.json + status.json).
//
//   node scripts/forum.mjs [--base https://forum.obsidian.md] [--out data/forum] [--strict]
//
// OPTIONAL step: a failure never fails the build. Exit code is 0 unless --strict is given and nothing was fetched.
import path from 'node:path';
import { loadConfig, WORK } from '../lib/config.mjs';
import { fetchForum } from '../lib/forum.mjs';
import { now } from '../lib/week.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const cfg = loadConfig();
// RADAR_FORUM_PAGES / RADAR_FORUM_DELAY_MS are test knobs (the CI dry run); the workflow uses config.json as is.
const pages = opt('pages', process.env.RADAR_FORUM_PAGES), delay = opt('delay', process.env.RADAR_FORUM_DELAY_MS);
if (pages) cfg.forum.pages = Number(pages);
if (delay) cfg.forum.delayMs = Number(delay);
const base = opt('base', process.env.RADAR_FORUM_BASE ?? cfg.sources.forumBase);
const out = path.resolve(WORK, opt('out', 'data/forum'));
const log = (m) => console.log(`[forum] ${m}`);

try {
  log(`fetching ${cfg.forum.categories.map((c) => c.slug).join(' + ')} from ${base} (about ${cfg.forum.categories.length * (cfg.forum.periods.length * cfg.forum.pages + cfg.forum.latestPages)} requests, ${cfg.forum.delayMs} ms apart)`);
  const s = await fetchForum({ base, cfg, outDir: out, now: now(), log });
  log(`${s.state}: ${s.topics} topics (${s.requests} requests, ${s.failures} failed); ${s.kept === 'new' ? 'saved' : `kept ${s.kept} data`}${s.error ? ` — ${s.error}` : ''}${s.note ? ` — ${s.note}` : ''}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    (await import('node:fs')).appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Forum\n- ${s.state}: ${s.topics} topics, ${s.requests} requests, ${s.failures} failed${s.error ? `\n- ${s.error}` : ''}\n`);
  }
  if (argv.includes('--strict') && (s.state === 'failed' || s.state === 'too-few')) process.exit(1);
} catch (e) {
  log(`unexpected error (ignored, the site builds without forum data): ${e.message}`);
  if (argv.includes('--strict')) process.exit(1);
}
