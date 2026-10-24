# DECISIONS

Every non-obvious choice, with the reason. Newest decisions are appended at the bottom of each section.

## Scope and brief
- **Placeholders in the brief** (`<your-user>`, `<repo-with-Tinta>`, `<your-obsidian-author-name>`) were never filled in and nobody can be asked, so they were resolved from public facts:
  - Repo owner = `perezamadorluisenrique-gif` (this repo's remote).
  - Author name for the "My plugins" panel = **`siulved54`**: the community directory lists 30 plugins under that author whose repos all live under `perezamadorluisenrique-gif/`. It is a single value in `config.json` (`myAuthor`), change it there.
  - Tinta design system: no repository called Tinta is visible to this session (only `obsidian-radar` and a private `obsidian-dev`, which the brief does not name and which was therefore not read). Fallback per the brief: a minimal, clean style built on CSS custom properties in `site/assets/tokens.css`, so Tinta tokens can be dropped in later by replacing that one file.
- **No pull request is opened.** The brief says not to open issues/PRs anywhere, which overrides the generic habit of opening a draft PR after pushing. Work lives on branch `claude/charming-bardeen-ptiqqz`; merging it to `main` is listed under "what's left for you" in RESULTS.md.
