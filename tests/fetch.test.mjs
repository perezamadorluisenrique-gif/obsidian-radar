import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { buildSnapshot, planRefresh } from '../lib/fetcher.mjs';
import { buildQuery } from '../lib/github.mjs';
import { listSnapshots, readSnapshot, snapshotFile } from '../lib/snapshot.mjs';
import { validate } from '../lib/schema.mjs';
import { startMockGitHub } from './helpers/mock-github.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASES = path.join(ROOT, 'fixtures', 'releases');
const SNAP_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'snapshot.schema.json'), 'utf8'));
const NOW = new Date('2026-10-24T04:00:00Z');
const cfgBase = loadConfig();
const cfg = (patch = {}) => ({ ...cfgBase, ...patch, fetch: { ...cfgBase.fetch, maxWaitSec: 900, ...(patch.fetch ?? {}) } });
const tmp = () => fs.mkdtempSync(path.join(process.env.RADAR_SCORE_TMP || os.tmpdir(), 'radar-fetch-'));
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const directory = JSON.parse(fs.readFileSync(path.join(RELEASES, 'community-plugins.json'), 'utf8'));
const N = directory.length;

let gh;
before(async () => { gh = await startMockGitHub(); });
after(async () => { await gh.close(); });
const reset = (o = {}) => {
  Object.assign(gh.state, { pointsLimit: 5000, notFound: new Set(), failNext: 0, maxBatch: Infinity, mode: 'graphql-error', restRemaining: Infinity, resetInSec: 3600, token: 'test-token', ...o });
  gh.state.remaining = o.remaining ?? gh.state.pointsLimit;
};
const run = (dirs, o = {}) => buildSnapshot({
  week: '2026-W43', now: NOW, cfg: cfg(), releases: RELEASES, snapshotsDir: dirs.snaps, cacheDir: dirs.cache,
  transport: 'graphql', token: 'test-token', graphqlUrl: gh.graphqlUrl, restUrl: gh.url, sleep: async () => {}, ...o,
});
const dirs = () => { const root = tmp(); return { root, snaps: path.join(root, 'snapshots'), cache: path.join(root, 'cache') }; };

test('buildQuery produces documents that are valid against the real GitHub schema (pruned copy)', async () => {
  const { buildSchema, parse, validate: gqlValidate } = await import('graphql');
  const schema = buildSchema(fs.readFileSync(path.join(ROOT, 'fixtures', 'graphql', 'github-subset.graphql'), 'utf8'));
  const q = buildQuery([{ repo: 'a/b', labels: false }, { repo: 'c/d.e-f', labels: true }, { repo: 'x/y', labels: false }]);
  assert.deepEqual(gqlValidate(schema, parse(q)).map((e) => e.message), []);
  const typo = q.replace('pushedAt', 'pushedAtt');
  assert.ok(gqlValidate(schema, parse(typo)).length > 0, 'the validator must actually reject unknown fields');
  assert.ok(!buildQuery([{ repo: 'a/b', labels: false }]).includes('fragment Labels'), 'unused fragments are invalid GraphQL');
});

test('full run: valid snapshot, metadata for every plugin, labels only for popular ones', async () => {
  reset({ notFound: new Set([directory[3].repo, directory[10].repo]) });
  const d = dirs();
  const { snapshot, file, stats } = await run(d);
  assert.deepEqual(validate(SNAP_SCHEMA, snapshot), []);
  assert.deepEqual(validate(SNAP_SCHEMA, readSnapshot(file)), [], 'what is on disk validates too');
  assert.equal(snapshot.plugins, N);
  assert.equal(Object.keys(snapshot.data).length, N);
  assert.equal(snapshot.refresh.state, 'complete');
  assert.equal(snapshot.refresh.withMeta, N);
  assert.equal(snapshot.refresh.transport, 'graphql');
  assert.equal(stats.gone, 2);
  assert.equal(snapshot.data[directory[3].id].gone, 1);
  assert.equal(snapshot.data[directory[3].id].push, undefined);
  const cfgFetch = cfgBase.fetch;
  for (const p of directory) {
    const r = snapshot.data[p.id];
    if (r.gone) continue;
    assert.match(r.push, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(r.chk, '2026-10-24');
    assert.equal(r.src, 'g');
    if (r.dl >= cfgFetch.labelsMinDownloads) assert.ok(Number.isInteger(r.fr), `${p.id} should carry a feature-request count`);
    else assert.equal(r.fr, undefined, `${p.id} is below the label threshold`);
  }
  // the fake label noise ("feature-flag-cleanup", "help wanted") must be handled: only feature-like labels count
  const popular = directory.map((p) => snapshot.data[p.id]).find((r) => r.fr !== undefined);
  assert.ok(popular.fr <= 15 + 6);
  assert.ok(fs.existsSync(path.join(d.cache, 'directory.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.cache, 'directory.json'))).length, N);
});

test('plugins without stats get 0 downloads; plugins with stats get the release date', async () => {
  reset();
  const { snapshot } = await run(dirs());
  const stats = JSON.parse(fs.readFileSync(path.join(RELEASES, 'community-plugin-stats.json'), 'utf8'));
  const missing = directory.filter((p) => !stats[p.id]);
  assert.ok(missing.length >= 1, 'the fixture keeps the real "listed but no stats yet" case');
  for (const p of missing) assert.deepEqual([snapshot.data[p.id].dl, snapshot.data[p.id].rel], [0, undefined]);
  const withStats = directory.find((p) => stats[p.id]?.updated > 1e9);
  assert.equal(snapshot.data[withStats.id].rel, new Date(stats[withStats.id].updated).toISOString().slice(0, 10));
  assert.equal(snapshot.data[withStats.id].dl, stats[withStats.id].downloads);
});

test('idempotent: re-running the same week gives identical bytes and never touches other weeks', async () => {
  reset();
  const d = dirs();
  fs.mkdirSync(d.snaps, { recursive: true });
  await run(d, { week: '2026-W41' }); // an older week that must stay exactly as it was
  const pastFile = snapshotFile(d.snaps, '2026-W41');
  const pastHash = sha(pastFile);
  const first = (await run(d)).file;
  const h1 = sha(first);
  reset();
  await run(d);
  assert.equal(sha(first), h1, 'second run of the same week must produce the same snapshot');
  assert.equal(sha(pastFile), pastHash, 'past snapshots are never rewritten');
  assert.deepEqual(listSnapshots(d.snaps).map((s) => s.week), ['2026-W41', '2026-W43']);
});

test('rate limit: saves progress, never throws, and the next run finishes the rest first', async () => {
  reset({ pointsLimit: 4, remaining: 4, resetInSec: 7200 }); // reset is far away -> must stop, not wait
  const d = dirs();
  const r1 = await run(d, { cfg: cfg({ fetch: { batchSize: 20 } }) });
  assert.equal(r1.snapshot.refresh.limited, true);
  assert.equal(r1.snapshot.refresh.state, 'rolling');
  assert.ok(r1.snapshot.refresh.refreshed > 0 && r1.snapshot.refresh.refreshed < N, `partial: ${r1.snapshot.refresh.refreshed}`);
  assert.match(r1.snapshot.refresh.note, /Rate limit/);
  assert.deepEqual(validate(SNAP_SCHEMA, readSnapshot(r1.file)), []);
  const done = new Set(Object.entries(r1.snapshot.data).filter(([, v]) => v.chk).map(([k]) => k));

  reset(); // a new hour: fresh budget; ask for exactly the leftover amount
  const left = N - done.size;
  const r2 = await run(d, { budget: left });
  assert.equal(r2.snapshot.refresh.withMeta, N, 'everything that was missing got fetched before anything was re-fetched');
  assert.equal(r2.stats.repoLookups, left);
});

test('rate limit that resets soon is waited out instead of giving up', async () => {
  reset({ pointsLimit: 10, remaining: 10, resetInSec: 30 });
  const slept = [];
  const d = dirs();
  const { snapshot } = await run(d, {
    cfg: cfg({ fetch: { batchSize: 100 } }),
    sleep: async (ms) => { slept.push(ms); gh.state.remaining = gh.state.pointsLimit; },
  });
  assert.ok(slept.some((ms) => ms >= 20_000 && ms <= 40_000), `slept ${JSON.stringify(slept)}`);
  assert.equal(snapshot.refresh.state, 'complete');
  assert.equal(snapshot.refresh.limited, false);
});

// reserve 0 disables our own pre-flight check, so the limit is only discovered from the server's answer
for (const mode of ['graphql-error', 'http403', 'http429']) {
  test(`limit signalled by the server as ${mode} stops cleanly with progress saved`, async () => {
    reset({ pointsLimit: 4, remaining: 4, resetInSec: 7200, mode });
    const { snapshot } = await run(dirs(), { cfg: cfg({ fetch: { batchSize: 20, rateLimitReserve: 0 } }) });
    assert.equal(snapshot.refresh.limited, true);
    assert.ok(snapshot.refresh.refreshed > 0);
    assert.deepEqual(validate(SNAP_SCHEMA, snapshot), []);
  });
}

test('a server that rate-limits forever cannot trap the run in a wait loop', async () => {
  reset({ pointsLimit: 1, remaining: 1, resetInSec: 10 }); // even one batch never fits
  let sleeps = 0;
  const { snapshot } = await run(dirs(), { cfg: cfg({ fetch: { batchSize: 100, rateLimitReserve: 0, maxWaits: 3 } }), sleep: async () => { sleeps++; } });
  assert.ok(sleeps <= 3, `slept ${sleeps} times`);
  assert.equal(snapshot.refresh.limited, true);
  assert.equal(snapshot.refresh.refreshed, 0);
});

test('transient 502s and over-heavy batches are retried with smaller batches', async () => {
  reset({ failNext: 2, maxBatch: 30 });
  gh.state.batchSizes.length = 0;
  const { snapshot, stats } = await run(dirs());
  assert.equal(snapshot.refresh.state, 'complete');
  assert.ok(stats.errors >= 2, `errors ${stats.errors}`);
  assert.ok(Math.max(...gh.state.batchSizes.slice(-5)) <= 30);
});

test('bad token: the run still produces a valid snapshot (downloads only) and says why', async () => {
  reset();
  const { snapshot } = await run(dirs(), { token: 'wrong' });
  assert.equal(snapshot.refresh.limited, true);
  assert.equal(snapshot.refresh.refreshed, 0);
  assert.match(snapshot.refresh.note, /refused|401/i);
  assert.deepEqual(validate(SNAP_SCHEMA, snapshot), []);
});

test('no token: metadata is carried over from the previous snapshot', async () => {
  reset();
  const d = dirs();
  await run(d, { week: '2026-W42' });
  const { snapshot } = await run(d, { token: '' });
  assert.equal(snapshot.refresh.transport, 'none');
  assert.equal(snapshot.refresh.withMeta, N, 'carried over');
  assert.equal(snapshot.refresh.refreshed, 0);
  assert.match(snapshot.refresh.note, /No GITHUB_TOKEN/);
  const prev = readSnapshot(snapshotFile(d.snaps, '2026-W42'));
  const some = directory[20].id;
  assert.equal(snapshot.data[some].push, prev.data[some].push);
});

test('a field that disappears upstream (un-archived) does not linger from older metadata', async () => {
  reset();
  const d = dirs();
  await run(d, { week: '2026-W42' });
  const prevFile = snapshotFile(d.snaps, '2026-W42');
  const prev = readSnapshot(prevFile);
  const archived = directory.map((p) => p.id).find((id) => prev.data[id].arch === 1);
  assert.ok(archived, 'fixture needs one archived repo');
  // pretend the repo was NOT archived in the data we carry over, then refresh from the mock (archived there)
  const { snapshot } = await run(d, { week: '2026-W43' });
  assert.equal(snapshot.data[archived].arch, 1);
  // and the opposite: carried-over arch must be dropped when GitHub no longer reports it
  const fix = readSnapshot(prevFile);
  const notArchived = directory.map((p) => p.id).find((id) => !fix.data[id].arch && !fix.data[id].gone);
  fix.data[notArchived].arch = 1;
  fs.writeFileSync(snapshotFile(d.snaps, '2026-W42'), (await import('../lib/snapshot.mjs')).serializeSnapshot(fix));
  const again = (await run(d, { week: '2026-W44' })).snapshot;
  assert.equal(again.data[notArchived].arch, undefined);
});

test('REST bootstrap: budgeted, quiet-but-popular candidates are checked first', async () => {
  reset();
  const c = cfg();
  const records = JSON.parse(fs.readFileSync(path.join(RELEASES, 'community-plugin-stats.json'), 'utf8'));
  const cutoff = NOW - c.abandonment.quietDays * 864e5;
  const candidates = directory.filter((p) => records[p.id]?.downloads >= c.abandonment.minDownloads && records[p.id].updated < cutoff);
  assert.ok(candidates.length >= 10, `fixture has ${candidates.length} candidates`);
  const { snapshot, stats } = await run(dirs(), { transport: 'rest', budget: candidates.length });
  assert.equal(stats.repoLookups, candidates.length);
  assert.equal(snapshot.refresh.transport, 'rest');
  assert.equal(snapshot.refresh.limited, true);
  assert.equal(snapshot.refresh.state, 'rolling');
  for (const p of candidates) assert.equal(snapshot.data[p.id].src, 'r', `${p.id} must be in the first budget slice`);
  assert.equal(snapshot.refresh.refreshed, candidates.length);
});

test('REST rate limit exhaustion stops with progress saved', async () => {
  reset({ restRemaining: 60 }); // our reserve is 25, so we should stop around 35 calls (a few more are already in flight)
  const { snapshot } = await run(dirs(), { transport: 'rest', budget: 1000 });
  assert.equal(snapshot.refresh.limited, true);
  assert.ok(snapshot.refresh.refreshed >= 30 && snapshot.refresh.refreshed <= 50, `refreshed ${snapshot.refresh.refreshed}`);
  assert.deepEqual(validate(SNAP_SCHEMA, snapshot), []);
});

test('a REST-bootstrapped plugin is re-fetched via GraphQL before fresh ones (src=r is tier 3)', () => {
  const c = cfg();
  const recs = { a: { dl: 1, chk: '2026-10-17', src: 'g' }, b: { dl: 1, chk: '2026-10-17', src: 'r' }, c: { dl: 1 } };
  const order = planRefresh(recs, { prevIds: new Set(['a', 'b', 'c']), transport: 'graphql', cfg: c, now: +NOW });
  assert.deepEqual(order, ['c', 'b', 'a']);
  // something refreshed earlier this same week goes after everything that still needs work
  const fresh = planRefresh({ x: { dl: 5, chk: '2026-10-22', src: 'g' }, y: { dl: 1, chk: '2026-10-10', src: 'g' }, z: { dl: 9 } }, { prevIds: null, transport: 'graphql', cfg: c, now: +NOW, weekStartDay: '2026-10-19' });
  assert.deepEqual(fresh, ['z', 'y', 'x']);
  const withNew = planRefresh({ ...recs, n: { dl: 0 } }, { prevIds: new Set(['a', 'b', 'c']), transport: 'graphql', cfg: c, now: +NOW });
  assert.equal(withNew[0], 'n', 'brand-new plugins go first');
});

test('CLI: scripts/fetch.mjs end to end against the mock, exit code 0 even when limited', async () => {
  reset({ pointsLimit: 4, remaining: 4, resetInSec: 7200 });
  const d = dirs();
  // async spawn: the mock server lives in this process, so the event loop must stay free
  const { stdout } = await execFileP('node', [path.join(ROOT, 'scripts', 'fetch.mjs'), '--week', '2026-W43', '--releases', RELEASES, '--out', d.snaps, '--cache', d.cache, '--graphql-url', gh.graphqlUrl, '--batch', '20'], {
    env: { ...process.env, GITHUB_TOKEN: 'test-token', RADAR_NOW: '2026-10-24T04:00:00Z' }, encoding: 'utf8',
  });
  assert.match(stdout, /wrote .*2026-W43\.json\.gz/);
  assert.match(stdout, /Rate limit|rolling/i);
  assert.ok(fs.existsSync(snapshotFile(d.snaps, '2026-W43')));
});
