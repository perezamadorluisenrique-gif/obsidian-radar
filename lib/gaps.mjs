// Gap analysis: which forum requests cluster together, and does any plugin already look like the answer?
//
//   1. Every topic (title + topical tags) and every plugin (name + description) becomes a TF-IDF vector (lib/text.mjs).
//   2. Each topic's `fit` = the highest cosine between it and any plugin; the plugin is its "closest plugin".
//   3. Topics are clustered deterministically: leader clustering in order of likes (a topic joins the most similar
//      cluster if cosine to its centroid >= gaps.similarity, else it starts one), then `refinePasses` passes that
//      move every topic to its nearest centroid.
//   4. cluster coverage = mean of its topics' `fit`, weighted by demand (1 + likes). Low coverage means no plugin
//      description resembles what people ask for: a likely gap.
//   5. rank = demand * (1 - min(1, coverage / coveredAbove)): lots of demand and little coverage comes first.
//
//   Clusters whose requests mostly talk about Obsidian itself (core, mobile apps, sync, publish...) carry
//   `appLevel: true`: a plugin may not be able to deliver them.
//
// Limits (also on the Methodology page): matching is by words, not meaning; a plugin can solve a request without
// sharing its vocabulary, and some requests are changes to Obsidian itself that no plugin can make.
import { terms, buildIdf, vectorize, cosine, centroid, topTerms } from './text.mjs';

const byLikes = (a, b) => b.likes - a.likes || a.id - b.id;
const round3 = (x) => Math.round(x * 1000) / 1000;

export function analyzeGaps({ topics, plugins, downloads = {}, cfg }) {
  const g = cfg.gaps;
  const ignore = new Set(g.ignoreTags ?? []);
  const coreHints = (g.coreHints ?? []).map((x) => new RegExp(x, 'i'));
  const looksCore = (t) => coreHints.some((r) => r.test(t.title) || t.tags.some((tag) => r.test(tag)));
  const pluginTerms = plugins.map((p) => [...terms(p.name), ...terms(p.name), ...terms(p.description)]);
  const topicTerms = topics.map((t) => [...terms(t.title, { raw: true }).map(([s]) => s), ...terms(t.tags.filter((x) => !ignore.has(x)).join(' '))]);
  const { idf } = buildIdf([...topicTerms, ...pluginTerms]);
  const tVec = topicTerms.map((tt) => vectorize(tt, idf));
  const pVec = pluginTerms.map((pt) => vectorize(pt, idf));

  // surface form of each stem for readable labels: the most frequent original spelling in the topics
  const surface = new Map();
  for (const t of topics) for (const [s, raw] of terms(t.title, { raw: true })) {
    if (!surface.has(s)) surface.set(s, new Map());
    surface.get(s).set(raw, (surface.get(s).get(raw) ?? 0) + 1);
  }
  const label = (stem) => { const m = surface.get(stem); return m ? [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0] : stem; };

  // 2. nearest plugins of every topic, through an inverted index over the plugin vectors
  const postings = new Map();
  pVec.forEach((v, j) => { for (const [t, w] of v) { if (!postings.has(t)) postings.set(t, []); postings.get(t).push([j, w]); } });
  const nearest = (vec, n) => {
    const score = new Map();
    for (const [t, w] of vec) for (const [j, pw] of postings.get(t) ?? []) score.set(j, (score.get(j) ?? 0) + w * pw);
    return [...score].sort((a, b) => b[1] - a[1] || (plugins[a[0]].id < plugins[b[0]].id ? -1 : 1)).slice(0, n);
  };
  const near = tVec.map((v) => nearest(v, g.closest));
  const fit = near.map((n) => n[0]?.[1] ?? 0);

  // 3. clustering
  const order = topics.map((t, i) => i).sort((a, b) => byLikes(topics[a], topics[b]));
  let clusters = []; // { members: [idx], c: centroid }
  for (const i of order) {
    let best = -1, bs = 0;
    clusters.forEach((cl, k) => { const s = cosine(tVec[i], cl.c); if (s > bs) { bs = s; best = k; } });
    if (best >= 0 && bs >= g.similarity) { clusters[best].members.push(i); clusters[best].c = centroid(clusters[best].members.map((m) => tVec[m])); }
    else clusters.push({ members: [i], c: tVec[i] });
  }
  for (let pass = 0; pass < g.refinePasses; pass++) {
    const next = clusters.map(() => []);
    const extra = [];
    for (const i of order) {
      let best = -1, bs = 0;
      clusters.forEach((cl, k) => { const s = cosine(tVec[i], cl.c); if (s > bs) { bs = s; best = k; } });
      if (best >= 0 && bs >= g.similarity) next[best].push(i);
      else extra.push({ members: [i], c: tVec[i] });
    }
    clusters = [...next.filter((m) => m.length).map((m) => ({ members: m, c: centroid(m.map((x) => tVec[x])) })), ...extra];
  }

  // 4. describe, score, rank
  const kept = [];
  let small = 0;
  for (const cl of clusters) {
    const ms = cl.members.map((i) => topics[i]);
    const likes = ms.reduce((s, t) => s + t.likes, 0);
    if (ms.length < g.minClusterSize && likes < g.singleMinLikes) { small += ms.length; continue; }
    const demand = ms.reduce((s, t) => s + 1 + t.likes, 0);
    const coverage = round3(cl.members.reduce((s, i) => s + (1 + topics[i].likes) * fit[i], 0) / demand);
    // closest plugins: each plugin keeps its best match with any request of the cluster
    const best = new Map();
    for (const i of cl.members) for (const [j, s] of near[i]) if (s > (best.get(j)?.s ?? 0)) best.set(j, { s, topic: topics[i] });
    const closestPlugins = [...best].sort((a, b) => b[1].s - a[1].s || (plugins[a[0]].id < plugins[b[0]].id ? -1 : 1)).slice(0, g.closest)
      .map(([j, m]) => ({ id: plugins[j].id, name: plugins[j].name, similarity: round3(m.s), downloads: downloads[plugins[j].id] ?? null, repo: plugins[j].repo ?? null, matches: m.topic.title }));
    const rep = cl.members.map((i) => ({ i, s: cosine(tVec[i], cl.c) * (1 + Math.log(1 + topics[i].likes)) })).sort((a, b) => b.s - a.s || topics[a.i].id - topics[b.i].id)[0];
    const sorted = [...ms].sort(byLikes);
    kept.push({
      id: `gap-${topics[rep.i].id}`,
      title: topics[rep.i].title,
      terms: topTerms(cl.c, g.labelTerms).map(label),
      topics: ms.length, likes, views: ms.reduce((s, t) => s + t.views, 0), demand,
      ideas: ms.filter((t) => t.cat === 10).length,
      // half or more of the requests mention Obsidian itself, the mobile apps, sync or publish: a plugin may not be able to do it
      appLevel: ms.filter(looksCore).length * 2 >= ms.length,
      first: ms.map((t) => t.created).sort()[0], last: ms.map((t) => t.last).sort().at(-1),
      coverage,
      status: coverage < g.gapBelow ? 'likely-gap' : coverage < g.coveredAbove ? 'partly-covered' : 'probably-covered',
      rank: Math.round(demand * (1 - Math.min(1, coverage / g.coveredAbove)) * 10) / 10,
      closestPlugins,
      evidence: sorted.slice(0, g.evidence).map((t) => ({ title: t.title, url: t.url, likes: t.likes, views: t.views, created: t.created })),
    });
  }
  kept.sort((a, b) => b.rank - a.rank || b.demand - a.demand || (a.id < b.id ? -1 : 1));
  return {
    meta: { topics: topics.length, plugins: plugins.length, clusters: clusters.length, kept: kept.length, ignoredSmall: small, similarity: g.similarity },
    clusters: kept.slice(0, g.topN),
  };
}
