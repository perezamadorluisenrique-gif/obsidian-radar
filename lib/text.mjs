// Tiny text toolkit for the gap analysis: tokenizer, light stemmer, TF-IDF vectors, cosine similarity.
// Deterministic, dependency-free. Sparse vectors are Maps term -> weight, L2-normalised.

const STOP = new Set(('a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each ' +
  'few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not of off on once only or other our out over own same she ' +
  'should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your ' +
  // words that appear in almost every feature request and say nothing about the topic
  'add added adding allow allows ability able please option options feature features request requests support supports want wants need needs needed make makes way use using used like ' +
  'new better improve improved improvement improvements enable enabled obsidian plugin plugins app apps idea ideas possible possibility instead simple easy easier etc via per ' +
  'currently currently one two get gets set sets let lets have').split(/\s+/));

/** Boilerplate Obsidian appends to many descriptions. */
const BOILERPLATE = /-?\s*this plugin has not been manually reviewed by obsidian staff\.?/gi;

/** Very light suffix stripping: enough to make link/links/linking and library/libraries meet. */
export function stem(w) {
  if (w.length <= 3 || !/^[a-z]+$/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (/(ing|ed)$/.test(w) && w.length > 5) {
    let b = w.replace(/(ing|ed)$/, '');
    if (/([^aeiou])\1$/.test(b)) b = b.slice(0, -1); // running -> run
    if (/[aeiou]/.test(b)) return b;
  }
  if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

/** Text -> stemmed content terms. `raw` keeps the unstemmed form next to each term for labels. */
export function terms(text, { raw = false } = {}) {
  const out = [];
  for (const t of String(text ?? '').replace(BOILERPLATE, ' ').toLowerCase().replace(/https?:\/\/\S+/g, ' ').split(/[^\p{L}\p{N}]+/u)) {
    if (t.length < 2 || /^\d+$/.test(t) || STOP.has(t)) continue;
    const s = stem(t);
    if (STOP.has(s)) continue;
    out.push(raw ? [s, t] : s);
  }
  return out;
}

/** Document frequencies over a list of term arrays -> idf function. */
export function buildIdf(docs) {
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return { n, df, idf: (t) => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1 };
}

/** Sublinear tf * idf, L2-normalised. Terms never seen in the corpus still get the maximum idf. */
export function vectorize(termList, idf) {
  const tf = new Map();
  for (const t of termList) tf.set(t, (tf.get(t) ?? 0) + 1);
  const v = new Map();
  let norm = 0;
  for (const [t, c] of tf) { const w = (1 + Math.log(c)) * idf(t); v.set(t, w); norm += w * w; }
  norm = Math.sqrt(norm);
  if (norm) for (const [t, w] of v) v.set(t, w / norm);
  return v;
}

export function cosine(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [t, w] of a) { const x = b.get(t); if (x) s += w * x; }
  return s;
}

/** Sum of vectors, re-normalised: a cluster centroid. */
export function centroid(vectors) {
  const c = new Map();
  for (const v of vectors) for (const [t, w] of v) c.set(t, (c.get(t) ?? 0) + w);
  let norm = 0;
  for (const w of c.values()) norm += w * w;
  norm = Math.sqrt(norm);
  if (norm) for (const [t, w] of c) c.set(t, w / norm);
  return c;
}

export const topTerms = (v, n) => [...v].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([t]) => t);
