#!/usr/bin/env node
// The "first real findings" block of RESULTS.md, generated from the committed data so no number is typed by hand.
//
//   node scripts/findings.mjs            print the block (Markdown) to stdout
//
// ./score (R6) regenerates it and compares it with the block in RESULTS.md for as long as the input files are the ones the
// block was written from (the marker carries a fingerprint of them); once the weekly run has replaced the data, the block
// stays as the record of that week. Only plugin names are printed, never other people's author names; the owner's own
// plugins (config.json: myAuthor) are the single author-level view.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ROOT, WORK } from '../lib/config.mjs';
import { listSnapshots } from '../lib/snapshot.mjs';
import { analyze, ideasFor } from './analyze.mjs';

const nf = new Intl.NumberFormat('en-US');
const n = (x) => nf.format(x);

/** Short hash of the files the findings are computed from: newest snapshot, forum topics, plugin directory. */
export function fingerprint({ snapshotsDir, directoryFile, forumDir }) {
  const h = crypto.createHash('sha1');
  const newest = listSnapshots(snapshotsDir).at(-1);
  for (const f of [newest && path.join(snapshotsDir, `${newest.week}.json.gz`), path.join(forumDir, 'topics.json'), directoryFile]) {
    if (f && fs.existsSync(f)) h.update(path.basename(f)).update(fs.readFileSync(f));
  }
  return h.digest('hex').slice(0, 12);
}

export async function findings({ snapshotsDir = path.join(WORK, 'data', 'snapshots'), directoryFile = path.join(WORK, 'data', 'cache', 'directory.json'), forumDir = path.join(WORK, 'data', 'forum'), cfg = loadConfig() } = {}) {
  const { snaps, directory, analysis } = await analyze({ snapshotsDir, directoryFile, forumDir, cfg });
  const latest = snaps.at(-1);
  const name = new Map(directory.map((p) => [p.id, p.name]));
  const nm = (id) => name.get(id) ?? id;
  const g = analysis.growth, a = analysis.abandonment, ideas = ideasFor(analysis, cfg);
  const L = [];

  const top = Object.entries(latest.data).sort((x, y) => y[1].dl - x[1].dl || (x[0] < y[0] ? -1 : 1));
  L.push(`**Data.** Week ${analysis.week}: ${n(g.totals.plugins)} plugins, ${n(g.totals.downloads)} downloads in total, ${g.meta.snapshots} snapshot${g.meta.snapshots === 1 ? '' : 's'}. ` +
    (g.meta.baseline ? 'This is the baseline week, so there is no weekly growth yet; the growth lists fill from the second weekly run. ' : '') +
    `GitHub details are known for ${n(analysis.refresh.withMeta)} of ${n(g.totals.plugins)} plugins (${analysis.refresh.state}).`);
  L.push('');
  L.push(`**Biggest plugins (downloads):** ${top.slice(0, 5).map(([id, r]) => `${nm(id)} ${n(r.dl)}`).join(', ')}.`);

  const newcomers = Object.entries(g.plugins).filter(([, p]) => p.newcomer).map(([id]) => [id, latest.data[id].dl]).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
  L.push('');
  L.push(`**Newcomers (listed in the last ${cfg.growth.newcomerDays} days; ages are estimated until we have watched them arrive):** ${n(newcomers.length)} plugins. Most downloaded so far: ${newcomers.slice(0, 5).map(([id, dl]) => `${nm(id)} ${n(dl)}`).join(', ')}.`);

  L.push('');
  L.push(`**Looking for maintainers:** ${n(a.meta.candidates)} plugins pass the filter (${n(a.meta.verified)} verified against GitHub, ${n(a.meta.provisional)} provisional until GitHub details arrive). Highest scores:`);
  L.push('');
  L.push('| Plugin | Downloads | Last release or push | Quiet for | Score |');
  L.push('|---|---:|---|---:|---:|');
  for (const m of a.list.slice(0, 8)) L.push(`| ${m.name} | ${n(m.dl)} | ${m.lastActivity} | ${(m.quietDays / 30.44).toFixed(0)} months | ${m.score} |`);

  const gaps = ideas.gaps.filter((x) => !x.appLevel);
  L.push('');
  L.push(`**Gaps:** ${n(analysis.forum?.topics ?? 0)} forum topics grouped into ${n(analysis.gaps.meta.kept)} requests, ${n(analysis.gaps.clusters.filter((c) => c.status === 'likely-gap').length)} of them likely gaps; ${n(ideas.gaps.length - gaps.length)} of the top ${ideas.gaps.length} probably need Obsidian itself to change and are left out here. The top ones a plugin could take:`);
  L.push('');
  L.push('| Request | Likes | Closest plugin (similarity) | Thread |');
  L.push('|---|---:|---|---|');
  for (const x of gaps.slice(0, 8)) {
    const c = x.closestPlugins[0];
    L.push(`| ${x.title.replace(/\|/g, '/')} | ${n(x.likes)} | ${c ? `${c.name} (${c.similarity.toFixed(2)})` : 'none'} | ${x.evidence[0] ? `[forum](${x.evidence[0].url})` : ''} |`);
  }

  const mine = directory.filter((p) => p.author === cfg.myAuthor && latest.data[p.id]).sort((x, y) => latest.data[y.id].dl - latest.data[x.id].dl);
  const rank = new Map(top.map(([id], i) => [id, i + 1]));
  L.push('');
  L.push(`**Your plugins (${cfg.myAuthor}):** ${mine.length} in the directory, ${n(mine.reduce((s, p) => s + latest.data[p.id].dl, 0))} downloads in total. Best: ${mine.slice(0, 5).map((p) => `${p.name} ${n(latest.data[p.id].dl)} (#${n(rank.get(p.id))} of ${n(top.length)})`).join(', ')}.`);

  return { week: analysis.week, fingerprint: fingerprint({ snapshotsDir, directoryFile, forumDir }), markdown: L.join('\n') };
}

export const START = (week, fp) => `<!-- findings:start ${week} ${fp} (generated by \`node scripts/findings.mjs\`; ./score compares it with the data) -->`;
export const START_RE = /<!-- findings:start (\d{4}-W\d{2}) ([0-9a-f]{12}) [^>]*-->/;
export const END = '<!-- findings:end -->';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { week, fingerprint: fp, markdown } = await findings();
  console.log(`${START(week, fp)}\n${markdown}\n${END}`);
}
