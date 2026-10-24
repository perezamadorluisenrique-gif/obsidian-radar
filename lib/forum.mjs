// Forum feature requests (Discourse JSON). Optional by design: any failure leaves the previous data in place and
// is recorded in status.json; the site and the analysis work without it.
import fs from 'node:fs';
import path from 'node:path';
import { request, sleep as realSleep, isHttp, USER_AGENT } from './http.mjs';
import { dayStr } from './week.mjs';

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&hellip;': '…', '&nbsp;': ' ' };
const decode = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|#39|#x27|hellip|nbsp);/g, (m) => ENTITIES[m]).replace(/\s+/g, ' ').trim();

/** Discourse returns tags as strings or as {id,name,slug} objects depending on the category/version. */
const META_TOPIC = /^about the .{0,60}category$/i;
const tagName = (t) => (typeof t === 'string' ? t : t?.name ?? t?.slug ?? '');

/** One Discourse listing topic -> the compact record we keep. */
export function normalizeTopic(t, base, fallbackCat) {
  const day = (s) => (s ? dayStr(s) : null);
  return {
    id: t.id, title: decode(t.title), slug: t.slug, cat: t.category_id ?? fallbackCat,
    created: day(t.created_at), last: day(t.last_posted_at ?? t.bumped_at ?? t.created_at),
    views: t.views ?? 0, likes: t.like_count ?? 0, posts: t.posts_count ?? 1,
    tags: (t.tags ?? []).map(tagName).filter(Boolean).sort(),
    closed: Boolean(t.closed || t.archived),
    url: `${base.replace(/\/$/, '')}/t/${t.slug}/${t.id}`,
  };
}

const listingUrl = (base, cat, kind, period, page) => (kind === 'top'
  ? `${base}/c/${cat.slug}/${cat.id}/l/top.json?period=${period}&page=${page}`
  : `${base}/c/${cat.slug}/${cat.id}.json?page=${page}`);

/**
 * Fetch the configured listings politely (one request at a time, `delayMs` apart).
 * Writes topics.json + status.json into outDir. Never throws for network/HTTP problems.
 */
export async function fetchForum({ base, cfg, outDir, now = new Date(), sleep = realSleep, log = () => {} }) {
  const f = cfg.forum;
  base = base.replace(/\/$/, '');
  const topics = new Map();
  const perCat = {};
  let requests = 0, failures = 0, consecutive = 0, stopped = null;
  const jobs = [];
  for (const cat of f.categories) {
    for (const period of f.periods) for (let page = 0; page < f.pages; page++) jobs.push({ cat, kind: 'top', period, page });
    for (let page = 0; page < f.latestPages; page++) jobs.push({ cat, kind: 'latest', page });
  }
  const done = new Set(); // categories/periods that ran out of pages
  for (const job of jobs) {
    const key = `${job.cat.id}/${job.kind}/${job.period ?? ''}`;
    if (done.has(key)) continue;
    if (consecutive >= f.maxFailures) { stopped = `stopped after ${consecutive} failed requests in a row`; break; }
    if (requests) await sleep(f.delayMs);
    const url = listingUrl(base, job.cat, job.kind, job.period, job.page);
    requests++;
    try {
      const res = await request(url, { retries: f.retries, timeoutMs: f.timeoutMs, headers: { accept: 'application/json' } });
      if (res.status === 429) {
        const wait = Math.min(60, Number(res.headers.get('retry-after')) || 30);
        log(`forum: rate limited, waiting ${wait}s`);
        await sleep(wait * 1000);
        throw new Error('HTTP 429');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const list = j?.topic_list?.topics;
      if (!Array.isArray(list)) throw new Error('unexpected JSON shape (no topic_list.topics)');
      consecutive = 0;
      for (const t of list) {
        if ((t.archetype && t.archetype !== 'regular') || META_TOPIC.test(decode(t.title))) continue; // category descriptions are not requests
        if (!topics.has(t.id)) topics.set(t.id, normalizeTopic(t, base, job.cat.id));
      }
      if (!list.length || !j.topic_list.more_topics_url) done.add(key);
    } catch (e) {
      failures++; consecutive++;
      log(`forum: ${url} failed: ${e.message}`);
    }
  }
  for (const t of topics.values()) perCat[t.cat] = (perCat[t.cat] ?? 0) + 1;

  fs.mkdirSync(outDir, { recursive: true });
  const topicsFile = path.join(outDir, 'topics.json');
  const statusFile = path.join(outDir, 'status.json');
  const prev = fs.existsSync(topicsFile) ? JSON.parse(fs.readFileSync(topicsFile, 'utf8')) : null;
  const status = { fetchedAt: now.toISOString(), source: base, requests, failures, topics: topics.size, perCategory: perCat };
  let state;
  if (!topics.size) state = 'failed';
  else if (prev && topics.size < prev.topics.length * f.keepIfBelow) state = 'too-few';
  else state = failures || stopped ? 'partial' : 'ok';
  if (state === 'ok' || state === 'partial') {
    const list = [...topics.values()].sort((a, b) => a.id - b.id);
    fs.writeFileSync(topicsFile, JSON.stringify({ schema: 1, fetchedAt: status.fetchedAt, topics: list }));
    status.kept = 'new';
  } else {
    status.kept = prev ? 'previous' : 'none';
    status.topics = prev?.topics.length ?? 0;
    status.error = state === 'too-few' ? `only ${topics.size} topics this run versus ${prev.topics.length} before; kept the previous data` : 'no topics could be fetched';
  }
  status.state = state;
  if (stopped) status.note = stopped;
  fs.writeFileSync(statusFile, JSON.stringify(status, null, 1) + '\n');
  return status;
}

export const readForum = (dir) => {
  const f = path.join(dir, 'topics.json');
  const s = path.join(dir, 'status.json');
  return {
    topics: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null,
    status: fs.existsSync(s) ? JSON.parse(fs.readFileSync(s, 'utf8')) : null,
  };
};

export { isHttp, USER_AGENT };
