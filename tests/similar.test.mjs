import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, CATEGORIES, categoryLabel } from '../lib/categories.mjs';
import { similarPlugins, keywords } from '../lib/similar.mjs';

const P = (id, name, description) => ({ id, name, description });
const world = [
  P('git-a', 'Git Sync', 'Back up your vault to a git repository and sync between devices.'),
  P('git-b', 'Git Backup', 'Automatic git backup of the vault to GitHub, with sync on a schedule.'),
  P('kanban', 'Kanban Board', 'Plan tasks and projects on a kanban board with todo columns.'),
  P('todo', 'Todo List', 'Track tasks and todo items; checklist reminders for projects.'),
  P('cal', 'Calendar', 'Browse daily notes and the weekly journal on a calendar.'),
  P('solo', 'Zebra Quokka', 'Xylophone marimba orchestra.'),
];

test('categorize: best category first, ties in the fixed order, capped at max, none for unrelated text', () => {
  assert.deepEqual(categorize(world[2]), ['tasks']);
  assert.equal(categorize(world[0])[0], 'sync');
  assert.deepEqual(categorize(world[5]), []);
  const many = categorize({ name: 'x', description: 'todo calendar sync publish gpt table graph canvas editor import search template citation image theme file jira word count mobile game' }, 3);
  assert.equal(many.length, 3);
  assert.deepEqual(categorize(world[0], 1).length, 1);
  assert.deepEqual(categorize(world[0]), categorize(world[0]), 'deterministic');
  assert.deepEqual(categorize({ name: 'Todo' }), ['tasks'], 'a missing description is fine');
});

test('categories: ids are unique, every regex is global (hit counting) and every id has a label', () => {
  assert.equal(new Set(CATEGORIES.map((c) => c[0])).size, CATEGORIES.length);
  for (const [id, label, re] of CATEGORIES) { assert.ok(re.global, `${id} regex must be /g to count hits`); assert.ok(label && categoryLabel[id] === label); }
});

test('similarPlugins: related plugins find each other, never themselves, unrelated ones find nothing', () => {
  const sim = similarPlugins(world, { n: 3, minSim: 0.1 });
  assert.equal(sim.get('git-a')[0][0], 'git-b');
  assert.equal(sim.get('git-b')[0][0], 'git-a');
  assert.equal(sim.get('kanban')[0][0], 'todo');
  for (const [id, list] of sim) { assert.ok(!list.some(([o]) => o === id), `${id} lists itself`); assert.ok(list.length <= 3); for (const [, s] of list) assert.ok(s >= 0.1 && s <= 1); }
  assert.deepEqual(sim.get('solo'), []);
  const sorted = sim.get('git-a').map(([, s]) => s);
  assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a), 'best first');
});

test('similarPlugins is deterministic and handles empty descriptions', () => {
  const a = [...similarPlugins(world)], b = [...similarPlugins(world)];
  assert.deepEqual(a, b);
  const odd = similarPlugins([P('a', 'A', ''), P('b', 'B', undefined), P('c', 'Alpha tool', 'Alpha tool')]);
  assert.equal(odd.size, 3);
});

test('keywords: name terms first, deduplicated, capped', () => {
  const k = keywords(world, 5);
  assert.equal(k.length, world.length);
  assert.ok(k[2].length <= 5);
  assert.ok(k[2].includes('kanban'));
  assert.equal(new Set(k[0]).size, k[0].length);
});
