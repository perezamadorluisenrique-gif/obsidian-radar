// Body of the Methodology page. Every number comes from config.json (the same object the analysis reads), so the
// documented thresholds cannot drift from the code that applies them.
import { CATEGORIES } from './categories.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const T = (key, en) => `<span data-i18n="${key}">${en}</span>`;
const nf = new Intl.NumberFormat('en-US');
const n = (x) => nf.format(x);

export function methodologyBody({ cfg, ctx }) {
  const a = cfg.abandonment, g = cfg.growth, k = cfg.gaps, w = a.weights, f = cfg.fetch;
  const wsum = w.loved + w.quiet + w.issues;
  return `
<h1>${T('method.title', 'Methodology')}</h1>
<p class="lead">${T('method.lead', 'How every number on this site is made, what it cannot tell you, and how to switch it off.')}</p>
<p class="notice" role="note">${T('method.summary', 'Summary in Spanish: everything is deterministic arithmetic with no AI. Growth is the difference between weekly snapshots; abandonment combines high downloads, months without activity and open issues; gaps compare forum request titles with plugin descriptions using TF-IDF. The exact formulas and thresholds are below (in English).')}</p>
<div class="prose">

<nav aria-label="On this page"><ul>
<li><a href="#principles">Principles</a></li><li><a href="#data">Data and refresh</a></li><li><a href="#growth">Growth and newcomers</a></li>
<li><a href="#maintainers">Looking for maintainers</a></li><li><a href="#gaps">Gaps</a></li><li><a href="#similar">Similar plugins, categories, My plugins</a></li>
<li><a href="#limits">Limits</a></li><li><a href="#pause">Pausing it</a></li><li><a href="#ideas">Reading ideas.json</a></li>
</ul></nav>

<h2 id="principles">Principles</h2>
<ul>
<li><strong>Deterministic.</strong> The same snapshots always produce the same pages. No language model, no randomness, no hidden manual edits; the analysis is plain JavaScript in the public repository.</li>
<li><strong>Public data only.</strong> The Obsidian plugin directory, the GitHub API and the public Obsidian forum.</li>
<li><strong>History begins at the first snapshot</strong> (<strong>${esc(ctx.firstWeek)}</strong>). Nothing before it is reconstructed or guessed; the site says so wherever it matters. The first snapshot is a baseline: weekly growth needs two.</li>
<li><strong>Plugins, not people.</strong> Pages about quiet plugins never name or rank their authors, and the wording is an invitation (help, fork, build an alternative), not a verdict. The only author-level view is the owner's own "My plugins" panel.</li>
<li><strong>Snapshots are append-only.</strong> A weekly run writes one file, <code>data/snapshots/YYYY-Www.json.gz</code>, and never rewrites earlier weeks. Re-running the same week overwrites only that week.</li>
</ul>

<h2 id="data">Data and refresh</h2>
<table>
<tr><th>Source</th><th>What we take</th><th>When</th></tr>
<tr><td><code>obsidianmd/obsidian-releases</code></td><td><code>community-plugins.json</code> (the directory), <code>community-plugin-stats.json</code> (cumulative downloads, latest release date), <code>community-plugins-removed.json</code></td><td>every run, 3 small files</td></tr>
<tr><td>GitHub GraphQL</td><td>per repository: last push, archived, stars, open issues, latest release date, open issues labelled as feature requests (for plugins with at least ${n(f.labelsMinDownloads)} downloads), created date</td><td>batches of about ${f.batchSize} repositories per request</td></tr>
<tr><td>Obsidian forum (Discourse JSON)</td><td>topics of the categories <em>Feature requests</em> and <em>Plugin ideas</em>: title, tags, likes, views, dates</td><td>every run, optional</td></tr>
</table>
<p><strong>Rolling refresh.</strong> The GitHub API has a rate limit. When it runs out, the run saves what it has, and the next run continues with the plugins that have waited longest. A snapshot's header says <em>rolling</em> or <em>complete</em>, and how many repositories were checked. A plugin that has not been checked yet is marked <em>provisional</em>; nothing fails and no number is invented. Downloads and release dates always come complete, because they are in the stats file.</p>
<p><strong>Forum step.</strong> Politeness delay of ${n(cfg.forum.delayMs)} ms between requests, a 429 waits for the server's <code>Retry-After</code>, and ${n(cfg.forum.maxFailures)} consecutive failures stop the step. If the forum is down, or returns less than ${Math.round(cfg.forum.keepIfBelow * 100)}% of the topics we already have, the previous forum data is kept and the Gaps page says when it was fetched. The rest of the site never depends on it.</p>

<h2 id="growth">Growth and newcomers</h2>
<p>A snapshot stores cumulative downloads, so all growth is a difference between snapshots.</p>
<p class="formula">per week = (downloads_now − downloads_before) ÷ weeks between the two snapshots<br>
relative growth = per week ÷ downloads_before</p>
<ul>
<li>A missed run is averaged over the gap (the divisor is the ISO-week distance), so one skipped Monday does not look like a double week.</li>
<li><strong>Relative growth</strong> only counts plugins with at least ${n(g.minBase)} downloads before and ${n(g.minDelta)} gained, otherwise "1 to 3 downloads" would read as +200%.</li>
<li>A negative difference (the directory occasionally corrects counts) is treated as a data anomaly: no growth is shown for that plugin that week.</li>
<li><strong>Trend</strong> compares the average weekly gain of the recent half of the last ${g.trendWeeks} weeks with the earlier half: <em>rising</em> if it is at least ${Math.round(g.trendFlat * 100)}% higher, <em>slowing</em> if at least ${Math.round(g.trendFlat * 100)}% lower, <em>steady</em> otherwise (and steady when both halves are under ${g.trendMinRate} downloads a week). The sparkline shows those weekly gains.</li>
<li><strong>Rising newcomers</strong> are plugins younger than ${g.newcomerDays} days, ranked by weekly gain (or, in their first week, downloads divided by age in weeks). A plugin we watched arrive is dated exactly and marked <em>first seen</em>. For plugins already listed when our history began, the date is <strong>estimated</strong>: the directory file is append-only, so list order is chronological, and the date is a low percentile of the latest-release dates of the ${2 * g.orderWindow} plugins around it, never earlier than the repository's creation date when known. These are marked <em>age estimated</em> and the estimate gets better only in the sense that every plugin that arrives from now on is exact.</li>
</ul>

<h2 id="maintainers">Looking for maintainers</h2>
<p>These are plugins people still download in large numbers whose repository has been quiet for a long time. It is a prompt for help, a fork or an alternative; it says nothing about the person who made the plugin, who owes nobody their free time. A plugin is listed when <strong>all</strong> of these hold:</p>
<ol>
<li>downloads ≥ ${n(a.minDownloads)} (people clearly use it);</li>
<li>quiet for ≥ ${a.quietDays} days (about ${Math.round(a.quietDays / 30.44)} months), where activity is the later of the last push and the latest release;</li>
<li>not archived and the repository still exists (those are listed separately, as <em>archived by their authors</em> and <em>no longer reachable</em>);</li>
<li>at least ${a.minOpenIssues} open issues, checked only when GitHub data is known. Otherwise the entry is <em>provisional</em>.</li>
</ol>
<p>Listed plugins are ranked by a 0–100 score:</p>
<p class="formula">score = 100 × (${w.loved}·L + ${w.quiet}·Q + ${w.issues}·I) ÷ ${wsum}<br>
L = clamp( log10(downloads ÷ ${n(a.minDownloads)}) ÷ log10(${a.lovedSpan}) )&nbsp;&nbsp;(${n(a.minDownloads)} downloads → 0, ${n(a.minDownloads * a.lovedSpan)} → 1)<br>
Q = clamp( (quiet days − ${a.quietDays}) ÷ ${a.quietSpanDays} )&nbsp;&nbsp;(12 months → 0, 36 months → 1)<br>
I = clamp( log10(1 + open issues) ÷ log10(${1 + a.issuesFull}) )&nbsp;&nbsp;(${a.issuesFull} open issues → 1)</p>
<p>While open issues are unknown (provisional), the issues term and its weight are left out, so a provisional score is comparable but not identical to a verified one. Only the top ${a.topN} are shown.</p>

<h2 id="gaps">Gaps</h2>
<p>A gap is a forum feature request that no plugin seems to cover. The method is word statistics, chosen because it is reproducible and explainable:</p>
<ol>
<li><strong>Documents.</strong> Each forum topic is its title plus its tags (minus generic meta tags such as <code>${esc(k.ignoreTags.slice(0, 4).join(', '))}</code>…). Each plugin is its name (counted twice) plus its description. Lower-cased, stop words removed, light stemming.</li>
<li><strong>TF-IDF vectors</strong> with sublinear term frequency and <code>idf = ln((N+1)/(df+1)) + 1</code> over topics and plugins together, each vector length-normalised.</li>
<li><strong>Fit.</strong> For each topic, the cosine similarity to the single closest plugin description.</li>
<li><strong>Clusters.</strong> Topics are grouped by a one-pass leader clustering at similarity ${k.similarity} (most-liked topic first), followed by ${k.refinePasses} refinement passes. Clusters of one are kept only with at least ${k.singleMinLikes} likes (${k.minClusterSize}+ topics are always kept).</li>
<li><strong>Coverage</strong> of a cluster is the like-weighted mean of its topics' fits (weight 1 + likes). Below <strong>${k.gapBelow}</strong> it is a <em>likely gap</em>, below ${k.coveredAbove} <em>partly covered</em>, otherwise <em>probably covered</em>.</li>
<li><strong>Rank</strong> = demand × (1 − min(1, coverage ÷ ${k.coveredAbove})), where demand = Σ(1 + likes). Big, uncovered demand floats to the top.</li>
<li>Each cluster lists the ${k.closest} closest plugins by description similarity and up to ${k.evidence} forum threads as evidence. Requests that mention the app itself (mobile, Sync, Publish, core editor, WYSIWYG…) are flagged <em>may need changes in Obsidian</em>, since a plugin may not be able to deliver them.</li>
</ol>
<p>The thresholds were calibrated on the real forum (about 1,000 topics against about 9,400 plugins): genuine matches score about 0.5 and above, unrelated pairs stay below about 0.45. Treat "likely gap" as <strong>worth a look</strong>. Matching is by words, not meaning, so a plugin can solve a request without sharing its vocabulary, and a shared word can look like coverage when there is none.</p>

<h2 id="similar">Similar plugins, categories, My plugins</h2>
<ul>
<li><strong>Similar plugins</strong> use the same TF-IDF cosine on name + description (at least 0.15, best 8). They power the plugin pages and the comparison below.</li>
<li><strong>Categories</strong> are a keyword map, not Obsidian's taxonomy (the directory has none): a plugin gets up to three of ${CATEGORIES.length} categories (${esc(CATEGORIES.map((c) => c[1]).join(', '))}) by the number of keyword hits in its name and description. They exist for navigation and filtering only.</li>
<li><strong>My plugins</strong> ranks each of the owner's plugins (set as <code>myAuthor</code> in <code>config.json</code>: <code>${esc(cfg.myAuthor)}</code>) among its similar plugins by downloads and compares downloads and weekly growth with the <em>median</em> of those similar plugins.</li>
</ul>

<h2 id="limits">Limits</h2>
<ul>
<li><strong>Downloads are not users.</strong> They are cumulative installs/updates counted by the directory; they can include reinstalls and bots.</li>
<li><strong>One data point is not a trend.</strong> Until a few weekly snapshots exist, "growing" rests on very little. The page says so.</li>
<li><strong>Quiet is not dead.</strong> A finished, stable plugin looks "abandoned" by these rules. Check the repository before drawing conclusions.</li>
<li><strong>Word matching is crude.</strong> It misses synonyms and can be fooled by shared vocabulary. Read the linked threads.</li>
<li><strong>Estimated ages</strong> for plugins listed before the first snapshot are approximations (see above).</li>
<li><strong>Data lags.</strong> GitHub details are refreshed in batches; the forum is fetched with a politeness delay. The footer shows the snapshot week and date.</li>
<li><strong>Sizes.</strong> The Gaps and Looking-for-maintainers lists are capped (top ${k.topN} and top ${a.topN}) to stay readable.</li>
</ul>

<h2 id="pause">Pausing it</h2>
<ul>
<li><strong>Stop the weekly run:</strong> GitHub → Actions → <em>weekly</em> → ⋯ → <em>Disable workflow</em> (re-enable the same way). Nothing is lost; the last site stays published.</li>
<li><strong>Or</strong> delete the <code>schedule:</code> block from <code>.github/workflows/weekly.yml</code> and keep manual runs (<em>Run workflow</em>).</li>
<li><strong>Take the site down:</strong> Settings → Pages → unpublish. Snapshots stay in the repository.</li>
<li><strong>Skip only the forum:</strong> the forum step is optional; set the repository variable <code>RADAR_FORUM</code> to <code>off</code> (Settings → Secrets and variables → Actions → Variables) and the Gaps page keeps showing the last data fetched.</li>
</ul>

<h2 id="ideas">Reading ideas.json</h2>
<p><a href="ideas.json">ideas.json</a> is rebuilt every run and validated against <code>schemas/ideas.schema.json</code> before it is written. Top level: <code>schema</code>, <code>week</code>, <code>generated</code> (date), <code>notes</code> (caveats, read them), <code>forum</code> (state of the forum data), <code>gaps</code>, <code>maintainersWanted</code>, <code>archivedByAuthors</code>, <code>basis</code> (snapshots, first week, plugin count).</p>
<ul>
<li><code>gaps[]</code>: <code>id</code>, <code>title</code>, <code>keywords</code>, <code>requests</code>, <code>likes</code>, <code>views</code>, <code>status</code> (likely-gap / partly-covered / probably-covered), <code>coverage</code> (0–1, lower = less covered), <code>rank</code>, <code>appLevel</code> (probably needs Obsidian itself to change), <code>firstRequested</code>, <code>lastActive</code>, <code>closestPlugins[]</code> with <code>similarity</code>, and <code>evidence[]</code> forum links.</li>
<li><code>maintainersWanted[]</code>: <code>id</code>, <code>name</code>, <code>downloads</code>, <code>weeklyDownloads</code>, <code>quietMonths</code>, <code>lastActivity</code>, <code>openIssues</code>, <code>stars</code>, <code>score</code>, <code>provisional</code>, and <code>evidence</code> links (directory, repository, issues). No author names, by design.</li>
<li><code>archivedByAuthors[]</code>: popular plugins whose authors archived the repository (<code>id</code>, <code>name</code>, <code>downloads</code>, <code>evidence</code>), listed as room for an alternative.</li>
<li>To use it: sort <code>gaps</code> by <code>rank</code>, skip <code>appLevel: true</code>, open the evidence threads, and check <code>closestPlugins</code> before building. For <code>maintainersWanted</code>, open the repository, read the issues, and offer help kindly before forking.</li>
</ul>
</div>
`;
}
