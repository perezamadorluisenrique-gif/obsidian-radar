#!/usr/bin/env node
// Commit this week's data (snapshots, forum data, ideas.json) back to the branch the workflow runs on.
//
//   node scripts/commit-data.mjs [--repo .] [--branch main] [--remote origin] [--week 2026-W43] [--no-push]
//                                [--paths data/snapshots,data/forum,ideas.json] [--retries 4] [--retry-delay-ms 2000]
//
// Why a script and not shell in the workflow: the same code runs in the CI dry run against a throw-away remote.
//   - Idempotent: nothing changed since the last commit means "nothing new to commit" and exit 0.
//   - Past snapshots are never rewritten: a staged change to (or deletion of) any snapshot other than <week> aborts
//     before anything is committed. The only file this script may touch in data/snapshots is the current week's.
//   - A push that loses a race with a human commit is rebased and retried; a real conflict stops with exit 1.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listSnapshots, SNAPSHOT_RE } from '../lib/snapshot.mjs';
import { isWeekId } from '../lib/week.mjs';

const BOT = { name: 'obsidian-radar[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };

export function commitData({
  repo = '.', branch = 'main', remote = 'origin', week, paths = ['data/snapshots', 'data/forum', 'ideas.json'],
  push = true, retries = 4, retryDelayMs = 2000, log = (m) => console.log(`[commit] ${m}`), sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', `user.name=${BOT.name}`, '-c', `user.email=${BOT.email}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const tryGit = (...args) => { try { return { ok: true, out: git(...args) }; } catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() }; } };

  const snapDir = path.join(repo, 'data', 'snapshots');
  week ??= listSnapshots(snapDir).at(-1)?.week;
  if (!week || !isWeekId(week)) throw new Error(`no snapshot week to commit (got ${week})`);

  // Only paths that exist on disk or are tracked: `git add` fails on a pathspec that matches nothing (data/forum before the
  // first forum fetch, or when the forum step is switched off).
  const present = paths.filter((x) => fs.existsSync(path.join(repo, x)) || git('ls-files', '--', x).trim());
  if (present.length) git('add', '-A', '--', ...present);
  const staged = git('diff', '--cached', '--name-status', '--no-renames').split('\n').filter(Boolean).map((l) => l.split('\t'));
  if (!staged.length) { log(`nothing new to commit for ${week}`); return { committed: false, week, files: [] }; }

  const bad = staged.filter(([status, file]) => file.startsWith('data/snapshots/') && SNAPSHOT_RE.test(path.basename(file)) && path.basename(file) !== `${week}.json.gz` && status !== 'A');
  const foreign = staged.filter(([, file]) => file.startsWith('data/snapshots/') && !SNAPSHOT_RE.test(path.basename(file)));
  if (bad.length || foreign.length) {
    git('reset', '-q');
    throw new Error(`refusing to commit: past snapshots are never rewritten (${[...bad, ...foreign].map(([s, f]) => `${s} ${f}`).join(', ')})`);
  }

  const files = staged.map(([, f]) => f);
  git('commit', '-q', '-m', `data: weekly snapshot ${week}`, '-m', `Automated by the weekly workflow. ${files.length} file(s):\n${files.map((f) => `- ${f}`).join('\n')}`);
  log(`committed ${files.length} file(s) for ${week}: ${files.join(', ')}`);
  if (!push) return { committed: true, pushed: false, week, files };

  for (let attempt = 1; attempt <= retries; attempt++) {
    const pushed = tryGit('push', remote, `HEAD:refs/heads/${branch}`);
    if (pushed.ok) { log(`pushed to ${remote}/${branch}${attempt > 1 ? ` (attempt ${attempt})` : ''}`); return { committed: true, pushed: true, week, files }; }
    log(`push attempt ${attempt} failed: ${pushed.out.split('\n').pop()}`);
    // Someone pushed in the meantime: replay our single data commit on top of the new tip. Data files and code files
    // never overlap, so this is a clean rebase unless a human edited the same snapshot, in which case we stop.
    const fetched = tryGit('fetch', '-q', remote, branch);
    if (fetched.ok) {
      const rebased = tryGit('rebase', `${remote}/${branch}`);
      if (!rebased.ok) { tryGit('rebase', '--abort'); throw new Error(`rebase onto ${remote}/${branch} conflicted; resolve by hand: ${rebased.out.split('\n').pop()}`); }
    }
    if (attempt < retries) sleep(retryDelayMs * attempt);
  }
  throw new Error(`could not push to ${remote}/${branch} after ${retries} attempts`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  try {
    const r = commitData({
      repo: opt('repo', '.'), branch: opt('branch', 'main'), remote: opt('remote', 'origin'), week: opt('week'),
      paths: opt('paths') ? opt('paths').split(',') : undefined, push: !argv.includes('--no-push'),
      retries: Number(opt('retries', 4)), retryDelayMs: Number(opt('retry-delay-ms', 2000)),
    });
    if (process.env.GITHUB_STEP_SUMMARY) (await import('node:fs')).appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Data commit\n- ${r.committed ? `${r.files.length} file(s) committed for ${r.week}` : `nothing new for ${r.week}`}\n`);
  } catch (e) {
    console.error(`[commit] FAILED: ${e.message}`);
    process.exit(1);
  }
}
