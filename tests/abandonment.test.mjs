import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { readSnapshot } from '../lib/snapshot.mjs';
import { assess, analyzeAbandonment, lastActivity } from '../lib/abandonment.mjs';
import { analyzeGrowth } from '../lib/growth.mjs';
import { DAY } from '../lib/week.mjs';
import { snap } from './helpers/snap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig();
const NOW = new Date('2026-10-24T00:00:00Z');
const ago = (days) => new Date(+NOW - days * DAY).toISOString().slice(0, 10);
const rec = (o) => ({ dl: 100000, chk: '2026-10-20', iss: 100, ...o });
const a = (r) => assess(r, { cfg, now: NOW });

test('score, hand-computed: 100k downloads, quiet 730 days, 100 open issues -> 40*0.5 + 30*0.5 + 30*1 = 65', () => {
  const r = a(rec({ rel: ago(730), push: ago(730) }));
  assert.equal(r.eligible, true);
  assert.equal(r.quietDays, 730);
  assert.deepEqual(r.parts, { loved: 0.5, quiet: 0.5, issues: 1 });
  assert.equal(r.score, 65);
  assert.equal(r.provisional, false);
});

test('score components saturate at 1 and start at 0', () => {
  const lo = a(rec({ dl: 10000, rel: ago(365), push: ago(365), iss: 5 }));
  assert.deepEqual(lo.parts, { loved: 0, quiet: 0, issues: 0.388 }); // log10(6)/log10(101)
  assert.equal(lo.score, 11.6);                                       // 30 * 0.388
  const hi = a(rec({ dl: 5_000_000, rel: ago(5000), push: ago(5000), iss: 4000 }));
  assert.deepEqual(hi.parts, { loved: 1, quiet: 1, issues: 1 });
  assert.equal(hi.score, 100);
});

test('without GitHub metadata the entry is provisional: issues are left out and the other weights are rescaled', () => {
  const r = a({ dl: 100000, rel: ago(730) });
  assert.equal(r.eligible, true);
  assert.equal(r.provisional, true);
  assert.equal(r.parts.issues, null);
  assert.equal(r.score, 50, '(40*0.5 + 30*0.5) / 70 * 100 = 50');
  assert.equal(a(rec({ rel: ago(730), push: ago(730), iss: undefined })).provisional, true, 'checked but issue count unknown');
});

test('gate: downloads (10,000 inclusive)', () => {
  assert.equal(a(rec({ dl: 9999, rel: ago(900), push: ago(900) })).reason, 'downloads');
  assert.equal(a(rec({ dl: 10000, rel: ago(900), push: ago(900) })).eligible, true);
});

test('gate: quiet for at least 365 days (inclusive), measured from the LATER of last push and latest release', () => {
  assert.equal(a(rec({ rel: ago(364), push: ago(364) })).reason, 'active');
  assert.equal(a(rec({ rel: ago(365), push: ago(365) })).eligible, true);
  assert.equal(a(rec({ rel: ago(900), push: ago(100) })).reason, 'active', 'pushed recently');
  assert.equal(a(rec({ rel: ago(100), push: ago(900) })).reason, 'active', 'released recently');
  assert.equal(a(rec({ rel: ago(900), push: ago(500) })).quietDays, 500);
  assert.equal(lastActivity({ rel: '2024-01-01', push: '2025-01-01' }), '2025-01-01');
  assert.equal(lastActivity({ rel: '2024-01-01' }), '2024-01-01');
  assert.equal(lastActivity({}), null);
  assert.equal(a({ dl: 50000 }).reason, 'no-activity-data');
});

test('gate: archived and unreachable repositories are not in the list', () => {
  assert.equal(a(rec({ rel: ago(900), push: ago(900), arch: 1 })).reason, 'archived');
  assert.equal(a(rec({ rel: ago(900), push: ago(900), gone: 1 })).reason, 'unreachable');
});

test('gate: "many open issues" (5 inclusive) applies only once the issue count is known', () => {
  assert.equal(a(rec({ rel: ago(900), push: ago(900), iss: 4 })).reason, 'few-issues');
  assert.equal(a(rec({ rel: ago(900), push: ago(900), iss: 5 })).eligible, true);
  assert.equal(a({ dl: 50000, rel: ago(900) }).eligible, true, 'unknown issues: shown as provisional, not dropped');
});

const directory = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map((id) => ({ id, name: `Plugin ${id}`, author: 'someone', description: 'x', repo: `someone/${id}` }));

test('ranking: score first, then downloads, then id; archived and unreachable are listed apart', () => {
  const latest = snap('2026-W43', {
    p1: rec({ dl: 100000, rel: ago(730), push: ago(730) }),                    // 65
    p2: rec({ dl: 100000, rel: ago(730), push: ago(730) }),                    // 65, same downloads -> id order
    p3: rec({ dl: 1000000, rel: ago(730), push: ago(730), iss: 100 }),        // 40*1 + 15 + 30 = 85
    p4: rec({ dl: 200000, rel: ago(730), push: ago(730), iss: 100 }),         // L = log10(20)/2 = 0.6505 -> 26.02+15+30 = 71.0
    p5: rec({ dl: 300000, rel: ago(900), push: ago(900), arch: 1 }),
    p6: rec({ dl: 400000, rel: ago(900), push: ago(900), gone: 1 }),
    p7: rec({ dl: 500, rel: ago(900), push: ago(900) }),
  });
  const r = analyzeAbandonment({ latest, directory, cfg, now: NOW });
  assert.deepEqual(r.list.map((x) => [x.id, x.score]), [['p3', 85], ['p4', 71], ['p1', 65], ['p2', 65]]);
  assert.deepEqual(r.archived.map((x) => x.id), ['p5']);
  assert.deepEqual(r.unreachable.map((x) => x.id), ['p6']);
  assert.deepEqual(r.meta, { week: '2026-W43', asOf: '2026-10-24', candidates: 4, verified: 4, provisional: 0, archived: 1, unreachable: 1 });
  assert.equal(r.list[0].name, 'Plugin p3');
  assert.equal(r.list[0].repo, 'someone/p3');
});

test('weekly downloads from the growth analysis are attached as "still in use" evidence', () => {
  const prev = snap('2026-W42', { p1: rec({ dl: 99000, rel: ago(730), push: ago(730) }) });
  const latest = snap('2026-W43', { p1: rec({ dl: 100000, rel: ago(730), push: ago(730) }) });
  const growth = analyzeGrowth({ snaps: [prev, latest], directory, cfg, now: NOW });
  const r = analyzeAbandonment({ latest, directory, growth, cfg, now: NOW });
  assert.equal(r.list[0].weekly, 1000);
});

test('topN limits the list but not the candidate count', () => {
  const data = {};
  const dir = [];
  for (let i = 0; i < 120; i++) { data[`q${i}`] = rec({ dl: 20000 + i, rel: ago(800), push: ago(800) }); dir.push({ id: `q${i}`, name: `Q${i}`, repo: `x/q${i}` }); }
  const r = analyzeAbandonment({ latest: snap('2026-W43', data), directory: dir, cfg, now: NOW });
  assert.equal(r.meta.candidates, 120);
  assert.equal(r.list.length, cfg.abandonment.topN);
});

test('real 2026-W43 sample (no GitHub metadata yet): every candidate is provisional and matches an independent filter', () => {
  const latest = readSnapshot(path.join(ROOT, 'fixtures', 'snapshots', '2026-W43.json.gz'));
  const now = new Date('2026-10-24T05:00:00Z');
  const r = analyzeAbandonment({ latest, directory: [], cfg, now });
  const expected = Object.entries(latest.data)
    .filter(([, x]) => x.dl >= 10000 && x.rel && (+now - Date.parse(`${x.rel}T00:00:00Z`)) / DAY >= 365)
    .map(([id]) => id).sort();
  assert.ok(expected.length > 10, 'the sample contains popular-but-quiet plugins');
  assert.deepEqual(r.list.map((x) => x.id).sort(), expected);
  assert.ok(r.list.every((x) => x.provisional));
  assert.equal(r.list[0].id, 'calendar');
  const scores = r.list.map((x) => x.score);
  assert.deepEqual(scores, [...scores].sort((x, y) => y - x));
});
