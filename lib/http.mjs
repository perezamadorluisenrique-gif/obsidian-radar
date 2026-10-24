import fs from 'node:fs';
import path from 'node:path';

export const USER_AGENT = 'obsidian-radar/0.1 (+https://github.com/perezamadorluisenrique-gif/obsidian-radar)';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isHttp = (s) => /^https?:\/\//i.test(s);

/** GET with timeout and retry on network errors / 5xx / 429. Returns the Response (also for 4xx). */
export async function request(url, { method = 'GET', headers = {}, body, retries = 3, timeoutMs = 60_000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method, body, headers: { 'user-agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 500 && attempt < retries) { lastErr = new Error(`HTTP ${res.status} from ${url}`); await sleep(500 * 2 ** attempt); continue; }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** Read JSON from an http(s) URL or from a file inside a local directory `base` (used for fixtures). */
export async function getJSON(base, name, opts = {}) {
  if (!isHttp(base)) return JSON.parse(fs.readFileSync(path.join(base, name), 'utf8'));
  const res = await request(`${base.replace(/\/$/, '')}/${name}`, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${base}/${name}`);
  return res.json();
}
