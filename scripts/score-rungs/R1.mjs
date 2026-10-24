// R1 - the fetch script produces a valid snapshot for the full plugin list.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export function register({ rung, assert, exists, read, p, sh, tmpdir, ROOT }) {
  const check = rung('R1', 'fetch produces a valid snapshot for the full plugin list (>=95% metadata, or a documented rolling-refresh state)');

  const schema = () => JSON.parse(read('schemas', 'snapshot.schema.json'));
  const snapDir = p('data', 'snapshots');
  const snaps = () => (fs.existsSync(snapDir) ? fs.readdirSync(snapDir).filter((f) => f.endsWith('.json.gz')).sort() : []);
  const load = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(snapDir, f))).toString('utf8'));
  const lib = async (name) => import(path.join(ROOT, 'lib', name));

  check('fetch unit + integration tests pass (mock GitHub: rate limits, 502, bad token, idempotency)', () => {
    const r = sh('node --test tests/fetch.test.mjs');
    const m = /# pass (\d+)/.exec(r.out);
    return `${m ? m[1] : '?'} tests`;
  });

  check('schema, fetch script and the Obsidian fixtures exist', () => {
    for (const f of ['schemas/snapshot.schema.json', 'scripts/fetch.mjs', 'lib/fetcher.mjs', 'lib/github.mjs',
      'fixtures/releases/community-plugins.json', 'fixtures/releases/community-plugin-stats.json']) assert(exists(f), `${f} is missing`);
  });

  check('fetch.mjs run on the saved Obsidian files writes a valid snapshot for every plugin in the list', async () => {
    const { validate } = await lib('schema.mjs');
    const out = tmpdir('r1-fetch');
    sh(`node scripts/fetch.mjs --releases fixtures/releases --transport none --week 2026-W43 --out ${out}/snaps --cache ${out}/cache`, { env: { RADAR_NOW: '2026-10-24T04:00:00Z' } });
    const file = path.join(out, 'snaps', '2026-W43.json.gz');
    assert(fs.existsSync(file), 'no snapshot written');
    const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    const errs = validate(schema(), snap);
    assert(!errs.length, `schema errors:\n${errs.join('\n')}`);
    const dir = JSON.parse(read('fixtures', 'releases', 'community-plugins.json'));
    assert(Object.keys(snap.data).length === dir.length, `snapshot has ${Object.keys(snap.data).length} plugins, list has ${dir.length}`);
    for (const pl of dir) assert(snap.data[pl.id], `plugin ${pl.id} missing from snapshot`);
    // second run, same inputs -> identical bytes (idempotent), and still only that one file
    const before = fs.readFileSync(file);
    sh(`node scripts/fetch.mjs --releases fixtures/releases --transport none --week 2026-W43 --out ${out}/snaps --cache ${out}/cache`, { env: { RADAR_NOW: '2026-10-24T04:00:00Z' } });
    assert(Buffer.compare(before, fs.readFileSync(file)) === 0, 're-running the same week changed the bytes');
    assert(fs.readdirSync(path.join(out, 'snaps')).filter((f) => f.endsWith('.gz')).length === 1, 'a re-run created extra snapshot files');
    return `${dir.length} plugins`;
  });

  check('fetch.mjs without any token never fails the build (exit 0, documented rolling state)', () => {
    const out = tmpdir('r1-notoken');
    const r = sh(`node scripts/fetch.mjs --releases fixtures/releases --week 2026-W43 --out ${out}/snaps --cache ${out}/cache`, { env: { GITHUB_TOKEN: '', GH_TOKEN: '', RADAR_NOW: '2026-10-24T04:00:00Z' } });
    assert(/rolling/.test(r.out), 'expected the run to report state=rolling');
  });

  check('at least one real snapshot is committed under data/snapshots and each file name matches its week', () => {
    const files = snaps();
    assert(files.length >= 1, 'no snapshot in data/snapshots');
    for (const f of files) {
      const s = load(f);
      assert(f === `${s.week}.json.gz`, `${f} contains week ${s.week}`);
    }
    return files.join(', ');
  });

  check('every committed snapshot validates against schemas/snapshot.schema.json', async () => {
    const { validate } = await lib('schema.mjs');
    for (const f of snaps()) {
      const s = load(f);
      const errs = validate(schema(), s);
      assert(!errs.length, `${f}:\n${errs.slice(0, 8).join('\n')}`);
      assert(s.plugins === Object.keys(s.data).length, `${f}: plugins=${s.plugins} but data has ${Object.keys(s.data).length} keys`);
    }
  });

  check('latest real snapshot covers the whole directory, and has >=95% metadata or a documented rolling state', () => {
    const f = snaps().at(-1);
    const s = load(f);
    assert(s.plugins >= 1000, `${f} has only ${s.plugins} plugins; the real directory has thousands`);
    if (exists('data', 'cache', 'directory.json')) {
      const d = JSON.parse(read('data', 'cache', 'directory.json'));
      const n = Array.isArray(d) ? d.length : Object.keys(d).length;
      assert(n === s.plugins, `directory cache lists ${n} plugins, snapshot has ${s.plugins}`);
    }
    const withMeta = Object.values(s.data).filter((r) => r.chk).length;
    assert(withMeta === s.refresh.withMeta, `refresh.withMeta=${s.refresh.withMeta} but ${withMeta} records carry metadata`);
    const cov = withMeta / s.plugins;
    if (cov >= 0.95) return `${(cov * 100).toFixed(1)}% metadata`;
    assert(s.refresh.state === 'rolling', `coverage is ${(cov * 100).toFixed(1)}% but refresh.state is "${s.refresh.state}"`);
    assert(s.refresh.pending + s.refresh.withMeta >= s.plugins - s.refresh.refreshed - 1 || s.refresh.pending > 0, 'rolling state without pending count');
    const dec = read('DECISIONS.md'), next = read('NEXT.md');
    assert(/rolling refresh/i.test(dec) && /GitHub access in the build sandbox/i.test(dec), 'DECISIONS.md must document the rolling-refresh state');
    assert(/Blockers/i.test(next) && /rolling-refresh/i.test(next), 'NEXT.md Blockers must mention the rolling-refresh state');
    return `rolling refresh: ${(cov * 100).toFixed(1)}% metadata, ${s.refresh.pending} pending (documented)`;
  });

  check('the snapshot stores downloads only (no per-version or per-day data) and stays compact', () => {
    const f = snaps().at(-1);
    const bytes = fs.statSync(path.join(snapDir, f)).size;
    const s = load(f);
    const allowed = new Set(['dl', 'rel', 'push', 'crt', 'arch', 'stars', 'iss', 'fr', 'gone', 'chk', 'src']);
    for (const r of Object.values(s.data)) for (const k of Object.keys(r)) assert(allowed.has(k), `unexpected field "${k}" in a plugin record`);
    assert(bytes < 600 * 1024, `${f} is ${(bytes / 1024).toFixed(0)} KB (limit 600 KB for a full-size snapshot)`);
    return `${(bytes / 1024).toFixed(0)} KB`;
  });

  check('past snapshots are never rewritten (git: only the newest week may differ from HEAD)', () => {
    const tracked = sh('git ls-files data/snapshots', { ok: false }).out.split('\n').filter((x) => x.endsWith('.json.gz'));
    if (!tracked.length) return 'no committed snapshots yet';
    const newest = snaps().at(-1);
    const changed = sh('git diff --name-only HEAD -- data/snapshots', { ok: false }).out.split('\n').filter((x) => x.endsWith('.json.gz'));
    const bad = changed.filter((x) => path.basename(x) !== newest);
    assert(!bad.length, `past snapshot(s) modified: ${bad.join(', ')}`);
  });
}
