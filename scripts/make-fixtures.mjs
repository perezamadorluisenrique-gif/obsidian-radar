#!/usr/bin/env node
// Regenerates the committed test fixtures. Only needed when the fixture design changes.
//
//   node scripts/make-fixtures.mjs releases --from <dir with the 3 raw Obsidian files>
//   node scripts/make-fixtures.mjs snapshots --from <data/snapshots/YYYY-Www.json.gz of a real snapshot>
//   node scripts/make-fixtures.mjs forum [--from data/forum] [--directory data/cache/directory.json]
//
// `forum` writes a trimmed sample of the real forum topics plus a matching plugin list to fixtures/forum/.
// `releases` writes a small, deterministic sample of the real directory to fixtures/releases/.
// `snapshots` writes that same sample of a REAL snapshot as fixtures/snapshots/<its week>.json.gz plus a SYNTHETIC
// previous week, built from fixtures/snapshots/plan.json, so growth tests have two weeks with known answers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, ROOT } from '../lib/config.mjs';
import { readSnapshot, writeSnapshot } from '../lib/snapshot.mjs';

const argv = process.argv.slice(2);
const what = argv[0];
const from = argv[argv.indexOf('--from') + 1];
const cfg = loadConfig();
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');

if (what === 'releases') {
  const dir = JSON.parse(fs.readFileSync(path.join(from, 'community-plugins.json'), 'utf8'));
  const stats = JSON.parse(fs.readFileSync(path.join(from, 'community-plugin-stats.json'), 'utf8'));
  const removed = JSON.parse(fs.readFileSync(path.join(from, 'community-plugins-removed.json'), 'utf8'));
  const dl = (p) => stats[p.id]?.downloads ?? 0;
  const old = Date.now() - cfg.abandonment.quietDays * 864e5;
  const pick = new Map();
  const add = (list, n) => { for (const p of list.slice(0, n)) pick.set(p.id, p); };
  add(dir.filter((p) => p.author === cfg.myAuthor), 100);                                              // the "my plugins" panel
  add([...dir].sort((a, b) => dl(b) - dl(a)), 40);                                                      // the leaders
  add(dir.filter((p) => dl(p) >= cfg.abandonment.minDownloads && (stats[p.id]?.updated ?? 0) < old)
    .sort((a, b) => dl(b) - dl(a)), 40);                                                                // popular but quiet
  add(dir.slice(-30).reverse(), 30);                                                                    // newest entries (incl. ones with no stats yet)
  add([...dir].sort((a, b) => hash(a.id).localeCompare(hash(b.id))), 40);                              // a deterministic random sample
  const ids = new Set(pick.keys());
  const outDir = path.join(ROOT, 'fixtures', 'releases');
  fs.mkdirSync(outDir, { recursive: true });
  const ordered = dir.filter((p) => ids.has(p.id)); // keep the real directory order (newest last)
  fs.writeFileSync(path.join(outDir, 'community-plugins.json'), JSON.stringify(ordered, null, 1));
  fs.writeFileSync(path.join(outDir, 'community-plugin-stats.json'), JSON.stringify(Object.fromEntries(ordered.filter((p) => stats[p.id]).map((p) => {
    const { downloads, updated, ...versions } = stats[p.id];
    return [p.id, { downloads, updated, ...Object.fromEntries(Object.entries(versions).slice(0, 3)) }]; // keep the real shape, drop the long version tail
  }))));
  fs.writeFileSync(path.join(outDir, 'community-plugins-removed.json'), JSON.stringify(removed.slice(0, 12), null, 1));
  console.log(`fixtures/releases: ${ordered.length} plugins`);
} else if (what === 'snapshots') {
  const real = readSnapshot(from);
  const dir = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'releases', 'community-plugins.json'), 'utf8'));
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'snapshots', 'plan.json'), 'utf8'));
  const outDir = path.join(ROOT, 'fixtures', 'snapshots');
  const sample = Object.fromEntries(dir.filter((p) => real.data[p.id]).map((p) => [p.id, real.data[p.id]]));
  const mk = (week, capturedAt, data, note) => ({
    schema: 1, week, capturedAt, ...(real.statsUpdated && week === real.week ? { statsUpdated: real.statsUpdated } : {}), plugins: Object.keys(data).length,
    refresh: { state: 'rolling', transport: 'none', withMeta: 0, pending: Object.keys(data).length, refreshed: 0, limited: false, note }, data,
  });
  writeSnapshot(outDir, mk(real.week, real.capturedAt, sample, 'Sample of the real snapshot (ids of fixtures/releases); no GitHub metadata.'));
  // Synthetic previous week: this week minus a known gain. Unplanned plugins gain up to 0.05% of their total.
  const gain = (id, dl) => plan.gains[id] ?? Math.floor((dl * (parseInt(hash(id).slice(0, 4), 16) % 100)) / 200000);
  const prev = {};
  for (const [id, rec] of Object.entries(sample)) {
    if (plan.absent.includes(id)) continue;
    const r = { ...rec, dl: Math.max(0, rec.dl - gain(id, rec.dl)) };
    if (plan.anomaly[id]) r.dl = rec.dl + plan.anomaly[id];
    if (plan.prevRel[id]) r.rel = plan.prevRel[id];
    prev[id] = r;
  }
  for (const [id, g] of Object.entries(plan.ghosts)) prev[id] = { dl: g.dl, rel: g.rel };
  writeSnapshot(outDir, mk(plan.previousWeek, plan.previousCapturedAt, prev, 'SYNTHETIC test week derived from the real sample by scripts/make-fixtures.mjs from fixtures/snapshots/plan.json. Not real data.'));
  console.log(`fixtures/snapshots: ${real.week} (${Object.keys(sample).length} plugins, real) + ${plan.previousWeek} (${Object.keys(prev).length} plugins, synthetic)`);
} else if (what === 'forum') {
  // A real, trimmed sample of the forum (the most liked topics + a deterministic random sample) and a plugin list for it:
  // for every sampled topic its two closest real plugins, plus unrelated ones, so the fixture holds covered requests and gaps.
  const { readForum } = await import('../lib/forum.mjs');
  const { analyzeGaps } = await import('../lib/gaps.mjs');
  const { topics } = readForum(path.resolve(ROOT, argv.includes('--from') ? from : 'data/forum')).topics ?? {};
  const dirFile = path.resolve(ROOT, argv.includes('--directory') ? argv[argv.indexOf('--directory') + 1] : 'data/cache/directory.json');
  const dir = JSON.parse(fs.readFileSync(dirFile, 'utf8'));
  const pick = new Map();
  for (const t of [...topics].sort((a, b) => b.likes - a.likes || a.id - b.id).slice(0, 70)) pick.set(t.id, t);
  for (const t of [...topics].sort((a, b) => hash(String(a.id)).localeCompare(hash(String(b.id)))).slice(0, 70)) pick.set(t.id, t);
  const sample = [...pick.values()].sort((a, b) => a.id - b.id);
  const probe = analyzeGaps({ topics: sample.map((t) => ({ ...t, tags: t.tags })), plugins: dir, cfg: { ...cfg, gaps: { ...cfg.gaps, closest: 2, topN: 1e6, minClusterSize: 1, singleMinLikes: 0, similarity: 0.99 } } });
  const keep = new Set();
  for (const c of probe.clusters) for (const p of c.closestPlugins) keep.add(p.id);
  for (const p of [...dir].sort((a, b) => hash(a.id).localeCompare(hash(b.id))).slice(0, 120)) keep.add(p.id);
  const plugins = dir.filter((p) => keep.has(p.id)).map(({ id, name, description, repo }) => ({ id, name, description, repo }));
  const outDir = path.join(ROOT, 'fixtures', 'forum');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'topics.json'), JSON.stringify({ schema: 1, fetchedAt: '2026-10-24T05:00:00.000Z', topics: sample }, null, 0));
  fs.writeFileSync(path.join(outDir, 'plugins.json'), JSON.stringify(plugins, null, 0));
  console.log(`fixtures/forum: ${sample.length} topics, ${plugins.length} plugins`);
} else if (what === 'graphql-subset') {
  // Prune GitHub's public schema (https://docs.github.com/public/fpt/schema.docs.graphql) down to the
  // fields lib/github.mjs queries, so tests can validate generated queries offline against REAL type definitions.
  const { parse, print, visit, Kind } = await import('graphql');
  const ast = parse(fs.readFileSync(path.join(from, 'schema.docs.graphql'), 'utf8'), { noLocation: true });
  const keep = {
    Query: ['repository', 'rateLimit'],
    Repository: ['pushedAt', 'createdAt', 'isArchived', 'stargazerCount', 'issues', 'latestRelease', 'labels'],
    IssueConnection: ['totalCount'], Release: ['publishedAt'], LabelConnection: ['nodes'], Label: ['name', 'issues'],
    RateLimit: ['cost', 'remaining', 'resetAt'],
  };
  const keepArgs = { repository: ['owner', 'name', 'followRenames'], issues: ['states', 'first', 'last', 'after', 'before'], labels: ['first', 'last', 'after', 'before', 'query'] };
  const keepEnums = new Set(['IssueState']);
  const keepScalars = new Set(['DateTime', 'URI', 'ID', 'Int', 'String', 'Boolean']);
  const defs = [];
  for (const d of ast.definitions) {
    const name = d.name?.value;
    if (d.kind === Kind.OBJECT_TYPE_DEFINITION && keep[name]) {
      defs.push({ ...d, interfaces: [], directives: [], description: undefined,
        fields: d.fields.filter((f) => keep[name].includes(f.name.value)).map((f) => ({ ...f, description: undefined, directives: [],
          arguments: (f.arguments ?? []).filter((a) => (keepArgs[f.name.value] ?? []).includes(a.name.value)).map((a) => ({ ...a, description: undefined, directives: [] })) })) });
    } else if (d.kind === Kind.ENUM_TYPE_DEFINITION && keepEnums.has(name)) defs.push({ ...d, description: undefined, directives: [], values: d.values.map((v) => ({ ...v, description: undefined, directives: [] })) });
    else if (d.kind === Kind.SCALAR_TYPE_DEFINITION && keepScalars.has(name)) defs.push({ ...d, description: undefined, directives: [] });
  }
  for (const [type, fields] of Object.entries(keep)) {
    const got = defs.find((d) => d.name?.value === type)?.fields.map((f) => f.name.value) ?? [];
    for (const f of fields) if (!got.includes(f)) throw new Error(`GitHub schema no longer has ${type}.${f}`);
  }
  const out = `# Pruned copy of GitHub's public GraphQL schema (docs.github.com/public/fpt/schema.docs.graphql).\n# Only the types/fields used by lib/github.mjs; regenerate with: node scripts/make-fixtures.mjs graphql-subset --from <dir>\n\n${print({ kind: Kind.DOCUMENT, definitions: defs })}\n`;
  fs.mkdirSync(path.join(ROOT, 'fixtures', 'graphql'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'fixtures', 'graphql', 'github-subset.graphql'), out);
  console.log(`fixtures/graphql/github-subset.graphql: ${out.length} bytes, ${defs.length} definitions`);
} else {
  console.error('usage: make-fixtures.mjs releases|snapshots|forum|graphql-subset --from <dir or file>');
  process.exit(2);
}
