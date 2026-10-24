// R2 - growth and abandonment analysis run on two snapshots (a real one + a synthetic previous week) and give correct results.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export function register({ rung, assert, exists, read, p, sh, tmpdir, ROOT }) {
  const check = rung('R2', 'growth + abandonment analysis on a real snapshot and a synthetic previous week, correct on test cases');
  const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p(f))).toString('utf8'));
  const lib = (n) => import(path.join(ROOT, 'lib', n));
  const DIRECTORY = 'fixtures/releases/community-plugins.json';

  check('analysis unit tests pass (growth, abandonment, analyze CLI)', () => {
    const r = sh('node --test tests/growth.test.mjs tests/abandonment.test.mjs tests/analyze.test.mjs');
    return `${/# pass (\d+)/.exec(r.out)?.[1]} tests`;
  });

  check('fixtures: a real 2026-W43 sample and a synthetic 2026-W42 exist, validate, and the synthetic one says so', async () => {
    const { validate } = await lib('schema.mjs');
    const schema = JSON.parse(read('schemas', 'snapshot.schema.json'));
    for (const w of ['2026-W42', '2026-W43']) {
      assert(exists('fixtures', 'snapshots', `${w}.json.gz`), `fixtures/snapshots/${w}.json.gz missing`);
      const errs = validate(schema, gz(`fixtures/snapshots/${w}.json.gz`));
      assert(!errs.length, `${w}: ${errs.join('; ')}`);
    }
    assert(/SYNTHETIC/.test(gz('fixtures/snapshots/2026-W42.json.gz').refresh.note), 'the synthetic week must be labelled SYNTHETIC in refresh.note');
    assert(!/SYNTHETIC/.test(gz('fixtures/snapshots/2026-W43.json.gz').refresh.note), 'the real sample must not be labelled synthetic');
    assert(exists('fixtures', 'snapshots', 'plan.json'), 'plan.json (the expected answers) is missing');
  });

  check('growth: analyze.mjs agrees with an independent recomputation from the two snapshots', () => {
    const out = tmpdir('r2-growth');
    fs.mkdirSync(`${out}/snaps`);
    for (const w of ['2026-W42', '2026-W43']) fs.copyFileSync(p('fixtures', 'snapshots', `${w}.json.gz`), `${out}/snaps/${w}.json.gz`);
    sh(`node scripts/analyze.mjs --snapshots ${out}/snaps --directory ${DIRECTORY} --out ${out}/a.json`);
    const a = JSON.parse(fs.readFileSync(`${out}/a.json`, 'utf8'));
    const prev = gz('fixtures/snapshots/2026-W42.json.gz').data, cur = gz('fixtures/snapshots/2026-W43.json.gz').data;
    const cfg = JSON.parse(read('config.json'));
    // independent: plain loops, no lib code
    const rows = [];
    for (const id of Object.keys(cur)) if (prev[id] && cur[id].dl >= prev[id].dl) rows.push({ id, d: cur[id].dl - prev[id].dl, base: prev[id].dl, dl: cur[id].dl });
    const byAbs = [...rows].filter((r) => r.d > 0).sort((x, y) => y.d - x.d || y.dl - x.dl || (x.id < y.id ? -1 : 1)).slice(0, 10).map((r) => r.id);
    const byRel = [...rows].filter((r) => r.base >= cfg.growth.minBase && r.d >= cfg.growth.minDelta).sort((x, y) => y.d / y.base - x.d / x.base || y.dl - x.dl).slice(0, 10).map((r) => r.id);
    assert(JSON.stringify(a.growth.lists.absolute.slice(0, 10)) === JSON.stringify(byAbs), `absolute top 10 differs:\n${a.growth.lists.absolute.slice(0, 10)}\nvs ${byAbs}`);
    assert(JSON.stringify(a.growth.lists.relative.slice(0, 10)) === JSON.stringify(byRel), `relative top 10 differs:\n${a.growth.lists.relative.slice(0, 10)}\nvs ${byRel}`);
    const added = Object.keys(cur).filter((id) => !prev[id]).sort(), removed = Object.keys(prev).filter((id) => !cur[id]).sort();
    assert(JSON.stringify([...a.growth.lists.added].sort()) === JSON.stringify(added), 'added differs');
    assert(JSON.stringify(a.growth.lists.removed) === JSON.stringify(removed), 'removed differs');
    assert(a.growth.totals.weeklyDownloads === rows.reduce((s, r) => s + r.d, 0), 'weekly total differs');
    return `top absolute: ${byAbs.slice(0, 3).join(', ')}; ${added.length} added, ${removed.length} removed`;
  });

  check('growth: the planned cases land where the plan says (big absolute, big relative, tiny base excluded, anomaly, new, removed)', () => {
    const out = tmpdir('r2-plan');
    fs.mkdirSync(`${out}/snaps`);
    for (const w of ['2026-W42', '2026-W43']) fs.copyFileSync(p('fixtures', 'snapshots', `${w}.json.gz`), `${out}/snaps/${w}.json.gz`);
    sh(`node scripts/analyze.mjs --snapshots ${out}/snaps --directory ${DIRECTORY} --out ${out}/a.json`);
    const g = JSON.parse(fs.readFileSync(`${out}/a.json`, 'utf8')).growth, plan = JSON.parse(read('fixtures', 'snapshots', 'plan.json'));
    const order = Object.entries(plan.gains).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([id]) => id);
    assert(JSON.stringify(g.lists.absolute.slice(0, 3)) === JSON.stringify(order), `top absolute should be ${order}, got ${g.lists.absolute.slice(0, 3)}`);
    assert(g.lists.relative[0] === 'library' && g.lists.relative[1] === 'xminder', `top relative should start library, xminder; got ${g.lists.relative.slice(0, 3)}`);
    for (const id of ['lac-costset', 'heading-guard']) assert(!g.lists.relative.includes(id), `${id} (base of 1 download) must not be ranked by relative growth`);
    assert(g.plugins['dice-rolls'].d1 === null && g.totals.anomalies === 1, 'the planted negative delta must be an anomaly, not negative growth');
    assert(JSON.stringify(g.lists.added) === JSON.stringify(['book-studio', 'claude-studio', 'markdown-rss', 'simboard']), `added: ${g.lists.added}`);
    assert(JSON.stringify(g.lists.removed) === JSON.stringify(Object.keys(plan.ghosts).sort()), `removed: ${g.lists.removed}`);
    assert(g.plugins['book-studio'].newcomer && g.plugins['book-studio'].ageSrc === 'seen', 'a plugin first seen this week is an exact newcomer');
  });

  check('abandonment: hand-computed score (100k downloads, quiet 730 days, 100 open issues = 65; unverified = 50) and gates', async () => {
    const { assess } = await lib('abandonment.mjs');
    const cfg = JSON.parse(read('config.json'));
    const now = new Date('2026-10-24T00:00:00Z');
    const r = assess({ dl: 100000, rel: '2024-10-24', push: '2024-10-24', chk: '2026-10-20', iss: 100 }, { cfg, now });
    assert(r.eligible && r.score === 65, `expected 65, got ${JSON.stringify(r)}`);
    const u = assess({ dl: 100000, rel: '2024-10-24' }, { cfg, now });
    assert(u.eligible && u.score === 50 && u.provisional, `expected provisional 50, got ${JSON.stringify(u)}`);
    const no = (rec, why) => { const x = assess(rec, { cfg, now }); assert(!x.eligible && x.reason === why, `expected ${why}, got ${JSON.stringify(x)}`); };
    no({ dl: 9999, rel: '2020-01-01' }, 'downloads');
    no({ dl: 50000, rel: '2026-01-01' }, 'active');
    no({ dl: 50000, rel: '2020-01-01', arch: 1 }, 'archived');
    no({ dl: 50000, rel: '2020-01-01', push: '2026-09-01' }, 'active');
    no({ dl: 50000, rel: '2020-01-01', chk: '2026-10-20', iss: 2 }, 'few-issues');
  });

  check('abandonment: on the real sample every maintainer-wanted candidate is provisional (no GitHub metadata yet) and says so', () => {
    const out = tmpdir('r2-aband');
    sh(`node scripts/analyze.mjs --snapshots fixtures/snapshots --directory ${DIRECTORY} --out ${out}/a.json`);
    const a = JSON.parse(fs.readFileSync(`${out}/a.json`, 'utf8')).abandonment;
    assert(a.meta.candidates >= 10, `only ${a.meta.candidates} candidates in the sample`);
    assert(a.meta.verified === 0 && a.meta.provisional === a.meta.candidates, 'with no GitHub metadata nothing may be reported as verified');
    assert(a.list.every((x) => x.provisional === true), 'a list entry without GitHub metadata must be flagged provisional');
    const s = a.list.map((x) => x.score);
    assert(JSON.stringify(s) === JSON.stringify([...s].sort((x, y) => y - x)), 'list is not sorted by score');
    return `${a.meta.candidates} provisional candidates, top: ${a.list.slice(0, 3).map((x) => x.id).join(', ')}`;
  });

  check('analysis of the real data/snapshots runs, reports a baseline honestly, and is reproducible', () => {
    const out = tmpdir('r2-real');
    const run = (f) => sh(`node scripts/analyze.mjs --out ${out}/${f}`, { env: { RADAR_NOW: '' } });
    const r = run('a.json');
    run('b.json');
    assert(fs.readFileSync(`${out}/a.json`, 'utf8') === fs.readFileSync(`${out}/b.json`, 'utf8'), 'two runs on the same snapshots differ');
    const a = JSON.parse(fs.readFileSync(`${out}/a.json`, 'utf8'));
    const snaps = fs.readdirSync(p('data', 'snapshots')).filter((f) => f.endsWith('.json.gz')).length;
    assert(a.growth.meta.snapshots === snaps, 'analysis did not read every snapshot');
    if (snaps === 1) {
      assert(a.growth.meta.baseline && a.growth.totals.weeklyDownloads === null, 'with one snapshot the analysis must say "baseline", not invent growth');
      assert(/baseline/.test(r.out), 'the CLI must say it is a baseline');
    }
    assert(a.growth.totals.plugins >= 1000 && a.abandonment.meta.candidates > 0, 'real analysis looks empty');
    return `${a.growth.totals.plugins} plugins, ${a.abandonment.meta.candidates} candidates, ${snaps} snapshot(s)`;
  });

  check('config.json carries every threshold the analysis uses (the Methodology page prints these)', () => {
    const c = JSON.parse(read('config.json'));
    for (const k of ['topN', 'minBase', 'minDelta', 'trendWeeks', 'trendFlat', 'trendMinRate', 'newcomerDays', 'orderWindow', 'orderPercentile']) assert(c.growth?.[k] !== undefined, `config.growth.${k} missing`);
    for (const k of ['minDownloads', 'quietDays', 'minOpenIssues', 'lovedSpan', 'quietSpanDays', 'issuesFull', 'topN']) assert(c.abandonment?.[k] !== undefined, `config.abandonment.${k} missing`);
    for (const k of ['loved', 'quiet', 'issues']) assert(c.abandonment.weights?.[k] > 0, `config.abandonment.weights.${k} missing`);
  });

  check('analysis code makes no network calls and no LLM calls', () => {
    for (const f of ['lib/growth.mjs', 'lib/abandonment.mjs']) {
      const src = read(f);
      assert(!/\bfetch\(|https?:\/\/|node:http|node:https|anthropic|openai/i.test(src.replace(/\/\/.*$/gm, '')), `${f} must be pure computation`);
    }
  });
}
