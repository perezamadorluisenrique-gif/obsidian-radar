#!/usr/bin/env node
// Regenerates the committed test fixtures. Only needed when the fixture design changes.
//
//   node scripts/make-fixtures.mjs releases --from <dir with the 3 raw Obsidian files>
//
// `releases` writes a small, deterministic sample of the real directory to fixtures/releases/.
// (Snapshot fixtures are produced by tests/helpers/synthetic.mjs; see `snapshots` below once R2 exists.)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, ROOT } from '../lib/config.mjs';

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
  console.error('usage: make-fixtures.mjs releases|graphql-subset --from <dir>');
  process.exit(2);
}
