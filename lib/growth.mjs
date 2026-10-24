// Growth analysis. Pure functions of (snapshots, directory, config, clock): no I/O, no randomness, no network.
//
// A snapshot only stores cumulative downloads, so everything here is a difference between snapshots:
//   d1   downloads gained per week since the previous snapshot (divided by the weeks between them)
//   r1   d1 as a fraction of the previous total
//   tr   the per-week gains over the last `trendWeeks` intervals, oldest first
//   dir  'up' | 'flat' | 'down': the recent half of `tr` compared with the earlier half
import { DAY, dayStr, parseDay, weekStart } from './week.mjs';

const WEEK = 7 * DAY;
const round1 = (x) => Math.round(x * 10) / 10;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/** Whole weeks between two snapshots (at least 1, so a missed run is averaged over the gap). */
export const weeksApart = (a, b) => Math.max(1, Math.round((weekStart(b.week) - weekStart(a.week)) / WEEK));

/** Per-week gains for the intervals of `hist` that contain the plugin. A negative gain is a data anomaly: null. */
export function weeklyRates(hist, id) {
  const out = [];
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1].data[id], b = hist[i].data[id];
    if (!a || !b) { out.push(null); continue; }
    const d = b.dl - a.dl;
    out.push(d < 0 ? null : d / weeksApart(hist[i - 1], hist[i]));
  }
  return out;
}

/** Direction of a series of weekly gains. `null` when there are fewer than two usable points. */
export function direction(rates, { trendFlat, trendMinRate }) {
  const r = rates.filter((x) => x !== null);
  if (r.length < 2) return null;
  const recent = mean(r.slice(r.length - Math.ceil(r.length / 2)));
  const earlier = mean(r.slice(0, Math.floor(r.length / 2)));
  if (Math.max(recent, earlier) < trendMinRate) return 'flat';
  const ratio = (recent + 1) / (earlier + 1);
  if (ratio >= 1 + trendFlat) return 'up';
  if (ratio <= 1 / (1 + trendFlat)) return 'down';
  return 'flat';
}

/**
 * Estimated listing day for plugins that were already in the first snapshot we ever took, whose real listing
 * date we cannot know. community-plugins.json is append-only (new plugins go to the end), so list order is
 * chronological; a low percentile of the latest-release dates of the ~2*window neighbours is a "local clock" for
 * that position (plugins that were never updated after listing have a release date close to their listing date;
 * a median would lean too recent because most plugins keep releasing after they are listed).
 */
export function estimateListingDays(directory, first, window, percentile = 0.25) {
  const rows = directory.filter((p) => first.data[p.id]?.rel).map((p) => ({ id: p.id, t: parseDay(first.data[p.id].rel) }));
  const est = new Map();
  for (let i = 0; i < rows.length; i++) {
    const w = rows.slice(Math.max(0, i - window), i + window + 1).map((r) => r.t).sort((x, y) => x - y);
    est.set(rows[i].id, dayStr(w[Math.floor((w.length - 1) * percentile)]));
  }
  return est;
}

export function analyzeGrowth({ snaps, directory, cfg, now }) {
  if (!snaps.length) throw new Error('analyzeGrowth needs at least one snapshot');
  const g = cfg.growth;
  const nowT = +now;
  const latest = snaps.at(-1);
  const prev = snaps.length > 1 ? snaps.at(-2) : null;
  const hist = snaps.slice(-(g.trendWeeks + 1));
  const ids = Object.keys(latest.data);

  // First snapshot that contains each plugin: exact "seen since" for everything that appears after the first week.
  const firstIdx = new Map();
  snaps.forEach((s, i) => { for (const id of Object.keys(s.data)) if (!firstIdx.has(id)) firstIdx.set(id, i); });
  const order = estimateListingDays(directory, snaps[0], g.orderWindow, g.orderPercentile);
  const gap = prev ? weeksApart(prev, latest) : 1;

  const plugins = {};
  let weeklyDownloads = 0, anomalies = 0;
  for (const id of ids) {
    const cur = latest.data[id];
    const p = { dl: cur.dl, d1: null, r1: null, tr: [], avg: null, dir: null, isNew: false, listed: null, ageDays: null, ageSrc: null, newcomer: false, momentum: null };
    const before = prev?.data[id];
    if (prev && !before) p.isNew = true;
    if (before) {
      const delta = cur.dl - before.dl;
      if (delta < 0) anomalies++;
      else {
        p.d1 = round1(delta / gap);
        p.r1 = before.dl > 0 ? delta / gap / before.dl : null;
        weeklyDownloads += delta / gap;
      }
    }
    const rates = weeklyRates(hist, id);
    p.tr = rates.map((x) => (x === null ? null : round1(x)));
    const usable = rates.filter((x) => x !== null);
    p.avg = usable.length ? round1(mean(usable)) : null;
    p.dir = direction(rates, g);

    // Age: exact when we watched it arrive, otherwise estimated from list order, tightened by the repo creation date.
    const fi = firstIdx.get(id);
    if (fi > 0) { p.listed = dayStr(snaps[fi].capturedAt); p.ageSrc = 'seen'; }
    else if (order.has(id)) { p.listed = order.get(id); p.ageSrc = 'order'; }
    if (p.ageSrc === 'order' && cur.crt && cur.crt > p.listed) { p.listed = cur.crt; p.ageSrc = 'repo'; }
    if (p.listed) {
      p.ageDays = Math.max(0, Math.floor((nowT - parseDay(p.listed)) / DAY));
      p.newcomer = p.ageDays < g.newcomerDays;
    }
    if (p.newcomer) p.momentum = p.d1 ?? round1(p.dl / Math.max(p.ageDays / 7, 1));
    plugins[id] = p;
  }

  const byDl = (a, b) => plugins[b].dl - plugins[a].dl || (a < b ? -1 : 1);
  const top = (list) => list.slice(0, g.topN);
  const absolute = top(ids.filter((id) => plugins[id].d1 > 0).sort((a, b) => plugins[b].d1 - plugins[a].d1 || byDl(a, b)));
  const relative = top(ids
    .filter((id) => plugins[id].r1 !== null && prev.data[id].dl >= g.minBase && plugins[id].d1 >= g.minDelta)
    .sort((a, b) => plugins[b].r1 - plugins[a].r1 || byDl(a, b)));
  const newcomers = top(ids.filter((id) => plugins[id].newcomer && plugins[id].momentum > 0)
    .sort((a, b) => plugins[b].momentum - plugins[a].momentum || byDl(a, b)));
  const added = prev ? ids.filter((id) => plugins[id].isNew).sort(byDl) : [];
  const removed = prev ? Object.keys(prev.data).filter((id) => !latest.data[id]).sort() : [];
  // "Released this week": the stats file's latest-release date moved forward (or, on the baseline, lies in the last 7 days).
  const sinceT = prev ? null : nowT - 7 * DAY;
  const released = ids.filter((id) => {
    const r = latest.data[id].rel;
    if (!r) return false;
    return prev ? prev.data[id]?.rel !== undefined && r > prev.data[id].rel : parseDay(r) >= sinceT;
  }).sort(byDl);

  return {
    meta: {
      latestWeek: latest.week, previousWeek: prev?.week ?? null, snapshots: snaps.length, firstWeek: snaps[0].week,
      baseline: !prev, trendWeeks: Math.min(g.trendWeeks, snaps.length - 1),
    },
    totals: {
      plugins: ids.length, downloads: ids.reduce((s, id) => s + plugins[id].dl, 0),
      weeklyDownloads: prev ? Math.round(weeklyDownloads) : null,
      added: added.length, removed: removed.length, released: released.length, anomalies,
    },
    plugins,
    lists: { absolute, relative, newcomers, added, removed, released: released.slice(0, g.topN * 2) },
  };
}

/** Download history of every plugin across all snapshots, for the charts: id -> [[week, downloads], ...]. */
export function downloadSeries(snaps) {
  const out = new Map();
  for (const s of snaps) for (const [id, r] of Object.entries(s.data)) {
    if (!out.has(id)) out.set(id, []);
    out.get(id).push([s.week, r.dl]);
  }
  return out;
}
