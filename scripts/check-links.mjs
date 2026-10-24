#!/usr/bin/env node
// Link checker for the built site (dist/). Offline: external links are counted and sanity-checked, never fetched.
//
//   node scripts/check-links.mjs [dist] [--allow-http host,host]
//     --allow-http: only for the CI dry run, whose mock forum is served over http://127.0.0.1; the weekly workflow never passes it.
//
// Checks, for every .html file:
//   - every relative href/src resolves to a file in dist (query strings ignored), with no absolute "/path" links
//     (they break under the GitHub Pages sub-path /<repo>/);
//   - every #fragment names an id that exists in the target page;
//   - plugin.html?id=X points at an existing p/X.json, and search.html?q= links need search.json;
//   - ids are unique within a page;
//   - external links are https:// (or mailto:) and well-formed.
// Exit code 1 when anything is broken.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkLinks(dist, { allowHttp = [] } = {}) {
  const problems = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const all = walk(dist).map((f) => path.relative(dist, f).split(path.sep).join('/'));
  const exists = new Set(all);
  const htmlFiles = all.filter((f) => f.endsWith('.html'));
  const idsOf = new Map();
  const pages = new Map();
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(dist, f), 'utf8');
    pages.set(f, html);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const seen = new Set();
    for (const id of ids) { if (seen.has(id)) problems.push(`${f}: duplicate id "${id}"`); seen.add(id); }
    idsOf.set(f, seen);
  }
  const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const pluginFile = (id) => `${String(id).replace(/[^a-z0-9._-]/gi, '_')}.json`;
  let internal = 0, external = 0;
  const externalHosts = new Map();
  for (const [f, html] of pages) {
    for (const m of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const raw = unesc(m[1]);
      if (raw === '' || raw.startsWith('data:')) continue;
      if (/^(https?:)?\/\//.test(raw) || raw.startsWith('mailto:')) {
        external++;
        if (raw.startsWith('http://') && !allowHttp.includes(new URL(raw).hostname)) problems.push(`${f}: insecure external link ${raw}`);
        try { const u = new URL(raw); externalHosts.set(u.host, (externalHosts.get(u.host) ?? 0) + 1); } catch { if (!raw.startsWith('mailto:')) problems.push(`${f}: malformed external link ${raw}`); }
        continue;
      }
      if (raw.startsWith('/')) { problems.push(`${f}: absolute link "${raw}" breaks under the Pages sub-path`); continue; }
      internal++;
      const u = new URL(raw, `http://x/${path.posix.dirname(f) === '.' ? '' : `${path.posix.dirname(f)}/`}${path.posix.basename(f)}`);
      let target = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (target === '') target = 'index.html';
      if (!exists.has(target)) { problems.push(`${f}: broken link "${raw}" (no ${target})`); continue; }
      if (u.hash && target.endsWith('.html')) {
        const frag = decodeURIComponent(u.hash.slice(1));
        if (frag && !idsOf.get(target)?.has(frag)) problems.push(`${f}: "${raw}" points at a missing #${frag} in ${target}`);
      }
      if (target === 'plugin.html' && u.searchParams.has('id')) {
        const pf = `p/${pluginFile(u.searchParams.get('id'))}`;
        if (!exists.has(pf)) problems.push(`${f}: plugin link "${raw}" has no ${pf}`);
      }
    }
  }
  for (const need of ['search.json', 'ideas.json', 'assets/app.js', 'assets/style.css', 'assets/i18n.js', 'meta.json']) if (!exists.has(need)) problems.push(`missing ${need}`);
  return { problems, pages: htmlFiles.length, files: all.length, internal, external, externalHosts: Object.fromEntries([...externalHosts].sort()) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf('--allow-http');
  const allowHttp = flag >= 0 ? String(argv[flag + 1] ?? '').split(',').filter(Boolean) : [];
  const dist = path.resolve(argv.find((a, i) => !a.startsWith('--') && i !== flag + 1) ?? 'dist');
  if (!fs.existsSync(dist)) { console.error(`[links] ${dist} does not exist; run \`npm run build\` first`); process.exit(2); }
  const r = checkLinks(dist, { allowHttp });
  console.log(`[links] ${r.pages} pages, ${r.files} files, ${r.internal} internal links checked, ${r.external} external links (${Object.keys(r.externalHosts).join(', ') || 'none'}; not fetched)`);
  if (r.problems.length) {
    for (const p of r.problems.slice(0, 40)) console.error(`  ✗ ${p}`);
    if (r.problems.length > 40) console.error(`  … and ${r.problems.length - 40} more`);
    process.exit(1);
  }
  console.log('[links] OK');
}
