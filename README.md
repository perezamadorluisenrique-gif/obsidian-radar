# Obsidian Ecosystem Radar

A small public site that rebuilds itself every week and answers four questions about the Obsidian community-plugin ecosystem:

| Question | Page | What it shows |
|---|---|---|
| What's new? | **This week**, **New** | plugins added and released this week; plugins listed in the last 90 days |
| What's growing? | **Growing** | biggest absolute and relative weekly download gains, 4-week trend, rising newcomers |
| What is loved but quiet? | **Looking for maintainers** | popular plugins with no activity for a year or more, framed as *room for help or for an alternative*, never as a verdict on anyone |
| Where are the gaps? | **Gaps** | forum feature requests that no plugin seems to cover, with the closest plugins and the threads as evidence |

Plus **My plugins** (rank, downloads and weekly growth against similar plugins), a **plugin page** with a downloads chart, **search** by name or category keyword, and a **Methodology** page. Light and dark, works at phone width without horizontal scroll, English with a one-click Spanish toggle.

Everything is deterministic arithmetic over public data. There is no language model anywhere in the pipeline, and the same snapshots always give the same pages.

> History begins at the first weekly snapshot. Nothing earlier is reconstructed, and the site says so. Weekly growth needs two snapshots, so the growth lists are empty until the second run.

## Set it up (three clicks, once)

1. **Merge** the branch with this code into `main` (nothing in the repository opens pull requests or issues for you).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Actions → weekly → Run workflow.** The first run fetches everything, commits the first real data, and publishes the site at `https://<owner>.github.io/obsidian-radar/` (the URL is also in `config.json`). After that it runs by itself every **Monday at 05:41 UTC**.

Optional: add a repository secret `RADAR_GITHUB_TOKEN` (a fine-grained token with *public repositories, read-only* access) if you want a larger GitHub rate limit than the built-in token gives; without it the run uses `GITHUB_TOKEN`. If the limit still runs out, nothing fails: see [rolling refresh](#data-and-storage).

## Pause it, or switch parts off

| You want to | Do this |
|---|---|
| Stop the weekly run | **Actions → weekly → ⋯ → Disable workflow** (re-enable the same way). The last site stays up; nothing is lost. |
| Keep manual runs only | Delete the `schedule:` block in `.github/workflows/weekly.yml`. |
| Skip only the forum (Gaps page keeps the last data) | Repository variable **`RADAR_FORUM` = `off`** (*Settings → Secrets and variables → Actions → Variables*), or tick *Skip the forum step* on a manual run. |
| Take the site down | **Settings → Pages → Unpublish site.** The snapshots stay in the repository. |

## How it works

```
obsidian-releases (3 JSON files) ─┐
GitHub GraphQL (repo metadata)  ──┼─► scripts/fetch.mjs ─► data/snapshots/2026-W43.json.gz   (append-only)
Obsidian forum (Discourse JSON) ──┴─► scripts/forum.mjs ─► data/forum/{topics,status}.json    (optional)
                                                              │
                      scripts/analyze.mjs  (growth, maintainers wanted, gaps) ─► ideas.json
                                                              │
                      scripts/build-site.mjs ─► dist/ (static HTML + small JSON) ─► GitHub Pages
```

The weekly workflow (`.github/workflows/weekly.yml`) runs those steps in order, **commits the data before building** (the snapshot is the one thing that cannot be rebuilt later), then checks links and layout and deploys. `scripts/commit-data.mjs` does the commit: it only touches `data/snapshots`, `data/forum` and `ideas.json`, commits nothing if nothing changed, and **refuses to change a past snapshot**.

Re-running a week is safe: it overwrites only that week's snapshot, with byte-identical output when the inputs are the same.

### Data and storage

* **Sources** (all public): `obsidianmd/obsidian-releases` (`community-plugins.json`, `community-plugin-stats.json`, `community-plugins-removed.json`), the GitHub GraphQL API (last push, archived, stars, open issues, latest release, feature-request-labelled issues, in batches of 100 repositories) and the Obsidian forum's JSON (*Feature requests* and *Plugin ideas*).
* **Snapshots:** `data/snapshots/YYYY-Www.json.gz` (ISO week). One compact record per plugin: cumulative downloads, latest release date, and the GitHub fields with the day they were checked. The first snapshot (downloads and release dates for 9,385 plugins) is about 100 KB gzipped, and the GitHub fields add some more; a snapshot is never rewritten after its week ends.
* **Rolling refresh:** the GitHub API has a rate limit. When it runs out, the run saves what it has and exits successfully; the next run continues with the repositories that have waited longest. A snapshot's header says `rolling` or `complete`, and pages mark anything not yet checked as *provisional*.
* **Forum step:** optional. If the forum is unreachable, returns too little, or the step is switched off, the previous forum data is kept and the Gaps page says when it was fetched.

### The numbers

Full formulas and every threshold are on the site's **Methodology** page, generated from `config.json` so the documentation cannot drift from the code. In short:

* **Growth** = difference between snapshots, divided by the ISO-week distance (a missed run does not look like a double week). *Relative growth* needs at least 200 downloads before and 20 gained. *Trend* compares the recent half of the last 4 weeks with the earlier half. *Rising newcomers* are younger than 90 days; for plugins already listed when history began the age is estimated from the append-only list order and marked as estimated.
* **Looking for maintainers** needs all of: ≥ 10,000 downloads, ≥ 365 days since the last push or release, not archived, ≥ 5 open issues (checked once GitHub data is known; until then *provisional*). Score = 100 × (40·L + 30·Q + 30·I) ÷ 100 with L = how loved (log of downloads), Q = how long quiet, I = open issues (log).
* **Gaps:** forum titles and plugin descriptions become TF-IDF vectors; topics are clustered at cosine similarity 0.45; a cluster's *coverage* is the like-weighted similarity to its closest plugin: below 0.35 is a *likely gap*, above 0.5 *probably covered*. Requests that need Obsidian itself to change are flagged `appLevel`.

### Limits

Downloads are not users. One data point is not a trend. Quiet is not dead: a finished, stable plugin looks abandoned by these rules. Word matching misses synonyms and can match on a shared word (the closest plugin to "disable auto-save or change frequency" can be one with "frequency" in its name), so treat *likely gap* as **worth a look** and read the linked threads. GitHub details arrive in batches. The Methodology page lists these and more.

### Reading `ideas.json`

`ideas.json` (repository root, also published at `/ideas.json`) is rebuilt every run and validated against `schemas/ideas.schema.json` before it is written.

| Field | Meaning |
|---|---|
| `schema`, `week`, `generated` | format version, ISO week of the data, date of the run |
| `notes` | the caveats; read them before relying on anything below |
| `forum` | state of the forum data (`ok`, `partial`, `failed`…), when it was fetched, how many topics |
| `gaps[]` | forum requests ranked by demand × (1 − coverage): `id`, `title`, `keywords`, `requests` (topics in the cluster), `likes`, `views`, `status` (`likely-gap`, `partly-covered` or `probably-covered`), `coverage` (0–1, lower = less covered), `rank`, `appLevel`, `firstRequested`, `lastActive`, `closestPlugins[]` (`id`, `name`, `similarity`, `downloads`, `url`) and `evidence[]` (forum threads: `title`, `url`, `likes`, `created`) |
| `maintainersWanted[]` | quiet but loved plugins: `id`, `name`, `downloads`, `weeklyDownloads`, `quietMonths`, `lastActivity`, `openIssues`, `stars`, `score`, `provisional`, and `evidence` links (`directory`, `repository`, `issues`). No author names, by design. |
| `archivedByAuthors[]` | popular plugins whose authors archived the repository, as a list of alternatives to build: `id`, `name`, `downloads`, `evidence` (`directory`, `repository`) |
| `basis` | what the numbers rest on (snapshot count, thresholds in force) |

Using it: sort `gaps` by `rank`, skip `appLevel: true`, open the `evidence` threads and check `closestPlugins` before building anything. For `maintainersWanted`, open the repository, read the issues, and offer help kindly before forking.

## Run it yourself

Plain Node 22, no runtime dependencies (`yaml` and `graphql` are dev-only, for the score ladder and the mock GitHub).

```bash
npm ci                                  # dev dependencies only
node scripts/fetch.mjs                  # snapshot for this ISO week (GITHUB_TOKEN raises the rate limit)
node scripts/forum.mjs                  # optional: forum feature requests
node scripts/analyze.mjs --ideas ideas.json
node scripts/build-site.mjs             # writes dist/
npx --yes serve dist                    # or any static file server; the site uses relative links only
```

Offline demo from the saved fixtures (no network at all):

```bash
node scripts/fetch.mjs --releases fixtures/releases --transport none --week 2026-W43 --out /tmp/radar/snaps --cache /tmp/radar/cache
node scripts/build-site.mjs --snapshots /tmp/radar/snaps --directory fixtures/releases/community-plugins.json --forum none --out /tmp/radar/dist
```

### Checks

```bash
npm test                                # 120+ unit and integration tests (node:test)
./score                                 # the whole ladder R0..R6; ./score --rung R4 stops at R4; --skip-browser skips Playwright
node scripts/ci-dry-run.mjs             # the weekly workflow's own commands, offline, against mocks and a local git remote
node scripts/check-links.mjs dist       # relative links, anchors, plugin pages, no absolute paths
node scripts/check-layout.mjs dist      # Playwright at 375 px and 320 px: no horizontal scroll, dark mode, search, chart, language
```

`./score` is the definition of done: R0 scaffolding, R1 fetch and snapshot, R2 growth and abandonment on two snapshots, R3 gaps and `ideas.json`, R4 the site, R5 the workflow and the CI dry run, R6 documentation. A check is never edited to make it pass, only extended. Playwright is not a dependency; it is found in `node_modules` or the global install (`npm i --no-save playwright` in CI).

### Repository map

| Path | What |
|---|---|
| `.github/workflows/weekly.yml`, `ci.yml` | weekly rebuild and deploy; checks on every push |
| `scripts/` | `fetch`, `forum`, `analyze`, `build-site`, `commit-data`, `check-links`, `check-layout`, `ci-dry-run`, `findings` (the findings block of RESULTS.md), `make-fixtures` (regenerates the saved test samples), `score` and `score-rungs/` |
| `lib/` | the analysis and site code (`growth`, `abandonment`, `gaps`, `text`, `similar`, `categories`, `site`, `i18n`, `methodology`, …) |
| `site/assets/` | `style.css` (all design tokens), `app.js` (small enhancements), `favicon.svg` |
| `data/` | `snapshots/` (append-only history), `forum/` (last forum fetch), `cache/` (git-ignored) |
| `config.json` | every threshold and URL; the Methodology page prints these same values |
| `schemas/` | JSON schemas for snapshots and `ideas.json` |
| `fixtures/`, `tests/` | saved Obsidian files, a synthetic previous week, forum sample; mock GitHub and Discourse servers |
| `DECISIONS.md` | why things are the way they are (every judgement call is justified there) |
| `STATE.md`, `NEXT.md`, `PROGRESS.md` | where the project stands, what is next and how to resume, one line per working session |
| `RESULTS.md` | what `./score` confirms, how to reproduce it, the first real findings, what is left to do |

### Design

No design system was available to this repository, so the site uses a minimal, clean style whose colours, spacing and type are CSS custom properties at the top of `site/assets/style.css` (light and dark). Replacing that block is all it takes to re-skin the site. See `DECISIONS.md`.

## Principles

Plugins, not people: pages about quiet plugins never name or rank their authors. Public data only. Deterministic and explainable: no model, no hidden edits. The owner's own plugins are the only author-level view (`myAuthor` in `config.json`).
