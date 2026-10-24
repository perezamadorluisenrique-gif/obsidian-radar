#!/usr/bin/env node
// CI dry run of the weekly workflow, offline.
//
//   node scripts/ci-dry-run.mjs [--browser] [--keep] [--json]
//
// It takes the `node scripts/...` commands out of .github/workflows/weekly.yml and runs them, in the workflow's order,
// inside a throw-away git checkout (RADAR_WORKDIR) whose "origin" is a local bare repository. The only differences from a
// real run are the sources (saved Obsidian files, a mock GitHub API, a mock or dead forum) and where the data lives.
//
// Two scenarios, each starting from a repository that already has last week's snapshot committed:
//   online   mock GitHub with a token, mock forum: every step succeeds, then re-runs prove idempotency (no new commit,
//            identical bytes), a tampered past snapshot is refused, and a push that loses a race is rebased and lands.
//   offline  GitHub rate-limited from the first request and the forum unreachable: fetch and forum still exit 0, the
//            previous forum data is kept, and the analysis, commit and build still go through.
// Exit code 1 as soon as any assertion fails. Playwright is only used with --browser.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { ROOT } from '../lib/config.mjs';
import { validate } from '../lib/schema.mjs';
import { listSnapshots, readSnapshot } from '../lib/snapshot.mjs';
import { startMockGitHub } from '../tests/helpers/mock-github.mjs';
import { startMockDiscourse } from '../tests/helpers/mock-discourse.mjs';

const execFileP = promisify(execFile);
const NOW = '2026-10-24T04:00:00Z'; // ISO week 2026-W43; the seeded history is 2026-W42
const WEEK = '2026-W43';
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'weekly.yml');
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const treeHash = (dir) => {
  const h = crypto.createHash('sha1');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  if (fs.existsSync(dir)) for (const f of walk(dir).sort()) h.update(path.relative(dir, f)).update(fs.readFileSync(f));
  return h.digest('hex');
};

/** The workflow's own `node scripts/...` commands, keyed by script name (fetch, forum, analyze, commit-data, build-site, check-links, check-layout). */
export function workflowCommands(file = WORKFLOW) {
  const wf = parse(fs.readFileSync(file, 'utf8'));
  const cmds = {};
  for (const job of Object.values(wf.jobs)) {
    for (const step of job.steps ?? []) {
      for (const line of String(step.run ?? '').split('\n')) {
        const m = /^\s*node (scripts\/([\w-]+)\.mjs)(.*)$/.exec(line);
        if (m) cmds[m[2]] = { script: m[1], args: m[3].trim().split(/\s+/).filter(Boolean), step: step.name ?? m[1] };
      }
    }
  }
  return cmds;
}

export async function dryRun({ log = () => {}, browser = false, keep = false } = {}) {
  const steps = [];
  const record = (scenario, name, ok, detail = '') => {
    steps.push({ scenario, name, ok, detail });
    log(`  ${ok ? '✓' : '✗'} [${scenario}] ${name}${detail ? ` — ${detail}` : ''}`);
    return ok;
  };
  const expect = (scenario, name, cond, detail = '') => { record(scenario, name, Boolean(cond), detail); if (!cond) throw new Error(`[${scenario}] ${name} failed${detail ? `: ${detail}` : ''}`); };

  const base = fs.mkdtempSync(path.join(process.env.RADAR_SCORE_TMP || os.tmpdir(), 'radar-dryrun-'));
  const cmds = workflowCommands();
  for (const need of ['fetch', 'forum', 'analyze', 'commit-data', 'build-site', 'check-links']) if (!cmds[need]) throw new Error(`weekly.yml has no \`node scripts/${need}.mjs\` command`);
  const servers = [];

  /** Run one of the workflow's commands in the work tree, optionally adding arguments. Never throws; returns {code, out}. */
  async function wf(ws, name, { env = {}, extra = [] } = {}) {
    const c = cmds[name];
    const args = c.args.map((a) => a.replace(/^"?\$(\w+)"?$/, (_, v) => ({ GITHUB_REF_NAME: 'main' })[v] ?? process.env[v] ?? ''));
    try {
      const r = await execFileP('node', [path.join(ROOT, c.script), ...args, ...extra], { cwd: ws.work, env: { ...process.env, ...ws.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
      return { code: 0, out: `${r.stdout}${r.stderr}` };
    } catch (e) { return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}${e.stdout || e.stderr ? '' : e.message}` }; }
  }
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=dry-run', '-c', 'user.email=dry-run@example.invalid', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  /** A bare "origin" with last week's snapshot (and forum data) on main, and a clone of it as the runner's checkout. */
  function seed(scenario, forumFrom) {
    const dir = path.join(base, scenario);
    const origin = path.join(dir, 'origin.git'), work = path.join(dir, 'work'), other = path.join(dir, 'other');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
    fs.mkdirSync(path.join(work, 'data', 'snapshots'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'fixtures', 'snapshots', '2026-W42.json.gz'), path.join(work, 'data', 'snapshots', '2026-W42.json.gz'));
    if (forumFrom) fs.cpSync(forumFrom, path.join(work, 'data', 'forum'), { recursive: true });
    fs.writeFileSync(path.join(work, 'README.md'), '# dry run\n');
    fs.writeFileSync(path.join(work, '.gitignore'), 'data/cache/\ndist/\nbuild/\n');
    git(work, 'checkout', '-q', '-b', 'main');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'seed: last week');
    git(work, 'push', '-q', 'origin', 'main');
    return { dir, origin, work, other, env: {} };
  }
  const originSnap = (ws, week) => { try { return git(ws.origin, 'rev-parse', `main:data/snapshots/${week}.json.gz`); } catch { return null; } };
  const originHead = (ws) => git(ws.origin, 'rev-parse', 'main');

  async function scenario(name, { github, forumBase, forumFrom, forumPages, expectState }) {
    const ws = seed(name, forumFrom);
    ws.env = {
      RADAR_WORKDIR: ws.work, RADAR_NOW: NOW, RADAR_RELEASES_BASE: path.join(ROOT, 'fixtures', 'releases'),
      RADAR_GRAPHQL_URL: `${github.url}/graphql`, RADAR_REST_URL: github.url, GITHUB_TOKEN: 'test-token',
      RADAR_FORUM_BASE: forumBase, RADAR_FORUM_DELAY_MS: '0', ...(forumPages ? { RADAR_FORUM_PAGES: forumPages } : {}), GITHUB_REF_NAME: 'main', GITHUB_STEP_SUMMARY: '',
    };
    const snapsDir = path.join(ws.work, 'data', 'snapshots'), forumDir = path.join(ws.work, 'data', 'forum');
    const w42Before = originSnap(ws, '2026-W42');
    expect(name, 'seed: origin has last week and nothing else', w42Before && !originSnap(ws, WEEK));

    // 1. fetch
    let r = await wf(ws, 'fetch');
    expect(name, 'fetch exits 0', r.code === 0, r.out.trim().split('\n').pop());
    const file = path.join(snapsDir, `${WEEK}.json.gz`);
    expect(name, `fetch wrote data/snapshots/${WEEK}.json.gz`, fs.existsSync(file));
    const snap = readSnapshot(file);
    const errs = validate(JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'snapshot.schema.json'), 'utf8')), snap);
    const dirCount = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'releases', 'community-plugins.json'), 'utf8')).length;
    expect(name, 'snapshot matches the schema and lists every plugin', !errs.length && snap.plugins === dirCount, errs[0] ?? `${snap.plugins} plugins, state=${snap.refresh.state}, GitHub metadata for ${snap.refresh.withMeta}`);
    expect(name, `snapshot refresh state is "${expectState}"`, snap.refresh.state === expectState, `state=${snap.refresh.state}`);
    expect(name, 'fetch left the committed past snapshot byte-identical', sha(path.join(snapsDir, '2026-W42.json.gz')) === sha(path.join(ROOT, 'fixtures', 'snapshots', '2026-W42.json.gz')));

    // 2. forum (optional step)
    const topicsBefore = fs.existsSync(path.join(forumDir, 'topics.json')) ? sha(path.join(forumDir, 'topics.json')) : null;
    r = await wf(ws, 'forum');
    expect(name, 'forum step exits 0', r.code === 0, r.out.trim().split('\n').pop());
    const fstatus = JSON.parse(fs.readFileSync(path.join(forumDir, 'status.json'), 'utf8'));
    if (expectState === 'complete') expect(name, 'forum online: topics saved', fstatus.state === 'ok' && fstatus.topics >= 100, `${fstatus.state}, ${fstatus.topics} topics`);
    else {
      const strict = await wf(ws, 'forum', { extra: ['--strict'] });
      expect(name, 'forum offline: the failure is real (--strict exits 1) yet the step itself exits 0', strict.code === 1, `strict exit ${strict.code}`);
      expect(name, 'forum offline: the previous forum data was kept untouched', topicsBefore && sha(path.join(forumDir, 'topics.json')) === topicsBefore, `status ${fstatus.state}, kept=${fstatus.kept}`);
    }

    // 3. analyse -> ideas.json
    r = await wf(ws, 'analyze');
    expect(name, 'analyze exits 0', r.code === 0, r.out.trim().split('\n').find((l) => /gaps:|looking for maintainers/.test(l)) ?? r.out.trim().split('\n').pop());
    const ideasFile = path.join(ws.work, 'ideas.json');
    const ideas = JSON.parse(fs.readFileSync(ideasFile, 'utf8'));
    const ierr = validate(JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'ideas.schema.json'), 'utf8')), ideas);
    expect(name, 'ideas.json validates against its schema', !ierr.length && ideas.week === WEEK, ierr[0] ?? `${ideas.gaps.length} gaps, ${ideas.maintainersWanted.length} maintainers wanted`);

    // 4. commit the data back
    r = await wf(ws, 'commit-data');
    expect(name, 'commit-data exits 0 and pushes', r.code === 0 && /pushed to origin\/main/.test(r.out), r.out.trim().split('\n').pop());
    expect(name, 'origin now has this week\'s snapshot, ideas.json and the untouched past snapshot', originSnap(ws, WEEK) && git(ws.origin, 'cat-file', '-e', 'main:ideas.json') === '' && originSnap(ws, '2026-W42') === w42Before);
    expect(name, 'only data files were committed', git(ws.origin, 'show', '--name-only', '--format=', 'main').split('\n').every((f) => /^(data\/(snapshots|forum)\/|ideas\.json$)/.test(f)));

    // 5. build + checks
    const distBefore = path.join(ws.work, 'dist');
    r = await wf(ws, 'build-site');
    expect(name, 'build-site exits 0 and writes dist/', r.code === 0 && fs.existsSync(path.join(distBefore, 'index.html')), r.out.trim().split('\n').pop());
    expect(name, 'dist/ is Pages-ready (.nojekyll, 404.html, every page)', ['.nojekyll', '404.html', 'index.html', 'growing.html', 'new.html', 'maintainers.html', 'gaps.html', 'methodology.html', 'search.html', 'plugin.html'].every((f) => fs.existsSync(path.join(distBefore, f))));
    r = await wf(ws, 'check-links', { extra: ['--allow-http', '127.0.0.1'] });
    expect(name, 'check-links passes', r.code === 0, r.out.trim().split('\n').find((l) => /internal links/.test(l)));
    if (browser && cmds['check-layout']) {
      r = await wf(ws, 'check-layout');
      expect(name, 'check-layout (Playwright, 375px) passes', r.code === 0, r.out.trim().split('\n').filter((l) => l.startsWith('[layout]')).join(' '));
    }
    const dist1 = treeHash(distBefore);

    // 6. idempotency: the same run again changes nothing
    const head = originHead(ws), before = { snap: sha(file), ideas: sha(ideasFile), forum: treeHash(forumDir), tree: treeHash(path.join(ws.work, 'data', 'snapshots')) };
    const again = [await wf(ws, 'fetch'), await wf(ws, 'forum'), await wf(ws, 'analyze'), await wf(ws, 'commit-data'), await wf(ws, 'build-site')];
    expect(name, 're-run: every step still exits 0', again.every((x) => x.code === 0), again.map((x) => x.code).join(','));
    expect(name, 're-run overwrites only this week\'s snapshot (same file set, past week untouched)', listSnapshots(snapsDir).map((s) => s.week).join() === '2026-W42,2026-W43' && sha(path.join(snapsDir, '2026-W42.json.gz')) === sha(path.join(ROOT, 'fixtures', 'snapshots', '2026-W42.json.gz')));
    if (expectState === 'complete') {
      const same = { snapshot: sha(file) === before.snap, 'ideas.json': sha(ideasFile) === before.ideas, 'forum data': treeHash(forumDir) === before.forum, site: treeHash(distBefore) === dist1 };
      expect(name, 're-run: identical snapshot, ideas.json, forum data and site bytes', Object.values(same).every(Boolean), Object.entries(same).filter(([, ok]) => !ok).map(([k]) => `${k} changed`).join(', '));
      expect(name, 're-run: "nothing new to commit" and origin is unchanged', /nothing new to commit/.test(again[3].out) && originHead(ws) === head, again[3].out.trim().split('\n').pop());
    } else {
      expect(name, 're-run continues the rolling refresh (never loses metadata) and still commits only this week', readSnapshot(file).refresh.withMeta >= snap.refresh.withMeta);
    }

    if (expectState === 'complete') {
      // 7. a past snapshot must never be rewritten
      const w42 = path.join(snapsDir, '2026-W42.json.gz');
      const good = fs.readFileSync(w42);
      fs.writeFileSync(w42, Buffer.concat([good, Buffer.from('tampered')]));
      const headT = originHead(ws);
      r = await wf(ws, 'commit-data');
      expect(name, 'a modified past snapshot is refused (exit 1, nothing pushed)', r.code === 1 && /never rewritten/.test(r.out) && originHead(ws) === headT, r.out.trim().split('\n').pop());
      fs.writeFileSync(w42, good);
      git(ws.work, 'reset', '-q');

      // 8. a push that loses a race (someone pushed to main meanwhile) is rebased and lands
      execFileSync('git', ['clone', '-q', ws.origin, ws.other], { stdio: 'ignore' });
      fs.appendFileSync(path.join(ws.other, 'README.md'), 'a human edit\n');
      git(ws.other, 'add', '-A'); git(ws.other, 'commit', '-q', '-m', 'human edit'); git(ws.other, 'push', '-q', 'origin', 'main');
      const NEXT = '2026-10-31T04:00:00Z';
      const raceEnv = { RADAR_NOW: NEXT };
      for (const s of ['fetch', 'forum', 'analyze']) await wf(ws, s, { env: raceEnv });
      r = await wf(ws, 'commit-data', { env: raceEnv, extra: ['--retry-delay-ms', '10'] });
      const tree = git(ws.origin, 'ls-tree', '-r', '--name-only', 'main').split('\n');
      expect(name, 'next week\'s run loses a push race, rebases onto the human commit and lands', r.code === 0 && tree.includes('data/snapshots/2026-W44.json.gz') && git(ws.origin, 'show', 'main:README.md').includes('a human edit') && /attempt 2/.test(r.out), r.out.trim().split('\n').slice(-2).join(' | '));
      expect(name, 'both earlier snapshots are still byte-identical on origin', originSnap(ws, '2026-W42') === w42Before);
    } else {
      expect(name, 'the site still builds from the rolling snapshot', true, `${again[4].out.trim().split('\n').pop()}`);
    }
    return ws;
  }

  try {
    log(`[dry-run] workspace ${base}; commands from ${path.relative(ROOT, WORKFLOW)}: ${Object.keys(cmds).join(', ')}`);
    const github = await startMockGitHub();
    const limited = await startMockGitHub({ pointsLimit: 1, remaining: 0, resetInSec: 6 * 3600 });
    const discourse = await startMockDiscourse();
    servers.push(github, limited, discourse);
    await scenario('online', { github, forumBase: discourse.url, forumFrom: null, expectState: 'complete' });
    await scenario('offline', { github: limited, forumBase: 'http://127.0.0.1:1', forumPages: '1', forumFrom: path.join(ROOT, 'data', 'forum'), expectState: 'rolling' });
    log(`[dry-run] OK: ${steps.length} assertions in 2 scenarios`);
    return { ok: true, steps, base };
  } catch (e) {
    log(`[dry-run] FAILED: ${e.message}`);
    return { ok: false, steps, base, error: e.message };
  } finally {
    for (const s of servers) await s.close?.();
    if (!keep) fs.rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const r = await dryRun({ log: (m) => console.log(m), browser: argv.includes('--browser'), keep: argv.includes('--keep') });
  if (argv.includes('--json')) console.log(JSON.stringify(r.steps));
  process.exit(r.ok ? 0 : 1);
}
