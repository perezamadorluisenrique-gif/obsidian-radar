// GitHub access for the metadata refresh: batched GraphQL (production) and per-repo REST (sandbox bootstrap).
import { request } from './http.mjs';
import { dayStr } from './week.mjs';

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Labels whose name suggests "feature request"; used to filter what `labels(query:)` returns. */
export const FEATURE_LABEL_RE = /feat|enhanc|request|idea|suggest|wish/i;

const CORE_FRAGMENT = `fragment Core on Repository {
  pushedAt
  createdAt
  isArchived
  stargazerCount
  issues(states: OPEN) { totalCount }
  latestRelease { publishedAt }
}`;
const LABELS_FRAGMENT = `fragment Labels on Repository {
  feat: labels(first: 5, query: "feature") { nodes { name issues(states: OPEN) { totalCount } } }
  enh: labels(first: 5, query: "enhancement") { nodes { name issues(states: OPEN) { totalCount } } }
}`;

/**
 * One GraphQL document asking for many repositories at once (aliases r0, r1, ...).
 * items: [{ repo: "owner/name", labels: boolean }]. The label sub-queries are the expensive part, so
 * they are only requested for the repositories that need a feature-request count.
 */
export function buildQuery(items) {
  const fields = items.map((it, i) => {
    const [owner, name] = it.repo.split('/');
    return `  r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ...Core${it.labels ? ' ...Labels' : ''} }`;
  });
  const usesLabels = items.some((it) => it.labels);
  return [`query {`, `  rateLimit { cost remaining resetAt }`, ...fields, `}`, CORE_FRAGMENT, ...(usesLabels ? [LABELS_FRAGMENT] : [])].join('\n');
}

/** Sum of open issues over the distinct feature-like labels returned by the two label queries. */
export function featureRequestCount(repo) {
  const seen = new Map();
  for (const conn of [repo.feat, repo.enh]) {
    for (const n of conn?.nodes ?? []) if (FEATURE_LABEL_RE.test(n.name)) seen.set(n.name.toLowerCase(), n.issues?.totalCount ?? 0);
  }
  return [...seen.values()].reduce((a, b) => a + b, 0);
}

const isoDay = (s) => (s ? dayStr(s) : undefined);

/** Normalise a GraphQL `Repository` node into the compact snapshot fields (no `chk`/`src`). */
export function metaFromGraphQL(repo, withLabels) {
  const m = {
    push: isoDay(repo.pushedAt), crt: isoDay(repo.createdAt),
    stars: repo.stargazerCount ?? 0, iss: repo.issues?.totalCount ?? 0,
  };
  if (repo.isArchived) m.arch = 1;
  if (withLabels) m.fr = featureRequestCount(repo);
  return m;
}

export function metaFromRest(r) {
  const m = { push: isoDay(r.pushed_at), crt: isoDay(r.created_at), stars: r.stargazers_count ?? 0, iss: r.open_issues_count ?? 0 };
  if (r.archived) m.arch = 1;
  return m;
}

export class RateLimited extends Error {
  constructor(message, { resetAt, remaining } = {}) { super(message); this.name = 'RateLimited'; this.resetAt = resetAt; this.remaining = remaining; }
}
export class Unauthorized extends Error {}

// An empty token sends no Authorization header (the Claude Code sandbox proxy attaches its own credentials).
const authHeaders = (token) => ({ ...(token ? { authorization: `bearer ${token}` } : {}), accept: 'application/vnd.github+json', 'content-type': 'application/json' });

function rateLimitFromHeaders(res) {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const retryAfter = Number(res.headers.get('retry-after'));
  return {
    remaining: res.headers.has('x-ratelimit-remaining') ? Number(res.headers.get('x-ratelimit-remaining')) : undefined,
    resetAt: reset ? new Date(reset * 1000).toISOString() : retryAfter ? new Date(Date.now() + retryAfter * 1000).toISOString() : undefined,
  };
}

/**
 * Run one batch. Returns { repos: Map(index -> node | null), errors, rateLimit }.
 * `null` means GitHub says the repository does not exist (NOT_FOUND). Throws RateLimited / Unauthorized,
 * or a plain Error for transient failures (the caller halves the batch and retries).
 */
export async function graphqlBatch({ url, token, items, timeoutMs = 90_000 }) {
  const res = await request(url, { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ query: buildQuery(items) }), retries: 1, timeoutMs });
  if (res.status === 401) throw new Unauthorized('GitHub rejected the token (401)');
  if (res.status === 403 || res.status === 429) {
    const rl = rateLimitFromHeaders(res);
    const text = await res.text().catch(() => '');
    if (/rate limit|abuse|secondary/i.test(text) || rl.remaining === 0 || res.status === 429) throw new RateLimited(`HTTP ${res.status}: rate limited`, rl);
    throw new Unauthorized(`HTTP 403 from GraphQL: ${text.slice(0, 160)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from GraphQL`);
  const json = await res.json();
  const errors = json.errors ?? [];
  if (errors.some((e) => e.type === 'RATE_LIMITED')) throw new RateLimited('GraphQL RATE_LIMITED', json.data?.rateLimit ? { remaining: json.data.rateLimit.remaining, resetAt: json.data.rateLimit.resetAt } : {});
  if (!json.data) throw new Error(`GraphQL returned no data: ${JSON.stringify(errors).slice(0, 200)}`);
  const repos = new Map();
  items.forEach((_, i) => {
    const node = json.data[`r${i}`];
    if (node) repos.set(i, node);
    else if (errors.some((e) => e.path?.[0] === `r${i}` && e.type === 'NOT_FOUND')) repos.set(i, null);
    // otherwise: unknown outcome -> left out, stays pending
  });
  return { repos, errors, rateLimit: json.data.rateLimit };
}

/** REST: one repository. Returns { status: 'ok'|'gone', meta? } or throws RateLimited/Unauthorized. */
export async function restRepo({ base, token, repo, timeoutMs = 30_000 }) {
  const res = await request(`${base.replace(/\/$/, '')}/repos/${repo}`, { headers: authHeaders(token), retries: 2, timeoutMs });
  const rl = rateLimitFromHeaders(res);
  if (res.status === 404 || res.status === 410 || res.status === 451) return { status: 'gone', rateLimit: rl };
  if (res.status === 401) throw new Unauthorized('GitHub rejected the token (401)');
  if (res.status === 403 || res.status === 429) {
    if (rl.remaining === 0 || res.status === 429) throw new RateLimited(`HTTP ${res.status}: rate limited`, rl);
    throw new Unauthorized(`HTTP 403 from REST for ${repo}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${repo}`);
  return { status: 'ok', meta: metaFromRest(await res.json()), rateLimit: rl };
}
