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
const analyze = (args, env = {}) => execFileP('node', [path.join(ROOT, 'scripts', 'analyze.mjs'), ...args], { cwd: ROOT, env: { ...process.env, RADAR_NOW: '', ...env } }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
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
