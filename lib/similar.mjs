// "Similar plugins": cosine similarity of name + description TF-IDF vectors (lib/text.mjs), through an inverted index.
// Used by the plugin page and the "My plugins" panel. Pure and deterministic.
import { terms, buildIdf, vectorize } from './text.mjs';

export function pluginVectors(plugins) {
  const docs = plugins.map((p) => [...terms(p.name), ...terms(p.name), ...terms(p.description)]);
  const { idf } = buildIdf(docs);
  return { docs, vecs: docs.map((d) => vectorize(d, idf)), idf };
}

/** Map plugin id -> [[otherId, similarity], ...] best first (at most n, similarity >= minSim, never itself). */
export function similarPlugins(plugins, { n = 8, minSim = 0.15 } = {}) {
  const { vecs } = pluginVectors(plugins);
  const postings = new Map();
  vecs.forEach((v, j) => { for (const [t, w] of v) { if (!postings.has(t)) postings.set(t, []); postings.get(t).push([j, w]); } });
  const out = new Map();
  vecs.forEach((v, i) => {
    const score = new Map();
    for (const [t, w] of v) for (const [j, pw] of postings.get(t)) if (j !== i) score.set(j, (score.get(j) ?? 0) + w * pw);
    const best = [...score].filter(([, s]) => s >= minSim)
      .sort((a, b) => b[1] - a[1] || (plugins[a[0]].id < plugins[b[0]].id ? -1 : 1)).slice(0, n)
      .map(([j, s]) => [plugins[j].id, Math.round(s * 1000) / 1000]);
    out.set(plugins[i].id, best);
  });
  return out;
}

/** Searchable keywords of a plugin for the compact search index: its name terms, then the first description terms. */
export function keywords(plugins, per = 8) {
  return plugins.map((p) => [...new Set([...terms(p.name), ...terms(p.description)])].slice(0, per));
}
