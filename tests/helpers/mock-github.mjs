// A tiny stand-in for api.github.com used by the fetch tests and the CI dry run.
// - POST /graphql : validates the query against a pruned copy of GitHub's REAL schema, answers with
//                   deterministic, hash-derived repository data; can simulate NOT_FOUND, rate limits, 5xx.
// - GET /repos/:o/:r : the REST equivalent (sandbox bootstrap transport).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(HERE, '..', '..', 'fixtures', 'graphql', 'github-subset.graphql');
const h = (s, salt) => parseInt(crypto.createHash('sha1').update(`${salt}:${s}`).digest('hex').slice(0, 8), 16);

/** Deterministic fake repository facts, stable across runs. NOW is the pretend current time. */
export function fakeRepo(repo, now = Date.parse('2026-10-24T04:00:00Z')) {
  const day = 864e5;
  const pushedDaysAgo = 1 + (h(repo, 'push') % 1500);
  const createdDaysAgo = pushedDaysAgo + (h(repo, 'crt') % 900);
  const relDaysAgo = pushedDaysAgo + (h(repo, 'rel') % 30);
  return {
    pushedAt: new Date(now - pushedDaysAgo * day).toISOString(),
    createdAt: new Date(now - createdDaysAgo * day).toISOString(),
    isArchived: h(repo, 'arch') % 20 === 0,
    stargazerCount: h(repo, 'stars') % 2000,
    issues: h(repo, 'iss') % 120,
    latestRelease: h(repo, 'hasrel') % 6 === 0 ? null : new Date(now - relDaysAgo * day).toISOString(),
    featureIssues: h(repo, 'fr') % 15,
    enhIssues: h(repo, 'enh') % 6,
  };
}

export async function startMockGitHub(o = {}) {
  const state = {
    token: 'test-token', notFound: new Set(), pointsLimit: 5000, remaining: 5000, resetInSec: 3600,
    failNext: 0, maxBatch: Infinity, mode: 'graphql-error', // how a primary rate limit is signalled: 'graphql-error' | 'http403' | 'http429'
    restRemaining: Infinity, now: Date.parse('2026-10-24T04:00:00Z'), validate: true,
    calls: { graphql: 0, rest: 0, repos: 0, rejected: 0 }, batchSizes: [], queries: [], ...o,
  };
  state.remaining = o.remaining ?? state.pointsLimit;

  let validateQuery = null;
  if (state.validate) {
    try {
      const { buildSchema, parse, validate } = await import('graphql');
      const schema = buildSchema(fs.readFileSync(SCHEMA_FILE, 'utf8'));
      validateQuery = (q) => validate(schema, parse(q)).map((e) => e.message);
    } catch { validateQuery = null; }
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    const authed = req.headers.authorization === `bearer ${state.token}`;
    const resetEpoch = Math.floor(Date.now() / 1000) + state.resetInSec;
    if (!authed) return send(401, { message: 'Bad credentials' });

    if (req.method === 'POST' && req.url === '/graphql') {
      let raw = ''; for await (const c of req) raw += c;
      state.calls.graphql++;
      const { query } = JSON.parse(raw);
      state.queries.push(query);
      if (state.failNext > 0) { state.failNext--; return send(502, { message: 'Server Error' }); }
      if (validateQuery) {
        const errs = validateQuery(query);
        if (errs.length) { state.calls.rejected++; return send(200, { errors: errs.map((message) => ({ message })) }); }
      }
      const items = [...query.matchAll(/(r\d+): repository\(owner: ("(?:[^"\\]|\\.)*"), name: ("(?:[^"\\]|\\.)*")\) \{ ([^}]*) \}/g)]
        .map((m) => ({ alias: m[1], repo: `${JSON.parse(m[2])}/${JSON.parse(m[3])}`, labels: m[4].includes('...Labels') }));
      state.batchSizes.push(items.length);
      if (items.length > state.maxBatch) return send(502, { message: 'Timeout: batch too heavy' });
      const cost = Math.max(1, Math.ceil((1 + items.length + 11 * items.filter((i) => i.labels).length) / 100));
      if (state.remaining < cost) {
        if (state.mode === 'http403') return send(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpoch) });
        if (state.mode === 'http429') return send(429, { message: 'secondary rate limit' }, { 'retry-after': String(state.resetInSec) });
        return send(200, { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }], data: { rateLimit: { cost, remaining: state.remaining, resetAt: new Date(resetEpoch * 1000).toISOString() } } });
      }
      state.remaining -= cost;
      const data = { rateLimit: { cost, remaining: state.remaining, resetAt: new Date(resetEpoch * 1000).toISOString() } };
      const errors = [];
      for (const it of items) {
        state.calls.repos++;
        if (state.notFound.has(it.repo)) { data[it.alias] = null; errors.push({ type: 'NOT_FOUND', path: [it.alias], message: `Could not resolve to a Repository with the name '${it.repo}'.` }); continue; }
        const f = fakeRepo(it.repo, state.now);
        data[it.alias] = {
          pushedAt: f.pushedAt, createdAt: f.createdAt, isArchived: f.isArchived, stargazerCount: f.stargazerCount,
          issues: { totalCount: f.issues }, latestRelease: f.latestRelease ? { publishedAt: f.latestRelease } : null,
          ...(it.labels ? {
            feat: { nodes: [{ name: 'feature request', issues: { totalCount: f.featureIssues } }, { name: 'feature-flag-cleanup', issues: { totalCount: 0 } }] },
            enh: { nodes: [{ name: 'enhancement', issues: { totalCount: f.enhIssues } }, { name: 'help wanted', issues: { totalCount: 99 } }] },
          } : {}),
        };
      }
      return send(200, errors.length ? { data, errors } : { data });
    }

    const m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && m) {
      state.calls.rest++; state.calls.repos++;
      const repo = `${m[1]}/${m[2]}`;
      if (state.restRemaining <= 0) return send(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpoch) });
      state.restRemaining--;
      const headers = { 'x-ratelimit-remaining': String(state.restRemaining), 'x-ratelimit-reset': String(resetEpoch) };
      if (state.notFound.has(repo)) return send(404, { message: 'Not Found' }, headers);
      const f = fakeRepo(repo, state.now);
      return send(200, { pushed_at: f.pushedAt, created_at: f.createdAt, archived: f.isArchived, stargazers_count: f.stargazerCount, open_issues_count: f.issues + 2 }, headers);
    }
    send(404, { message: 'no route' });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, graphqlUrl: `http://127.0.0.1:${port}/graphql`, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
