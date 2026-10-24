# DECISIONS

Every non-obvious choice, with the reason. Newest decisions are appended at the bottom of each section.

## Scope and brief
- **Placeholders in the brief** (`<your-user>`, `<repo-with-Tinta>`, `<your-obsidian-author-name>`) were never filled in and nobody can be asked, so they were resolved from public facts:
  - Repo owner = `perezamadorluisenrique-gif` (this repo's remote).
  - Author name for the "My plugins" panel = **`siulved54`**: the community directory lists 30 plugins under that author whose repos all live under `perezamadorluisenrique-gif/`. It is a single value in `config.json` (`myAuthor`), change it there.
  - Tinta design system: no repository called Tinta is visible to this session (only `obsidian-radar` and a private `obsidian-dev`, which the brief does not name and which was therefore not read). Fallback per the brief: a minimal, clean style built on CSS custom properties in `site/assets/tokens.css`, so Tinta tokens can be dropped in later by replacing that one file.
- **No pull request is opened.** The brief says not to open issues/PRs anywhere, which overrides the generic habit of opening a draft PR after pushing. Work lives on branch `claude/charming-bardeen-ptiqqz`; merging it to `main` is listed under "what's left for you" in RESULTS.md.

## Data and fetching
- **Real scale.** `community-plugins.json` lists 9,385 plugins (not the ~3k the brief assumed). Everything is sized for that: a snapshot is about 106 KB gzipped without GitHub metadata, and a full GraphQL refresh is about 94 batches of 100 repositories.
- **Snapshot content.** Per plugin: `dl` (downloads, cumulative) and `rel` (date of the latest release, which `community-plugin-stats.json` reports as `updated`), plus the optional GitHub fields `push`, `crt`, `arch`, `stars`, `iss`, `fr`, `gone`, `chk`, `src`. Weekly growth is never stored; it is the difference between two snapshots. Plugin ids are written in sorted order and gzip is deterministic, so re-running a week with the same inputs gives the same bytes.
- **`rel` is a free maintenance signal.** It is available for every plugin without any GitHub call, so the analysis always has "last release" even in a week where GitHub metadata could not be refreshed. `push` (last push) is the stronger signal the brief asks for and is used whenever it is present.
- **Never rewrite past snapshots.** `buildSnapshot` writes only the file for the requested week, atomically. Re-running a week overwrites that week only; `score` R1 checks with git that no older snapshot was modified.
- **Rolling refresh (the rate-limit design).** GitHub metadata is refreshed in priority order until the budget or rate limit runs out; the rest keeps the values from the previous snapshot (or from this week's earlier partial run) and the snapshot records `refresh.state = "rolling"` plus how many are pending. A rate limit, a bad token, a missing token or a 502 never fails the build. The order (tier 0 first):
  0. plugins new since the previous snapshot (never checked);
  1. maintainer-wanted candidates (downloads at or above the threshold and no release for 12 months or more), so the headline list is always verified against GitHub first;
  2. plugins never checked;
  3. plugins whose last check was the REST bootstrap, so they gain the feature-request count when GraphQL is available;
  4. everyone else, stalest check first;
  5. plugins already refreshed this week by an earlier partial run (so a re-run continues instead of repeating).
- **GraphQL batching.** 100 repositories per request using aliases (`r0..r99`), and two fragments: `Core` for everyone and `Labels` (open issues with a feature-request-like label) only for plugins at or above `labelsMinDownloads`, to keep the query cost low. On HTTP 502 the batch is halved. The query is validated in tests against a pruned copy of the real GitHub schema (`fixtures/graphql/github-subset.graphql`, made from the published schema by `scripts/make-fixtures.mjs`), and a mock server reproduces NOT_FOUND, rate limits (GraphQL error, HTTP 403, HTTP 429) and 502s.
- **Feature-request labels** are matched by `/feat|enhanc|request|idea|suggest|wish/i`: GitHub label names are free text, and an exact list would miss `type: enhancement`, `feature-request`, `💡 idea` and so on.
- **REST fallback (`--transport rest`).** Used only for local development and for environments where GraphQL is unreachable but the REST API is. It records `src: "r"`, its `iss` includes pull requests, and it has no feature-request count; the planner puts such records first (tier 3) as soon as GraphQL works. The weekly workflow uses GraphQL with the repository's own `GITHUB_TOKEN`.

## GitHub access in the build sandbox (important)
- The sandbox that built this project reaches `raw.githubusercontent.com` (so the Obsidian files) and `forum.obsidian.md`, but its proxy refuses `api.github.com/graphql` and refuses the REST API for any repository other than the one attached to the session. So **the live GraphQL path has never run against real GitHub**. What backs it instead: validation of the query against the real GitHub schema, a mock server with the failure modes above, and the REST field mapping checked against the one repository that is reachable.
- Consequence for the first real snapshot (`2026-W43`): it has complete downloads and release dates for all 9,385 plugins and **no GitHub metadata** (`refresh.state = "rolling"`, `transport = "none"`, 9,385 pending). This is the documented rolling-refresh state the ladder accepts instead of 95% coverage. The first scheduled run on GitHub Actions (which has a token and API access) will start filling it: it does the maintainer-wanted candidates first, and the full list within a few runs at most.
- Consequence for the analysis: wherever `push`/`iss`/`arch` are missing, abandonment falls back to `rel` and the entry is shown as *provisional* ("not yet verified against GitHub") on the site. Nothing is invented.
