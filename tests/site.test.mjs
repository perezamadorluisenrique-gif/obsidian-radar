import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../scripts/build-site.mjs';
import { checkLinks } from '../scripts/check-links.mjs';
import { loadConfig } from '../lib/config.mjs';
import { ES } from '../lib/i18n.mjs';
import { sparkline, esc, usedKeys, pluginFile } from '../lib/site.mjs';
import { validate } from '../lib/schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'fixtures');
const cfg = loadConfig();
const tmp = () => fs.mkdtempSync(path.join(process.env.RADAR_SCORE_TMP || os.tmpdir(), 'radar-site-'));
const DIRECTORY = path.join(FX, 'releases', 'community-plugins.json');
const snaps = (dir, ...weeks) => { fs.mkdirSync(dir, { recursive: true }); for (const w of weeks) fs.copyFileSync(path.join(FX, 'snapshots', `${w}.json.gz`), path.join(dir, `${w}.json.gz`)); return dir; };
const forumDir = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(path.join(FX, 'forum', 'topics.json'), path.join(dir, 'topics.json')); fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ fetchedAt: '2026-10-24T05:00:00.000Z', source: 'https://forum.example.test', requests: 1, failures: 0, topics: 1, perCategory: {}, kept: 'new', state: 'ok' })); return dir; };
const read = (out, f) => fs.readFileSync(path.join(out, f), 'utf8');
const htmlFiles = (out) => fs.readdirSync(out).filter((f) => f.endsWith('.html'));
const build = async ({ weeks = ['2026-W42', '2026-W43'], forum = true, directory = DIRECTORY } = {}) => {
  const d = tmp();
  const out = path.join(d, 'dist');
  const r = await buildSite({ snapshotsDir: snaps(path.join(d, 'snaps'), ...weeks), directoryFile: directory, forumDir: forum ? forumDir(path.join(d, 'forum')) : null, out, cfg });
  return { d, out, ...r };
};
const hashTree = (out) => {
  const h = crypto.createHash('sha1');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)).forEach((e) => { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else h.update(path.relative(out, f)).update(fs.readFileSync(f)); });
  walk(out);
  return h.digest('hex');
};

test('the site builds from two fixture weeks with every page, valid links and one JSON per plugin', async () => {
  const { out, files, analysis } = await build();
  for (const f of ['index.html', 'growing.html', 'new.html', 'maintainers.html', 'gaps.html', 'mine.html', 'methodology.html', 'search.html', 'plugin.html', '404.html', 'search.json', 'ideas.json', 'meta.json', '.nojekyll', 'assets/app.js', 'assets/style.css', 'assets/i18n.js', 'assets/favicon.svg']) assert.ok(files.includes(f), `missing ${f}`);
  const pluginJson = files.filter((f) => f.startsWith('p/'));
  assert.equal(pluginJson.length, analysis.growth.totals.plugins, 'one p/<id>.json per plugin in the latest snapshot');
  const r = checkLinks(out);
  assert.deepEqual(r.problems, []);
  assert.ok(r.internal > 100);
  const ideas = JSON.parse(read(out, 'ideas.json'));
  const errs = validate(JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'ideas.schema.json'), 'utf8')), ideas);
  assert.deepEqual(errs, [], 'the published ideas.json matches its schema');
});

test('building twice gives byte-identical output', async () => {
  const a = await build(), b = await build();
  assert.equal(hashTree(a.out), hashTree(b.out));
});

test('growth pages show the known winners from the synthetic week, with no placeholder text anywhere', async () => {
  const { out } = await build();
  const growing = read(out, 'growing.html');
  assert.match(growing, /Most downloads gained per week/);
  assert.ok(growing.indexOf('Templater') < growing.indexOf('Excalidraw'), 'Templater (+30,000/week) is listed before Excalidraw (+24,000)');
  assert.match(growing, /\+30,000/);
  assert.doesNotMatch(growing, /First week of history/, 'not a baseline with two weeks');
  const index = read(out, 'index.html');
  assert.match(index, /2 removed/);
  assert.match(index, /first seen/);
  for (const f of htmlFiles(out)) assert.doesNotMatch(read(out, f), /\b(NaN|undefined|\[object Object\])\b|>null</, `${f} has placeholder text`);
  const meta = JSON.parse(read(out, 'meta.json'));
  assert.deepEqual([meta.week, meta.baseline, meta.snapshots], ['2026-W43', false, 2]);
});

test('with a single snapshot the site says history begins there and still has useful lists', async () => {
  const { out } = await build({ weeks: ['2026-W43'] });
  const index = read(out, 'index.html'), growing = read(out, 'growing.html');
  assert.match(index, /First week of history/);
  assert.match(index, /History begins at<\/span> <strong>2026-W43<\/strong>/);
  assert.match(growing, /Biggest plugins right now/);
  assert.doesNotMatch(growing, /Most downloads gained per week/);
  assert.match(read(out, 'new.html'), /age estimated/, 'ages of plugins listed before the first snapshot are marked as estimates');
  assert.deepEqual(checkLinks(out).problems, []);
  const p = JSON.parse(read(out, 'p/templater-obsidian.json'));
  assert.equal(p.series.length, 1);
  assert.equal(p.d1, null);
});

test('GitHub data that is still being collected is announced and entries are marked provisional', async () => {
  const { out } = await build();
  assert.match(read(out, 'index.html'), /GitHub data is still being collected/);
  assert.match(read(out, 'maintainers.html'), /provisional/);
});

test('maintainer pages are about plugins, never about people: no author name appears on them', async () => {
  const { out } = await build();
  const dir = JSON.parse(fs.readFileSync(DIRECTORY, 'utf8'));
  const plugins = new Set(dir.flatMap((p) => [p.id.toLowerCase(), p.name.toLowerCase()]));
  // visible text only: a repository link necessarily contains its owner's GitHub handle, but no name is displayed
  const visible = (f) => read(out, f).replace(/<[^>]+>/g, ' ').toLowerCase();
  const chrome = `${visible('404.html')} ${visible('methodology.html')}`; // an author called "Obsidian" is in the page furniture
  const authors = [...new Set(dir.map((p) => p.author).filter((a) => a && a.length > 3 && !plugins.has(a.toLowerCase()) && !chrome.includes(a.toLowerCase())))];
  assert.ok(authors.length > 20);
  const maint = visible('maintainers.html');
  const gaps = visible('gaps.html');
  const names = (text, a) => new RegExp(`(?<![\\w-])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text); // whole word: "Remi" is not "remind"
  for (const a of authors) { assert.ok(!names(maint, a), `maintainers.html names ${a}`); assert.ok(!names(gaps, a), `gaps.html names ${a}`); }
  for (const f of fs.readdirSync(path.join(out, 'p'))) { const j = JSON.parse(read(out, `p/${f}`)); assert.ok(!('author' in j), `${f} exposes an author`); }
  assert.match(maint, /not a judgement|not a judgment/);
  assert.match(maint, /room for an alternative/);
});

test('"My plugins" lists the configured author with a rank among similar plugins', async () => {
  const { out } = await build();
  const mine = read(out, 'mine.html');
  assert.ok(mine.includes(esc(cfg.myAuthor)));
  const dir = JSON.parse(fs.readFileSync(DIRECTORY, 'utf8'));
  const own = dir.filter((p) => p.author === cfg.myAuthor);
  assert.ok(own.length > 5);
  for (const p of own.slice(0, 5)) assert.ok(mine.includes(`plugin.html?id=${encodeURIComponent(p.id)}`), `${p.id} missing`);
  assert.match(mine, /Rank by downloads/);
  assert.match(mine, /vs/);
});

test('hostile plugin text is escaped in HTML and stays inert data in the JSON files', async () => {
  const d = tmp();
  const dir = JSON.parse(fs.readFileSync(DIRECTORY, 'utf8'));
  const evil = { ...dir.find((p) => p.id === 'templater-obsidian'), name: '"><img src=x onerror=alert(1)>', description: '<script>alert(2)</script> & <b>bold</b>' };
  const file = path.join(d, 'directory.json');
  fs.writeFileSync(file, JSON.stringify(dir.map((p) => (p.id === evil.id ? evil : p))));
  const { out } = await build({ directory: file });
  for (const f of htmlFiles(out)) {
    const html = read(out, f);
    assert.doesNotMatch(html, /<img src=x/, `${f} has an unescaped tag from a plugin name`);
    assert.doesNotMatch(html, /<script>alert/, `${f} has an unescaped script from a plugin description`);
  }
  assert.match(read(out, 'growing.html'), /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.equal(JSON.parse(read(out, 'p/templater-obsidian.json')).desc, evil.description, 'JSON keeps the literal text; the page renders it with textContent');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(fs.readFileSync(path.join(ROOT, 'site', 'assets', 'app.js'), 'utf8')), 'app.js never builds markup from data');
});

test('every page has a viewport, a title, a skip link, a single main and no absolute links', async () => {
  const { out } = await build();
  const titles = new Set();
  for (const f of htmlFiles(out)) {
    const html = read(out, f);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, f);
    assert.match(html, /<html lang="en">/, f);
    assert.match(html, /<a class="skip" href="#main"/, f);
    assert.equal((html.match(/<main\b/g) ?? []).length, 1, f);
    const t = /<title>([^<]+)<\/title>/.exec(html)?.[1];
    assert.ok(t, `${f} has no title`);
    if (f !== '404.html') assert.ok(!titles.has(t), `duplicate title ${t}`);
    titles.add(t);
    assert.doesNotMatch(html, /(?:href|src)="\//, `${f} has an absolute link, which breaks under the Pages sub-path`);
    assert.doesNotMatch(html, /https?:\/\/[^"' ]+\.(?:css|js|woff2?)/, `${f} loads a remote asset`);
    if (f !== 'plugin.html') assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${f} should have exactly one h1`);
  }
});

test('the dark-mode tokens exist for both the OS setting and the manual toggle', () => {
  const css = fs.readFileSync(path.join(ROOT, 'site', 'assets', 'style.css'), 'utf8');
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  for (const token of ['--bg', '--surface', '--ink', '--muted', '--line', '--link', '--series-1']) {
    assert.ok(new RegExp(`${token}:`).test(css.split(':root[data-theme="dark"]')[1]), `dark set lacks ${token}`);
  }
  assert.doesNotMatch(css, /@import|url\(http/);
});

test('Spanish: every key used by a page or by app.js has a translation, and none is dead weight', async () => {
  const used = new Set();
  for (const opts of [{}, { weeks: ['2026-W43'] }, { forum: false }]) {
    const { out } = await build(opts);
    for (const f of htmlFiles(out)) for (const k of usedKeys(read(out, f))) used.add(k);
    assert.match(read(out, 'assets/i18n.js'), /^window\.RADAR_ES=\{/);
  }
  const app = fs.readFileSync(path.join(ROOT, 'site', 'assets', 'app.js'), 'utf8');
  for (const m of app.matchAll(/\bt\('([a-z][a-z0-9.]*)'/g)) used.add(m[1]);
  for (const m of app.matchAll(/\b(?:fact|numCell)\('[^']*',\s*'([a-z][a-z0-9.]*)'/g)) used.add(m[1]);
  assert.ok(used.size > 60);
  const missing = [...used].filter((k) => !ES[k]);
  assert.deepEqual(missing, [], `no Spanish for: ${missing.join(', ')}`);
  for (const [k, v] of Object.entries(ES)) assert.ok(typeof v === 'string' && v.trim(), `empty translation for ${k}`);
  // rendered only once a trend exists (needs 3+ snapshots) or when the author has no plugins: no fixture has either
  const conditional = new Set(['trend.up', 'trend.down', 'trend.flat', 'mine.none']);
  const unused = Object.keys(ES).filter((k) => !used.has(k) && !conditional.has(k));
  assert.deepEqual(unused, [], `dictionary entries nothing uses: ${unused.join(', ')}`);
});

test('size budgets: the search index and each plugin file stay small', async () => {
  const { out, analysis } = await build();
  const n = analysis.growth.totals.plugins;
  const search = JSON.parse(read(out, 'search.json'));
  assert.equal(search.plugins.length, n);
  assert.ok(read(out, 'search.json').length / n < 170, 'search.json averages under 170 bytes per plugin');
  for (const row of search.plugins) assert.equal(row.length, 6);
  const biggest = Math.max(...fs.readdirSync(path.join(out, 'p')).map((f) => fs.statSync(path.join(out, 'p', f)).size));
  assert.ok(biggest < 6000, `largest plugin file is ${biggest} bytes`);
  for (const f of htmlFiles(out)) assert.ok(fs.statSync(path.join(out, f)).size < 300_000, `${f} is too big for a phone`);
});

test('the plugin shell page and the JSON agree on file names, including awkward ids', () => {
  assert.equal(pluginFile('obsidian-git'), 'obsidian-git.json');
  assert.equal(pluginFile('a/b c'), 'a_b_c.json');
  assert.equal(pluginFile('weird?id=1&x'), 'weird_id_1_x.json');
  const app = fs.readFileSync(path.join(ROOT, 'site', 'assets', 'app.js'), 'utf8');
  assert.ok(app.includes("id.replace(/[^a-z0-9._-]/gi, '_')"), 'app.js must use the same replacement as pluginFile()');
});

test('no forum data: the site still builds and the Gaps page says so', async () => {
  const none = await build({ forum: false });
  assert.match(read(none.out, 'gaps.html'), /No forum data yet/);
  assert.match(read(none.out, 'index.html'), /No forum data yet/);
  const ideas = JSON.parse(read(none.out, 'ideas.json'));
  assert.deepEqual(ideas.gaps, []);
  assert.deepEqual(checkLinks(none.out).problems, []);
  // and a forum directory that does not exist at all behaves the same
  const d = tmp();
  const r = await buildSite({ snapshotsDir: snaps(path.join(d, 's'), '2026-W43'), directoryFile: DIRECTORY, forumDir: path.join(d, 'nope'), out: path.join(d, 'out'), cfg });
  assert.ok(r.files.includes('gaps.html'));
});

test('with forum data the Gaps page lists clusters with evidence and closest plugins', async () => {
  const { out, analysis } = await build();
  assert.ok(analysis.gaps.clusters.length > 5);
  const gaps = read(out, 'gaps.html');
  assert.match(gaps, /class="gapcard"/);
  assert.match(gaps, /Forum threads/);
  assert.match(gaps, /Closest plugins/);
  assert.match(gaps, /forum\.obsidian\.md\/t\//);
  assert.match(read(out, 'index.html'), /gaps\.html#gap-/);
});

test('Methodology documents the live thresholds from config.json and its anchors exist', async () => {
  const { out } = await build();
  const m = read(out, 'methodology.html');
  const a = cfg.abandonment;
  assert.match(m, new RegExp(`downloads ≥ ${a.minDownloads.toLocaleString('en-US')}`));
  assert.match(m, new RegExp(`quiet for ≥ ${a.quietDays} days`));
  assert.ok(m.includes(`${cfg.gaps.gapBelow}</strong> it is a <em>likely gap</em>`));
  for (const id of ['principles', 'data', 'growth', 'maintainers', 'gaps', 'similar', 'limits', 'pause', 'ideas']) assert.ok(m.includes(`id="${id}"`), `no #${id}`);
  assert.match(m, /History begins at the first snapshot/);
  assert.match(m, /Summary in Spanish/);
  assert.match(m, /Disable workflow/);
});

test('sparkline: needs two usable points, skips gaps, one 2px line, no author of numbers in markup', () => {
  assert.equal(sparkline([], 'x'), '');
  assert.equal(sparkline([5], 'x'), '');
  assert.equal(sparkline([null, 5], 'x'), '');
  const svg = sparkline([1, null, 5, 9], 'gain');
  assert.match(svg, /<svg class="spark"/);
  assert.match(svg, /aria-label="gain"/);
  assert.match(svg, /stroke-width="2"/);
  assert.equal((svg.match(/<path /g) ?? []).length, 1);
  assert.doesNotMatch(svg, /NaN/);
  assert.doesNotMatch(sparkline([3, 3, 3], 'flat'), /NaN/, 'a flat series does not divide by zero');
});
