# Tasks

## Resume here
Owner (2026-10-26): Claude is the architect; work the queue autonomously, stop only for critical issues.
Release plan (in order; each = build → adversarial test → review → deploy to the Mac → smoke check):
1–4 SHIPPED 2026-10-26 (live 993c6d9): Waivers rows + FA/waivers + K/DEF; league-name prefix stripped; import captures
   standings + waiver order (needs the owner's re-import; Yahoo markup unverified — check the import diagnostics);
   League tab (standings, power chart, who is above me); Trade Finder + Targets collapsed rows, column help, Values
   payload 1 MB → 97 KB.
5. SHIPPED 2026-10-26 (live 28b0671): My Team one lineup+bench table, equal-height cards, bullet "why"; header
   "League updated <date> · by <name>"; Values/Connect tidy; bookmark renamed "Trade Desk import v2".
VERIFIED 2026-10-26 on the owner's v2 import (real Yahoo pages): standings 12/12 (read from the league home page;
   /standings has no table), waiver order 12/12, availability 172 W / 5 FA / 14 unknown (offense + K lists hit the
   page cap, so a few stay unknown), 25 K + 16 DEF free agents. Bookmark link now served no-store (Cloudflare had
   edge-cached the old ".js" bookmarklet for 4 h).
NEXT (backlog, highest value first):
- IN PROGRESS: power score v2 (0.7 projected starters + 0.3 actual pts/game; IR-slot players never start).
- Right after it (owner, Trade Finder vs Yahoo evaluator): "Fairness: Favors them (+16%)" reads as "bad for me" but is
  MARKET value (FantasyCalc) — split into "Lineup impact: good for you (+0.3/wk you, −0.2/wk them)" and "Market value:
  they get +16% (why they'd accept)"; pitch text must not say "you win on value" ambiguously; name the projection
  source in the lineup tooltip (ours blends ECR + usage; Yahoo's projections differ, e.g. Hockenson).
- K/DEF streaming uses ECR only, so every K/DEF free agent is "pass"; add the week's matchup (opponent, implied
  points / sacks / turnovers) so Waivers can name a streaming DEF/K for next week (owner wants a Week 8 DEF).
- Page-cap unknowns: raise the waivers list cap or stop at the last available player so fewer statuses stay unknown.
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
