# Tasks

## Resume here
- Active phase: none. Project picked up locally on 2026-10-26. Last cloud commit 60f172a (2026-10-26,
  import keeps original import time + stale-roster banner), live on Render.
- Open bugs: none known.
- Next brief: none yet.

## Waiting on
- Yahoo Fantasy API approval for the app's Client ID (applied; still pending as of 2026-10-26).
  Until then use the browser import (docs/IMPORT.md). No code change needed once approved.

## To confirm
- Local test run: `npm ci && npm run typecheck && npm test` not yet run on this machine.

## Backlog
Observed on the live app with the owner's real import, 2026-10-26 (not yet triaged or root-caused):
- Records show "–" for every team (standings not imported or not displayed).
- Team names carry the league-name prefix ("<League> - <Team>").
- Optimal lineup starts a Questionable WR over a healthy one; no injury discount visible for Q.
- Waivers: almost every free agent shows value 0.0, so nearly all calls are PASS (incl. a RB with +43% snaps);
  a CLAIM is recommended on a Questionable player, spending rolling priority. Waiver priority shows "unknown".
- Footer said "regular season ends week 18" before the league loaded (check it reads 14 with the league).
- Imports vanish on every Render restart; only the importing browser can restore them. Options costed in chat:
  Render paid disk (~$7/mo) or a free external DB.
