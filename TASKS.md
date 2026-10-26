# Tasks

## Resume here
Owner (2026-10-26): Claude is the architect; work the queue autonomously, stop only for critical issues.
Release plan (in order; each = build → adversarial test → review → deploy to the Mac → smoke check):
1. Waivers cleanup (IN PROGRESS, developer agent): summary ≤255 + bullet details on tap, free agents vs waivers
   (import captures FA/W), K/DEF free agents, shared expandable-row component. Same deploy: strip league-name prefix
   from team names everywhere.
2. Import enabler: bookmarklet captures standings (W-L-T, points for/against, rank) and waiver priority; parser
   fixtures + defensive diagnostics. Needs the owner's next re-import to show real data.
3. League tab (BUILT 2026-10-26, not yet deployed; DESIGN.md "League tab"): standings table, power rankings with a chart, "who is above me and why" (per-team position-group
   deltas vs mine, starter ppg vs bench), all collapsed rows + bullets on tap. Power rankings MOVE here from My Team.
4. Trade Finder + Targets cleanup (collapsed cards/rows, bullet details, one-line notices) + tappable column help on
   every table, Values first (Edge "—" when market missing). BUILT 2026-10-26, not yet deployed (DESIGN.md "Collapsed
   rows everywhere"). Leftovers: unused .trade-card / .targets-grid / .target-card CSS rules; My Team still shows prose why.
5. Values, My Team, Connect cleanup + header "League updated <date> · by <name>" (rename the "Data Xm ago" pill).
   My Team (owner screenshot): power rankings removed (they live in the League tab, release 3); bench = same table as
   the starting lineup; dense layout, cards in a row equal height (no dead space under Byes & injuries).
Open bug (not reproduced): tab clicks sometimes "don't register" until the mouse moves. Local repro: every click
registered, 0 long tasks, API < 50 ms. Suspects: main-thread stalls from big payloads (values 1 MB, waivers 423 KB —
trim in releases 1/4/5) or a Chrome/Windows repaint glitch. Asked the owner: does the underline move, which browser/OS.
- Release 1 (advice fixes) shipped 2026-10-26: injury-discounted My Team lineup; waivers claim future starters,
  new Stash call, no priority on injured/DNP players (DESIGN.md "Waivers v2").
- Hosting: Mac mini service com.fantasy.tradedesk (127.0.0.1:5070) behind the raibot-dashboard Cloudflare tunnel at
  https://ff.raibot.us; data on local disk in ~/FantasyFootball-run/.data. Render retired (owner suspends it).
- Discord sign-in (multi-tenant) shipped 2026-10-26: admin = owner; league members are added by editing
  ~/FantasyFootball-run/.data/access.json (re-read per request, no restart). Owner will supply member Discord ids.

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
