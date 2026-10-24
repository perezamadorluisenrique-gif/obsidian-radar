// Builds this week's snapshot: directory + download stats (always complete) + GitHub metadata
// (rolling refresh: whatever fits in the rate limit is refreshed, the rest keeps its previous values).
import fs from 'node:fs';
import path from 'node:path';
import { getJSON, sleep as realSleep } from './http.mjs';
import { graphqlBatch, restRepo, metaFromGraphQL, REPO_RE, RateLimited, Unauthorized } from './github.mjs';
import { listSnapshots, readSnapshot, writeSnapshot, snapshotFile } from './snapshot.mjs';
import { dayStr, DAY, weekStart } from './week.mjs';

const META_KEYS = ['push', 'crt', 'arch', 'stars', 'iss', 'fr', 'gone', 'chk', 'src'];
const pickMeta = (rec) => Object.fromEntries(META_KEYS.filter((k) => rec?.[k] !== undefined).map((k) => [k, rec[k]]));

/** Which plugins to refresh first. Lower tier = sooner; see DECISIONS.md "Rolling refresh order". */
export function planRefresh(records, { prevIds, transport, cfg, now, weekStartDay = '0000-00-00' }) {
  const cutoff = now - cfg.abandonment.quietDays * DAY;
  const tier = (id, r) => {
    const quietCandidate = r.dl >= cfg.abandonment.minDownloads && (!r.rel || Date.parse(r.rel) < cutoff);
    if (!r.chk && prevIds && !prevIds.has(id)) return 0; // brand-new plugin, never checked
    if (r.chk && transport === 'graphql' && r.src === 'r') return 3; // REST bootstrap values lack the feature-request count
    if (r.chk && r.chk >= weekStartDay) return 5; // already refreshed this week by an earlier (rate-limited) run: last
    if (quietCandidate) return 1; // the maintainer-wanted candidates must be verified against GitHub
    if (!r.chk) return 2; // never checked
    return 4; // stalest first
  };
  return Object.keys(records)
    .map((id) => ({ id, t: tier(id, records[id]) }))
    .sort((a, b) => a.t - b.t
      || (a.t >= 4 ? (records[a.id].chk ?? '').localeCompare(records[b.id].chk ?? '') : 0)
      || records[b.id].dl - records[a.id].dl || a.id.localeCompare(b.id))
    .map((x) => x.id);
}

export async function buildSnapshot(o) {
  const log = o.log ?? (() => {});
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? new Date();
  const cfg = o.cfg;
  const stats = { batches: 0, repoLookups: 0, gone: 0, errors: 0, waitedSec: 0 };

  // 1. The two Obsidian files: complete by construction, always fresh.
  const [directory, rawStats, removed] = await Promise.all([
    getJSON(o.releases, 'community-plugins.json'),
    getJSON(o.releases, 'community-plugin-stats.json'),
    getJSON(o.releases, 'community-plugins-removed.json').catch(() => []),
  ]);
  if (!Array.isArray(directory) || !directory.length) throw new Error('community-plugins.json is empty or not an array');
  if (!rawStats || typeof rawStats !== 'object') throw new Error('community-plugin-stats.json is not an object');

  const records = {};
  let statsUpdated = 0;
  directory.forEach((p) => {
    const s = rawStats[p.id];
    const rec = { dl: Number.isFinite(s?.downloads) ? s.downloads : 0 };
    if (s?.updated > DAY) { rec.rel = dayStr(s.updated); statsUpdated = Math.max(statsUpdated, s.updated); }
    records[p.id] = rec;
  });

  // 2. Carry metadata over: this week's earlier run first (progress), then the previous snapshot.
  const all = listSnapshots(o.snapshotsDir);
  const sameWeek = all.find((s) => s.week === o.week);
  const prevInfo = [...all].reverse().find((s) => s.week < o.week);
  const prev = prevInfo ? readSnapshot(prevInfo.file) : null;
  const cur = sameWeek ? readSnapshot(sameWeek.file) : null;
  const prevIds = prev ? new Set(Object.keys(prev.data)) : null;
  for (const id of Object.keys(records)) {
    const a = cur?.data[id], b = prev?.data[id];
    const best = a?.chk && (!b?.chk || a.chk >= b.chk) ? a : b?.chk ? b : null;
    if (best) Object.assign(records[id], pickMeta(best));
  }

  // 3. Rolling refresh.
  const repoOf = Object.fromEntries(directory.map((p) => [p.id, p.repo]));
  const today = dayStr(now);
  const refreshed = new Set();
  const used = new Set();
  let limited = false, note = '';
  const transport = o.transport === 'none' || (!o.token && !o.anonymous) ? 'none' : o.transport;
  if (o.transport === 'none') note = 'GitHub metadata step skipped (--transport none).';
  else if (!o.token && !o.anonymous) note = 'No GITHUB_TOKEN in this run: GitHub metadata was not refreshed (kept from the previous snapshot where one exists).';

  const queue = planRefresh(records, { prevIds, transport, cfg, now: +now, weekStartDay: dayStr(weekStart(o.week)) }).filter((id) => REPO_RE.test(repoOf[id] ?? ''));
  const applyMeta = (id, meta, src) => {
    for (const k of ['push', 'crt', 'arch', 'stars', 'iss', 'gone']) delete records[id][k]; // a field that vanished upstream must vanish here too
    Object.assign(records[id], { chk: today, src }, meta);
    refreshed.add(id); used.add(src);
  };
  const applyGone = (id, src) => { for (const k of ['push', 'crt', 'arch', 'stars', 'iss', 'fr']) delete records[id][k]; Object.assign(records[id], { gone: 1, chk: today, src }); refreshed.add(id); used.add(src); stats.gone++; };

  const snapshotNow = () => {
    const withMeta = Object.values(records).filter((r) => r.chk).length;
    const pending = Object.keys(records).length - refreshed.size;
    const t = used.size === 0 ? 'none' : used.size > 1 ? 'mixed' : used.has('g') ? 'graphql' : 'rest';
    return {
      schema: 1, week: o.week, capturedAt: now.toISOString().replace(/\.\d+Z$/, 'Z'),
      ...(statsUpdated ? { statsUpdated: new Date(statsUpdated).toISOString().replace(/\.\d+Z$/, 'Z') } : {}),
      plugins: Object.keys(records).length,
      refresh: { state: pending === 0 ? 'complete' : 'rolling', transport: t, withMeta, pending, refreshed: refreshed.size, limited, ...(note ? { note } : {}) },
      data: records,
    };
  };

  // Sleep until the limit resets if that is soon enough, otherwise stop and save progress.
  let waits = 0;
  const waitOrStop = async (rl, why) => {
    if (++waits > cfg.fetch.maxWaits) { limited = true; note = `Rate limit hit ${waits} times (${why}); stopped. Progress saved, the next run continues.`; log(note); return false; }
    const waitSec = rl?.resetAt ? Math.ceil((Date.parse(rl.resetAt) - Date.now()) / 1000) + 2 : Infinity;
    if (waitSec <= cfg.fetch.maxWaitSec) { log(`rate limit (${why}); waiting ${waitSec}s for reset`); stats.waitedSec += waitSec; await sleep(waitSec * 1000); return true; }
    limited = true; note = `Rate limit reached (${why}); resets ${rl?.resetAt ?? 'unknown'}. Progress saved, the next run continues.`;
    log(note); return false;
  };

  if (transport === 'graphql') {
    let size = cfg.fetch.batchSize, lastCost = 10, remaining = Infinity, failures = 0, i = 0;
    const budget = o.budget ?? Infinity;
    while (i < queue.length && !limited && stats.repoLookups < budget) {
      if (remaining < lastCost + cfg.fetch.rateLimitReserve) {
        const keep = await waitOrStop({ resetAt: o.resetAt }, `remaining ${remaining}`);
        if (!keep) break; remaining = Infinity;
      }
      const slice = queue.slice(i, i + Math.min(size, budget - stats.repoLookups));
      const items = slice.map((id) => ({ repo: repoOf[id], labels: records[id].dl >= cfg.fetch.labelsMinDownloads }));
      try {
        const res = await graphqlBatch({ url: o.graphqlUrl, token: o.token, items });
        stats.batches++; stats.repoLookups += slice.length; failures = 0;
        slice.forEach((id, k) => {
          if (!res.repos.has(k)) return;
          const node = res.repos.get(k);
          if (node === null) applyGone(id, 'g');
          else applyMeta(id, metaFromGraphQL(node, items[k].labels), 'g');
        });
        i += slice.length;
        if (res.rateLimit) { lastCost = Math.max(res.rateLimit.cost, 1); remaining = res.rateLimit.remaining; o.resetAt = res.rateLimit.resetAt; }
        if (stats.batches % cfg.fetch.saveEveryBatches === 0) writeSnapshot(o.snapshotsDir, snapshotNow());
        if (o.pauseMs) await sleep(o.pauseMs);
      } catch (e) {
        if (e instanceof RateLimited) { if (!(await waitOrStop(e, e.message))) break; remaining = Infinity; continue; }
        if (e instanceof Unauthorized) { limited = true; note = `GitHub refused the request (${e.message}). Metadata carried over.`; log(note); break; }
        stats.errors++; failures++;
        log(`batch of ${slice.length} failed: ${e.message}`);
        if (size > 10) size = Math.max(10, Math.floor(size / 2)); // heavy batches time out: halve and retry
        else { i += slice.length; } // give up on this slice for this run; it stays pending
        if (failures >= 6) { limited = true; note = `Stopped after repeated GitHub errors (${e.message}). Progress saved.`; break; }
        await sleep(1000 * failures);
      }
    }
    if (!limited && stats.repoLookups >= budget && i < queue.length) { limited = true; note = `Budget of ${budget} lookups reached; the rest is refreshed on the next run.`; }
  } else if (transport === 'rest') {
    const budget = o.budget ?? cfg.fetch.restBudget;
    let next = 0, stop = false;
    const worker = async () => {
      while (!stop) {
        const idx = next++;
        if (idx >= queue.length) return;
        if (stats.repoLookups >= budget) { stop = true; limited = true; note = `REST budget of ${budget} calls reached; refreshed in priority order, the rest keeps older/no metadata.`; return; }
        const id = queue[idx];
        stats.repoLookups++;
        try {
          const r = await restRepo({ base: o.restUrl, token: o.token, repo: repoOf[id] });
          if (r.status === 'gone') applyGone(id, 'r'); else applyMeta(id, r.meta, 'r');
          if (r.rateLimit?.remaining !== undefined && r.rateLimit.remaining < cfg.fetch.rateLimitReserve) { stop = true; limited = true; note = `REST rate limit nearly exhausted (${r.rateLimit.remaining} left); progress saved.`; }
        } catch (e) {
          if (e instanceof RateLimited) { stop = true; limited = true; note = `REST rate limit reached; progress saved. ${e.message}`; }
          else if (e instanceof Unauthorized) { stop = true; limited = true; note = `GitHub refused the request (${e.message}).`; }
          else stats.errors++;
        }
      }
    };
    await Promise.all(Array.from({ length: cfg.fetch.restConcurrency }, worker));
    if (limited) log(note);
  }

  const snapshot = snapshotNow();
  const file = writeSnapshot(o.snapshotsDir, snapshot);

  // The directory itself is not versioned (it is re-fetched every run); the build reads it from the cache.
  if (o.cacheDir) {
    fs.mkdirSync(o.cacheDir, { recursive: true });
    fs.writeFileSync(path.join(o.cacheDir, 'directory.json'), JSON.stringify(directory.map((p) => ({ id: p.id, name: p.name, author: p.author, description: p.description, repo: p.repo }))));
    fs.writeFileSync(path.join(o.cacheDir, 'removed.json'), JSON.stringify(removed));
  }
  return { snapshot, file, stats, queueLength: queue.length };
}

export { snapshotFile };
