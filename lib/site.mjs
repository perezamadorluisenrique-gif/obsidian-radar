// Static site generator: analysis in, a Map of { path -> string } out. Pure (no I/O); scripts/build-site.mjs writes it.
// Every list page is plain server-rendered HTML (works without JavaScript); app.js only adds filtering, search,
// the theme/language toggles and the plugin-detail chart, from small precomputed JSON files.
import { categorize, categoryLabel, CATEGORIES } from './categories.mjs';
import { similarPlugins, keywords } from './similar.mjs';
import { downloadSeries } from './growth.mjs';
import { methodologyBody } from './methodology.mjs';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const nf = new Intl.NumberFormat('en-US');
const fmt = (x) => (x === null || x === undefined ? '–' : nf.format(Math.round(x)));
const pct = (x) => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const median = (a) => { const s = a.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** i18n helper: English text in the HTML, Spanish looked up by key in the browser. */
const T = (key, en) => `<span data-i18n="${key}">${en}</span>`;
export const usedKeys = (html) => [...html.matchAll(/data-i18n(?:-ph|-label)?="([^"]+)"/g)].map((m) => m[1]);

/** File name of a plugin's JSON: ids are already filename-safe in practice; anything else becomes "_". */
export const pluginFile = (id) => `${String(id).replace(/[^a-z0-9._-]/gi, '_')}.json`;
const pluginHref = (id) => `plugin.html?id=${encodeURIComponent(id)}`;
const directoryUrl = (id) => `https://obsidian.md/plugins?id=${encodeURIComponent(id)}`;
const ghUrl = (repo) => (repo ? `https://github.com/${repo}` : null);

const NAV = [['index.html', 'nav.week', 'This week'], ['growing.html', 'nav.growing', 'Growing'], ['new.html', 'nav.new', 'New'], ['maintainers.html', 'nav.maint', 'Looking for maintainers'], ['gaps.html', 'nav.gaps', 'Gaps'], ['mine.html', 'nav.mine', 'My plugins'], ['methodology.html', 'nav.method', 'Methodology']];

export function layout({ file, title, desc, body, cfg, ctx }) {
  const nav = NAV.map(([f, k, en]) => `<a href="${f}"${f === file ? ' aria-current="page"' : ''}>${T(k, en)}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(cfg.site.title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="assets/style.css">
<script>try{var t=localStorage.getItem('radar-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}</script>
</head>
<body>
<a class="skip" href="#main" data-i18n="skip">Skip to content</a>
<header class="top">
<a class="brand" href="index.html"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 12 18 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg><span>Obsidian Radar</span></a>
<nav aria-label="Main">${nav}</nav>
<div class="tools">
<form action="search.html" method="get" role="search"><input type="search" name="q" data-i18n-ph="search.ph" placeholder="Search plugins…" aria-label="Search plugins" data-i18n-label="search.label" autocomplete="off"></form>
<button type="button" id="lang" aria-label="Language" data-i18n-label="lang">ES</button>
<button type="button" id="theme" aria-label="Theme" data-i18n-label="theme"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg></button>
</div>
</header>
<main id="main">
${body}
</main>
<footer>
<p>${T('footer.data', 'Data: the Obsidian plugin directory, GitHub and the Obsidian forum. Rebuilt every Monday.')} ${T('footer.history', 'History begins at')} <strong>${esc(ctx.firstWeek)}</strong>. <a href="${esc(ghUrl(cfg.site.repo))}">Source</a> · <a href="ideas.json">ideas.json</a></p>
<p class="muted">Snapshot ${esc(ctx.week)} · as of ${esc(ctx.asOf)}</p>
</footer>
<script src="assets/i18n.js" defer></script>
<script src="assets/app.js" defer></script>
</body>
</html>
`;
}

// ---- small components --------------------------------------------------------------------------------------------
const badge = (text, cls = '', key) => `<span class="badge ${cls}">${key ? T(key, text) : esc(text)}</span>`;
const notice = (kind, titleKey, titleEn, bodyKey, bodyEn) => `<aside class="notice ${kind}" role="note"><strong>${T(titleKey, titleEn)}.</strong> ${T(bodyKey, bodyEn)}</aside>`;

/** Weekly-gain sparkline: server-rendered SVG, one series, 2px line, last point marked. Needs two usable points. */
export function sparkline(tr, label) {
  const pts = (tr ?? []).map((v, i) => [i, v]).filter(([, v]) => v !== null);
  if (pts.length < 2) return '';
  const W = 72, H = 22, pad = 3;
  const lo = Math.min(0, ...pts.map((p) => p[1])), hi = Math.max(1, ...pts.map((p) => p[1]));
  const x = (i) => pad + (i / Math.max(1, tr.length - 1)) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad);
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('');
  const [li, lv] = pts.at(-1);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}"><path d="${d}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${x(li).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="3" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/></svg>`;
}

const trendTag = (dir) => (dir === 'up' ? `<span class="trend up" title="Gaining faster than a few weeks ago">▲ ${T('trend.up', 'rising')}</span>` : dir === 'down' ? `<span class="trend down" title="Gaining slower than a few weeks ago">▼ ${T('trend.down', 'slowing')}</span>` : dir === 'flat' ? `<span class="trend flat">– ${T('trend.flat', 'steady')}</span>` : '');

function stat(labelKey, labelEn, value, note = '') {
  return `<div class="stat"><dt>${T(labelKey, labelEn)}</dt><dd>${value}</dd>${note ? `<small>${note}</small>` : ''}</div>`;
}

function num(labelKey, labelEn, value) {
  return `<div><dt>${T(labelKey, labelEn)}</dt><dd>${value}</dd></div>`;
}

// ---- site assembly -----------------------------------------------------------------------------------------------
export function renderSite({ analysis, snaps, directory, ideas, cfg }) {
  const g = analysis.growth, ab = analysis.abandonment, gp = analysis.gaps;
  const latest = snaps.at(-1);
  const dirBy = new Map(directory.map((p) => [p.id, p]));
  const baseline = g.meta.baseline;
  const ctx = { week: analysis.week, asOf: analysis.asOf, firstWeek: g.meta.firstWeek };
  const nameOf = (id) => dirBy.get(id)?.name ?? id;
  const rankOrder = Object.keys(latest.data).sort((a, b) => latest.data[b].dl - latest.data[a].dl || (a < b ? -1 : 1));
  const rank = new Map(rankOrder.map((id, i) => [id, i + 1]));
  const files = new Map();
  const page = (file, title, desc, body) => files.set(file, layout({ file, title, desc, body, cfg, ctx }));

  // plugin rows ------------------------------------------------------------------------------------------------
  const cats = new Map(directory.map((p) => [p.id, categorize(p)]));
  const row = (id, { extra = '', nums = [], badges = '', desc = true } = {}) => {
    const p = dirBy.get(id);
    const name = nameOf(id);
    const text = `${name} ${id} ${p?.description ?? ''}`.toLowerCase();
    const catIds = (cats.get(id) ?? []).join(' ');
    return `<li class="row" data-text="${esc(text)}" data-cats="${esc(catIds)}"><div class="main"><a class="name" href="${pluginHref(id)}">${esc(name)}</a>${badges}${desc && p?.description ? `<p class="desc">${esc(clip(p.description, 150))}</p>` : ''}${extra}</div><dl class="nums">${nums.join('')}</dl></li>`;
  };
  const filterBar = () => `<div class="filterbar"><input type="search" class="filter" data-i18n-ph="filter.ph" placeholder="Filter this list…" aria-label="Filter the list" data-i18n-label="filter.label" autocomplete="off"><select class="catfilter" aria-label="Category"><option value="">All categories</option>${CATEGORIES.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('')}</select></div>`;
  const list = (items, empty) => (items.length ? `<ol class="rows filterable">${items.join('')}</ol>` : `<p class="muted">${empty}</p>`);

  const baselineNote = baseline ? notice('info', 'baseline.title', 'First week of history', 'baseline.body', 'History begins at our first snapshot. Weekly growth needs two snapshots, so the growth lists fill in after the next weekly run. Until then this page shows the biggest plugins and the newest arrivals.') : '';
  const rs = latest.refresh;
  const rollingNote = rs.state === 'rolling' ? `<aside class="notice warn" role="note"><strong>${T('rolling.title', 'GitHub data is still being collected')}.</strong> ${T('rolling.body', 'GitHub details (last push, open issues, archived) are gathered in batches to respect API limits; anything not yet checked is marked provisional.')} <span class="muted">${fmt(rs.withMeta)} / ${fmt(latest.plugins)} checked.</span></aside>` : '';

  // lists ------------------------------------------------------------------------------------------------------
  const growRow = (id, mode) => {
    const p = g.plugins[id];
    const nums = [num('download', 'downloads', fmt(p.dl)), num('perweek', 'per week', p.d1 === null ? '–' : `+${fmt(p.d1)}`)];
    if (mode === 'rel') nums.splice(1, 0, num('growth', 'growth', `+${pct(p.r1)}`));
    const spark = sparkline(p.tr, `Weekly downloads gained, last ${p.tr.length} weeks`);
    return row(id, { nums, badges: trendTag(p.dir), extra: spark ? `<div class="sparkwrap">${spark}</div>` : '' });
  };
  const biggest = rankOrder.slice(0, g.meta.baseline ? 50 : 10).map((id) => row(id, { nums: [num('download', 'downloads', fmt(latest.data[id].dl)), num('perweek', 'per week', g.plugins[id]?.d1 == null ? '–' : `+${fmt(g.plugins[id].d1)}`)] }));
  const ageBadge = (p) => (p.ageSrc === 'seen' ? badge('first seen', 'ok', 'age.seen') + ` <small class="muted">${esc(p.listed)}</small>` : p.ageSrc ? `${badge('age estimated', 'est', 'age.est')} <small class="muted">≈ ${esc(p.listed)}</small>` : '');
  const newcomerRow = (id) => {
    const p = g.plugins[id];
    return row(id, { badges: ` ${ageBadge(p)}`, nums: [num('download', 'downloads', fmt(p.dl)), num('perweek', p.d1 === null ? 'per week since listing' : 'per week', `+${fmt(p.momentum)}`)] });
  };
  const releasedRow = (id) => row(id, { nums: [num('download', 'downloads', fmt(latest.data[id].dl))], badges: latest.data[id].rel ? ` <small class="muted">${esc(latest.data[id].rel)}</small>` : '' });

  // maintainers ------------------------------------------------------------------------------------------------
  const months = (d) => Math.max(0, Math.floor(d / 30.44));
  const maintRow = (m) => {
    const links = [`<a href="${directoryUrl(m.id)}">directory</a>`, m.repo ? `<a href="${ghUrl(m.repo)}">repository</a>` : '', m.repo ? `<a href="${ghUrl(m.repo)}/issues">issues</a>` : ''].filter(Boolean).join(' · ');
    const nums = [num('download', 'downloads', fmt(m.dl)), num('quiet', 'quiet', `${months(m.quietDays)} <span data-i18n="months">months</span>`)];
    if (m.issues !== null) nums.push(num('issues', 'open issues', fmt(m.issues)));
    if (m.weekly !== null) nums.push(num('perweek', 'per week', `+${fmt(m.weekly)}`));
    return row(m.id, { desc: true, badges: m.provisional ? ` <span class="badge est" title="Not yet verified against GitHub"><span data-i18n="provisional">provisional</span></span>` : '', nums, extra: `<p class="links">${links}</p>` });
  };

  // ---- index ----
  const top5 = (ids, f) => `<ol class="rows compact">${ids.slice(0, 5).map(f).join('')}</ol>`;
  const gapList = (gp?.clusters ?? []).filter((c) => c.rank > 0);
  page('index.html', 'This week', 'Weekly radar of the Obsidian community-plugin ecosystem: what is new, what is growing, who needs a maintainer, where the gaps are.', `
<h1>${T('week.title', 'This week in Obsidian plugins')}</h1>
<p class="lead">${T('week.sub', 'What is new, what is growing, what is looking for maintainers, and what is missing.')}</p>
${baselineNote}${rollingNote}
<dl class="stats">
${stat('stat.plugins', 'Plugins', fmt(g.totals.plugins))}
${stat('stat.added', 'New this week', baseline ? '–' : fmt(g.totals.added), baseline ? 'first snapshot' : g.totals.removed ? `${fmt(g.totals.removed)} removed` : '')}
${stat('stat.released', 'Released an update', fmt(g.totals.released), baseline ? 'in the last 7 days' : '')}
${stat('stat.weekly', 'Downloads this week', g.totals.weeklyDownloads === null ? '–' : fmt(g.totals.weeklyDownloads))}
${stat('stat.total', 'Total downloads', fmt(g.totals.downloads))}
</dl>
<section><h2>${T('sec.growing', 'Growing')}</h2>
${baseline ? `<p class="muted">${T('see.biggest', 'Biggest plugins right now')}</p>${top5(rankOrder, (id) => row(id, { nums: [num('download', 'downloads', fmt(latest.data[id].dl))] }))}` : top5(g.lists.absolute, (id) => growRow(id, 'abs'))}
<p><a href="growing.html">${T('see.all', 'See all')} →</a></p></section>
<section><h2>${T('sec.new', 'New and rising')}</h2>
${top5(g.lists.newcomers, newcomerRow)}
<p><a href="new.html">${T('see.all', 'See all')} →</a></p></section>
<section><h2>${T('sec.maint', 'Looking for maintainers / room for an alternative')}</h2>
${top5(ab.list.map((m) => m.id), (id) => maintRow(ab.list.find((m) => m.id === id)))}
<p><a href="maintainers.html">${T('see.all', 'See all')} →</a></p></section>
<section><h2>${T('sec.gaps', 'Gaps: requests no plugin covers')}</h2>
${gapList.length ? `<ol class="gaplist">${gapList.slice(0, 5).map((c) => `<li><a href="gaps.html#${esc(c.id)}">${esc(clip(c.title, 90))}</a> <small class="muted">${fmt(c.likes)} ${T('gaps.likes', 'likes')}</small></li>`).join('')}</ol>` : `<p class="muted">${T('gaps.none', 'No forum data yet; the rest of the site is unaffected.')}</p>`}
<p><a href="gaps.html">${T('see.all', 'See all')} →</a></p></section>
`);

  // ---- growing ----
  page('growing.html', 'Growing', 'Plugins gaining the most downloads, in absolute and relative terms.', `
<h1>${T('growing.title', 'Growing')}</h1>
<p class="lead">${T('growing.sub', 'Plugins gaining the most downloads, in absolute and relative terms.')}</p>
${baselineNote}
${filterBar()}
${baseline
    ? `<section><h2>${T('see.biggest', 'Biggest plugins right now')}</h2>${list(biggest, 'No data.')}</section>`
    : `<section><h2>${T('growing.abs', 'Most downloads gained per week')}</h2>${list(g.lists.absolute.map((id) => growRow(id, 'abs')), 'Nothing gained downloads.')}</section>
<section><h2>${T('growing.rel', 'Fastest relative growth')}</h2><p class="muted">${T('growing.rel.note', 'Only plugins with at least 200 downloads before and 20 gained, so "1 to 3" does not count as +200%.')}</p>${list(g.lists.relative.map((id) => growRow(id, 'rel')), 'Nothing qualifies this week.')}</section>`}
`);

  // ---- new ----
  const removedRows = g.lists.removed.map((id) => `<li>${esc(nameOf(id))} <small class="muted">${esc(id)}</small></li>`).join('');
  page('new.html', 'New', 'New arrivals and rising newcomers under 90 days old.', `
<h1>${T('new.title', 'New')}</h1>
<p class="lead">${T('new.sub', 'This week\'s arrivals and plugins under 90 days old that are rising.')}</p>
${baselineNote}
${filterBar()}
${baseline ? '' : `<section><h2>${T('new.added', 'Added this week')} <small class="muted">(${fmt(g.totals.added)})</small></h2>${list(g.lists.added.slice(0, 100).map((id) => row(id, { nums: [num('download', 'downloads', fmt(latest.data[id].dl))] })), 'No new plugins this week.')}</section>`}
<section><h2>${T('new.rising', 'Rising newcomers (under 90 days)')}</h2>
<p class="muted">${baseline ? 'Ages of plugins listed before our first snapshot are estimated from their position in the directory (marked "age estimated"); every plugin that arrives from now on is dated exactly.' : 'Marked "age estimated" when the plugin was already listed at our first snapshot.'}</p>
${list(g.lists.newcomers.map(newcomerRow), 'No newcomers yet.')}</section>
<section><h2>${T('new.released', 'Released an update this week')} <small class="muted">(${fmt(g.totals.released)})</small></h2>${list(g.lists.released.slice(0, 50).map(releasedRow), 'No releases.')}</section>
${baseline ? '' : `<section><h2>${T('new.removed', 'Removed this week')} <small class="muted">(${fmt(g.totals.removed)})</small></h2>${removedRows ? `<ul>${removedRows}</ul>` : '<p class="muted">None.</p>'}</section>`}
`);

  // ---- maintainers ----
  const archivedRow = (m) => `<li class="row"><div class="main"><a class="name" href="${pluginHref(m.id)}">${esc(m.name)}</a><p class="links">${m.repo ? `<a href="${ghUrl(m.repo)}">repository</a> · ` : ''}<a href="${directoryUrl(m.id)}">directory</a></p></div><dl class="nums">${num('download', 'downloads', fmt(m.dl))}</dl></li>`;
  page('maintainers.html', 'Looking for maintainers', 'Popular Obsidian plugins whose repositories have been quiet for a long time: room for a maintainer or an alternative.', `
<h1>${T('maint.title', 'Looking for maintainers / room for an alternative')}</h1>
<p class="lead">${T('maint.sub', 'Plugins people still download in large numbers whose repository has been quiet for a long time. This is not a judgement: the people who made them owe nobody their free time. It is an invitation to help, fork, or build an alternative.')}</p>
<p>${T('maint.help', 'How to help: open a friendly issue offering a hand, send a pull request, or ask whether the author would like to hand the plugin over. If you would rather build an alternative, do, and link the original.')}</p>
${rollingNote}
<p class="muted">${fmt(ab.meta.candidates)} candidates · ${fmt(ab.meta.verified)} verified against GitHub · ${fmt(ab.meta.provisional)} provisional. <a href="methodology.html#maintainers">How this is scored</a></p>
${filterBar()}
${list(ab.list.map(maintRow), 'No candidates.')}
<section><h2>${T('maint.archived', 'Archived by their authors')} <small class="muted">(${fmt(ab.meta.archived)})</small></h2>${ab.archived.length ? `<ol class="rows">${ab.archived.map(archivedRow).join('')}</ol>` : '<p class="muted">None known yet.</p>'}</section>
<section><h2>${T('maint.gone', 'Repository no longer reachable')} <small class="muted">(${fmt(ab.meta.unreachable)})</small></h2>${ab.unreachable.length ? `<ol class="rows">${ab.unreachable.map(archivedRow).join('')}</ol>` : '<p class="muted">None known yet.</p>'}</section>
`);

  // ---- gaps ----
  const gapCard = (c) => `<article class="gapcard" id="${esc(c.id)}"><h3>${esc(c.title)}</h3>
<p class="muted">${c.appLevel ? `${badge('May need changes in Obsidian itself', 'warn', 'gaps.applevel')} ` : ''}${badge(c.status.replace('-', ' '), c.status === 'likely-gap' ? 'gap' : c.status === 'probably-covered' ? 'ok' : 'est')} ${fmt(c.topics)} ${c.topics === 1 ? T('gaps.request', 'request') : T('gaps.requests', 'requests')} · ${fmt(c.likes)} ${T('gaps.likes', 'likes')} · ${esc(c.terms.join(', '))}</p>
<div class="cols"><div><h4>${T('gaps.evidence', 'Forum threads')}</h4><ul>${c.evidence.map((e) => `<li><a href="${esc(e.url)}">${esc(clip(e.title, 100))}</a> <small class="muted">${fmt(e.likes)} ♥</small></li>`).join('')}</ul></div>
<div><h4>${T('gaps.closest', 'Closest plugins')}</h4>${c.closestPlugins.length ? `<ul>${c.closestPlugins.slice(0, 4).map((p) => `<li><a href="${pluginHref(p.id)}">${esc(p.name)}</a> <small class="muted">${Math.round(p.similarity * 100)}% match</small></li>`).join('')}</ul>` : '<p class="muted">None resemble it.</p>'}</div></div></article>`;
  const fstatus = analysis.forum;
  page('gaps.html', 'Gaps', 'Feature requests from the Obsidian forum that no plugin description seems to cover.', `
<h1>${T('gaps.title', 'Gaps')}</h1>
<p class="lead">${T('gaps.sub', 'Forum requests that no plugin description seems to cover. Matching is by words, not meaning: read "likely gap" as "worth a look", not as proof.')}</p>
${fstatus ? `<p class="muted">Forum data: ${fmt(fstatus.topics)} topics, fetched ${esc(String(fstatus.fetchedAt).slice(0, 10))} (${esc(fstatus.state)}). <a href="ideas.json">${T('gaps.json', 'Download ideas.json')}</a> · <a href="methodology.html#gaps">How this works</a></p>` : ''}
${gp ? `${gapList.length ? gapList.slice(0, 40).map(gapCard).join('\n') : '<p class="muted">Nothing stands out.</p>'}
<details class="covered"><summary>${T('gaps.covered', 'Probably already covered')} (${fmt(gp.clusters.filter((c) => c.rank === 0).length)})</summary>${gp.clusters.filter((c) => c.rank === 0).slice(0, 40).map(gapCard).join('\n')}</details>` : `<p class="muted">${T('gaps.none', 'No forum data yet; the rest of the site is unaffected.')}</p>`}
`);

  // ---- plugin data (JSON), similar, mine ----
  const simAll = similarPlugins(directory, { n: 8, minSim: 0.15 });
  const series = downloadSeries(snaps);
  const kws = keywords(directory);
  const maintBy = new Map(ab.list.map((m) => [m.id, m]));
  const simInfo = (id) => (simAll.get(id) ?? []).filter(([o]) => latest.data[o]).map(([o, s]) => ({ id: o, name: nameOf(o), dl: latest.data[o].dl, d1: g.plugins[o]?.d1 ?? null, sim: s }));
  for (const p of directory) {
    const rec = latest.data[p.id];
    if (!rec) continue;
    const gp1 = g.plugins[p.id];
    const m = maintBy.get(p.id);
    files.set(`p/${pluginFile(p.id)}`, JSON.stringify({
      id: p.id, name: p.name, desc: p.description ?? '', repo: p.repo ?? null,
      urls: { directory: directoryUrl(p.id), repository: ghUrl(p.repo), issues: p.repo ? `${ghUrl(p.repo)}/issues` : null },
      dl: rec.dl, rank: rank.get(p.id), of: rankOrder.length, d1: gp1.d1, r1: gp1.r1, dir: gp1.dir, tr: gp1.tr,
      listed: gp1.listed, ageSrc: gp1.ageSrc, newcomer: gp1.newcomer,
      stars: rec.stars ?? null, issues: rec.iss ?? null, push: rec.push ?? null, rel: rec.rel ?? null, arch: Boolean(rec.arch), gone: Boolean(rec.gone),
      cats: (cats.get(p.id) ?? []).map((c) => categoryLabel[c]),
      maint: m ? { score: m.score, quietDays: m.quietDays, provisional: m.provisional } : null,
      series: series.get(p.id) ?? [], similar: simInfo(p.id),
    }));
  }
  const cdict = CATEGORIES.map(([id]) => id);
  files.set('search.json', JSON.stringify({ week: analysis.week, cats: CATEGORIES.map(([id, label]) => [id, label]), plugins: directory.filter((p) => latest.data[p.id]).map((p, i) => [p.id, p.name, latest.data[p.id].dl, g.plugins[p.id].d1, (cats.get(p.id) ?? []).map((c) => cdict.indexOf(c)).join(','), kws[i].join(' ')]) }));

  // ---- mine ----
  const mine = directory.filter((p) => p.author === cfg.myAuthor && latest.data[p.id]).sort((a, b) => latest.data[b.id].dl - latest.data[a.id].dl);
  const mineRow = (p) => {
    const rec = latest.data[p.id], gp1 = g.plugins[p.id];
    const sim = simInfo(p.id);
    const group = [{ id: p.id, dl: rec.dl }, ...sim].sort((a, b) => b.dl - a.dl || (a.id < b.id ? -1 : 1));
    const pos = group.findIndex((x) => x.id === p.id) + 1;
    const medDl = median(sim.map((s) => s.dl)), medD1 = median(sim.map((s) => s.d1));
    const vs = (mineV, medV) => (medV === null || mineV === null || mineV === undefined ? '–' : `${mineV >= medV ? '▲' : '▼'} ${fmt(mineV)} vs ${fmt(medV)}`);
    return row(p.id, {
      desc: false,
      extra: `<p class="muted">${sim.length ? `${T('mine.rank', 'Rank by downloads')}: <strong>${pos}</strong> / ${group.length} ${T('mine.similar', 'among similar plugins')}` : 'No similar plugins found.'}</p>${sim.length ? `<p class="muted">${sim.slice(0, 4).map((s) => `<a href="${pluginHref(s.id)}">${esc(s.name)}</a>`).join(' · ')}</p>` : ''}`,
      nums: [num('download', 'downloads', `${fmt(rec.dl)}<small> #${fmt(rank.get(p.id))}</small>`), num('perweek', 'per week', gp1.d1 === null ? '–' : `+${fmt(gp1.d1)}`), num('mine.median', 'downloads vs median of similar', vs(rec.dl, medDl)), num('mine.medianweek', 'per week vs median of similar', baseline ? '–' : vs(gp1.d1, medD1))],
    });
  };
  const sumDl = mine.reduce((s, p) => s + latest.data[p.id].dl, 0);
  const sumD1 = baseline ? null : mine.reduce((s, p) => s + (g.plugins[p.id].d1 ?? 0), 0);
  page('mine.html', 'My plugins', `Downloads, rank and weekly growth of ${cfg.myAuthor}'s plugins compared with similar plugins.`, `
<h1>${T('mine.title', 'My plugins')}</h1>
<p class="lead">${T('mine.sub', 'Your plugins compared with similar ones (by description).')} <span class="muted">(${esc(cfg.myAuthor)})</span></p>
${baselineNote}
${mine.length ? `<dl class="stats">${stat('stat.plugins', 'Plugins', fmt(mine.length))}${stat('stat.total', 'Total downloads', fmt(sumDl))}${stat('stat.weekly', 'Downloads this week', sumD1 === null ? '–' : fmt(sumD1))}</dl>${list(mine.map(mineRow), '')}` : `<p class="muted">${T('mine.none', 'No plugins found for this author in the directory.')}</p>`}
<p class="muted">Similar = the plugins whose name and description are closest by TF-IDF cosine similarity (<a href="methodology.html#similar">method</a>). The author is set in <code>config.json</code>.</p>
`);

  // ---- search + plugin shells ----
  page('search.html', 'Search', 'Search Obsidian plugins by name or category keyword.', `
<h1>${T('search.title', 'Search')}</h1>
<form class="bigsearch" action="search.html" method="get" role="search"><input type="search" id="q" name="q" data-i18n-ph="search.ph" placeholder="Search plugins…" aria-label="Search plugins" data-i18n-label="search.label" autocomplete="off"></form>
<div id="chips" class="chips" role="group" aria-label="Categories"></div>
<p id="status" class="muted" aria-live="polite">${T('search.hint', 'Search by name, id or a category keyword.')}</p>
<ol id="results" class="rows"></ol>
<noscript><p class="notice warn">Search needs JavaScript. The lists on the other pages work without it.</p></noscript>
`);
  page('plugin.html', 'Plugin', 'Obsidian plugin details: downloads over time, growth, similar plugins.', `
<div id="plugin" data-base="p/"><p class="muted">${T('plugin.loading', 'Loading…')}</p></div>
<noscript><p class="notice warn">The plugin page needs JavaScript to load its data (a small JSON file).</p></noscript>
`);

  page('methodology.html', 'Methodology', 'How the Obsidian Radar numbers are made: formulas, thresholds, limits, and how to pause it.', methodologyBody({ cfg, ctx }));

  files.set('404.html', layout({ file: '404.html', title: 'Not found', desc: 'Page not found', cfg, ctx, body: '<h1>Not found</h1><p>That page does not exist. <a href="index.html">Back to this week</a>.</p>' }));
  files.set('ideas.json', `${JSON.stringify(ideas, null, 1)}\n`);
  files.set('.nojekyll', '');
  files.set('meta.json', JSON.stringify({ week: analysis.week, asOf: analysis.asOf, firstWeek: g.meta.firstWeek, snapshots: g.meta.snapshots, plugins: g.totals.plugins, baseline }));
  return files;
}
