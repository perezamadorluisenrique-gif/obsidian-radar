# RESULTS

Obsidian Ecosystem Radar, built autonomously on branch `claude/charming-bardeen-ptiqqz` (commits only; no pull request, issue, message or scheduled task was created anywhere). Everything below is checked by `./score`, which reads these files, so a number here that stops being true turns a check red.

**Short version.** The pipeline (fetch, forum, analyse, commit data, build, check, deploy), the static site, the weekly workflow and the docs are done and pass R0 to R6. The one thing this environment could not do is talk to the GitHub API, so the first real GitHub-metadata snapshot is yours to trigger (see [What is left for you](#what-is-left-for-you)).

## What `./score` confirms

**83 checks** in seven rungs. A rung is only meaningful if the ones below it pass, so `./score --rung R4` runs R0 to R4.

| Rung | What it verifies | Checks |
|---|---|---|
| R0 | the ladder itself runs; README, `.gitignore`, `STATE.md`, `NEXT.md`, `PROGRESS.md`, `DECISIONS.md` exist; `STATE.md` has a status and a UTC time, `NEXT.md` has Next, How to resume and Blockers | 12 |
| R1 | `scripts/fetch.mjs` writes a schema-valid snapshot for every plugin (fixtures, no token, rate-limited), a real snapshot is committed, snapshots store downloads only and are never rewritten | 9 |
| R2 | growth and the maintainer-wanted score on two snapshots, checked by an independent recomputation, planned test cases and a hand-computed score; the real baseline is reported honestly; no network or LLM calls in the analysis | 9 |
| R3 | forum fixture and mock Discourse, TF-IDF clustering checked against a naive reimplementation, hand-built gap world, committed forum data, `ideas.json` validates and is reproducible, forum step fails gracefully | 11 |
| R4 | static site: every page, valid links and anchors, works without JavaScript, small files and lazy search, byte-identical rebuild, Methodology thresholds, Playwright at 375 px and 320 px (no horizontal scroll, dark mode, search, chart, Spanish toggle) on fixtures and on the real 9,385-plugin data | 10 |
| R5 | `weekly.yml` and `ci.yml` valid and least-privilege; **offline dry run of the workflow's own commands** against a mock GitHub, a mock forum and a local git remote: forum offline, rate-limited GitHub, idempotent re-run, tampered past snapshot refused, push race rebased | 16 |
| R6 | README, Methodology page and this file are complete and agree with `config.json`, the schema, the scripts and the data (numbers, fields, commands, links, findings block, test count) | 16 |

Also confirmed along the way: `npm test` runs 124 unit and integration tests, all passing (R6 re-runs them and checks the README's "120+").

### What `./score` does not confirm

These could not be exercised from the build environment, where the proxy refuses `api.github.com` for every repository except this one:

* **The live GitHub GraphQL calls.** They were written against the real GitHub schema (the SDL is the basis of the mock server, which executes the real query text) and exercised against that mock: batching, rate limits, 502s, bad tokens, partial errors. They have never run against the real API. If the first run's *fetch* step shows an unexpected error, that is where to look; the fetcher falls back to REST and never fails the build (the snapshot is saved in the documented *rolling* state).
* **The GitHub Actions runner and GitHub Pages deployment.** The CI dry run runs every `node scripts/...` line of `weekly.yml` in order, but not the YAML through Actions. The workflow is pinned to released action versions, validated structurally by R5, and uses only documented inputs; the first run is the real test.
* **Playwright in the Actions runner.** The browser check in `weekly.yml` is allowed to fail with a warning so a runner without a browser cannot block the weekly refresh. In `ci.yml` it is blocking.
* **The Tinta design system.** The brief says to use it if its tokens exist in the repository; none exist in this repository and no other repository is visible, so the site uses a minimal style whose tokens are the first lines of `site/assets/style.css`.

## Reproduce

Node 22. Nothing needs a network connection except the optional last command.

```bash
git checkout claude/charming-bardeen-ptiqqz
npm ci                                  # dev dependencies only (yaml, graphql)
npm i --no-save playwright              # browser checks; without it use ./score --skip-browser (then not a full pass)
./score                                 # R0..R6, 83 checks; exit code 0 = everything passes
./score --rung R4                       # R0..R4 only
./score --only R6                       # just the documentation rung
npm test                                # the 124 unit and integration tests
node scripts/ci-dry-run.mjs             # the weekly workflow's commands, offline, 44 assertions
node scripts/ci-dry-run.mjs --browser   # the same plus the Playwright layout check (46)
node scripts/findings.mjs               # prints the findings block below from the committed data
node scripts/fetch.mjs --out /tmp/radar-snaps --cache data/cache   # optional, needs network: fills the git-ignored plugin cache so the real-data checks in R4 and R6 run instead of skipping
```

The checks that need the plugin directory cache (`data/cache/directory.json`, git-ignored) say `skipped: …` and still pass when it is absent, which is how a fresh clone and CI behave.

## First real findings

Generated by `node scripts/findings.mjs` from the committed snapshot and forum data, never typed by hand (R6 regenerates it and compares). This is the **baseline** week, so there is no growth yet, and GitHub details are still pending, so every "looking for maintainers" row is provisional (it rests on the last release date from the directory, not on the last push). Once the weekly workflow has run, the data moves on and this block stays as the record of the first week.

<!-- findings:start 2026-W43 cf3a0f6e95dd (generated by `node scripts/findings.mjs`; ./score compares it with the data) -->
**Data.** Week 2026-W43: 9,385 plugins, 163,481,506 downloads in total, 1 snapshot. This is the baseline week, so there is no weekly growth yet; the growth lists fill from the second weekly run. GitHub details are known for 0 of 9,385 plugins (rolling).

**Biggest plugins (downloads):** Excalidraw 8,679,776, Templater 6,001,835, Dataview 5,194,476, Tasks 4,490,721, Git 3,344,041.

**Newcomers (listed in the last 90 days; ages are estimated until we have watched them arrive):** 3,338 plugins. Most downloaded so far: Chinese Market 58,980, Sync Engine 49,682, Unhide 36,934, WeSight 35,507, Abyss Tasks 30,202.

**Looking for maintainers:** 458 plugins pass the filter (0 verified against GitHub, 458 provisional until GitHub details arrive). Highest scores:

| Plugin | Downloads | Last release or push | Quiet for | Score |
|---|---:|---|---:|---:|
| Calendar | 3,215,652 | 2021-04-20 | 66 months | 100 |
| Mind Map | 900,603 | 2020-12-13 | 70 months | 98.7 |
| Advanced Slides | 840,651 | 2023-02-15 | 44 months | 97.8 |
| Periodic Notes | 785,867 | 2022-04-14 | 54 months | 97 |
| Highlightr | 741,469 | 2022-08-31 | 50 months | 96.3 |
| Pandoc Plugin | 563,251 | 2022-09-25 | 49 months | 92.9 |
| Full Calendar | 471,794 | 2023-04-06 | 43 months | 90.7 |
| Annotator | 603,864 | 2024-01-08 | 34 months | 89.3 |

**Gaps:** 987 forum topics grouped into 278 requests, 20 of them likely gaps; 8 of the top 25 probably need Obsidian itself to change and are left out here. The top ones a plugin could take:

| Request | Likes | Closest plugin (similarity) | Thread |
|---|---:|---|---|
| Properties: let the user customize the way Dates/Times are displayed (independently from OS) | 662 | YAML Properties (0.38) | [forum](https://forum.obsidian.md/t/properties-let-the-user-customize-the-way-dates-times-are-displayed-independently-from-os/64139) |
| Writing in tree structure - The solution to long form writing (Gingko) | 460 | Lineage (0.37) | [forum](https://forum.obsidian.md/t/writing-in-tree-structure-the-solution-to-long-form-writing-gingko/20727) |
| Automatic/inline update of links to headings and blocks when they are modified (rename header with no extra dialog window) | 352 | Heading Link Sync (0.35) | [forum](https://forum.obsidian.md/t/automatic-inline-update-of-links-to-headings-and-blocks-when-they-are-modified-rename-header-with-no-extra-dialog-window/25412) |
| Use H1 or YAML property "title" instead of or in addition to filename as display name | 715 | Tab Title from H1 File Title (0.45) | [forum](https://forum.obsidian.md/t/use-h1-or-yaml-property-title-instead-of-or-in-addition-to-filename-as-display-name/687) |
| A general format for specifying links to a part of note (multiple paragraphs, ranges) / Embedding Multiple Consecutive Headings Or Blocks | 253 | Multiple Notes Outline (0.31) | [forum](https://forum.obsidian.md/t/a-general-format-for-specifying-links-to-a-part-of-note-multiple-paragraphs-ranges-embedding-multiple-consecutive-headings-or-blocks/19962) |
| Ignore/exclude completely files or a folder from all obsidian indexers and parsers | 348 | File Ignore (0.36) | [forum](https://forum.obsidian.md/t/ignore-exclude-completely-files-or-a-folder-from-all-obsidian-indexers-and-parsers/52025) |
| Disable auto-save or change frequency | 461 | Word Frequency (0.40) | [forum](https://forum.obsidian.md/t/disable-auto-save-or-change-frequency/14230) |
| Add counters/markers for headings and blocks that are referenced somewhere else | 202 | Custom Counter (0.28) | [forum](https://forum.obsidian.md/t/add-counters-markers-for-headings-and-blocks-that-are-referenced-somewhere-else/37708) |

**Your plugins (siulved54):** 29 in the directory, 14,212 downloads in total. Best: Section Numbering 2,404 (#3,031 of 9,385), Typography as You Type 2,361 (#3,061 of 9,385), Spreadsheet to Table 1,615 (#3,713 of 9,385), Text Case and Cleanup 1,502 (#3,848 of 9,385), Update Radar 1,082 (#4,410 of 9,385).
<!-- findings:end -->

### How to read them (the part a script cannot say)

* **The directory is much bigger than expected: 9,385 plugins, 163 million downloads.** The top five (Excalidraw, Templater, Dataview, Tasks, Git) hold about 17 % of all downloads; the long tail is very long.
* **"Newcomers: 3,338" is an overestimate.** Before the radar has watched plugins arrive, age is estimated from the position in the append-only directory list, which is generous. From the second snapshot on, newcomers are plugins first seen in a snapshot, and the number will drop to the real count of new listings per week.
* **Looking for maintainers.** The head of the list is plausible: Calendar, Mind Map, Advanced Slides, Periodic Notes and Highlightr all have hundreds of thousands to millions of downloads and no release for years. All 458 are provisional: a plugin may have had pushes without a release. The list becomes final once GitHub details arrive (first real run). Read the repository and its issues, and offer help kindly before forking; the site's wording is *room for help or for an alternative*, never a verdict on an author.
* **Gaps need reading, not trusting.** Of the eight rows, "customize how dates are displayed" (662 likes, closest plugin 0.38) is the clearest plugin-sized gap. Others look half answered: *Tab Title from H1* (0.45) is probably an answer to the H1-as-title request, *Heading Link Sync* (0.35) to automatic link updates, *Lineage* (0.37) to the Gingko-style tree, *File Ignore* (0.36) to the exclude request. *Word Frequency* for "disable auto-save or change frequency" is a word coincidence. This is the known limit of word matching, stated on the Methodology page; the table is a shortlist of threads to open, ranked by likes.
* **Eight of the 25 top gap clusters need Obsidian itself to change** (WYSIWYG mode, mobile, Sync, Publish). They are flagged `appLevel` in `ideas.json` and left out of the table above.
* **Your plugins** (`myAuthor` in `config.json`): 29 in the directory and 14,212 downloads. They sit around rank 3,000 to 4,400 of 9,385, the upper-middle of the directory; weekly growth against similar plugins appears on the *My plugins* page from the second snapshot.

## What is left for you

Nothing was merged, published or triggered on your behalf. In this order:

1. **Merge the branch** `claude/charming-bardeen-ptiqqz` into `main` (open the pull request yourself, or `git merge`). The brief said not to open pull requests, so none exists.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Actions → weekly → Run workflow** (on `main`). The first run fetches everything with the built-in `GITHUB_TOKEN`, commits the first real data (the bot pushes to `main`) and deploys the site at `https://perezamadorluisenrique-gif.github.io/obsidian-radar/`.
4. **Read that run's log once**, especially the *fetch* step. It prints how many repositories it could check; if the rate limit ends the run early that is fine (the next run continues), but a GraphQL error would be the first sign of something the mock could not show. If GitHub rate limits you, add a repository secret `RADAR_GITHUB_TOKEN` (fine-grained, public repositories read-only).
5. **If `main` is protected** (pull request required), allow the Actions bot to push to it or relax the rule for this path; otherwise the *commit data* step fails on purpose, because losing a snapshot is the one thing the pipeline refuses to do quietly.
6. **Expect the growth lists to fill on the second snapshot.** The schedule is Mondays 05:41 UTC. If your first run happens this ISO week (2026-W43) it overwrites only that week's snapshot, and the first scheduled run (Monday 2026-10-26, week 2026-W44) is the first week-over-week comparison. If your first run happens after that Monday it writes 2026-W44 next to the baseline and the growth lists fill immediately.
7. **Optional:** set the repository variable `RADAR_FORUM` to `off` if you ever want to skip the forum; replace the token block at the top of `site/assets/style.css` if you want the Tinta look; GitHub may disable scheduled workflows after 60 days without repository activity (the weekly data commit should count as activity; if GitHub emails you that it was disabled, re-enable it under Actions → weekly).

To pause everything, see the README ("Pause it, or switch parts off").

### Blockers hit and how they were routed around

* **GitHub API unreachable from the build environment** (denied; took another route): the proxy refuses `api.github.com`, so the first snapshot has downloads and release dates for all 9,385 plugins but no GitHub metadata, and says so (`rolling`, 0 of 9,385 checked). The code path is tested against the real schema with a mock. Details in `DECISIONS.md`, "GitHub access in the build sandbox".
* **Tinta design system not found** (took another route): minimal fallback style, documented in `DECISIONS.md`.
* No approval prompt was refused and nothing under `~/.claude` was touched.

Judgement calls (every threshold, the rolling refresh, why TF-IDF, why static pages with a JS plugin shell, why no author names) are in `DECISIONS.md`; where the project stands is in `STATE.md`, `NEXT.md` and `PROGRESS.md`.
