// R4 - the site builds with all pages; links are valid; a Playwright check at 375px shows no horizontal scroll.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function register({ rung, assert, exists, read, p, sh, tmpdir, ROOT }) {
  const check = rung('R4', 'static site builds with every page, valid links, small JSON, and no horizontal scroll at 375px (Playwright)');
  const PAGES = ['index.html', 'growing.html', 'new.html', 'maintainers.html', 'gaps.html', 'mine.html', 'methodology.html', 'search.html', 'plugin.html', '404.html'];
  const DIRECTORY = p('fixtures', 'releases', 'community-plugins.json');
  const REAL_DIR = p('data', 'cache', 'directory.json');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const treeHash = (d) => { const h = crypto.createHash('sha1'); for (const f of walk(d).sort()) h.update(path.relative(d, f)).update(fs.readFileSync(f)); return h.digest('hex'); };
  const cache = {};
  /** Build once per variant and reuse: 'fx' = two fixture weeks, 'base' = one week (baseline), 'real' = the committed snapshots. */
  const built = (variant) => {
    if (cache[variant]) return cache[variant];
    const d = tmpdir(`site-${variant}`);
    const snaps = path.join(d, 'snaps');
    fs.mkdirSync(snaps);
    const weeks = variant === 'fx' ? ['2026-W42', '2026-W43'] : ['2026-W43'];
    if (variant === 'real') for (const f of fs.readdirSync(p('data', 'snapshots'))) fs.copyFileSync(p('data', 'snapshots', f), path.join(snaps, f));
    else for (const w of weeks) fs.copyFileSync(p('fixtures', 'snapshots', `${w}.json.gz`), path.join(snaps, `${w}.json.gz`));
    const out = path.join(d, 'dist');
    const dir = variant === 'real' ? REAL_DIR : DIRECTORY;
    const r = sh(`node scripts/build-site.mjs --snapshots ${snaps} --directory ${dir} --forum ${variant === 'real' ? 'data/forum' : 'none'} --out ${out}`);
    return (cache[variant] = { out, log: r.out.trim().split('\n').pop() });
  };

  check('site and similar-plugins unit tests pass (escaping, no author names, baseline wording, Spanish coverage, size budgets)', () => {
    const r = sh('node --test tests/site.test.mjs tests/similar.test.mjs');
    return `${/# pass (\d+)/.exec(r.out)?.[1]} tests`;
  });

  check('build from two fixture weeks writes every page, the assets and one JSON per plugin', () => {
    const { out } = built('fx');
    for (const f of [...PAGES, 'search.json', 'ideas.json', 'meta.json', '.nojekyll', 'assets/style.css', 'assets/app.js', 'assets/i18n.js', 'assets/favicon.svg']) assert(fs.existsSync(path.join(out, f)), `dist/${f} is missing`);
    const n = fs.readdirSync(path.join(out, 'p')).length;
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
    assert(n === meta.plugins && n > 100, `${n} plugin files for ${meta.plugins} plugins`);
    assert(!meta.baseline && meta.snapshots === 2, 'two weeks should not be a baseline');
    return `${PAGES.length} pages, ${n} plugin files`;
  });

  check('the real committed snapshots build too (baseline wording, 9k+ plugin files) when the directory cache exists', () => {
    if (!fs.existsSync(REAL_DIR)) return 'skipped: data/cache/directory.json not present (run `npm run fetch` first)';
    const { out, log } = built('real');
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
    assert(meta.plugins > 5000, `only ${meta.plugins} plugins`);
    const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    if (meta.baseline) assert(/First week of history/.test(index) && /History begins at/.test(index), 'a baseline site must say that history begins at the first snapshot');
    return log.replace(/^\[build\] /, '');
  });

  check('links: every relative link, #anchor, plugin.html?id= target and asset resolves; no absolute /paths; ids unique', async () => {
    const { checkLinks } = await import(p('scripts', 'check-links.mjs'));
    const variants = fs.existsSync(REAL_DIR) ? ['fx', 'base', 'real'] : ['fx', 'base'];
    let n = 0;
    for (const v of variants) {
      const r = checkLinks(built(v).out);
      assert(r.problems.length === 0, `${v}: ${r.problems.slice(0, 8).join('\n')}`);
      n += r.internal;
    }
    return `${n} internal links over ${variants.length} builds`;
  });

  check('works without JavaScript: the list pages already contain their rows, the baseline notice and the history start', () => {
    const { out } = built('base');
    const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert((index.match(/class="row"/g) ?? []).length >= 5, 'index.html has no server-rendered rows');
    assert(/First week of history/.test(index), 'baseline notice missing');
    const maint = fs.readFileSync(path.join(out, 'maintainers.html'), 'utf8');
    assert((maint.match(/class="row"/g) ?? []).length >= 10, 'maintainers.html has no server-rendered rows');
    assert(/not a judgement/.test(maint) && /room for an alternative/.test(maint), 'respectful framing missing from the maintainers page');
    assert(/<script src="assets\/app\.js" defer>/.test(index), 'app.js should be deferred');
  });

  check('precomputed and small: no remote assets, search.json lazy-loaded, per-plugin JSON < 6KB, each page < 300KB', () => {
    const { out } = built(fs.existsSync(REAL_DIR) ? 'real' : 'fx');
    const files = walk(out);
    for (const f of files.filter((x) => x.endsWith('.html'))) {
      const html = fs.readFileSync(f, 'utf8');
      assert(!/<(?:script|link|img|iframe)[^>]+(?:src|href)="https?:/.test(html.replace(/<a [^>]*>/g, '')), `${path.basename(f)} loads a remote resource`);
      assert(fs.statSync(f).size < 300_000, `${path.basename(f)} is ${fs.statSync(f).size} bytes`);
      assert(!/search\.json/.test(html), `${path.basename(f)} references search.json directly; it must be lazy-loaded by app.js`);
    }
    const big = files.filter((x) => x.includes(`${path.sep}p${path.sep}`)).map((f) => fs.statSync(f).size);
    assert(Math.max(...big) < 6000, `largest plugin JSON is ${Math.max(...big)} bytes`);
    const total = files.reduce((s, f) => s + fs.statSync(f).size, 0);
    assert(total < 40 * 1048576, `site is ${(total / 1048576).toFixed(1)} MB`);
    assert(/search\.json/.test(fs.readFileSync(path.join(out, 'assets', 'app.js'), 'utf8')), 'app.js should fetch search.json');
    return `${files.length} files, ${(total / 1048576).toFixed(1)} MB; largest plugin JSON ${Math.max(...big)} B; search.json ${fs.statSync(path.join(out, 'search.json')).size} B`;
  });

  check('same inputs, same bytes: building the fixture site twice gives an identical tree', () => {
    const a = built('fx').out;
    const d = tmpdir('site-again');
    const r = sh(`node scripts/build-site.mjs --snapshots ${path.join(path.dirname(a), 'snaps')} --directory ${DIRECTORY} --forum none --out ${path.join(d, 'dist')}`);
    assert(treeHash(a) === treeHash(path.join(d, 'dist')), `trees differ (${r.out.trim().split('\n').pop()})`);
  });

  check('Methodology page documents the live thresholds, limits, how to pause it and how to read ideas.json', () => {
    const m = fs.readFileSync(path.join(built('fx').out, 'methodology.html'), 'utf8');
    for (const id of ['principles', 'data', 'growth', 'maintainers', 'gaps', 'similar', 'limits', 'pause', 'ideas']) assert(m.includes(`id="${id}"`), `methodology.html lacks #${id}`);
    const cfg = JSON.parse(read('config.json'));
    assert(m.includes(String(cfg.abandonment.minDownloads.toLocaleString('en-US'))) && m.includes(`${cfg.abandonment.quietDays} days`), 'abandonment thresholds not shown');
    assert(/score = 100/.test(m) && /idf = ln/.test(m), 'formulas missing');
  });

  check('Playwright @375px and @320px: no horizontal scroll on any page, no console errors, dark mode, search, plugin chart, Spanish toggle, filter', () => {
    const shots = tmpdir('shots');
    const r = sh(`node scripts/check-layout.mjs ${built('fx').out} --shots ${shots}`, { timeout: 900_000 });
    return r.out.trim().split('\n').filter((l) => l.startsWith('[layout]')).join(' ');
  }, { browser: true });

  check('Playwright on the real data site (9k+ plugins): same checks pass', () => {
    if (!fs.existsSync(REAL_DIR)) return 'skipped: data/cache/directory.json not present';
    const r = sh(`node scripts/check-layout.mjs ${built('real').out}`, { timeout: 900_000 });
    return r.out.trim().split('\n').filter((l) => l.startsWith('[layout]')).join(' ');
  }, { browser: true });
}
