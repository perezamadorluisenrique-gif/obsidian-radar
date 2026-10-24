// R6 - the documentation is complete and cannot drift from the code: README, Methodology page and RESULTS.md.
// Every number, command, path and field name the docs mention is looked up in the code, the config or the schema.
import fs from 'node:fs';
import path from 'node:path';

export function register({ rung, assert, exists, read, p, sh, tmpdir, counts }) {
  const check = rung('R6', 'README, Methodology page and RESULTS.md are complete and agree with the code, config, schema and data');
  const README = 'README.md';
  const RESULTS = 'RESULTS.md';
  const cfg = () => JSON.parse(read('config.json'));
  const schema = () => JSON.parse(read('schemas', 'ideas.schema.json'));
  const REAL_DIR = p('data', 'cache', 'directory.json');
  const nf = (x) => x.toLocaleString('en-US');
  const headings = (md) => [...md.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => m[1]);
  const inline = (md) => [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  /** GitHub's heading anchor: lower-case, drop punctuation except hyphens, spaces to hyphens. */
  const slug = (h) => h.toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
  const fences = (md) => [...md.matchAll(/```[\w]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  let site;
  /** The Methodology page of a two-week fixture site, built once. */
  const methodology = () => {
    if (!site) {
      const d = tmpdir('r6-site');
      const snaps = path.join(d, 'snaps');
      fs.mkdirSync(snaps);
      for (const w of ['2026-W42', '2026-W43']) fs.copyFileSync(p('fixtures', 'snapshots', `${w}.json.gz`), path.join(snaps, `${w}.json.gz`));
      sh(`node scripts/build-site.mjs --snapshots ${snaps} --directory ${p('fixtures', 'releases', 'community-plugins.json')} --forum none --out ${path.join(d, 'dist')}`);
      site = fs.readFileSync(path.join(d, 'dist', 'methodology.html'), 'utf8');
    }
    return site;
  };

  // ---------------------------------------------------------------------------------------------- README
  check('README has what it answers, set-up, pausing, how it works, the numbers, limits, reading ideas.json, run and check commands', () => {
    assert(exists(README), 'README.md is missing');
    const h = headings(read(README)).map((x) => x.toLowerCase().replace(/`/g, ''));
    for (const need of ['set it up', 'pause it', 'how it works', 'data and storage', 'the numbers', 'limits', 'reading ideas.json', 'run it yourself', 'checks', 'principles']) {
      assert(h.some((x) => x.includes(need)), `README has no heading about "${need}" (headings: ${h.join(' | ')})`);
    }
    const md = read(README);
    for (const q of ['What\'s new?', 'What\'s growing?', 'What is loved but quiet?', 'Where are the gaps?']) assert(md.includes(q), `README does not answer the question "${q}"`);
    return `${h.length} headings`;
  });

  check('README tells the owner the three set-up clicks (merge, Pages source, first run) and the exact schedule from weekly.yml', () => {
    const md = read(README);
    assert(/merge/i.test(md) && /Source: GitHub Actions/.test(md) && /Run workflow/.test(md), 'set-up steps incomplete');
    const cron = /cron:\s*['"]?(\d+) (\d+) \* \* (\d)['"]?/.exec(read('.github', 'workflows', 'weekly.yml'));
    assert(cron, 'no cron line in weekly.yml');
    const [, min, hour, dow] = cron;
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(dow)];
    assert(md.includes(`${day} at ${hour.padStart(2, '0')}:${min.padStart(2, '0')} UTC`) || md.includes(`${day}s at ${hour.padStart(2, '0')}:${min.padStart(2, '0')} UTC`), `README should say "${day} at ${hour.padStart(2, '0')}:${min.padStart(2, '0')} UTC" to match the cron line`);
    return `${day} ${hour.padStart(2, '0')}:${min.padStart(2, '0')} UTC`;
  });

  check('README and the Methodology page both say how to pause it (Disable workflow, schedule block, RADAR_FORUM, unpublish) and the workflow honours them', () => {
    const wf = read('.github', 'workflows', 'weekly.yml');
    assert(/vars\.RADAR_FORUM/.test(wf) && /skip_forum/.test(wf) && /schedule:/.test(wf), 'weekly.yml no longer has the switches the docs describe');
    for (const [where, text] of [['README', read(README)], ['Methodology', methodology()]]) {
      for (const need of ['Disable workflow', 'schedule:', 'RADAR_FORUM', 'npublish']) assert(text.includes(need), `${where} does not mention "${need}"`);
    }
  });

  check('README numbers match config.json (thresholds, weights, windows, similarity cut-offs, batch size)', () => {
    const c = cfg();
    const md = read(README);
    const want = {
      'minimum downloads': `≥ ${nf(c.abandonment.minDownloads)} downloads`,
      'quiet days': `≥ ${c.abandonment.quietDays} days since the last push or release`,
      'open issues': `≥ ${c.abandonment.minOpenIssues} open issues`,
      'weights': `${c.abandonment.weights.loved}·L + ${c.abandonment.weights.quiet}·Q + ${c.abandonment.weights.issues}·I`,
      'newcomer days': `younger than ${c.growth.newcomerDays} days`,
      'relative growth': `at least ${c.growth.minBase} downloads before and ${c.growth.minDelta} gained`,
      'trend weeks': `last ${c.growth.trendWeeks} weeks`,
      'cluster similarity': `cosine similarity ${c.gaps.similarity}`,
      'likely gap': `below ${c.gaps.gapBelow} is a *likely gap*`,
      'probably covered': `above ${c.gaps.coveredAbove} *probably covered*`,
      'batch size': `batches of ${c.fetch.batchSize} repositories`,
    };
    const missing = Object.entries(want).filter(([, v]) => !md.includes(v));
    assert(!missing.length, `README text no longer matches config.json: ${missing.map(([k, v]) => `${k} = "${v}"`).join('; ')}`);
    return `${Object.keys(want).length} values`;
  });

  check('Methodology page prints the same live values and has every section the README points to', () => {
    const c = cfg();
    const m = methodology();
    for (const id of ['principles', 'data', 'growth', 'maintainers', 'gaps', 'similar', 'limits', 'pause', 'ideas']) assert(m.includes(`id="${id}"`), `methodology.html lacks #${id}`);
    for (const v of [nf(c.abandonment.minDownloads), `${c.abandonment.quietDays} days`, String(c.gaps.similarity), String(c.gaps.gapBelow), String(c.gaps.coveredAbove), String(c.growth.newcomerDays), String(c.growth.minBase)]) assert(m.includes(v), `Methodology does not show ${v}`);
    assert(/Limits/.test(m) && /not users/i.test(m), 'the limits section should say downloads are not users');
    assert(/history begins/i.test(m), 'Methodology should say that history begins at the first snapshot');
  });

  check('every field of ideas.json (top level, gaps, closest plugins, evidence, maintainersWanted, archivedByAuthors) is described in README and on the Methodology page', () => {
    const s = schema();
    const sets = [s.properties, s.definitions.gap.properties, s.definitions.gap.properties.closestPlugins.items.properties, s.definitions.gap.properties.evidence.items.properties,
      s.definitions.maintainerWanted.properties, s.definitions.maintainerWanted.properties.evidence.properties, s.definitions.archived.properties];
    const names = [...new Set(sets.flatMap((x) => Object.keys(x)))];
    const md = read(README);
    const ticks = new Set(inline(md).map((x) => x.replace(/\[\]$/, '')));
    const miss = names.filter((x) => !ticks.has(x));
    assert(!miss.length, `README does not describe: ${miss.join(', ')}`);
    const page = methodology();
    // The page lists the fields that matter for reading the file; the ones it must not omit are the top level, gaps and maintainersWanted.
    const pageNames = [...new Set([...Object.keys(s.properties), ...Object.keys(s.definitions.gap.properties), ...Object.keys(s.definitions.maintainerWanted.properties)])];
    const pageMiss = pageNames.filter((x) => !page.includes(`<code>${x}</code>`) && !page.includes(`<code>${x}[]</code>`));
    assert(!pageMiss.length, `Methodology page does not describe: ${pageMiss.join(', ')}`);
    return `${names.length} fields in README, ${pageNames.length} on the page`;
  });

  check('every command, script, npm script and repository path named in README.md and RESULTS.md exists', () => {
    const pkg = JSON.parse(read('package.json'));
    const docs = [README, ...(exists(RESULTS) ? [RESULTS] : [])];
    let n = 0;
    for (const f of docs) {
      const md = read(f);
      const bad = [];
      const code = [...fences(md).join('\n').matchAll(/^\s*(?:\$ )?((?:node|npm|npx|\.\/score)\b[^\n#]*)/gm)].map((m) => m[1].trim());
      for (const line of [...code, ...inline(md)]) {
        for (const m of line.matchAll(/(?:^|\s)node\s+((?:scripts|tests)\/[\w./-]+\.mjs)/g)) { n++; if (!exists(m[1])) bad.push(m[1]); }
        for (const m of line.matchAll(/npm run ([\w:-]+)/g)) { n++; if (!pkg.scripts?.[m[1]]) bad.push(`npm run ${m[1]}`); }
        for (const m of line.matchAll(/npm (test|ci|i)\b/g)) { n++; if (m[1] === 'test' && !pkg.scripts?.test) bad.push('npm test'); }
        if (/(^|\s)\.\/score\b/.test(line)) { n++; if (!exists('score')) bad.push('./score'); }
      }
      for (const tok of inline(md)) {
        if (/[<>*{}]|YYYY|^\/|^data\/cache|\s|\.\.\.|…/.test(tok)) continue; // placeholders, globs, URL paths, git-ignored caches, prose
        if (!/^(?:\.github\/|scripts\/|lib\/|site\/|schemas\/|fixtures\/|tests\/|data\/|config\.json|package\.json|[A-Z]+\.md$)/.test(tok)) continue;
        n++;
        if (!exists(tok.replace(/\/$/, ''))) bad.push(tok);
      }
      assert(!bad.length, `${f} names things that do not exist: ${[...new Set(bad)].join(', ')}`);
    }
    return `${n} references in ${docs.join(' and ')}`;
  });

  check('every script in scripts/ and both workflows are mentioned in the README repository map (nothing undocumented)', () => {
    const md = read(README);
    const scripts = fs.readdirSync(p('scripts')).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, ''));
    const miss = scripts.filter((s) => !new RegExp(`\\b${s}\\b`).test(md));
    assert(!miss.length, `README does not mention: ${miss.join(', ')}`);
    for (const w of fs.readdirSync(p('.github', 'workflows'))) assert(md.includes(w.replace(/\.ya?ml$/, '')) && md.includes('.github/workflows/'), `README does not mention workflow ${w}`);
    return `${scripts.length} scripts`;
  });

  check('links inside README.md and RESULTS.md resolve (local files and #anchors)', () => {
    const docs = [README, ...(exists(RESULTS) ? [RESULTS] : [])];
    let n = 0;
    for (const f of docs) {
      const md = read(f);
      const anchors = new Set(headings(md).map(slug));
      const bad = [];
      for (const m of md.replace(/```[\s\S]*?```/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = m[1];
        if (/^(https?:|mailto:)/.test(href)) continue;
        n++;
        if (href.startsWith('#')) { if (!anchors.has(href.slice(1))) bad.push(href); continue; }
        if (!exists(href.split('#')[0])) bad.push(href);
      }
      assert(!bad.length, `${f} has broken links: ${bad.join(', ')}`);
    }
    return `${n} links`;
  });

  check('the test count README claims is true: tests/*.test.mjs holds at least that many tests and they all pass', () => {
    const claim = Number(/(\d+)\+ unit and integration tests/.exec(read(README))?.[1]);
    assert(claim >= 50, 'README should state how many tests there are ("NN+ unit and integration tests")');
    const r = sh('npm test --silent', { timeout: 900_000 });
    const pass = Number(/# pass (\d+)/.exec(r.out)?.[1]);
    const fail = Number(/# fail (\d+)/.exec(r.out)?.[1]);
    assert(fail === 0 && pass >= claim, `npm test: ${pass} passed, ${fail} failed; README claims ${claim}+`);
    return `${pass} tests pass (README claims ${claim}+)`;
  });

  // ---------------------------------------------------------------------------------------------- RESULTS.md
  check('RESULTS.md has what score confirms, the exact commands to reproduce it, the first real findings and what is left for the owner', () => {
    assert(exists(RESULTS), 'RESULTS.md is missing');
    const md = read(RESULTS);
    const h = headings(md).map((x) => x.toLowerCase().replace(/`/g, ''));
    for (const need of ['what', 'reproduce', 'first real findings', 'left for you']) assert(h.some((x) => x.includes(need)), `RESULTS.md has no heading about "${need}" (headings: ${h.join(' | ')})`);
    for (const need of ['Settings → Pages', 'Run workflow', 'claude/charming-bardeen-ptiqqz', 'RADAR_GITHUB_TOKEN']) assert(md.includes(need), `the "left for you" part should mention ${need}`);
    assert(/not (?:been )?(?:run|exercised|tested)|never (?:run|exercised|tested)|could not be (?:run|exercised|tested)/i.test(md), 'RESULTS.md must say what could not be verified here (live GitHub API, Pages, the Actions runner)');
    assert(/Blockers|Denied/i.test(md), 'RESULTS.md should list the blockers that were hit');
    return `${h.length} headings`;
  });

  check('RESULTS.md per-rung table is the truth: one row per rung R0..R6 with the real number of checks', () => {
    const md = read(RESULTS);
    const real = counts();
    const rows = Object.fromEntries([...md.matchAll(/^\|\s*(R\d)\s*\|[^\n]*\|\s*(\d+)\s*\|\s*$/gm)].map((m) => [m[1], Number(m[2])]));
    for (const id of ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
      assert(id in rows, `RESULTS.md has no table row for ${id} (rows end with the number of checks, e.g. "| R1 | fetch … | 9 |")`);
      assert(rows[id] === real[id], `RESULTS.md says ${id} has ${rows[id]} checks, ./score has ${real[id]}`);
    }
    const total = /\*\*(\d+) checks\*\*/.exec(md);
    const sum = Object.values(real).reduce((a, b) => a + b, 0);
    assert(total && Number(total[1]) === sum, `RESULTS.md should state "**${sum} checks**" in total (found ${total?.[1]})`);
    return `${sum} checks`;
  });

  check('RESULTS.md reproduce commands are runnable here: each fenced command exists, and the key ones are all present', () => {
    const md = read(RESULTS);
    const cmds = [...fences(md).join('\n').matchAll(/^\s*((?:node|npm|npx|\.\/score)\b[^\n#]*)/gm)].map((m) => m[1].trim());
    for (const need of ['npm ci', './score', 'node scripts/ci-dry-run.mjs', 'npm test', 'node scripts/findings.mjs']) assert(cmds.some((c) => c.startsWith(need)), `RESULTS.md reproduce block lacks "${need}"`);
    const pkg = JSON.parse(read('package.json'));
    for (const c of cmds) {
      const script = /^node\s+(scripts\/[\w./-]+\.mjs)/.exec(c)?.[1];
      if (script) assert(exists(script), `${c}: ${script} does not exist`);
      const run = /^npm run ([\w:-]+)/.exec(c)?.[1];
      if (run) assert(pkg.scripts?.[run], `${c}: no such npm script`);
    }
    // the cheap ones are executed for real, so the page cannot promise a command that fails
    const r = sh('node scripts/findings.mjs', { ok: false });
    assert(r.code === 0 || !exists('data/cache/directory.json'), `node scripts/findings.mjs failed: ${r.out.trim().split('\n').pop()}`);
    return `${cmds.length} commands`;
  });

  check('the findings block in RESULTS.md is what scripts/findings.mjs prints for the data it was written from (no hand-typed number)', async () => {
    const md = read(RESULTS);
    const { START_RE, END, findings } = await import(p('scripts', 'findings.mjs'));
    const m = START_RE.exec(md);
    assert(m, 'RESULTS.md lacks the "<!-- findings:start <week> <fingerprint> … -->" marker (paste the output of `node scripts/findings.mjs`)');
    const start = m.index + m[0].length;
    const end = md.indexOf(END, start);
    assert(end > start, 'RESULTS.md lacks the "<!-- findings:end -->" marker');
    const block = md.slice(start, end).trim();
    assert(block.length > 400 && /\*\*Gaps:\*\*/.test(block) && /\*\*Looking for maintainers:\*\*/.test(block), 'the findings block looks empty');
    if (!fs.existsSync(REAL_DIR)) return `not compared: data/cache/directory.json is not present here (run \`npm run fetch\`); block records ${m[1]}`;
    const now = await findings();
    if (now.fingerprint !== m[2]) return `not compared: the data has moved on since the block was written (block ${m[1]} ${m[2]}, data ${now.week} ${now.fingerprint}); the block stays as the record of ${m[1]}`;
    assert(now.markdown.trim() === block, `the findings block differs from \`node scripts/findings.mjs\`; paste the new output.\n--- expected\n${now.markdown.slice(0, 600)}\n--- found\n${block.slice(0, 600)}`);
    return `identical to the generated block for ${m[1]}`;
  });

  // ---------------------------------------------------------------------------------------------- hygiene + done
  check('no tokens or secrets in tracked files', () => {
    const files = sh('git ls-files -z', { ok: true }).out.split('\0').filter((f) => f && !/\.(gz|png|ico)$/.test(f) && !f.startsWith('node_modules/') && fs.existsSync(p(f)));
    const secret = /(?:ghp_|gho_|ghs_|github_pat_|sk-ant-|xox[bp]-)[A-Za-z0-9_-]{16,}/;
    for (const f of files) assert(!secret.test(fs.readFileSync(p(f), 'utf8')), `${f} looks like it contains a token`);
    return `${files.length} files scanned`;
  });

  check('the project is declared done: STATE.md says done; NEXT.md keeps Next, How to resume and Blockers and points to RESULTS.md', () => {
    const state = read('STATE.md');
    assert(/^status:\s*done\s*$/mi.test(state), 'STATE.md should say "status: done" once R0..R6 pass');
    const next = read('NEXT.md');
    assert(/^#{1,3}\s*Blockers/mi.test(next), 'NEXT.md lost its Blockers section');
    assert(/^#{1,3}\s*Next/mi.test(next) && /^#{1,3}\s*How to resume/mi.test(next), 'NEXT.md needs Next and How to resume');
    assert(/RESULTS\.md/.test(next), 'NEXT.md should point to RESULTS.md for what is left for the owner');
  });
}
