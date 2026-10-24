import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { readSnapshot } from '../lib/snapshot.mjs';
import { analyzeGrowth, weeksApart, direction, estimateListingDays, weeklyRates, downloadSeries } from '../lib/growth.mjs';
import { snap } from './helpers/snap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig();
const NOW = new Date('2026-10-24T05:00:00Z');
const run = (snaps, directory = [], now = NOW) => analyzeGrowth({ snaps, directory, cfg, now });
const dl = (n, extra = {}) => ({ dl: n, ...extra });

test('weeksApart counts ISO weeks, across year ends, and is at least 1', () => {
  assert.equal(weeksApart({ week: '2026-W42' }, { week: '2026-W43' }), 1);
  assert.equal(weeksApart({ week: '2025-W52' }, { week: '2026-W01' }), 1);
  assert.equal(weeksApart({ week: '2020-W53' }, { week: '2021-W01' }), 1);
  assert.equal(weeksApart({ week: '2026-W41' }, { week: '2026-W43' }), 2);
  assert.equal(weeksApart({ week: '2026-W43' }, { week: '2026-W43' }), 1);
});

test('weekly delta and relative growth, hand-computed', () => {
  const g = run([
    snap('2026-W42', { a: dl(1000), b: dl(200), c: dl(50) }),
    snap('2026-W43', { a: dl(1100), b: dl(239), c: dl(70), d: dl(5) }),
  ]);
  assert.equal(g.plugins.a.d1, 100);
  assert.equal(g.plugins.a.r1, 0.1);
  assert.equal(g.plugins.b.d1, 39);
  assert.equal(g.plugins.b.r1, 39 / 200);
  assert.equal(g.plugins.c.d1, 20);
  assert.equal(g.plugins.d.d1, null);
  assert.deepEqual(g.lists.absolute, ['a', 'b', 'c']);
  assert.deepEqual(g.lists.relative, ['b', 'a'], 'c is excluded: its base (50) is below minBase');
  assert.deepEqual(g.lists.added, ['d']);
  assert.deepEqual(g.lists.removed, []);
  assert.equal(g.totals.weeklyDownloads, 159);
  assert.equal(g.totals.downloads, 1100 + 239 + 70 + 5);
  assert.equal(g.meta.baseline, false);
});

test('a gap of two weeks between snapshots is averaged, not counted as one big week', () => {
  const g = run([snap('2026-W41', { a: dl(1000) }), snap('2026-W43', { a: dl(1100) })]);
  assert.equal(g.plugins.a.d1, 50);
  assert.equal(g.plugins.a.r1, 0.05);
});

test('relative ranking thresholds: base >= minBase and gain >= minDelta, boundaries inclusive', () => {
  const g = run([
    snap('2026-W42', { atBase: dl(200), belowBase: dl(199), atDelta: dl(1000), belowDelta: dl(1000) }),
    snap('2026-W43', { atBase: dl(260), belowBase: dl(259), atDelta: dl(1020), belowDelta: dl(1019) }),
  ]);
  assert.deepEqual(g.lists.relative, ['atBase', 'atDelta'], 'atBase 30%, atDelta 2%; the other two sit just below a threshold');
  assert.deepEqual(g.lists.absolute, ['atBase', 'belowBase', 'atDelta', 'belowDelta'].sort((a, b) => g.plugins[b].d1 - g.plugins[a].d1 || g.plugins[b].dl - g.plugins[a].dl));
});

test('ties are broken by total downloads, then by id (stable, deterministic)', () => {
  const g = run([
    snap('2026-W42', { b: dl(100), a: dl(100), c: dl(1000) }),
    snap('2026-W43', { b: dl(150), a: dl(150), c: dl(1050) }),
  ]);
  assert.deepEqual(g.lists.absolute, ['c', 'a', 'b'], 'all gained 50; c has the most downloads, then a before b');
});

test('a download count that goes down is an anomaly: counted, excluded from rankings, never negative growth', () => {
  const g = run([snap('2026-W42', { a: dl(1000), b: dl(1000) }), snap('2026-W43', { a: dl(900), b: dl(1100) })]);
  assert.equal(g.plugins.a.d1, null);
  assert.equal(g.totals.anomalies, 1);
  assert.deepEqual(g.lists.absolute, ['b']);
  assert.equal(g.totals.weeklyDownloads, 100);
});

test('direction(): up / down / flat, with the exact boundaries', () => {
  const o = { trendFlat: cfg.growth.trendFlat, trendMinRate: cfg.growth.trendMinRate };
  assert.equal(direction([100, 110, 240, 450], o), 'up');
  assert.equal(direction([450, 240, 110, 100], o), 'down');
  assert.equal(direction([100, 100, 100, 100], o), 'flat');
  assert.equal(direction([1, 2, 3, 4], o), 'flat', 'both halves below trendMinRate');
  assert.equal(direction([10, 10, 100], o), 'up', 'three points: recent = last two, earlier = first one');
  assert.equal(direction([100, 50, 10], o), 'down');
  assert.equal(direction([7, 9], o), 'up', '(9+1)/(7+1) = 1.25 exactly');
  assert.equal(direction([9, 7], o), 'down', '(7+1)/(9+1) = 0.8 exactly');
  assert.equal(direction([7, 8], o), 'flat');
  assert.equal(direction([100], o), null);
  assert.equal(direction([null, 100, null], o), null, 'unusable points are ignored');
});

test('4-week trend over five snapshots', () => {
  const W = ['2026-W39', '2026-W40', '2026-W41', '2026-W42', '2026-W43'];
  const series = {
    x: [1000, 1100, 1210, 1450, 1900], // +100 +110 +240 +450
    y: [1900, 2350, 2590, 2700, 2800], // +450 +240 +110 +100
    z: [0, 100, 200, 300, 400],
    q: [0, 1, 3, 6, 10],
  };
  const g = run(W.map((w, i) => snap(w, Object.fromEntries(Object.entries(series).map(([k, v]) => [k, dl(v[i])])))));
  assert.deepEqual(g.plugins.x.tr, [100, 110, 240, 450]);
  assert.equal(g.plugins.x.avg, 225);
  assert.equal(g.plugins.x.dir, 'up');
  assert.equal(g.plugins.y.dir, 'down');
  assert.equal(g.plugins.z.dir, 'flat');
  assert.equal(g.plugins.q.dir, 'flat');
  assert.equal(g.meta.trendWeeks, 4);
});

test('trend uses only the last trendWeeks intervals and skips intervals where the plugin did not exist', () => {
  const g = run([
    snap('2026-W38', { m: dl(1) }),
    snap('2026-W39', { m: dl(200) }),
    snap('2026-W40', { m: dl(300) }),
    snap('2026-W41', { m: dl(400) }),
    snap('2026-W42', { m: dl(500) }),
    snap('2026-W43', { m: dl(600) }),
  ]);
  assert.deepEqual(g.plugins.m.tr, [100, 100, 100, 100], 'the W38 -> W39 interval (+199) is outside the last 4 intervals');
  const h = run([snap('2026-W40', { m: dl(100) }), snap('2026-W41', { }), snap('2026-W42', { m: dl(300) }), snap('2026-W43', { m: dl(400) })]);
  assert.deepEqual(h.plugins.m.tr, [null, null, 100]);
  assert.equal(h.plugins.m.avg, 100);
  assert.equal(h.plugins.m.dir, null, 'one usable interval is not a trend');
});

test('two snapshots: one interval, no direction yet', () => {
  const g = run([snap('2026-W42', { a: dl(100) }), snap('2026-W43', { a: dl(160) })]);
  assert.deepEqual(g.plugins.a.tr, [60]);
  assert.equal(g.plugins.a.dir, null);
  assert.equal(g.meta.trendWeeks, 1);
});

test('weeklyRates marks missing and negative intervals as null', () => {
  const hist = [snap('2026-W41', { a: dl(10) }), snap('2026-W42', { a: dl(5) }), snap('2026-W43', { a: dl(25) })];
  assert.deepEqual(weeklyRates(hist, 'a'), [null, 20]);
  assert.deepEqual(weeklyRates(hist, 'zzz'), [null, null]);
});

test('estimateListingDays: low percentile of neighbouring release dates, windowed by list order', () => {
  const dir = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  const first = snap('2026-W43', { a: dl(1, { rel: '2026-01-01' }), b: dl(1, { rel: '2026-01-03' }), c: dl(1, { rel: '2026-01-05' }), d: dl(1, { rel: '2026-01-07' }), e: dl(1, { rel: '2026-01-09' }), f: dl(1) });
  const est = estimateListingDays([...dir, { id: 'f' }], first, 1, 0.25);
  assert.equal(est.get('a'), '2026-01-01');
  assert.equal(est.get('c'), '2026-01-03');
  assert.equal(est.get('e'), '2026-01-07');
  assert.equal(est.has('f'), false, 'no release date, no estimate');
});

test('age: plugins we watched arrive have an exact "seen" date; the first snapshot gets an estimate; crt tightens it', () => {
  const dir = [{ id: 'old' }, { id: 'oldRepoNew' }, { id: 'oldRepoOlder' }, { id: 'mid' }, { id: 'fresh' }];
  const base = { old: dl(5000, { rel: '2026-01-01' }), oldRepoNew: dl(5000, { rel: '2026-01-01' }), oldRepoOlder: dl(5000, { rel: '2026-01-01' }) };
  const g = run([
    snap('2026-W41', base),
    snap('2026-W42', { ...base, mid: dl(100, { rel: '2026-10-14' }) }),
    snap('2026-W43', { old: base.old, oldRepoNew: dl(5000, { rel: '2026-01-01', crt: '2026-09-20' }), oldRepoOlder: dl(5000, { rel: '2026-01-01', crt: '2019-01-01' }), mid: dl(160, { rel: '2026-10-14' }), fresh: dl(40, { rel: '2026-10-22' }) }),
  ], dir);
  const p = g.plugins;
  assert.deepEqual([p.mid.listed, p.mid.ageSrc, p.mid.ageDays, p.mid.newcomer], ['2026-10-12', 'seen', 12, true]);
  assert.deepEqual([p.fresh.listed, p.fresh.ageSrc, p.fresh.ageDays, p.fresh.newcomer, p.fresh.isNew], ['2026-10-19', 'seen', 5, true, true]);
  assert.equal(p.old.ageSrc, 'order');
  assert.equal(p.old.newcomer, false);
  assert.deepEqual([p.oldRepoNew.ageSrc, p.oldRepoNew.listed, p.oldRepoNew.newcomer], ['repo', '2026-09-20', true], 'a repository created last month cannot have been listed longer ago');
  assert.equal(p.oldRepoOlder.ageSrc, 'order', 'an older repository says nothing about the listing date');
  assert.equal(p.oldRepoNew.momentum, 0, 'a newcomer that gained nothing this week is not "rising"');
  assert.deepEqual(g.lists.newcomers, ['mid', 'fresh'], 'ranked by momentum');
  assert.equal(p.mid.momentum, 60, 'listed earlier: its weekly gain');
  assert.equal(p.fresh.momentum, 40, 'listed this week: downloads so far');
});

test('the newcomer window is exactly newcomerDays: 89 days old yes, 90 no', () => {
  const at = (iso) => {
    const g = analyzeGrowth({ snaps: [snap('2026-W30', { x: dl(1) }), snap('2026-W31', { x: dl(1), n: dl(50) }, iso), snap('2026-W43', { x: dl(1), n: dl(60) })], directory: [], cfg, now: new Date('2026-10-24T00:00:00Z') });
    return g.plugins.n;
  };
  assert.deepEqual([at('2026-07-27T05:41:00Z').ageDays, at('2026-07-27T05:41:00Z').newcomer], [89, true]);
  assert.deepEqual([at('2026-07-26T05:41:00Z').ageDays, at('2026-07-26T05:41:00Z').newcomer], [90, false]);
});

test('baseline (first snapshot only): no deltas, no rankings, estimated ages, stated plainly', () => {
  const dir = [{ id: 'a' }];
  const g = run([snap('2026-W43', { a: dl(10, { rel: '2026-10-20' }), b: dl(900, { rel: '2026-03-01' }) })], dir);
  assert.equal(g.meta.baseline, true);
  assert.equal(g.meta.previousWeek, null);
  assert.equal(g.totals.weeklyDownloads, null);
  assert.deepEqual([g.lists.absolute, g.lists.relative, g.lists.added, g.lists.removed], [[], [], [], []]);
  assert.equal(g.plugins.a.d1, null);
  assert.equal(g.plugins.a.ageSrc, 'order');
  assert.deepEqual(g.lists.released, ['a'], 'released within the last 7 days of the capture');
  assert.equal(g.plugins.a.newcomer, true);
  assert.deepEqual([g.plugins.b.ageSrc, g.plugins.b.newcomer], [null, false], 'not in the directory file: age unknown, never guessed');
});

test('added, removed and released compare consecutive snapshots', () => {
  const g = run([
    snap('2026-W42', { a: dl(10, { rel: '2026-10-01' }), b: dl(10, { rel: '2026-10-01' }), gone1: dl(5), gone2: dl(50) }),
    snap('2026-W43', { a: dl(10, { rel: '2026-10-14' }), b: dl(10, { rel: '2026-10-01' }), n1: dl(3, { rel: '2026-10-20' }), n2: dl(8) }),
  ]);
  assert.deepEqual(g.lists.added, ['n2', 'n1'], 'by downloads');
  assert.deepEqual(g.lists.removed, ['gone1', 'gone2']);
  assert.deepEqual(g.lists.released, ['a'], 'new plugins are "added", not "released"');
});

test('growth is deterministic and does not mutate its input', () => {
  const snaps = [snap('2026-W42', { a: dl(1000), b: dl(200) }), snap('2026-W43', { a: dl(1100), b: dl(239), c: dl(4) })];
  const copy = JSON.parse(JSON.stringify(snaps));
  const a = JSON.stringify(run(snaps)), b = JSON.stringify(run(snaps));
  assert.equal(a, b);
  assert.deepEqual(snaps, copy);
});

test('downloadSeries gives each plugin its history across snapshots', () => {
  const s = downloadSeries([snap('2026-W42', { a: dl(1) }), snap('2026-W43', { a: dl(2), b: dl(7) })]);
  assert.deepEqual(s.get('a'), [['2026-W42', 1], ['2026-W43', 2]]);
  assert.deepEqual(s.get('b'), [['2026-W43', 7]]);
});

// ---- the committed fixture pair: a REAL sample of 2026-W43 and a SYNTHETIC 2026-W42 with a known plan ----------
const fx = (w) => readSnapshot(path.join(ROOT, 'fixtures', 'snapshots', `${w}.json.gz`));
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'snapshots', 'plan.json'), 'utf8'));

test('fixtures: real W43 sample + synthetic W42 give exactly the planned answers', () => {
  const w42 = fx('2026-W42'), w43 = fx('2026-W43');
  const g = run([w42, w43]);
  const gain = (id) => w43.data[id].dl - w42.data[id].dl;
  for (const [id, n] of Object.entries(plan.gains)) assert.equal(gain(id), n, `${id} planned gain`);
  assert.deepEqual(g.lists.absolute.slice(0, 3), ['templater-obsidian', 'obsidian-excalidraw-plugin', 'copilot']);
  assert.deepEqual(g.lists.absolute.slice(0, 3).map((id) => g.plugins[id].d1), [30000, 24000, 18000]);
  assert.deepEqual(g.lists.relative.slice(0, 3), ['library', 'xminder', 'base-form']);
  assert.equal(g.plugins.library.r1, 2400 / 2560);
  assert.equal(g.plugins.xminder.r1, 1000 / 2465);
  assert.equal(g.plugins['base-form'].r1, 400 / 2245);
  for (const id of ['lac-costset', 'heading-guard', 'hybrid-line-numbers']) assert.ok(!g.lists.relative.includes(id), `${id} must not be in the relative ranking (tiny base or tiny gain)`);
  assert.ok(g.lists.relative.includes('typography-as-you-type'), 'a gain of exactly minDelta counts');
  assert.deepEqual(g.lists.added, ['book-studio', 'claude-studio', 'markdown-rss', 'simboard']);
  assert.deepEqual(g.lists.removed, ['ghost-plugin-a', 'ghost-plugin-b']);
  assert.deepEqual(g.lists.released.sort(), ['library', 'tasknotes']);
  assert.equal(g.plugins['dice-rolls'].d1, null);
  assert.equal(g.totals.anomalies, 1);
  assert.ok(!g.lists.absolute.includes('dice-rolls'));
  assert.deepEqual(g.lists.newcomers, ['book-studio', 'claude-studio'], 'listed this week with downloads; the two with 0 downloads have no momentum');
  assert.deepEqual([g.plugins['book-studio'].listed, g.plugins['book-studio'].ageDays, g.plugins['book-studio'].momentum], ['2026-10-24', 0, 84]);
  assert.equal(g.totals.plugins, 168);
  assert.equal(g.totals.added, 4);
  assert.equal(g.totals.removed, 2);
  const expected = Object.keys(w42.data).filter((id) => w43.data[id] && w43.data[id].dl >= w42.data[id].dl).reduce((s, id) => s + gain(id), 0);
  assert.equal(g.totals.weeklyDownloads, expected);
  const d = g.lists.absolute.map((id) => g.plugins[id].d1);
  assert.deepEqual(d, [...d].sort((a, b) => b - a), 'absolute ranking is sorted');
  assert.ok(g.lists.absolute.every((id) => g.plugins[id].d1 > 0));
});
