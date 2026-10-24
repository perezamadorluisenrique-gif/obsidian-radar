import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { fetchForum, normalizeTopic, readForum } from '../lib/forum.mjs';
import { startMockDiscourse, fixtureTopics, toRaw } from './helpers/mock-discourse.mjs';
const execFileP = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(process.env.RADAR_SCORE_TMP || os.tmpdir(), 'radar-forum-'));
const noSleep = async () => {};
const quick = () => { const cfg = loadConfig(); cfg.forum = { ...cfg.forum, pages: 6, latestPages: 2, delayMs: 0, retries: 0, timeoutMs: 3000, maxFailures: 3 }; return cfg; };
const run = (base, out, cfg = quick(), extra = {}) => fetchForum({ base, cfg, outDir: out, now: new Date('2026-10-24T05:00:00Z'), sleep: noSleep, ...extra });

test('normalizeTopic keeps the compact record: day strings, tag names (strings or objects), HTML entities decoded', () => {
  const t = normalizeTopic({
    id: 7, title: 'Tables &amp; &quot;lists&quot; &lt;3', slug: 'tables-lists', category_id: 8, created_at: '2025-03-04T23:59:59.000Z',
    last_posted_at: '2026-01-02T00:00:01.000Z', views: 120, like_count: 9, posts_count: 4, tags: ['bases', { id: 1, name: 'canvas', slug: 'canvas' }], closed: false,
  }, 'https://forum.example/', 8);
  assert.deepEqual(t, {
    id: 7, title: 'Tables & "lists" <3', slug: 'tables-lists', cat: 8, created: '2025-03-04', last: '2026-01-02', views: 120, likes: 9, posts: 4,
    tags: ['bases', 'canvas'], closed: false, url: 'https://forum.example/t/tables-lists/7',
  });
});

test('normalizeTopic falls back sensibly when optional fields are missing', () => {
  const t = normalizeTopic({ id: 1, title: 'x', slug: 'x', created_at: '2025-01-01T00:00:00Z' }, 'https://f', 10);
  assert.equal(t.cat, 10);
  assert.equal(t.last, '2025-01-01');
  assert.deepEqual([t.views, t.likes, t.posts, t.tags.length, t.closed], [0, 0, 1, 0, false]);
});

test('fetchForum: a healthy forum gives state ok, deduplicated sorted topics, no category-description topics, tag names', async () => {
  const mock = await startMockDiscourse();
  try {
    const out = tmp();
    const s = await run(mock.url, out);
    const want = fixtureTopics();
    assert.equal(s.state, 'ok');
    assert.equal(s.kept, 'new');
    assert.equal(s.failures, 0);
    assert.equal(s.topics, want.length, 'every fixture topic arrives exactly once even though top/yearly, top/all and latest all list it');
    const { topics, status } = readForum(out);
    assert.equal(topics.schema, 1);
    assert.deepEqual(topics.topics.map((t) => t.id), want.map((t) => t.id).sort((a, b) => a - b));
    assert.ok(!topics.topics.some((t) => /^About the/.test(t.title)), 'the "About the ... category" topic is not a request');
    for (const t of topics.topics) for (const tag of t.tags) assert.equal(typeof tag, 'string');
    const got = topics.topics.find((t) => t.id === want[0].id);
    assert.deepEqual({ ...got, url: got.url.replace(mock.url, 'https://forum.obsidian.md') }, want[0], 'raw -> normalized round-trips the fixture (the url follows the base)');
    assert.equal(status.state, 'ok');
    assert.equal(status.source, mock.url);
    assert.equal(status.perCategory[8] + status.perCategory[10], want.length);
  } finally { await mock.close(); }
});

test('fetchForum: stops paging a listing when the forum says there is no more', async () => {
  const mock = await startMockDiscourse({ pageSize: 1000 }); // everything on page 0, no more_topics_url
  try {
    const cfg = quick();
    await run(mock.url, tmp(), cfg);
    // 2 categories x (2 top periods + latest) = 6 listings, one page each
    assert.equal(mock.state.requests.length, 6, mock.state.requests.join('\n'));
  } finally { await mock.close(); }
});

test('fetchForum: a forum that is down never throws; no earlier data -> state failed, nothing written', async () => {
  const mock = await startMockDiscourse({ fail: () => 503 });
  try {
    const out = tmp();
    const s = await run(mock.url, out);
    assert.equal(s.state, 'failed');
    assert.equal(s.kept, 'none');
    assert.equal(s.topics, 0);
    assert.ok(s.failures >= 1 && s.failures <= 3, 'gives up after maxFailures in a row instead of hammering the server');
    assert.ok(!fs.existsSync(path.join(out, 'topics.json')));
    assert.equal(readForum(out).status.state, 'failed');
  } finally { await mock.close(); }
});

test('fetchForum: with earlier data on disk, a failed run leaves it untouched (byte for byte)', async () => {
  const good = await startMockDiscourse();
  const out = tmp();
  try { await run(good.url, out); } finally { await good.close(); }
  const before = fs.readFileSync(path.join(out, 'topics.json'));
  const bad = await startMockDiscourse({ fail: () => 500 });
  try {
    const s = await run(bad.url, out);
    assert.equal(s.state, 'failed');
    assert.equal(s.kept, 'previous');
    assert.equal(s.topics, fixtureTopics().length, 'status reports the topics still in use');
    assert.equal(Buffer.compare(before, fs.readFileSync(path.join(out, 'topics.json'))), 0);
  } finally { await bad.close(); }
});

test('fetchForum: a run that returns far fewer topics than before is "too-few" and does not replace the data', async () => {
  const good = await startMockDiscourse();
  const out = tmp();
  try { await run(good.url, out); } finally { await good.close(); }
  const before = fs.readFileSync(path.join(out, 'topics.json'));
  const thin = await startMockDiscourse({ topics: fixtureTopics().slice(0, 10), extras: false });
  try {
    const s = await run(thin.url, out);
    assert.equal(s.state, 'too-few');
    assert.equal(s.kept, 'previous');
    assert.match(s.error, /kept the previous data/);
    assert.equal(Buffer.compare(before, fs.readFileSync(path.join(out, 'topics.json'))), 0);
  } finally { await thin.close(); }
});

test('fetchForum: some failing pages -> state partial, what arrived is saved', async () => {
  const mock = await startMockDiscourse({ pageSize: 20, fail: (u) => (/period=all/.test(u) ? 500 : null) });
  try {
    const out = tmp();
    const cfg = quick(); cfg.forum.maxFailures = 100;
    const s = await run(mock.url, out, cfg);
    assert.equal(s.state, 'partial');
    assert.ok(s.failures > 0);
    assert.equal(s.kept, 'new');
    assert.ok(s.topics > 50, 'the yearly and latest listings still delivered topics');
    assert.equal(readForum(out).topics.topics.length, s.topics);
  } finally { await mock.close(); }
});

test('fetchForum: a 429 makes it wait (Retry-After) and carry on', async () => {
  let hits = 0;
  const mock = await startMockDiscourse({ fail: () => (++hits === 1 ? 429 : null) });
  try {
    const waits = [];
    const s = await run(mock.url, tmp(), quick(), { sleep: async (ms) => { waits.push(ms); } });
    assert.ok(waits.some((ms) => ms >= 1000), `expected a wait of at least the 1s Retry-After, got ${waits}`);
    assert.equal(s.failures, 1);
    assert.ok(['ok', 'partial'].includes(s.state));
    assert.ok(s.topics > 0);
  } finally { await mock.close(); }
});

test('fetchForum: HTML instead of JSON (a captive portal, a Cloudflare page) counts as a failure, not a crash', async () => {
  const mock = await startMockDiscourse({ fail: () => 200 }); // fail() returns 200 with an error body -> JSON without topic_list
  try {
    const s = await run(mock.url, tmp());
    assert.equal(s.state, 'failed');
    assert.match(String(s.note ?? ''), /stopped after/);
  } finally { await mock.close(); }
});

test('fetchForum: nothing listening at all (offline) -> state failed, no exception', async () => {
  const out = tmp();
  const s = await run('http://127.0.0.1:1', out);
  assert.equal(s.state, 'failed');
  assert.equal(s.topics, 0);
});

test('scripts/forum.mjs exits 0 when the forum is unreachable, and 1 only with --strict', async () => {
  const env = { ...process.env, RADAR_FORUM_BASE: 'http://127.0.0.1:1' };
  const out = tmp();
  const args = [path.join(ROOT, 'scripts', 'forum.mjs'), '--out', out, '--delay', '0', '--pages', '1'];
  const soft = await execFileP('node', args, { cwd: ROOT, env }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout }));
  assert.equal(soft.code, 0);
  assert.match(soft.stdout, /failed/);
  const strict = await execFileP('node', [...args, '--strict'], { cwd: ROOT, env }).then(() => 0, (e) => e.code);
  assert.equal(strict, 1);
});

test('scripts/forum.mjs against the mock forum writes topics.json and status.json', async () => {
  const mock = await startMockDiscourse();
  try {
    const out = tmp();
    const r = await execFileP('node', [path.join(ROOT, 'scripts', 'forum.mjs'), '--out', out, '--delay', '0'], { cwd: ROOT, env: { ...process.env, RADAR_FORUM_BASE: mock.url } });
    assert.match(r.stdout, /ok: \d+ topics/);
    assert.ok(fs.existsSync(path.join(out, 'topics.json')) && fs.existsSync(path.join(out, 'status.json')));
  } finally { await mock.close(); }
});

test('the mock serves the raw Discourse shape (guards the helper itself)', () => {
  const raw = toRaw(fixtureTopics()[0], 0);
  assert.ok('like_count' in raw && 'created_at' in raw && Array.isArray(raw.tags));
});
