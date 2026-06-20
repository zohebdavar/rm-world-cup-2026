# Real Madrid at the 2026 World Cup — auto-updating goal tracker

A public web page that tracks goals scored by current and former Real Madrid
players at the FIFA World Cup 2026. It updates itself — no maintenance.

**Live page:** `https://<your-username>.github.io/<repo-name>/` (after setup)

## How it works

- `index.html` — the page. Reads `data.json` and also pulls live match
  results in the browser from TheSportsDB (no key needed).
- `data.json` — the goal numbers shown on the page.
- `scripts/refresh.mjs` — recomputes `data.json` from the live match feed.
  It reads each World Cup match's scorers from TheSportsDB's free API and
  tallies goals for the players listed in the script. **No API key required.**
- `.github/workflows/refresh.yml` — a GitHub Action that runs the script on a
  schedule (every 6 hours) and commits the updated `data.json`. GitHub Pages
  then re-publishes automatically.

If the feed is ever unreachable, the script leaves the last good `data.json`
in place, so the page never breaks or shows zeros.

## One-time setup (about 3 minutes)

1. **Create a repository** on GitHub (Public). Any name, e.g. `rm-world-cup`.
2. **Add these files** to it (keep the folder structure):
   ```
   index.html
   data.json
   .nojekyll
   README.md
   scripts/refresh.mjs
   .github/workflows/refresh.yml
   ```
3. **Turn on GitHub Pages:** repo **Settings → Pages → Build and deployment →
   Source: "Deploy from a branch" → Branch: `main` / `(root)` → Save.**
   Your live URL appears at the top of that page after a minute.
4. **Allow the Action to run:** **Settings → Actions → General → Workflow
   permissions → "Read and write permissions" → Save.** (Lets the schedule
   commit updated data.)
5. **Run it once now:** **Actions tab → "Refresh World Cup goals" → Run
   workflow.** After it finishes, the page shows live-tallied numbers.

That's it. From then on it refreshes on its own every 6 hours.

## Tweaks

- **Change how often it updates:** edit the `cron` line in
  `.github/workflows/refresh.yml` (times are UTC). `"0 */3 * * *"` = every 3h.
- **Change the players tracked:** edit the `CURRENT` and `FORMER` lists at the
  top of `scripts/refresh.mjs` (name, country, two-letter flag `code`).
- **Run on demand any time:** Actions tab → Run workflow.

## Notes

- Data source: [TheSportsDB](https://www.thesportsdb.com) free tier
  (FIFA World Cup, league 4429, season 2026).
- Scheduled GitHub Actions can occasionally start a few minutes late when
  GitHub is busy — normal, nothing to fix.
