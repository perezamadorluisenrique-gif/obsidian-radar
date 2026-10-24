// A tiny stand-in for forum.obsidian.md used by the forum tests and the CI dry run.
// Serves the normalized topics of fixtures/forum/topics.json back in Discourse's RAW listing shape
// (tags as strings AND as {id,name,slug} objects, a category description topic, a banner), 30 topics per page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const fixtureTopics = () => JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'fixtures', 'forum', 'topics.json'), 'utf8')).topics;

/** normalized topic -> what Discourse sends (some tags as objects, HTML-escaped title). */
export const toRaw = (t, i = 0) => ({
  id: t.id, title: t.title.replace(/&/g, '&amp;').replace(/</g, '&lt;'), fancy_title: t.title, slug: t.slug, category_id: t.cat,
  created_at: `${t.created}T10:00:00.000Z`, last_posted_at: `${t.last}T11:00:00.000Z`, bumped_at: `${t.last}T11:00:00.000Z`,
  views: t.views, like_count: t.likes, posts_count: t.posts, closed: t.closed, archived: false, archetype: 'regular',
  tags: t.tags.map((name, k) => ((i + k) % 2 ? { id: 100 + k, name, slug: name } : name)),
});

/**
 * o.topics: normalized topics to serve (default: the fixture). o.pageSize, o.fail: (req) => status|null to simulate errors.
 * Every topic is served for every top period and for "latest", to the category it belongs to.
 */
export async function startMockDiscourse(o = {}) {
  const state = { topics: o.topics ?? fixtureTopics(), pageSize: o.pageSize ?? 30, fail: o.fail ?? (() => null), requests: [], extras: o.extras ?? true };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push(req.url);
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const code = state.fail(req.url);
    if (code) return send(code, { error: 'simulated' }, code === 429 ? { 'retry-after': '1' } : {});
    const m = /^\/c\/([^/]+)\/(\d+)(?:\/l\/top)?\.json$/.exec(url.pathname);
    if (!m) return send(404, { error: 'not found' });
    const cat = Number(m[2]);
    const page = Number(url.searchParams.get('page') ?? 0);
    let mine = state.topics.filter((t) => t.cat === cat);
    if (state.extras) { // the description topic leads every listing, so it shifts all pages by one like the real thing
      mine = [
        { id: 900000 + cat, title: `About the ${m[1]} category`, slug: `about-the-${m[1]}-category`, cat, created: '2020-01-01', last: '2020-01-01', views: 5, likes: 0, posts: 1, tags: [], closed: false },
        ...mine,
      ];
    }
    const slice = mine.slice(page * state.pageSize, (page + 1) * state.pageSize);
    const more = (page + 1) * state.pageSize < mine.length;
    send(200, { topic_list: { topics: slice.map((t, i) => toRaw(t, i)), ...(more ? { more_topics_url: `${url.pathname}?page=${page + 1}` } : {}) } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
