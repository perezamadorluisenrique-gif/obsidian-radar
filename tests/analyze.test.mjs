import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execFileP = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'fixtures');
const tmp = () => fs.mkdtempSync(path.join(process.env.RADAR_SCORE_TMP || os.tmpdir(), 'radar-analyze-'));
const analyze = (args, env = {}) => execFileP('node', [path.join(ROOT, 'scripts', 'analyze.mjs'), ...(args.includes('--forum') ? [] : ['--forum', 'none']), ...args], { cwd: ROOT, env: { ...process.env, RADAR_NOW: '', ...env } }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
const copy = (dir, ...weeks) => { fs.mkdirSync(dir, { recursive: true }); for (const w of weeks) fs.copyFileSync(path.join(FX, 'snapshots', `${w}.json.gz`), path.join(dir, `${w}.json.gz`)); };
const DIRECTORY = path.join(FX, 'releases', 'community-plugins.json');

test('analyze.mjs on the two fixture weeks writes analysis.json with growth and maintainer lists', async () => {
  const d = tmp();
  copy(path.join(d, 'snaps'), '2026-W42', '2026-W43');
  const r = await analyze(['--snapshots', path.join(d, 'snaps'), '--directory', DIRECTORY, '--out', path.join(d, 'analysis.json')]);
  assert.equal(r.code, 0, r.stderr);
  const a = JSON.parse(fs.readFileSync(path.join(d, 'analysis.json'), 'utf8'));
  assert.equal(a.schema, 1);
  assert.equal(a.week, '2026-W43');
  assert.equal(a.asOf, '2026-10-24', 'defaults to the capture day of the newest snapshot, not the wall clock');
  assert.equal(a.growth.meta.previousWeek, '2026-W42');
  assert.deepEqual(a.growth.lists.absolute.slice(0, 3), ['templater-obsidian', 'obsidian-excalidraw-plugin', 'copilot']);
  assert.ok(a.abandonment.list.length > 10);
  assert.equal(a.abandonment.list[0].id, 'calendar');
  assert.equal(a.abandonment.list[0].name, 'Calendar');
  assert.match(r.stdout, /\+4 new, -2 removed/);
});

test('analyze.mjs is reproducible: same snapshots, same bytes, whatever the wall clock says', async () => {
  const d = tmp();
  copy(path.join(d, 'snaps'), '2026-W42', '2026-W43');
  const run = (out) => analyze(['--snapshots', path.join(d, 'snaps'), '--directory', DIRECTORY, '--out', out]);
  await run(path.join(d, 'a.json'));
  await run(path.join(d, 'b.json'));
  assert.equal(fs.readFileSync(path.join(d, 'a.json'), 'utf8'), fs.readFileSync(path.join(d, 'b.json'), 'utf8'));
});

test('analyze.mjs with a single snapshot is a clear baseline, not an error', async () => {
  const d = tmp();
  copy(path.join(d, 'snaps'), '2026-W43');
  const r = await analyze(['--snapshots', path.join(d, 'snaps'), '--directory', DIRECTORY, '--out', path.join(d, 'analysis.json')]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /baseline/);
  const a = JSON.parse(fs.readFileSync(path.join(d, 'analysis.json'), 'utf8'));
  assert.equal(a.growth.meta.baseline, true);
  assert.deepEqual(a.growth.lists.absolute, []);
  assert.ok(a.abandonment.meta.provisional > 0 && a.abandonment.meta.verified === 0);
});

test('analyze.mjs with no snapshots fails with a message that says what to do', async () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'snaps'));
  const r = await analyze(['--snapshots', path.join(d, 'snaps'), '--directory', DIRECTORY, '--out', path.join(d, 'x.json')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no snapshots/);
});

test('analyze.mjs still works when the directory file is missing and offline: names fall back to ids', async () => {
  const d = tmp();
  copy(path.join(d, 'snaps'), '2026-W42', '2026-W43');
  const r = await analyze(['--snapshots', path.join(d, 'snaps'), '--directory', path.join(d, 'nope.json'), '--out', path.join(d, 'a.json')], { RADAR_RELEASES_BASE: path.join(d, 'no-such-dir') });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /names will fall back to plugin ids/);
  const a = JSON.parse(fs.readFileSync(path.join(d, 'a.json'), 'utf8'));
  assert.equal(a.abandonment.list[0].name, a.abandonment.list[0].id);
});

// ---- forum gaps + ideas.json -------------------------------------------------------------------------------------
import { validate } from '../lib/schema.mjs';
import { buildIdeas } from '../lib/ideas.mjs';
import { loadConfig } from '../lib/config.mjs';

const IDEAS_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'ideas.schema.json'), 'utf8'));
const forumDir = (dir, state = 'ok') => {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FX, 'forum', 'topics.json'), path.join(dir, 'topics.json'));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ fetchedAt: '2026-10-24T05:00:00.000Z', source: 'https://forum.obsidian.md', requests: 3, failures: 0, topics: 140, perCategory: { 8: 110, 10: 30 }, kept: 'new', state }));
};
// the fixture forum is paired with the fixture directory of 168 plugins, as the real pipeline pairs forum with directory
const withForum = async (extra = []) => {
  const d = tmp();
  copy(path.join(d, 'snaps'), '2026-W42', '2026-W43');
  forumDir(path.join(d, 'forum'));
  const args = ['--snapshots', path.join(d, 'snaps'), '--directory', DIRECTORY, '--forum', path.join(d, 'forum'), '--out', path.join(d, 'analysis.json'), ...extra];
  return { d, args, run: () => analyze(args) };
};

test('analyze.mjs --ideas writes a schema-valid ideas.json with evidence links; without the flag it writes none', async () => {
  const { d, args, run } = await withForum();
  let r = await run();
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(d, 'ideas.json')), 'ideas.json is opt-in');
  assert.match(r.stdout, /gaps: 140 forum topics/);
  r = await analyze([...args, '--ideas', path.join(d, 'ideas.json')]);
  assert.equal(r.code, 0, r.stderr);
  const ideas = JSON.parse(fs.readFileSync(path.join(d, 'ideas.json'), 'utf8'));
  assert.deepEqual(validate(IDEAS_SCHEMA, ideas), []);
  assert.equal(ideas.week, '2026-W43');
  assert.equal(ideas.forum.state, 'ok');
  assert.ok(ideas.gaps.length > 5 && ideas.maintainersWanted.length > 5);
  for (const g of ideas.gaps) assert.ok(g.rank > 0 && g.evidence.every((e) => e.url.startsWith('https://forum.obsidian.md/t/')));
  for (const m of ideas.maintainersWanted) assert.match(m.evidence.directory, /^https:\/\/obsidian\.md\/plugins\?id=/);
  assert.deepEqual(ideas.gaps.map((g) => g.rank), ideas.gaps.map((g) => g.rank).sort((a, b) => b - a));
});

test('ideas.json never names plugin authors (maintainer-wanted is about plugins, not people)', async () => {
  const { d, args } = await withForum();
  await analyze([...args, '--ideas', path.join(d, 'ideas.json')]);
  const text = fs.readFileSync(path.join(d, 'ideas.json'), 'utf8');
  const dir = JSON.parse(fs.readFileSync(DIRECTORY, 'utf8'));
  const pluginWords = new Set(dir.flatMap((p) => [p.id, p.name])); // a few authors are named like their plugin; that is not a leak
  const authors = new Set(dir.map((p) => p.author).filter((a) => !pluginWords.has(a)));
  assert.ok(authors.size > 20);
  for (const a of authors) if (a.length > 3) assert.ok(!text.includes(`"${a}"`), `author "${a}" appears in ideas.json`);
  assert.ok(!/"author"/.test(text));
  for (const m of JSON.parse(text).maintainersWanted) if (m.evidence.repository) assert.ok(!('author' in m));
});

test('analyze.mjs and ideas.json are reproducible byte for byte', async () => {
  const { d, args } = await withForum();
  await analyze([...args, '--ideas', path.join(d, 'a.json')]);
  await analyze([...args, '--ideas', path.join(d, 'b.json')]);
  assert.equal(fs.readFileSync(path.join(d, 'a.json'), 'utf8'), fs.readFileSync(path.join(d, 'b.json'), 'utf8'));
});

test('no forum data (never fetched, or --forum none) still analyses; ideas.json then has no gaps and says so', async () => {
  const d = tmp();
  copy(path.join(d, 'snaps'), '2026-W42', '2026-W43');
  for (const forum of ['none', path.join(d, 'no-such-dir')]) {
    const r = await analyze(['--snapshots', path.join(d, 'snaps'), '--directory', DIRECTORY, '--forum', forum, '--out', path.join(d, 'analysis.json'), '--ideas', path.join(d, 'ideas.json')]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /gaps: no forum data, skipped/);
    const ideas = JSON.parse(fs.readFileSync(path.join(d, 'ideas.json'), 'utf8'));
    assert.deepEqual(validate(IDEAS_SCHEMA, ideas), []);
    assert.deepEqual(ideas.gaps, []);
    assert.equal(ideas.forum, null);
    assert.ok(ideas.maintainersWanted.length > 0);
  }
});

test('a forum that failed on its last run: the earlier topics are still used and the state is reported', async () => {
  const d = tmp();
  copy(path.join(d, 'snaps'), '2026-W42', '2026-W43');
  forumDir(path.join(d, 'forum'), 'failed');
  await analyze(['--snapshots', path.join(d, 'snaps'), '--directory', DIRECTORY, '--forum', path.join(d, 'forum'), '--out', path.join(d, 'analysis.json'), '--ideas', path.join(d, 'ideas.json')]);
  const ideas = JSON.parse(fs.readFileSync(path.join(d, 'ideas.json'), 'utf8'));
  assert.equal(ideas.forum.state, 'failed');
  assert.ok(ideas.gaps.length > 0);
});

test('ideas.schema.json rejects broken documents (it is a real gate, not decoration)', async () => {
  const { d, args } = await withForum();
  await analyze([...args, '--ideas', path.join(d, 'ideas.json')]);
  const good = JSON.parse(fs.readFileSync(path.join(d, 'ideas.json'), 'utf8'));
  const clone = () => JSON.parse(JSON.stringify(good));
  const bad = [
    (x) => { delete x.gaps; },
    (x) => { x.gaps[0].evidence = []; },
    (x) => { x.gaps[0].evidence[0].url = 'not a url'; },
    (x) => { x.gaps[0].coverage = 3; },
    (x) => { x.gaps[0].status = 'maybe'; },
    (x) => { x.maintainersWanted[0].score = 101; },
    (x) => { x.maintainersWanted[0].extra = 1; },
    (x) => { x.week = '2026-43'; },
    (x) => { x.schema = 2; },
  ];
  for (const [i, f] of bad.entries()) { const x = clone(); f(x); assert.ok(validate(IDEAS_SCHEMA, x).length > 0, `mutation ${i} passed validation`); }
});

test('buildIdeas honours the configured list sizes', () => {
  const cfg = loadConfig();
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, repo: `o/p${i}`, dl: 20000, weekly: null, issues: null, stars: null, score: 50, provisional: true, lastActivity: '2024-01-01', quietDays: 600 }));
  const cl = (n) => Array.from({ length: n }, (_, i) => ({ id: `gap-${i + 1}`, title: 't', terms: [], topics: 1, likes: 1, views: 1, status: 'likely-gap', coverage: 0, rank: 1 + i, appLevel: false, first: '2025-01-01', last: '2025-01-02', closestPlugins: [], evidence: [{ title: 't', url: 'https://f/t/1', likes: 1, created: '2025-01-01' }] }));
  const analysis = { week: '2026-W43', asOf: '2026-10-24', forum: null, gaps: { clusters: cl(80) }, abandonment: { list: mk(90), archived: mk(40) }, growth: { meta: { snapshots: 1, firstWeek: '2026-W43' }, totals: { plugins: 9 } } };
  const ideas = buildIdeas({ analysis, cfg: { ideas: { gaps: 3, maintainers: 4, archived: 2 } } });
  assert.deepEqual([ideas.gaps.length, ideas.maintainersWanted.length, ideas.archivedByAuthors.length], [3, 4, 2]);
  assert.deepEqual(validate(IDEAS_SCHEMA, buildIdeas({ analysis, cfg })), []);
});
