// "Looking for maintainers" analysis. Deterministic and documented on the Methodology page.
//
// A plugin is listed when ALL of these hold (the gates):
//   - downloads >= abandonment.minDownloads            people clearly use it
//   - quiet for >= abandonment.quietDays days          last activity = the later of last push and latest release
//   - not archived and its repository still exists     archived plugins are listed apart, as "archived by their authors"
//   - open issues >= abandonment.minOpenIssues         only checked when GitHub metadata is known; otherwise the
//                                                      entry is marked provisional (not yet verified against GitHub)
// and is then ranked by a 0-100 score:
//   score = 100 * (wL*L + wQ*Q + wI*I) / (wL + wQ + wI)           (wI is dropped while open issues are unknown)
//   L = clamp(log10(downloads / minDownloads) / log10(lovedSpan), 0, 1)       10k -> 0, 1M -> 1 with lovedSpan 100
//   Q = clamp((quietDays - quietGate) / quietSpanDays, 0, 1)                   12 months -> 0, 36 months -> 1
//   I = clamp(log10(1 + openIssues) / log10(1 + issuesFull), 0, 1)             100 open issues -> 1
import { DAY, dayStr, parseDay } from './week.mjs';

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const round1 = (x) => Math.round(x * 10) / 10;
const round3 = (x) => Math.round(x * 1000) / 1000;

/** Later of last push and latest release (day strings compare correctly as text). */
export const lastActivity = (rec) => [rec.push, rec.rel].filter(Boolean).sort().at(-1) ?? null;

/**
 * Judge one plugin record. Returns { eligible: false, reason } or { eligible: true, score, parts, ... }.
 * `now` is a Date.
 */
export function assess(rec, { cfg, now }) {
  const a = cfg.abandonment;
  if (rec.gone) return { eligible: false, reason: 'unreachable' };
  if (rec.arch) return { eligible: false, reason: 'archived' };
  if (rec.dl < a.minDownloads) return { eligible: false, reason: 'downloads' };
  const last = lastActivity(rec);
  if (!last) return { eligible: false, reason: 'no-activity-data' };
  const quiet = Math.floor((+now - parseDay(last)) / DAY);
  if (quiet < a.quietDays) return { eligible: false, reason: 'active' };
  const issuesKnown = Boolean(rec.chk) && rec.iss !== undefined;
  if (issuesKnown && rec.iss < a.minOpenIssues) return { eligible: false, reason: 'few-issues' };

  const w = a.weights;
  const L = clamp(Math.log10(rec.dl / a.minDownloads) / Math.log10(a.lovedSpan));
  const Q = clamp((quiet - a.quietDays) / a.quietSpanDays);
  const I = issuesKnown ? clamp(Math.log10(1 + rec.iss) / Math.log10(1 + a.issuesFull)) : null;
  const num = w.loved * L + w.quiet * Q + (issuesKnown ? w.issues * I : 0);
  const den = w.loved + w.quiet + (issuesKnown ? w.issues : 0);
  return {
    eligible: true,
    score: round1((100 * num) / den),
    parts: { loved: round3(L), quiet: round3(Q), issues: I === null ? null : round3(I) },
    lastActivity: last,
    quietDays: quiet,
    provisional: !issuesKnown,
  };
}

/** Rank everything in the latest snapshot. `growth` (optional) adds weekly downloads as "still in use" evidence. */
export function analyzeAbandonment({ latest, directory, growth, cfg, now }) {
  const meta = Object.fromEntries(directory.map((p) => [p.id, p]));
  const entry = (id, rec, extra = {}) => ({
    id, name: meta[id]?.name ?? id, repo: meta[id]?.repo ?? null, dl: rec.dl,
    stars: rec.stars ?? null, issues: rec.iss ?? null, featureRequests: rec.fr ?? null,
    weekly: growth?.plugins[id]?.d1 ?? null, ...extra,
  });
  const list = [], archived = [], unreachable = [];
  let candidates = 0;
  for (const id of Object.keys(latest.data)) {
    const rec = latest.data[id];
    const r = assess(rec, { cfg, now });
    if (r.eligible) { candidates++; list.push(entry(id, rec, { score: r.score, parts: r.parts, lastActivity: r.lastActivity, quietDays: r.quietDays, provisional: r.provisional })); }
    else if (r.reason === 'archived' && rec.dl >= cfg.abandonment.minDownloads) archived.push(entry(id, rec, { lastActivity: lastActivity(rec) }));
    else if (r.reason === 'unreachable' && rec.dl >= cfg.abandonment.minDownloads) unreachable.push(entry(id, rec, { lastActivity: lastActivity(rec) }));
  }
  const cmp = (a, b) => b.dl - a.dl || (a.id < b.id ? -1 : 1);
  list.sort((a, b) => b.score - a.score || cmp(a, b));
  archived.sort(cmp);
  unreachable.sort(cmp);
  const verified = list.filter((x) => !x.provisional).length;
  return {
    meta: {
      week: latest.week, asOf: dayStr(now), candidates, verified, provisional: candidates - verified,
      archived: archived.length, unreachable: unreachable.length,
    },
    list: list.slice(0, cfg.abandonment.topN),
    archived: archived.slice(0, 30),
    unreachable: unreachable.slice(0, 30),
  };
}
