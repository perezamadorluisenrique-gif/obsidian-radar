// ideas.json: the machine-readable "what could someone build or adopt" list. Pure function of the analysis.
//
//   gaps               forum requests that no plugin description resembles (see lib/gaps.mjs), with links to the threads
//   maintainersWanted  popular plugins that have gone quiet and could use a maintainer or room for an alternative
//                      (see lib/abandonment.mjs). Plugins only, never authors: no author name appears in this file.
export const IDEAS_NOTES = [
  'Gaps are found by comparing words, not meaning: a plugin can solve a request without sharing its vocabulary, so treat "likelyGap" as "worth a look", not as proof.',
  'Some requests ask for changes to Obsidian itself (core app, mobile apps, Sync, Publish). Those are flagged appLevel and may not be possible as a plugin.',
  'maintainersWanted lists plugins people still download in large numbers whose repository has been quiet for a long time. It is an invitation, not a judgement: authors owe nobody their free time. Fork, offer help or build an alternative, and be kind about it.',
  'Entries with provisional=true have not been checked against GitHub yet (open issues unknown); their score leaves the issues component out.',
];

const round1 = (x) => Math.round(x * 10) / 10;

export function buildIdeas({ analysis, cfg }) {
  const k = cfg.ideas;
  const { gaps, abandonment, growth, forum } = analysis;
  const ghUrl = (repo) => (repo ? `https://github.com/${repo}` : null);
  const entry = (m) => ({
    id: m.id, name: m.name, downloads: m.dl, weeklyDownloads: m.weekly, quietMonths: round1(m.quietDays / 30.44),
    lastActivity: m.lastActivity, openIssues: m.issues, stars: m.stars, score: m.score, provisional: m.provisional,
    evidence: {
      directory: `https://obsidian.md/plugins?id=${m.id}`,
      repository: ghUrl(m.repo),
      issues: m.repo ? `${ghUrl(m.repo)}/issues` : null,
    },
  });
  return {
    schema: 1,
    week: analysis.week,
    generated: analysis.asOf,
    notes: IDEAS_NOTES,
    forum: forum ? { state: forum.state, fetchedAt: forum.fetchedAt, topics: forum.topics, source: forum.source } : null,
    gaps: (gaps?.clusters ?? []).filter((c) => c.rank > 0).slice(0, k.gaps).map((c) => ({
      id: c.id, title: c.title, keywords: c.terms, requests: c.topics, likes: c.likes, views: c.views,
      status: c.status, coverage: c.coverage, rank: c.rank, appLevel: c.appLevel,
      firstRequested: c.first, lastActive: c.last,
      closestPlugins: c.closestPlugins.map((p) => ({ id: p.id, name: p.name, similarity: p.similarity, downloads: p.downloads, url: `https://obsidian.md/plugins?id=${p.id}` })),
      evidence: c.evidence.map((e) => ({ title: e.title, url: e.url, likes: e.likes, created: e.created })),
    })),
    maintainersWanted: abandonment.list.slice(0, k.maintainers).map(entry),
    archivedByAuthors: abandonment.archived.slice(0, k.archived).map((m) => ({ id: m.id, name: m.name, downloads: m.dl, evidence: { directory: `https://obsidian.md/plugins?id=${m.id}`, repository: ghUrl(m.repo) } })),
    basis: { snapshots: growth.meta.snapshots, firstWeek: growth.meta.firstWeek, plugins: growth.totals.plugins },
  };
}
