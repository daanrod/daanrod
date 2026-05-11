# Profile stats generator

Self-hosted replacement for third-party README stats services. Generates three
SVGs in `assets/` from real GitHub data (public + private repos):

- `stats.svg` — totals (stars, commits all-time, PRs, issues, contributions, repos, followers)
- `top-langs.svg` — language distribution by code size across all owned repos
- `streak.svg` — current streak, longest streak, total contributions

## Setup (one-time)

1. Create a Personal Access Token at <https://github.com/settings/tokens/new>:
   - **Classic** token, scopes: `repo` (full), `read:user`
   - Or **Fine-grained** with `Contents: read` and `Metadata: read` for all repos
2. Add it as a repo secret named `STATS_TOKEN` at
   <https://github.com/daanrod/daanrod/settings/secrets/actions>.
3. (Optional) Enable "Include private contributions on my profile" in
   <https://github.com/settings/profile> so private contribution counts show.

## Run

- **GitHub Actions**: triggered daily by cron at 04:00 UTC, on push to
  `scripts/generate-stats.mjs` or the workflow, or manually via Actions tab →
  *Update profile stats* → *Run workflow*.
- **Local**: `STATS_TOKEN=ghp_xxx node scripts/generate-stats.mjs`.

## Customize

- Colors: edit `THEME` at the top of `scripts/generate-stats.mjs`.
- Layout/sizes: each SVG is built by `statsSvg`, `langsSvg`, `streakSvg`.
- Different username: set `STATS_USERNAME=<login>` (defaults to `daanrod`).
