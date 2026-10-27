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
MODEL v4 (DESIGN "Model v4"): (a) signals, (b) projection v4 / labels / power score v2 / no riser sales, (c) returns +
   stash watch + IR "hold" values SHIPPED 2026-10-26 (acceptance cases checked on a data copy — see Claude's memory).
   (d) SHIPPED 2026-10-26 (live 3a97173; also: my side's consolidation premium uses true values, not market): import v3 captures Yahoo projections (URL params and
   markup UNVERIFIED — check the `projections` diagnostics on the owner's next import), perception.ts, Trades v4
   (acceptance from the partner's Yahoo-style lineup view, spike penalty, lost bye cover, pitch for them, lineup /
   market labels), IR tradeValue fix. Adversarial test done (971a642); fix round 1
   done (DESIGN "Fix round 1"). Pending: owner drags "Trade Desk import v3" and re-imports; then verify the
   `projections` diagnostics and the stored projWeek on real data; authenticated smoke check of trades2 on the Mac. Bench upgrades on the real
   league are empty for want of tradeable bench pieces (gate probe, fix round 1), not a mis-set gate.
   Injured trade pieces (owner 2026-10-26, DESIGN "Injured trade pieces"): SHIPPED 2026-10-26 (live bb56ff8, with import v4) — injured players are
   pieces with ≥ 3 games left from their return (never out for the season), IR slots counted in roster cuts, every
   partner searched. Fix round 1 shipped: returners count at expected availability in every lineup /
   strength / partner view (unconfirmed ½ × healthy from wk +4, IR slot from his return; DESIGN "Fix round 1 — a
   returner is never free"). Fix round 2 shipped: an unconfirmed return is a scenario mix, ½ × lineup with
   him back at full rate from wk +4 + ½ × lineup without him (top 2 per roster exact, more at expected points), in team
   strength, roster score and the partner's view (DESIGN "Fix round 2 — the scenario mix"). Real import: the owner's
   example +2.8 → +2.0/wk; 18 suggestions, 11 where I give an unconfirmed piece (set changed); trades2 0.78 s.
   Import v5 (1208bba, live): Yahoo's data-tooltip attributes held raw <table>/<tr> markup that cut v4's table scans
   short (122/189 ROS). VERIFIED 2026-10-27 on the owner's v5 import: projWeek 8, rest-of-season 188/188 on all 12
   teams, weekly 148/188 (the 40 missing = week-8 byes NO/HOU/SF/NYG + single injured players; Yahoo shows "–").
   League tab Now / Playoffs toggle SHIPPED 2026-10-27 (live 2810f7a; owner: keep power as is + a pure playoff
   projection mode; DESIGN "League tab modes"). Unverified: 390 px layout (window resize did not apply). Next release: (e) playoff odds + Best moves.
SHIPPED 2026-10-27 (live 5db1266): one playoff engine (floor factor out of season/playoffs), small-sample prior
   (priorKSmall 8, capped at the prior's games), FLEX-mate cover, per-opportunity TD regression; tester 736a5a6, 2 fix
   rounds. Residuals: a grown red-zone role still regresses (per-opportunity baseline can't tell it from noise); some
   0-game QBs moved +1.7–2.3 (ECR-curve drift, not investigated); the 3-for-1 acceptance case is off the list only via
   the "lean decline" check (strength +1.2 > gate). BUILT 2026-10-27, not deployed (94a93e1, daff093 + fix round 1
   42bad43..50cc789; tester f1a1571; DESIGN "Fix: role-change prior + mode-aware listing"): role-change exemption for the
   small-sample prior (bar max(1.5×, +3) over a > 0 prior, rate and last 2 unflagged games) + Trade Finder lists/ranking
   follow the mode (rounded bar, marginal > +0.0, evaluate bar neutral unless Accept). Gate green (623 + 7 timing).
   Real copy: backup-turned-starter 11.2 → 11.85 (rest of the drop is the TD regression); trades2 145–177 ms; counts
   main/smaller/near Now 2/3/7, Balanced 2/3/7, Playoffs 2/1/6. Known residuals: a 0-usage week-1 game dilutes a riser's
   sample; the 3-for-1 case is blocked by the true-value bar, not the mode gate (pieces only Questionable on this
   snapshot); evaluate's "Now" bullet still says "pts this week" for the availability-weighted rate.
   NEXT BRIEF after it: "vacated role" — a usage jump that coincides
   with a same-team, same-position teammate's absence (e.g. lead RB out week-to-week) must revert in the weeks after that
   teammate's projected return (playoff weeks especially); and a single spike game must not lift our own rate much
   (recency weight capped for one outlier game). Also check acceptance on "buy the high" deals (partner sees a sell-high
   vs a breakout: today ×0.7 spike penalty only).
NEXT (backlog, highest value first):
- DONE in (d): (owner, Trade Finder vs Yahoo evaluator): "Fairness: Favors them (+16%)" reads as "bad for me" but is
  MARKET value (FantasyCalc) — split into "Lineup impact: good for you (+0.3/wk you, −0.2/wk them)" and "Market value:
  they get +16% (why they'd accept)"; pitch text must not say "you win on value" ambiguously; name the projection
  source in the lineup tooltip (ours blends ECR + usage; Yahoo's projections can differ a lot for the same player).
- Then (owner, top trade item): the partner judges a trade by YAHOO's evaluator ("Proj. pts remaining", weekly optimal
  lineups), not FantasyCalc. A real near miss showed 88% accept while Yahoo's evaluator showed the partner losing ~13 pts
  over the season. (1) Bookmarklet captures Yahoo rest-of-season projected points per rostered player (verify
  the page/stat view on real pages; defensive, diagnostics); (2) trade cards show "What Yahoo shows him: you +x, him −y";
  (3) acceptance uses the Yahoo-visible lineup delta for the partner (a Yahoo-visible loss → low acceptance, out of the
  main list); (4) pitch = reasons that matter to him (need fill, bye cover, rising role), never "market value says".
- Same trade release (owner feedback, checked against news): a near miss at +0.2 (noise) sold a WR with a fresh
  breakout and a TE who was the owner's bye/playoff cover for two low-ceiling WRs. (a) No trade in ANY list (incl. near
  misses) below a meaningful gain (~+1.0); (b) never suggest selling a player whose role is rising (breakout tier rising
  or snap/target trend up) and flag bye/playoff cover lost; (c) projections react faster to recent usage (raise the
  recent expected-points weight) — ECR-anchored values lag breakouts, and finding risers is the app's purpose.
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
