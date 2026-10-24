import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitData } from '../scripts/commit-data.mjs';

const tmp = () => fs.mkdtempSync(path.join(process.env.RADAR_SCORE_TMP || os.tmpdir(), 'radar-commit-'));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (repo, rel, text) => { const f = path.join(repo, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const quiet = { log: () => {}, sleep: () => {}, retryDelayMs: 0 };

/** A repo with 2026-W42 committed (and a bare origin when asked). */
function repo({ remote = false } = {}) {
  const dir = tmp(), work = path.join(dir, 'work'), origin = path.join(dir, 'origin.git');
  if (remote) execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  if (remote) git(work, 'remote', 'add', 'origin', origin);
  put(work, 'data/snapshots/2026-W42.json.gz', 'week 42');
  put(work, 'README.md', 'readme');
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'seed');
  if (remote) git(work, 'push', '-q', 'origin', 'main');
  return { work, origin, dir };
}

test('commits only the data paths, never stray files, and names the week', () => {
  const { work } = repo();
  put(work, 'data/snapshots/2026-W43.json.gz', 'week 43');
  put(work, 'ideas.json', '{}');
  put(work, 'notes.txt', 'not data');
  const r = commitData({ repo: work, push: false, ...quiet });
  assert.equal(r.committed, true);
  assert.deepEqual(r.files.sort(), ['data/snapshots/2026-W43.json.gz', 'ideas.json']);
  assert.match(git(work, 'log', '-1', '--format=%s'), /data: weekly snapshot 2026-W43/);
  assert.match(git(work, 'status', '--porcelain'), /\?\? notes\.txt/);
});

test('nothing changed means no commit (idempotent)', () => {
  const { work } = repo();
  put(work, 'data/snapshots/2026-W43.json.gz', 'week 43');
  commitData({ repo: work, push: false, ...quiet });
  const head = git(work, 'rev-parse', 'HEAD');
  const r = commitData({ repo: work, push: false, ...quiet });
  assert.equal(r.committed, false);
  assert.equal(git(work, 'rev-parse', 'HEAD'), head);
});

test('re-running a week may overwrite that week only; a changed or deleted past snapshot is refused and unstaged', () => {
  const { work } = repo();
  put(work, 'data/snapshots/2026-W43.json.gz', 'week 43');
  commitData({ repo: work, push: false, ...quiet });
  put(work, 'data/snapshots/2026-W43.json.gz', 'week 43, second run');
  assert.equal(commitData({ repo: work, push: false, ...quiet }).committed, true, 'the current week may be overwritten');

  put(work, 'data/snapshots/2026-W42.json.gz', 'tampered');
  assert.throws(() => commitData({ repo: work, push: false, ...quiet }), /never rewritten.*2026-W42/);
  assert.equal(git(work, 'diff', '--cached', '--name-only'), '', 'nothing may stay staged after a refusal');
  git(work, 'checkout', '--', 'data/snapshots/2026-W42.json.gz');

  fs.rmSync(path.join(work, 'data/snapshots/2026-W42.json.gz'));
  assert.throws(() => commitData({ repo: work, push: false, ...quiet }), /never rewritten/);
});

test('a missing earlier week may be added (backfill), only changing existing ones is refused', () => {
  const { work } = repo();
  put(work, 'data/snapshots/2026-W43.json.gz', 'week 43');
  commitData({ repo: work, push: false, ...quiet });
  put(work, 'data/snapshots/2026-W41.json.gz', 'week 41');
  const r = commitData({ repo: work, week: '2026-W43', push: false, ...quiet });
  assert.deepEqual(r.files, ['data/snapshots/2026-W41.json.gz']);
});

test('push: lands on the remote branch; a lost race is rebased and retried; a real conflict stops', () => {
  const { work, origin, dir } = repo({ remote: true });
  put(work, 'data/snapshots/2026-W43.json.gz', 'week 43');
  assert.equal(commitData({ repo: work, ...quiet }).pushed, true);
  assert.ok(git(origin, 'ls-tree', '-r', '--name-only', 'main').includes('data/snapshots/2026-W43.json.gz'));

  const other = path.join(dir, 'other');
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'ignore' });
  put(other, 'README.md', 'a human edit'); git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'human'); git(other, 'push', '-q', 'origin', 'main');
  put(work, 'data/snapshots/2026-W44.json.gz', 'week 44');
  assert.equal(commitData({ repo: work, ...quiet }).pushed, true);
  assert.equal(git(origin, 'show', 'main:README.md'), 'a human edit');
  assert.ok(git(origin, 'ls-tree', '-r', '--name-only', 'main').includes('data/snapshots/2026-W44.json.gz'));

  // a human also changed the same snapshot: do not guess, stop
  put(other, 'data/snapshots/2026-W45.json.gz', 'by hand'); git(other, 'pull', '-q', 'origin', 'main'); git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'hand-made week 45'); git(other, 'push', '-q', 'origin', 'main');
  put(work, 'data/snapshots/2026-W45.json.gz', 'by the bot');
  assert.throws(() => commitData({ repo: work, ...quiet }), /conflict|could not push/);
  assert.equal(git(work, 'status', '--porcelain').includes('rebase'), false);
});

test('without any snapshot there is nothing to name and the script says so', () => {
  const dir = tmp(); execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  assert.throws(() => commitData({ repo: dir, push: false, ...quiet }), /no snapshot week/);
});
