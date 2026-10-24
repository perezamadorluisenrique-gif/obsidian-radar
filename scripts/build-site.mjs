#!/usr/bin/env node
// Builds the static site into dist/ from the snapshots and the forum data. No network (the plugin directory comes
// from data/cache/directory.json, fetched by `npm run fetch`), no LLM, no runtime build step on GitHub Pages.
//
//   node scripts/build-site.mjs [--snapshots data/snapshots] [--directory data/cache/directory.json]
//                               [--forum data/forum | none] [--out dist] [--now 2026-10-24T04:00:00Z]
//
// The output is a pure function of its inputs: building twice gives byte-identical files.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, WORK } from '../lib/config.mjs';
import { analyze, ideasFor } from './analyze.mjs';
import { renderSite } from '../lib/site.mjs';
import { esScript } from '../lib/i18n.mjs';

const log = (m) => console.log(`[build] ${m}`);

/** Writes the site; returns the list of files written (relative to `out`). */
export async function buildSite({ snapshotsDir, directoryFile, forumDir, out, now, cfg = loadConfig() }) {
  const { snaps, directory, analysis } = await analyze({ snapshotsDir, directoryFile, forumDir, now, cfg });
  const ideas = ideasFor(analysis, cfg);
  const files = renderSite({ analysis, snaps, directory, ideas, cfg });
  files.set('assets/i18n.js', esScript());
  for (const f of fs.readdirSync(path.join(ROOT, 'site', 'assets'))) files.set(`assets/${f}`, fs.readFileSync(path.join(ROOT, 'site', 'assets', f)));
  fs.rmSync(out, { recursive: true, force: true });
  for (const [rel, content] of files) {
    const dest = path.join(out, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return { files: [...files.keys()].sort(), analysis };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(WORK, p));
  try {
    const t0 = Date.now();
    const out = abs(opt('out', 'dist'));
    const forum = opt('forum', 'data/forum');
    const { files, analysis } = await buildSite({
      snapshotsDir: abs(opt('snapshots', 'data/snapshots')), directoryFile: abs(opt('directory', 'data/cache/directory.json')),
      forumDir: forum === 'none' ? null : abs(forum), out,
      now: opt('now', process.env.RADAR_NOW) ? new Date(opt('now', process.env.RADAR_NOW)) : undefined,
    });
    const pages = files.filter((f) => f.endsWith('.html')).length;
    const bytes = files.reduce((s, f) => s + fs.statSync(path.join(out, f)).size, 0);
    log(`${analysis.week}: ${pages} pages, ${files.length} files, ${(bytes / 1048576).toFixed(1)} MB -> ${path.relative(WORK, out) || '.'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error(`[build] FAILED: ${e.stack || e.message}`);
    process.exit(1);
  }
}
