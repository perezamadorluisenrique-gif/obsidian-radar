// R3 - gap clustering runs on the forum fixture; ideas.json validates against its schema.
import fs from 'node:fs';
import path from 'node:path';

export function register({ rung, assert, exists, read, p, sh, tmpdir, ROOT }) {
  const check = rung('R3', 'forum fixture, gap clustering (TF-IDF) and ideas.json validate against their schema');
  const lib = (n) => import(path.join(ROOT, 'lib', n));
  const FX = (f) => path.join(ROOT, 'fixtures', 'forum', f);
  const fxTopics = () => JSON.parse(fs.readFileSync(FX('topics.json'), 'utf8')).topics;
  const fxPlugins = () => JSON.parse(fs.readFileSync(FX('plugins.json'), 'utf8'));

  check('forum, text, gaps and ideas unit tests pass (mock Discourse: ok/partial/too-few/failed/offline)', () => {
    const r = sh('node --test tests/forum.test.mjs tests/text.test.mjs tests/gaps.test.mjs tests/analyze.test.mjs');
    return `${/# pass (\d+)/.exec(r.out)?.[1]} tests`;
  });

  check('forum fixture: >=100 real topics in the normalized shape, and a plugin list that holds both near matches and unrelated plugins', () => {
    for (const f of ['fixtures/forum/topics.json', 'fixtures/forum/plugins.json', 'schemas/ideas.schema.json', 'lib/forum.mjs', 'lib/text.mjs', 'lib/gaps.mjs', 'lib/ideas.mjs', 'scripts/forum.mjs']) assert(exists(f), `${f} is missing`);
    const t = fxTopics();
    assert(t.length >= 100, `only ${t.length} fixture topics`);
    const ids = new Set();
    for (const x of t) {
      for (const k of ['id', 'title', 'slug', 'cat', 'created', 'last', 'views', 'likes', 'posts', 'tags', 'closed', 'url']) assert(x[k] !== undefined, `topic ${x.id} lacks ${k}`);
      assert(/^https:\/\/forum\.obsidian\.md\/t\/[^/]+\/\d+$/.test(x.url), `bad url ${x.url}`);
      assert(/^\d{4}-\d{2}-\d{2}$/.test(x.created) && x.tags.every((g) => typeof g === 'string'), `topic ${x.id} has a malformed date or tag`);
      assert(!ids.has(x.id), `duplicate topic ${x.id}`);
      ids.add(x.id);
    }
    assert(t.some((x) => x.cat === 8) && t.some((x) => x.cat === 10), 'fixture should hold both feature requests (8) and plugin ideas (10)');
    assert(fxPlugins().length >= 150, 'fixture plugin list is too small to show any coverage');
    return `${t.length} topics, ${fxPlugins().length} plugins`;
  });

  check('gap clustering on the fixture: every topic in exactly one cluster, both likely gaps and covered requests found', async () => {
    const { analyzeGaps } = await lib('gaps.mjs');
    const { loadConfig } = await lib('config.mjs');
    const cfg = loadConfig();
    cfg.gaps = { ...cfg.gaps, minClusterSize: 1, singleMinLikes: 0, topN: 1e6 };
    const topics = fxTopics();
    const r = analyzeGaps({ topics, plugins: fxPlugins(), cfg });
    const seen = r.clusters.reduce((s, c) => s + c.topics, 0);
    assert(seen === topics.length, `clusters hold ${seen} topics, fixture has ${topics.length}`);
    const n = (s) => r.clusters.filter((c) => c.status === s).length;
    assert(n('likely-gap') >= 5 && n('probably-covered') >= 5, `gap=${n('likely-gap')} covered=${n('probably-covered')}`);
    assert(r.clusters.some((c) => c.topics >= 3), 'no multi-topic cluster formed');
    return `${r.clusters.length} clusters: ${n('likely-gap')} likely gap, ${n('partly-covered')} partly, ${n('probably-covered')} covered`;
  });

  check('independent check: a naive dense TF-IDF/cosine in this file reproduces every request\'s closest plugin and similarity', async () => {
    const { terms } = await lib('text.mjs');
    const { analyzeGaps } = await lib('gaps.mjs');
    const { loadConfig } = await lib('config.mjs');
    const cfg = loadConfig();
    cfg.gaps = { ...cfg.gaps, minClusterSize: 1, singleMinLikes: 0, topN: 1e6, similarity: 0.9999, closest: 1 }; // one request per cluster
    const topics = fxTopics().slice(0, 60), plugins = fxPlugins();
    const ignore = new Set(cfg.gaps.ignoreTags);
    const tDocs = topics.map((t) => [...terms(t.title), ...terms(t.tags.filter((g) => !ignore.has(g)).join(' '))]);
    const pDocs = plugins.map((x) => [...terms(x.name), ...terms(x.name), ...terms(x.description)]);
    const docs = [...tDocs, ...pDocs];
    const df = {};
    for (const d of docs) for (const w of new Set(d)) df[w] = (df[w] ?? 0) + 1;
    const idf = (w) => Math.log((docs.length + 1) / ((df[w] ?? 0) + 1)) + 1;
    const vec = (d) => { const tf = {}; for (const w of d) tf[w] = (tf[w] ?? 0) + 1; const v = {}; let s = 0; for (const w in tf) { v[w] = (1 + Math.log(tf[w])) * idf(w); s += v[w] ** 2; } for (const w in v) v[w] /= Math.sqrt(s) || 1; return v; };
    const dot = (a, b) => Object.keys(a).reduce((s, w) => s + a[w] * (b[w] ?? 0), 0);
    const pv = pDocs.map(vec);
    // the library sees the same corpus only if given the same topics: analyse exactly this slice
    const r = analyzeGaps({ topics, plugins, cfg });
    let checked = 0;
    for (const [i, t] of topics.entries()) {
      const tv = vec(tDocs[i]);
      const best = pv.map((v, j) => [dot(tv, v), plugins[j].id]).sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : 1))[0];
      const c = r.clusters.find((x) => x.evidence.some((e) => e.url === t.url));
      assert(c, `topic ${t.id} is in no cluster`);
      assert(Math.abs(c.coverage - Math.round(best[0] * 1000) / 1000) <= 0.001, `topic ${t.id}: library coverage ${c.coverage}, independent ${best[0].toFixed(3)}`);
      if (best[0] > 0) assert(c.closestPlugins[0].id === best[1], `topic ${t.id}: closest ${c.closestPlugins[0]?.id} vs independent ${best[1]}`);
      checked++;
    }
    return `${checked} requests agree`;
  });

  check('hand-built world: the unanswered request is a likely gap ranked first, the answered one is covered', async () => {
    const { analyzeGaps } = await lib('gaps.mjs');
    const { loadConfig } = await lib('config.mjs');
    const cfg = loadConfig();
    cfg.gaps = { ...cfg.gaps, minClusterSize: 1, singleMinLikes: 0, topN: 10, similarity: 0.3 };
    const mk = (id, title, likes) => ({ id, title, slug: 's', cat: 8, created: '2025-01-01', last: '2025-02-01', views: 10, likes, posts: 1, tags: [], closed: false, url: `https://forum.obsidian.md/t/s/${id}` });
    const r = analyzeGaps({
      topics: [mk(1, 'Spell checker with custom dictionary words', 10), mk(2, 'Habit tracker with streak counter', 30), mk(3, 'Streak counter for daily habit tracking', 20)],
      plugins: [{ id: 'spell', name: 'Spell Checker', description: 'Spell checker using a custom dictionary of words', repo: 'a/spell' }, { id: 'cal', name: 'Calendar', description: 'Calendar view', repo: 'a/cal' }],
      cfg,
    });
    assert(r.clusters[0].title.includes('Habit') && r.clusters[0].status === 'likely-gap' && r.clusters[0].topics === 2, `first cluster: ${JSON.stringify(r.clusters[0])}`);
    const spell = r.clusters.find((c) => /Spell/.test(c.title));
    assert(spell.status === 'probably-covered' && spell.closestPlugins[0].id === 'spell' && spell.rank === 0, `spell: ${JSON.stringify(spell)}`);
  });

  check('real forum data is committed (data/forum), well-formed, and its status says when it was fetched', () => {
    assert(exists('data', 'forum', 'topics.json') && exists('data', 'forum', 'status.json'), 'data/forum/topics.json + status.json missing (run: node scripts/forum.mjs)');
    const t = JSON.parse(read('data', 'forum', 'topics.json'));
    const s = JSON.parse(read('data', 'forum', 'status.json'));
    assert(t.schema === 1 && t.topics.length >= 200, `only ${t.topics.length} topics`);
    assert(['ok', 'partial', 'too-few', 'failed'].includes(s.state) && !Number.isNaN(Date.parse(s.fetchedAt)), 'status.json malformed');
    assert(!t.topics.some((x) => /^About the .* category$/i.test(x.title)), 'category description topics must be filtered out');
    return `${t.topics.length} topics fetched ${s.fetchedAt.slice(0, 10)} (${s.state})`;
  });

  check('ideas.json at the repo root validates against schemas/ideas.schema.json, has evidence links, and names no authors', async () => {
    const { validate } = await lib('schema.mjs');
    assert(exists('ideas.json'), 'ideas.json missing (run: npm run analyze)');
    const ideas = JSON.parse(read('ideas.json'));
    const errs = validate(JSON.parse(read('schemas', 'ideas.schema.json')), ideas);
    assert(!errs.length, errs.slice(0, 6).join('\n'));
    assert(ideas.gaps.length >= 5 && ideas.maintainersWanted.length >= 5, `gaps=${ideas.gaps.length} maintainersWanted=${ideas.maintainersWanted.length}`);
    for (const g of ideas.gaps) assert(g.evidence.length && g.evidence.every((e) => e.url.startsWith('https://forum.obsidian.md/t/')), `gap ${g.id} lacks forum evidence`);
    for (const m of ideas.maintainersWanted) assert(m.evidence.directory.startsWith('https://obsidian.md/plugins?id=') && (m.evidence.repository === null || m.evidence.repository.startsWith('https://github.com/')), `maintainer entry ${m.id} lacks evidence`);
    assert(!/"author"/.test(read('ideas.json')), 'ideas.json must not carry an author field');
    const snaps = fs.readdirSync(p('data', 'snapshots')).filter((f) => f.endsWith('.json.gz')).sort();
    assert(ideas.week === snaps.at(-1).replace('.json.gz', ''), `ideas.json is for ${ideas.week}, newest snapshot is ${snaps.at(-1)}`);
    return `${ideas.gaps.length} gaps, ${ideas.maintainersWanted.length} maintainers wanted, week ${ideas.week}`;
  });

  check('ideas.json is reproducible from the committed snapshots + forum data (same bytes)', () => {
    if (!exists('data', 'cache', 'directory.json')) return 'skipped: data/cache/directory.json absent (written by scripts/fetch.mjs; CI always has it)';
    const out = tmpdir('r3-ideas');
    sh(`node scripts/analyze.mjs --out ${out}/analysis.json --ideas ${out}/ideas.json`, { env: { RADAR_NOW: '' } });
    assert(fs.readFileSync(`${out}/ideas.json`, 'utf8') === read('ideas.json'), 'regenerating ideas.json gives different bytes: the committed file is stale (run: npm run analyze)');
  });

  check('the forum step is optional: with the forum unreachable scripts/forum.mjs exits 0 and the analysis still works', () => {
    const out = tmpdir('r3-offline');
    const r = sh(`node scripts/forum.mjs --out ${out}/forum --delay 0 --pages 1`, { env: { RADAR_FORUM_BASE: 'http://127.0.0.1:1' } });
    assert(/failed/.test(r.out), 'expected the run to report state failed');
    assert(!exists(path.relative(ROOT, `${out}/forum/topics.json`)) && JSON.parse(fs.readFileSync(`${out}/forum/status.json`, 'utf8')).state === 'failed', 'status.json should record the failure and no topics file be invented');
    sh(`node scripts/analyze.mjs --snapshots fixtures/snapshots --directory fixtures/releases/community-plugins.json --forum ${out}/forum --out ${out}/a.json --ideas ${out}/ideas.json`);
    const ideas = JSON.parse(fs.readFileSync(`${out}/ideas.json`, 'utf8'));
    assert(ideas.gaps.length === 0 && ideas.forum?.state === 'failed' && ideas.maintainersWanted.length > 0, 'ideas.json should keep working without forum data');
  });

  check('config.json carries every gap threshold the Methodology page will print', () => {
    const c = JSON.parse(read('config.json'));
    for (const k of ['similarity', 'refinePasses', 'minClusterSize', 'singleMinLikes', 'gapBelow', 'coveredAbove', 'closest', 'evidence', 'topN', 'ignoreTags', 'coreHints']) assert(c.gaps?.[k] !== undefined, `config.gaps.${k} missing`);
    for (const k of ['categories', 'pages', 'delayMs', 'maxFailures', 'keepIfBelow']) assert(c.forum?.[k] !== undefined, `config.forum.${k} missing`);
    assert(c.ideas?.gaps > 0 && c.ideas?.maintainers > 0, 'config.ideas missing');
    assert(c.gaps.gapBelow < c.gaps.coveredAbove, 'gapBelow must be below coveredAbove');
  });

  check('gap analysis code makes no network calls and no LLM calls (TF-IDF is plain arithmetic)', () => {
    for (const f of ['lib/text.mjs', 'lib/gaps.mjs', 'lib/ideas.mjs']) {
      assert(!/\bfetch\(|https?:\/\/|node:http|node:https|anthropic|openai/i.test(read(f).replace(/\/\/.*$/gm, '').replace(/`https:\/\/[^`]*`/g, '')), `${f} must be pure computation`);
    }
  });
}
