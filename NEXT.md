# NEXT

## Next
1. R4: site (scripts/build-site.mjs, link check, Playwright 375px + dark mode + search).
2. R5: .github/workflows/weekly.yml + CI dry run (forum step offline). R6: README, Methodology page, RESULTS.md.

## How to resume
1. `git checkout claude/charming-bardeen-ptiqqz && git pull`
2. `npm ci` (only needed for the workflow validator, `yaml`)
3. `./score` shows the highest rung that passes; work on the first failing check.
4. Update STATE.md, PROGRESS.md and this file before every commit.

## Blockers
- **GitHub API from the build sandbox** (denied, took another route): the proxy refuses `api.github.com/graphql` and REST for repos other than this one. The live GraphQL path is therefore only tested against the real schema + a mock. The first snapshot (2026-W43) is in the documented rolling-refresh state (downloads and release dates complete, GitHub metadata pending). It fills in automatically on the first Actions run, which has a token. See DECISIONS.md "GitHub access in the build sandbox".
- **Tinta design system**: the brief names no repository for it and none is visible to this session, so the site uses the minimal fallback style (tokens in one CSS file). See DECISIONS.md.
