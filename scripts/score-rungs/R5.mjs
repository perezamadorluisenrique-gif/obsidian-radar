// R5 - the weekly workflow file is valid, the CI dry run passes, and the forum step fails gracefully offline.
import fs from 'node:fs';

export function register({ rung, assert, exists, read, p, sh }) {
  const check = rung('R5', 'weekly workflow is valid, the offline CI dry run passes (idempotent, forum step fails gracefully)');
  const WEEKLY = '.github/workflows/weekly.yml';
  const CI = '.github/workflows/ci.yml';
  let yaml;
  const load = async (f) => {
    yaml ??= (await import('yaml').catch(() => { throw new Error('the `yaml` package is missing: run `npm ci`'); }));
    assert(exists(f), `${f} is missing`);
    return yaml.parse(read(f));
  };
  const triggers = (wf) => wf.on ?? wf[true]; // YAML 1.1 parsers read the key `on` as boolean true
  const steps = (wf, job) => wf.jobs[job].steps;
  const idx = (list, pred, what) => { const i = list.findIndex(pred); assert(i >= 0, `no step for: ${what}`); return i; };
  const runs = (s, re) => re.test(String(s.run ?? ''));
  const fingerprint = () => {
    const out = [];
    const walk = (d) => { if (fs.existsSync(d)) for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = `${d}/${e.name}`; if (e.isDirectory()) walk(f); else out.push(`${f}:${fs.statSync(f).size}:${fs.statSync(f).mtimeMs}`); } };
    for (const d of ['data', 'dist']) walk(p(d));
    if (exists('ideas.json')) out.push(`ideas.json:${fs.statSync(p('ideas.json')).mtimeMs}`);
    return out.sort().join('\n');
  };
  const before = fingerprint(); // taken when the rung is registered, i.e. before any check has run the dry run
  let dry;
  const dryRun = async () => (dry ??= await (await import(p('scripts', 'ci-dry-run.mjs'))).dryRun({}));
  const stepOk = async (scenario, re) => {
    const r = await dryRun();
    const hit = r.steps.filter((s) => s.scenario === scenario && re.test(s.name));
    assert(hit.length > 0, `the dry run has no step matching ${re} in the "${scenario}" scenario`);
    assert(hit.every((s) => s.ok), `dry run step failed: ${hit.filter((s) => !s.ok).map((s) => s.name).join('; ')}`);
    return hit[0].detail;
  };

  check('commit-data unit tests pass (data paths only, nothing-to-commit, past snapshots never rewritten, push race, conflicts)', () => {
    const r = sh('node --test tests/commit-data.test.mjs');
    return `${/# pass (\d+)/.exec(r.out)?.[1]} tests`;
  });

  check('weekly.yml parses and is scheduled for Mondays 05:41 UTC, with a manual trigger', async () => {
    const wf = await load(WEEKLY);
    const on = triggers(wf);
    assert(Array.isArray(on.schedule) && on.schedule.length === 1, 'exactly one schedule entry expected');
    const cron = on.schedule[0].cron;
    assert(cron === '41 5 * * 1', `cron is "${cron}", expected "41 5 * * 1" (Mondays 05:41 UTC)`);
    const f = cron.split(' ');
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    f.forEach((x, i) => { if (x !== '*') assert(/^\d+$/.test(x) && +x >= ranges[i][0] && +x <= ranges[i][1], `cron field ${i} "${x}" out of range`); });
    assert('workflow_dispatch' in on, 'workflow_dispatch trigger missing');
    assert(!('pull_request_target' in on), 'pull_request_target must not trigger a workflow that holds write permission');
    return cron;
  });

  check('permissions are least-privilege: contents write only where the data is committed, pages + id-token only on deploy', async () => {
    const wf = await load(WEEKLY);
    assert(wf.permissions && wf.permissions !== 'write-all' && wf.permissions.contents === 'read', 'top-level permissions should be contents: read');
    assert(wf.jobs.build.permissions?.contents === 'write', 'build job needs contents: write to commit the data back');
    assert(!wf.jobs.build.permissions.pages && !wf.jobs.build.permissions['id-token'], 'build job should not hold pages/id-token');
    const d = wf.jobs.deploy.permissions ?? {};
    assert(d.pages === 'write' && d['id-token'] === 'write', 'deploy job needs pages: write and id-token: write');
    assert(!d.contents || d.contents === 'read', 'deploy job should not write contents');
  });

  check('jobs: deploy needs build, uses the github-pages environment, one run at a time, every job has a timeout', async () => {
    const wf = await load(WEEKLY);
    const needs = [].concat(wf.jobs.deploy.needs);
    assert(needs.includes('build'), 'deploy must need build');
    assert(wf.jobs.deploy.environment?.name === 'github-pages', 'deploy must use environment github-pages');
    assert(wf.concurrency?.group && wf.concurrency['cancel-in-progress'] === false, 'concurrency group with cancel-in-progress: false expected (never cancel a run mid-snapshot)');
    for (const [name, j] of Object.entries(wf.jobs)) assert(Number(j['timeout-minutes']) > 0, `job ${name} has no timeout-minutes`);
    assert(/default_branch/.test(JSON.stringify(wf.jobs.deploy.if)), 'deploy should only run on the default branch');
  });

  check('build job runs fetch -> forum -> analyse -> commit data -> build -> links -> browser check -> upload, in that order', async () => {
    const wf = await load(WEEKLY);
    const s = steps(wf, 'build');
    const order = [
      idx(s, (x) => /actions\/checkout@/.test(x.uses ?? ''), 'checkout'),
      idx(s, (x) => /actions\/setup-node@/.test(x.uses ?? '') && String(x.with?.['node-version']) === '22', 'setup-node 22'),
      idx(s, (x) => runs(x, /node scripts\/fetch\.mjs/), 'fetch'),
      idx(s, (x) => runs(x, /node scripts\/forum\.mjs/), 'forum'),
      idx(s, (x) => runs(x, /node scripts\/analyze\.mjs --ideas ideas\.json/), 'analyze --ideas ideas.json'),
      idx(s, (x) => runs(x, /node scripts\/commit-data\.mjs/), 'commit data'),
      idx(s, (x) => runs(x, /node scripts\/build-site\.mjs/), 'build site'),
      idx(s, (x) => runs(x, /node scripts\/check-links\.mjs dist/), 'check links'),
      idx(s, (x) => runs(x, /node scripts\/check-layout\.mjs dist/), 'browser check'),
      idx(s, (x) => /actions\/upload-pages-artifact@/.test(x.uses ?? '') && x.with?.path === 'dist', 'upload pages artifact (dist)'),
    ];
    assert(order.every((v, i) => i === 0 || v > order[i - 1]), `steps out of order: ${order.join(',')}`);
    assert(steps(wf, 'deploy').some((x) => /actions\/deploy-pages@/.test(x.uses ?? '')), 'deploy job lacks actions/deploy-pages');
    return `${s.length} steps`;
  });

  check('the forum step is optional (continue-on-error, RADAR_FORUM=off skips it) and the data is saved before anything that could fail', async () => {
    const wf = await load(WEEKLY);
    const s = steps(wf, 'build');
    const forum = s[idx(s, (x) => runs(x, /scripts\/forum\.mjs/), 'forum')];
    assert(forum['continue-on-error'] === true, 'forum step needs continue-on-error: true');
    assert(/vars\.RADAR_FORUM\s*!=\s*'off'/.test(String(forum.if)), "forum step should be skipped when the variable RADAR_FORUM is 'off'");
    const commit = s[idx(s, (x) => runs(x, /commit-data/), 'commit data')];
    assert(/default_branch/.test(String(commit.if)), 'data is only committed on the default branch');
    const layout = s[idx(s, (x) => runs(x, /check-layout/), 'browser check')];
    assert(layout['continue-on-error'] === true, 'the browser check should warn, not block the weekly refresh');
    const links = s[idx(s, (x) => runs(x, /check-links/), 'links')];
    assert(!links['continue-on-error'], 'the link check must block a deploy');
    assert(/RADAR_FORUM/.test(read('lib', 'methodology.mjs')), 'the Methodology page should tell the reader about the RADAR_FORUM variable');
  });

  check('actions are pinned to a version, secrets only through ${{ secrets.* }}, no event data interpolated into shell', async () => {
    for (const f of [WEEKLY, CI]) {
      const wf = await load(f);
      for (const [name, j] of Object.entries(wf.jobs)) for (const st of j.steps ?? []) {
        if (st.uses) assert(/@(v\d+(\.\d+){0,2}|[0-9a-f]{40})$/.test(st.uses), `${f} ${name}: "${st.uses}" is not pinned to a version`);
        if (st.run) assert(!/\$\{\{\s*(github\.(event|head_ref)|inputs)/.test(st.run), `${f} ${name}: event data interpolated into a run script (${st.run.trim().split('\n')[0]})`);
      }
      assert(!/ghp_|github_pat_|-----BEGIN/.test(read(f)), `${f} seems to contain a credential`);
    }
    const wf = await load(WEEKLY);
    const fetch = steps(wf, 'build').find((x) => runs(x, /scripts\/fetch\.mjs/));
    assert(/secrets\.(RADAR_GITHUB_TOKEN \|\| secrets\.)?GITHUB_TOKEN/.test(String(fetch.env?.GITHUB_TOKEN)), 'fetch should get GITHUB_TOKEN from secrets');
  });

  check('every script and npm script the workflows call exists', async () => {
    const pkg = JSON.parse(read('package.json'));
    let n = 0;
    for (const f of [WEEKLY, CI]) {
      const wf = await load(f);
      for (const j of Object.values(wf.jobs)) for (const st of j.steps ?? []) for (const line of String(st.run ?? '').split('\n')) {
        for (const m of line.matchAll(/node (scripts\/[\w-]+\.mjs)/g)) { assert(exists(m[1]), `${f}: ${m[1]} does not exist`); n++; }
        const sc = /npm run ([\w:-]+)/.exec(line); if (sc) { assert(pkg.scripts[sc[1]], `${f}: npm script ${sc[1]} missing`); n++; }
        if (/\.\/score/.test(line)) { assert(exists('score'), 'ci.yml calls ./score but it is missing'); n++; }
      }
    }
    return `${n} commands`;
  });

  check('ci.yml runs the whole score ladder (npm ci, Playwright, ./score) on every push and pull request', async () => {
    const wf = await load(CI);
    const on = triggers(wf);
    assert('push' in on && 'pull_request' in on, 'ci.yml should run on push and pull_request');
    const all = Object.values(wf.jobs).flatMap((j) => j.steps).map((x) => x.run ?? '').join('\n');
    assert(/npm ci/.test(all) && /playwright/.test(all) && /\.\/score/.test(all), 'ci.yml should npm ci, install playwright and run ./score');
    assert(!JSON.stringify(wf).includes('secrets.'), 'ci.yml should not need secrets');
    assert(fs.statSync(p('score')).mode & 0o111, './score is not executable');
  });

  check('CI dry run: the workflow\'s own commands pass offline end to end in both scenarios (online mocks / rate-limited GitHub + dead forum)', async () => {
    const r = await dryRun();
    assert(r.ok, `dry run failed: ${r.error}\n${r.steps.filter((s) => !s.ok).map((s) => `${s.scenario}: ${s.name} ${s.detail}`).join('\n')}`);
    return `${r.steps.length} assertions`;
  });

  check('dry run executes every script the build job calls (nothing in the workflow goes untested; check-layout needs a browser, so R4 and `--browser` cover it)', async () => {
    const { workflowCommands } = await import(p('scripts', 'ci-dry-run.mjs'));
    const wf = await load(WEEKLY);
    const used = new Set(steps(wf, 'build').flatMap((x) => [...String(x.run ?? '').matchAll(/node scripts\/([\w-]+)\.mjs/g)].map((m) => m[1])));
    const cmds = workflowCommands();
    for (const s of used) assert(cmds[s], `workflowCommands() does not see ${s}`);
    const src = read('scripts', 'ci-dry-run.mjs');
    for (const s of used) if (s !== 'check-layout') assert(new RegExp(`'${s}'`).test(src), `ci-dry-run.mjs never runs ${s}`);
    return [...used].join(', ');
  });

  check('forum step offline: exits 0, keeps the previous forum data, while --strict proves the failure was real', async () => stepOk('offline', /forum offline: the failure is real/).then(() => stepOk('offline', /forum offline: the previous forum data was kept/)));

  check('rate-limited GitHub: fetch exits 0, snapshot is in the documented rolling state and the site still builds', async () => {
    await stepOk('offline', /^fetch exits 0/);
    await stepOk('offline', /snapshot refresh state is "rolling"/);
    return stepOk('offline', /the site still builds from the rolling snapshot/);
  });

  check('idempotent: a re-run changes no byte and commits nothing; only the current week\'s snapshot can ever change', async () => {
    await stepOk('online', /re-run: identical snapshot/);
    await stepOk('online', /nothing new to commit/);
    await stepOk('online', /re-run overwrites only this week/);
    return stepOk('online', /a modified past snapshot is refused/);
  });

  check('a push that loses a race with a human commit is rebased and lands; only data files are ever committed', async () => {
    await stepOk('online', /only data files were committed/);
    return stepOk('online', /loses a push race/);
  });

  check('scripts honour the workflow\'s env: RADAR_WORKDIR keeps data/, ideas.json and dist/ out of the checkout (dry run left the repo untouched)', async () => {
    await dryRun();
    assert(fingerprint() === before, 'the dry run changed data/, ideas.json or dist/ in the checkout');
  });
}
