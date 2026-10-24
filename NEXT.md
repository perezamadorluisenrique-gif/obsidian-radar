# NEXT

## Next
1. R1: scripts/fetch.mjs (directory + stats + GitHub metadata -> data/snapshots/YYYY-Www.json.gz), schema, rolling refresh.
2. R2: growth + maintainer-wanted analysis. R3: forum gap clustering + ideas.json. R4: site. R5: workflow. R6: docs + RESULTS.md.

## How to resume
1. `git checkout claude/charming-bardeen-ptiqqz && git pull`
2. `npm ci` (only needed for the workflow validator, `yaml`)
3. `./score` shows the highest rung that passes; work on the first failing check.
4. Update STATE.md, PROGRESS.md and this file before every commit.

## Blockers
- none yet
