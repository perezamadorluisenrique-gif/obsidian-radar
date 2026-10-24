// Ladder verifier for Obsidian Ecosystem Radar.
//
//   ./score                 run every rung R0..R6
//   ./score --rung R3       run R0..R3 (a rung is only meaningful if the ones below pass)
//   ./score --only R4       run just R4
//   ./score --skip-browser  mark Playwright checks SKIP (the run is then NOT a full pass)
//   ./score -v              show command output for passing checks too
//
// Rule of the ladder: never edit a check to make it pass. Fix the code, or extend the checks.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const VERBOSE = flag('-v') || flag('--verbose');
const SKIP_BROWSER = flag('--skip-browser');
const upTo = opt('--rung');
const only = opt('--only');

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c(32, s), red = (s) => c(31, s), dim = (s) => c(2, s), yellow = (s) => c(33, s), bold = (s) => c(1, s);

const rungs = new Map(); // id -> { title, checks: [] }
export function rung(id, title) { rungs.set(id, { title, checks: [] }); return (name, fn, o = {}) => rungs.get(id).checks.push({ name, fn, ...o }); }

export class Skip extends Error {}
export function assert(cond, msg) { if (!cond) throw new Error(msg); }
export const p = (...a) => path.join(ROOT, ...a);
export const exists = (...a) => fs.existsSync(p(...a));
export const read = (...a) => fs.readFileSync(p(...a), 'utf8');
export const tmpdir = (tag) => fs.mkdtempSync(path.join(process.env.RADAR_SCORE_TMP || os.tmpdir(), `radar-score-${tag}-`));

/** Run a command, return {code, out}. Throws when `ok` is true and the exit code is non-zero. */
export function sh(cmd, { cwd = ROOT, env = {}, ok = true, timeout = 600_000 } = {}) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (ok && r.status !== 0) {
    const tail = out.trim().split('\n').slice(-25).join('\n');
    throw new Error(`command failed (exit ${r.status}): ${cmd}\n${tail}`);
  }
  return { code: r.status, out };
}

// ---------------------------------------------------------------------------------------------
// R0 - the project scaffolding and the ladder itself
// ---------------------------------------------------------------------------------------------
{
  const check = rung('R0', 'score runs; README, .gitignore, STATE.md, NEXT.md, PROGRESS.md exist');
  check('score runs under node and finds the repo root', () => assert(exists('package.json') && exists('scripts', 'score.mjs'), 'repo root not found'));
  for (const f of ['README.md', '.gitignore', 'STATE.md', 'NEXT.md', 'PROGRESS.md', 'DECISIONS.md']) {
    check(`${f} exists and is not empty`, () => { assert(exists(f), `${f} is missing`); assert(read(f).trim().length > 40, `${f} is (almost) empty`); });
  }
  check('STATE.md has a valid status and a UTC timestamp', () => {
    const s = read('STATE.md');
    const st = /^status:\s*(running|handoff|done)\s*$/mi.exec(s);
    assert(st, 'STATE.md needs a line "status: running|handoff|done"');
    const up = /^updated:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z)\s*$/mi.exec(s);
    assert(up, 'STATE.md needs a line "updated: <UTC ISO time ending in Z>"');
    assert(!Number.isNaN(Date.parse(up[1])), 'STATE.md updated time does not parse');
  });
  check('NEXT.md says what is next and how to resume', () => {
    const s = read('NEXT.md');
    assert(/^#{1,3}\s*Next/mi.test(s), 'NEXT.md needs a "Next" heading');
    assert(/^#{1,3}\s*How to resume/mi.test(s), 'NEXT.md needs a "How to resume" heading');
    assert(/^#{1,3}\s*Blockers/mi.test(s), 'NEXT.md needs a "Blockers" heading (may say "none")');
  });
  check('PROGRESS.md has one line per session', () => {
    const lines = read('PROGRESS.md').split('\n').filter((l) => /^\s*[-*]\s*\S|^\|?\s*\d{4}-\d{2}-\d{2}/.test(l));
    assert(lines.length >= 1, 'PROGRESS.md has no session lines');
  });
  check('.gitignore keeps build output and caches out of git', () => {
    const g = read('.gitignore');
    for (const need of ['node_modules', 'dist', 'data/cache']) assert(g.includes(need), `.gitignore should list ${need}`);
  });
  check('package.json is valid and wires test + score', () => {
    const j = JSON.parse(read('package.json'));
    assert(j.scripts?.test && j.scripts?.score, 'package.json needs test and score scripts');
  });
}

// ---------------------------------------------------------------------------------------------
// Extension point: later rungs live in scripts/score-rungs/*.mjs and are loaded in order.
// ---------------------------------------------------------------------------------------------
const rungDir = p('scripts', 'score-rungs');
if (fs.existsSync(rungDir)) {
  for (const f of fs.readdirSync(rungDir).filter((x) => /^R\d\.mjs$/.test(x)).sort()) {
    const mod = await import(path.join(rungDir, f));
    // counts(): how many checks each rung has, so RESULTS.md can be held to the real numbers
    mod.register({ rung, assert, exists, read, p, sh, tmpdir, Skip, ROOT, SKIP_BROWSER, counts: () => Object.fromEntries([...rungs].map(([id, r]) => [id, r.checks.length])) });
  }
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------
const ALL = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6'];
let wanted = ALL;
if (only) wanted = [only];
else if (upTo) wanted = ALL.slice(0, ALL.indexOf(upTo) + 1);
if (wanted.some((r) => !ALL.includes(r))) { console.error(`unknown rung; use one of ${ALL.join(' ')}`); process.exit(2); }

const summary = [];
let failed = 0, skipped = 0, missing = 0;
for (const id of wanted) {
  const r = rungs.get(id);
  if (!r) { console.log(`\n${bold(id)} ${yellow('not defined yet')}`); summary.push([id, 'undefined', 0, 0]); missing++; continue; }
  console.log(`\n${bold(id)} ${r.title}`);
  let pass = 0, bad = 0, skip = 0;
  for (const ck of r.checks) {
    const t0 = Date.now();
    try {
      if (ck.browser && SKIP_BROWSER) throw new Skip('--skip-browser');
      const detail = await ck.fn();
      pass++;
      console.log(`  ${green('✓')} ${ck.name}${detail && typeof detail === 'string' ? dim('  — ' + detail) : ''} ${dim(`(${Date.now() - t0}ms)`)}`);
    } catch (e) {
      if (e instanceof Skip) { skip++; console.log(`  ${yellow('○ SKIP')} ${ck.name} ${dim('(' + e.message + ')')}`); continue; }
      bad++;
      console.log(`  ${red('✗')} ${ck.name}`);
      for (const line of String(e.message).split('\n').slice(0, 30)) console.log(`      ${red(line)}`);
    }
  }
  failed += bad; skipped += skip;
  summary.push([id, bad ? 'FAIL' : skip ? 'SKIPPED' : 'PASS', pass, r.checks.length]);
}

console.log('\n' + bold('Summary'));
for (const [id, st, pass, total] of summary) {
  const colour = st === 'PASS' ? green : st === 'FAIL' ? red : yellow;
  console.log(`  ${id}  ${colour(st.padEnd(9))} ${st === 'undefined' ? '' : `${pass}/${total}`}`);
}
const ok = failed === 0 && skipped === 0 && missing === 0;
console.log(ok ? green(`\nAll requested rungs pass (${wanted.join(', ')}).`) : red(`\nNot a full pass: ${failed} failed, ${skipped} skipped, ${missing} not defined.`));
process.exit(ok ? 0 : 1);
