# Tasks

## Resume here
- Release 1 (advice fixes) shipped 2026-10-26: injury-discounted My Team lineup; waivers claim future starters,
  new Stash call, no priority on injured/DNP players (DESIGN.md "Waivers v2").
- Hosting: Mac mini service com.fantasy.tradedesk (127.0.0.1:5070) behind the raibot-dashboard Cloudflare tunnel at
  https://ff.raibot.us; data on local disk in ~/FantasyFootball-run/.data. No password (APP_PUBLIC=1, owner's choice
  2026-10-26) until Discord login ships. Render still runs (password-protected); owner to decide whether to suspend it.
- Next feature (owner, 2026-10-26): Discord single sign-on like perp.raibot.us, multi-tenant: allow-listed Discord
  user ids (owner will supply), each user manages their own team/league. Then release 2 = import fixes (Backlog).
- Right after sign-in (owner, 2026-10-26): header shows "League updated <date, time> · by <Discord name>" at all
  times (store importedBy on each import/re-import; any user in the league can re-import, it upserts the shared
  league). Rename the existing "Data Xm ago" pill (player-stats download time) so the two are not confused.
- Then (owner, 2026-10-26): clean up tables, starting with Waivers. Every row shows a 1–2 sentence summary under
  255 characters; the full analysis opens when the row is tapped (rule for ALL tables: Waivers, Trades, Targets,
  Values, My Team). Waivers also only shows players "on waivers": the import has no on-waivers vs free-agent flag, so
  every player is marked W and true free agents (no priority cost) cannot be told apart. Capture that in the import
  and show free agents worth adding.
- Open bugs: none known beyond the backlog.

## Waiting on
- Yahoo Fantasy API approval for the app's Client ID (applied; still pending as of 2026-10-26).
  Until then use the browser import (docs/IMPORT.md). No code change needed once approved.

## Backlog
Release 2 — import fixes (verified against the owner's raw browser import, 2026-10-26):
- Standings/records are not captured by the bookmarklet: every team shows "–" (power-rank ties, record display).
- Waiver priority is not captured ("Waiver priority unknown").
- Team names arrive with the league-name prefix ("<League> - <Team>") from the bookmarklet itself.
- The free-agent list has no K or DEF, so kicker/defense streaming advice cannot work for imports.
- Footer said "regular season ends week 18" before a league loaded; check it reads 14 with the league.

Known limitations (not scheduled):
- Future-starter claims ignore position depth (e.g. a TE claim when three TEs are rostered = a trade chip, not a lineup fix).
- Trade lineups do not apply the Q/D/O discount (only My Team / power ranks do).
- Waivers now loads the depth chart (~55 MB, cached 12 h; wiped on Render restarts), so the first Waivers load after a
  wake is slower.
