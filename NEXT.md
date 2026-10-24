# NEXT

## Next
Nothing is open for the agent: R0..R6 pass. What is left is for the owner and is listed in RESULTS.md, "What is left for you":
1. Merge `claude/charming-bardeen-ptiqqz` into `main` (no pull request was opened, by the brief).
2. Settings -> Pages -> Source: GitHub Actions.
3. Actions -> weekly -> Run workflow, then read that run's *fetch* step once (the live GitHub calls have only ever run against a mock).
4. After the second snapshot the growth lists fill by themselves.

## How to resume
1. `git checkout claude/charming-bardeen-ptiqqz && git pull`
2. `npm ci` (dev dependencies only: `yaml`, `graphql`); `npm i --no-save playwright` for the browser checks.
3. `./score` shows the highest rung that passes; work on the first failing check. Never edit a check to make it pass, only extend it.
4. Optional, with network: `node scripts/fetch.mjs --out /tmp/radar-snaps --cache data/cache` fills the git-ignored plugin cache so the real-data checks run instead of skipping.
5. Update STATE.md, PROGRESS.md and this file before every commit. If the data moved on (a real weekly run), nothing needs regenerating: the findings block in RESULTS.md stays as the record of the first week.

## Blockers
- **GitHub API from the build sandbox** (denied, took another route): the proxy refuses `api.github.com/graphql` and REST for repos other than this one. The live GraphQL path is therefore only tested against the real schema + a mock. The first snapshot (2026-W43) is in the documented rolling-refresh state (downloads and release dates complete, GitHub metadata pending). It fills in automatically on the first Actions run, which has a token. See DECISIONS.md "GitHub access in the build sandbox".
- **Tinta design system**: the brief names no repository for it and none is visible to this session, so the site uses the minimal fallback style (tokens in one CSS file). See DECISIONS.md.
- No approval prompt was refused; nothing under `~/.claude` was touched; no pull request, issue, scheduled task, message or second repository was created.
