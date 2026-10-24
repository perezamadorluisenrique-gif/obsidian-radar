import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeGaps } from '../lib/gaps.mjs';
import { loadConfig } from '../lib/config.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'forum');

const cfgWith = (over = {}) => { const cfg = loadConfig(); cfg.gaps = { ...cfg.gaps, ...over }; return cfg; };
let nextId = 1;
const topic = (title, likes, extra = {}) => ({
  id: nextId++, title, slug: title.toLowerCase().replace(/\W+/g, '-'), cat: 8, created: '2025-01-01', last: '2025-06-01', views: likes * 10,
  likes, posts: 2, tags: [], closed: false, url: `https://forum.example/t/${nextId}`, ...extra,
});
const plugin = (id, name, description) => ({ id, name, description, repo: `me/${id}` });

// Tiny, hand-checkable world: kanban is covered by a plugin, the pomodoro timer is not, word count is covered.
const PLUGINS = [
  plugin('kanban-board', 'Kanban Board', 'Kanban board view for your tasks and projects'),
  plugin('word-count', 'Word Count', 'Count words and characters in notes'),
  plugin('calendar', 'Calendar', 'Calendar view with daily notes'),
  plugin('git', 'Git', 'Backup your vault to git'),
];
const world = () => {
  nextId = 1;
  return [
    topic('Kanban board for tasks', 30),
    topic('Kanban boards with task columns', 12),
    topic('Pomodoro timer in the status bar', 40),
    topic('Status bar pomodoro timer countdown', 25),
    topic('Pomodoro timer sessions with breaks', 5),
    topic('Count words in a selection', 8),
    topic('Encrypt individual notes with a password', 4),
  ];
};
// The production threshold (0.45) is calibrated on the real corpus (~10k plugins); idf is far flatter in a corpus this
// small, so these hand-sized worlds cluster at 0.3.
const all = { minClusterSize: 1, singleMinLikes: 0, topN: 100, similarity: 0.3 };

test('every topic lands in exactly one cluster', () => {
  const topics = world();
  const r = analyzeGaps({ topics, plugins: PLUGINS, cfg: cfgWith(all) });
  assert.equal(r.clusters.reduce((s, c) => s + c.topics, 0), topics.length);
  assert.equal(r.meta.topics, topics.length);
  assert.equal(r.meta.plugins, PLUGINS.length);
});

test('obvious groups cluster together and unrelated requests stay apart', () => {
  const r = analyzeGaps({ topics: world(), plugins: PLUGINS, cfg: cfgWith(all) });
  const sizes = r.clusters.map((c) => c.topics).sort((a, b) => b - a);
  assert.deepEqual(sizes, [3, 2, 1, 1], 'pomodoro x3, kanban x2, word count, encryption');
  const pomodoro = r.clusters.find((c) => /pomodoro/i.test(c.title));
  assert.equal(pomodoro.topics, 3);
  assert.equal(pomodoro.likes, 70);
  assert.equal(pomodoro.demand, 73, 'sum of (1 + likes)');
  assert.equal(pomodoro.evidence.length, 3);
  assert.deepEqual(pomodoro.evidence.map((e) => e.likes), [40, 25, 5], 'evidence is the most liked requests first');
  assert.ok(pomodoro.terms.includes('pomodoro'));
});

test('a request a plugin already answers is "probably-covered" and ranks last; an unanswered one is a "likely-gap" and ranks first', () => {
  const r = analyzeGaps({ topics: world(), plugins: PLUGINS, cfg: cfgWith(all) });
  const by = (re) => r.clusters.find((c) => re.test(c.title));
  const kanban = by(/kanban/i), pomodoro = by(/pomodoro/i), words = by(/words/i);
  assert.equal(kanban.status, 'probably-covered');
  assert.equal(kanban.closestPlugins[0].id, 'kanban-board');
  assert.equal(kanban.rank, 0, 'covered clusters carry no gap rank');
  assert.equal(words.closestPlugins[0].id, 'word-count');
  assert.equal(pomodoro.status, 'likely-gap');
  assert.equal(pomodoro.coverage, 0, 'no plugin shares a single word with the pomodoro requests');
  assert.deepEqual(pomodoro.closestPlugins, []);
  assert.equal(r.clusters[0].id, pomodoro.id, 'most demand with no plugin comes first');
  assert.equal(pomodoro.rank, 73, 'zero coverage -> rank equals demand');
  assert.ok(r.clusters.indexOf(kanban) > r.clusters.indexOf(pomodoro));
});

test('closest plugins carry similarity, downloads, repo and the request that matched', () => {
  const r = analyzeGaps({ topics: world(), plugins: PLUGINS, downloads: { 'kanban-board': 12345 }, cfg: cfgWith(all) });
  const top = r.clusters.find((c) => /kanban/i.test(c.title)).closestPlugins[0];
  assert.equal(top.id, 'kanban-board');
  assert.equal(top.name, 'Kanban Board');
  assert.equal(top.downloads, 12345);
  assert.equal(top.repo, 'me/kanban-board');
  assert.ok(top.similarity > 0.5 && top.similarity <= 1);
  assert.match(top.matches, /Kanban/);
});

test('coverage is the demand-weighted mean of the requests\' best plugin match', () => {
  nextId = 1;
  const a = topic('Kanban board for tasks', 9), b = topic('Kanban timer', 29);
  const merged = analyzeGaps({ topics: [a, b], plugins: PLUGINS, cfg: cfgWith({ ...all, similarity: 0.05 }) });
  assert.equal(merged.clusters.length, 1, 'they share the word "kanban"');
  // same corpus, every request on its own: each cluster's coverage is then that request's own best match
  const apart = analyzeGaps({ topics: [a, b], plugins: PLUGINS, cfg: cfgWith({ ...all, similarity: 0.999 }) });
  const [fa, fb] = [apart.clusters.find((c) => /board/.test(c.title)).coverage, apart.clusters.find((c) => /timer/.test(c.title)).coverage];
  assert.ok(fa > fb && fb > 0, `the board request fits the kanban plugin better than the timer one (${fa} vs ${fb})`);
  const expected = (10 * fa + 30 * fb) / 40; // weights are 1 + likes
  assert.ok(Math.abs(merged.clusters[0].coverage - expected) <= 0.002, `${merged.clusters[0].coverage} vs ${expected}`);
});

test('small clusters are dropped unless a single request has enough likes; the drop is counted', () => {
  const r = analyzeGaps({ topics: world(), plugins: PLUGINS, cfg: cfgWith({ ...all, minClusterSize: 2, singleMinLikes: 20 }) });
  assert.deepEqual(r.clusters.map((c) => c.topics).sort(), [2, 3]);
  assert.equal(r.meta.ignoredSmall, 2);
  assert.equal(r.meta.kept, 2);
  const r2 = analyzeGaps({ topics: world(), plugins: PLUGINS, cfg: cfgWith({ ...all, minClusterSize: 2, singleMinLikes: 8 }) });
  assert.equal(r2.clusters.length, 3, 'the 8-like word count request now qualifies on its own');
});

test('ignored tags do not pull unrelated requests together', () => {
  nextId = 1;
  const topics = [topic('Pomodoro timer', 5, { tags: ['valuable', 'ui-ux'] }), topic('Encrypt notes', 5, { tags: ['valuable', 'ui-ux'] })];
  const withTag = analyzeGaps({ topics, plugins: PLUGINS, cfg: cfgWith({ ...all, similarity: 0.3, ignoreTags: [] }) });
  const without = analyzeGaps({ topics, plugins: PLUGINS, cfg: cfgWith({ ...all, similarity: 0.3, ignoreTags: ['valuable', 'ui-ux'] }) });
  assert.equal(withTag.clusters.length, 1, 'the shared meta tag alone makes them look alike');
  assert.equal(without.clusters.length, 2);
});

test('requests that talk about Obsidian itself are flagged appLevel', () => {
  nextId = 1;
  const topics = [topic('Obsidian Core: portable mode', 30), topic('Pomodoro timer', 20), topic('Sync conflicts on iOS app', 15, { tags: ['ios'] })];
  const r = analyzeGaps({ topics, plugins: PLUGINS, cfg: cfgWith(all) });
  const flag = (re) => r.clusters.find((c) => re.test(c.title)).appLevel;
  assert.equal(flag(/portable/i), true);
  assert.equal(flag(/pomodoro/i), false);
  assert.equal(flag(/sync/i), true);
});

test('deterministic: the same input in any order gives byte-identical output', () => {
  const a = analyzeGaps({ topics: world(), plugins: PLUGINS, cfg: cfgWith(all) });
  const shuffled = world().reverse();
  const b = analyzeGaps({ topics: shuffled, plugins: [...PLUGINS].reverse(), cfg: cfgWith(all) });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('empty inputs do not crash', () => {
  assert.deepEqual(analyzeGaps({ topics: [], plugins: PLUGINS, cfg: cfgWith(all) }).clusters, []);
  const r = analyzeGaps({ topics: world(), plugins: [], cfg: cfgWith(all) });
  assert.ok(r.clusters.every((c) => c.coverage === 0 && c.status === 'likely-gap'));
});

test('pipeline on the real forum fixture: covered requests and gaps both show up, with evidence links', () => {
  const topics = JSON.parse(fs.readFileSync(path.join(FX, 'topics.json'), 'utf8')).topics;
  const plugins = JSON.parse(fs.readFileSync(path.join(FX, 'plugins.json'), 'utf8'));
  const cfg = cfgWith({ minClusterSize: 1, singleMinLikes: 0, topN: 1000 });
  const r = analyzeGaps({ topics, plugins, cfg });
  assert.equal(r.clusters.reduce((s, c) => s + c.topics, 0), topics.length, 'no topic lost or counted twice');
  const status = (s) => r.clusters.filter((c) => c.status === s).length;
  assert.ok(status('likely-gap') >= 5, 'some requests have no plugin');
  assert.ok(status('probably-covered') >= 5, 'some requests already have one');
  for (const c of r.clusters) {
    assert.ok(c.evidence.length >= 1 && c.evidence.every((e) => /^https:\/\/forum\.obsidian\.md\/t\//.test(e.url)));
    assert.ok(c.coverage >= 0 && c.coverage <= 1);
    assert.ok(c.closestPlugins.length <= cfg.gaps.closest);
  }
  assert.deepEqual(r.clusters.map((c) => c.rank), [...r.clusters.map((c) => c.rank)].sort((a, b) => b - a), 'sorted by rank');
  const again = analyzeGaps({ topics: [...topics].reverse(), plugins: [...plugins].reverse(), cfg });
  assert.equal(JSON.stringify(r), JSON.stringify(again), 'order of the input files does not matter');
});
