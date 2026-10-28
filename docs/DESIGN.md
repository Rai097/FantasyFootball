# Fantasy Trade Desk — Design Spec

Local web app that connects to a Yahoo Fantasy Football league, models every
player's rest-of-season value under the league's own scoring, and recommends
trades and waiver moves. Owner's league: Yahoo league id 1405188, 12 teams,
head-to-head, redraft, regular season weeks 1–14, playoffs 15–17, rolling-list
waivers processed Tuesdays, trade deadline Nov 28 2026.

Season context at build time: 2026 NFL season, weeks 1–3 complete, week 4 next.

## Non-negotiables

* Runs locally with `npm install && npm run dev`. Data never leaves the machine
  except calls to Yahoo and to the public GitHub data files.
* Yahoo is NOT reachable from the cloud build environment. Yahoo code is written
  against the documented API and must be defensive (log the raw response shape on
  parse failure). Everything else is verified against the `demo` provider.
* All numbers shown to the user must be explainable in one sentence
  (a tooltip / "why" string), no black boxes.
* TypeScript strict, ESM, Node 22. Server: Express 4. Web: Vite + React 18.
  No UI framework; plain CSS with CSS variables, dark theme, works at phone width.
* Never commit `.env`, `.cache/`, `.data/`.

## Repository layout

```
package.json                 root scripts: dev, dev:server, dev:web, build, start, typecheck, test
server/index.ts              express app; /api routes; serves web/dist in production
server/config.ts             env loading (dotenv): YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_REDIRECT_URI, PORT
server/data/                 free data loaders (DONE: csv, cache, sources, names, nfl, players)
server/model/types.ts        shared types (DONE — extend, don't fork; web imports it)
server/model/scoring.ts      score StatLine under Scoring
server/model/projectionV4.ts ValuedPlayer computation for a league (THE valuation; projection.ts keeps shared helpers)
server/model/lineup.ts       optimal lineup + slot eligibility
server/model/analysis.ts     TeamAnalysis for every team, power ranks, needs/surplus
server/model/tradesV3.ts     trade finder + evaluator (tradeKit.ts helpers, benchUpgrades.ts)
server/model/waivers.ts      free-agent ranking + waiver-priority advice
server/providers/demo.ts     12-team demo league built from real ECR (seeded snake draft)
server/providers/yahoo.ts    OAuth2 + league import → League
server/providers/store.ts    token + league cache persistence in .data/
server/api.ts                route handlers, thin; all logic lives in model/
server/**/*.test.ts          node:test unit tests (run with `npm test`)
web/                         Vite app (index.html, vite.config.ts, src/)
web/src/api.ts               typed fetch wrappers for the contract below
web/src/App.tsx              tabs: Connect · My Team · Trade Finder · Waivers · Values
docs/DESIGN.md               this file
docs/YAHOO_SETUP.md          end-user walkthrough for creating the Yahoo app + first login
README.md                    quick start
```

## Data sources (all keyless, already wired in server/data)

| Source | What | Freshness |
|---|---|---|
| nflverse `schedules/games.csv` | season/week detection, byes | daily |
| nflverse `rosters/roster_2026.csv` | active players, ids, headshots | daily |
| nflverse `injuries/injuries_2026.csv` | official injury report | daily |
| nflverse `snap_counts/snap_counts_2026.csv` | offensive snap share | weekly |
| ffopportunity `ep_weekly_2026.csv` / `_2025` | weekly actual + expected stats per player (PPR points + raw components) | weekly |
| DynastyProcess `db_fpecr_latest.csv` | FantasyPros ECR: `redraft-overall` (ROS, PPR) + `redraft-{qb,rb,wr,te,k,dst}` | ~daily |
| DynastyProcess `fp_latest_weekly.csv` | this-week FantasyPros projected pts (`r2p_pts`), opponent | ~daily |
| DynastyProcess `db_playerids.csv` | yahoo_id / sleeper_id / espn_id / gsis_id / fantasypros_id crosswalk | weekly |
| DynastyProcess `values-players.csv` | dynasty values (only used if league is dynasty) | weekly |

`server/data/players.ts` merges all of these into `PlayerDb` keyed by gsis id
(`DEF:KC` for defenses). `db.find({yahoo, name, pos, team})` resolves a Yahoo
roster entry; prefer yahoo id, fall back to normalised name + position + team.

## Value model (server/model/projection.ts) — superseded: projection v4 is the one valuation (see "Release (b) implemented")

For a league `L` with scoring `S` and every player `p`:

1. `ppg26 = mean over played weeks of score(S, actual)`; `ppgExp26` same with `expected`;
   `ppg25 = score(S, prior.line)/prior.games` (only if prior.games ≥ 4).
2. `ecrPts`: map ECR positional rank → points. For each position build the
   descending sorted list of `blend26 = 0.6*ppgExp26 + 0.4*ppg26` over players
   with ≥2 games, smooth it (moving average window 3), and read off the value at
   index `round(ecrPos)-1` (linear interpolate fractional ranks). If the player
   has only `ecrOverall`, derive positional rank by ordering within position.
3. `ppg = weighted blend` with weights: ecr 0.50, current-season 0.35
   (itself 0.6 expected / 0.4 actual, and scaled by `min(games,3)/3`), prior 0.15.
   Missing components drop out and the rest renormalise. A player with no ECR,
   no games and no prior → ppg 0.
4. K and DEF: no stat model. `ppg = max(0, base − slope·(ecrPos−1))`, K base 9 slope 0.10,
   DEF base 8.5 slope 0.15. Excluded from trade search; included in lineups.
5. `remainingGames`: weeks `[currentWeek, finalWeek]` minus bye if inside that
   window, minus an injury haircut: status Out → −1 (and −3 if detail matches
   /ACL|Achilles|IR|season/i), Doubtful → −0.5. IR designation from Yahoo (status
   "IR" / "O" with IR slot) → treat as Out.
6. Replacement level per position: rank the league's player pool by ppg;
   replacement rank = `numTeams × dedicatedStarters(pos) + flexShare(pos) × numTeams × flexSlots + round(numTeams × 0.5)`
   where flexShare defaults RB .45 / WR .45 / TE .10 for FLEX, QB 0.7 of SFLEX
   slots, WR .6 / TE .4 for RFLEX. `replPpg(pos)` = ppg at that rank.
7. `vorp = max(0, ppg − replPpg(pos))`; `value = 100 × (vorp × remainingGames / maxAcrossLeague)^1.35` (star premium; was 1.15)
   rounded to 1 decimal. Convex so studs are worth more than two mid players.
8. `posRank` = rank by ppg within position.

`why` strings: e.g. "Proj 14.8 ppg = ECR RB7 (15.6) · 2026 exp 13.9 / act 15.2 · 2025 12.1. RB replacement 8.9 → +5.9/g × 13 games."

## Lineup (server/model/lineup.ts)

Slot eligibility: QB/RB/WR/TE/K/DEF exact; FLEX → RB,WR,TE; WRRB → RB,WR;
RFLEX → WR,TE; SFLEX → QB,RB,WR,TE. Fill order: exact slots by descending ppg,
then WRRB, RFLEX, FLEX, SFLEX (narrow to wide). Players with `remainingGames==0`
or ppg 0 may fill slots only if nothing else is eligible. `starterPpg` = sum of
starters' ppg. Return `LineupSlot[]` in slot order plus `bench` sorted by value.

## Team analysis (server/model/analysis.ts)

For each team: lineup, starterPpg, benchValue (sum value of bench), totalValue.
`groups`: QB, RB, WR, TE, FLEX (all flex-type slots), K, DEF — starter ppg per
group, league rank, league average. `needs`: groups ranked ≥ 9th of 12 (bottom
third) or whose best starter is below replacement; `surplus`: positions where a
bench player's ppg ≥ the league-average starter ppg for that slot. `powerRank`
orders teams by the power score — superseded: see "Power score v2 (2026-10-26)" at the end.
Also return `byeExposure`: for each remaining week, count of starters on bye,
and `injuryFlags`.

## Trade finder (server/model/trades.ts) — v1, deleted in Model v4 release (b)

Inputs: league, analysis, myTeamId, options `{maxGive: 2, maxGet: 2, partnerId?, wantPos?}`.
Candidate pools: my players and partner players excluding K/DEF, excluding
`remainingGames==0`, top 14 by value each side. Enumerate packages 1–2 each side.
For each: rebuild both rosters, recompute optimal lineup, `lineupDelta` for both.
When a side receives more players than it gives, it drops its lowest-value bench
player (no lineup effect). Keep a trade if:

* `me.lineupDelta ≥ 0.75` ppg, and
* partner is plausibly better off: `them.lineupDelta ≥ −0.25` OR `fairness ≥ 1.0`,
  where `fairness = valueReceivedByThem / valueGivenByThem`.

`acceptance = clamp01(0.5 + 0.35·tanh(2·(fairness−1)) + 0.15·tanh(them.lineupDelta/2))`.
`score = me.lineupDelta × acceptance`. Dedupe identical player sets, return top 40
sorted by score. Each trade carries `lineupChanges` for both sides
("RB2: Player A 9.1 → Player B 13.4"), `summary` (one sentence), and `tags`
(e.g. "2-for-1 consolidation", "fills RB need", "sells WR surplus", "buy-low:
exp > act by 3+", "injury-discount").
`evaluateTrade(league, myTeamId, partnerId, giveIds, getIds)` returns one `Trade`
with a verdict string ("Accept", "Fair, lean accept", "Decline") based on my
lineupDelta and fairness from my side.

## Waivers (server/model/waivers.ts)

Input: league, analysis, myTeamId, free agents (ValuedPlayer[] from provider;
demo = every ranked player not on a roster). For each FA compute
`gain = lineupDelta if added and my lowest-value droppable player (bench, not
K/DEF starter) is dropped`, plus `benchGain = value − droppedValue`. Rank by
`max(gain·3, benchGain/10)`; show `trend` (avg expected pts last 2 weeks vs
season), `snap trend`, injury. Waiver advice: given my waiver priority `w` (1 =
first) of N, rolling list: recommend **claim** if
`gain ≥ 2` ppg or (value ≥ 1.5× my dropped and player is top-3 FA at a need
position); recommend **wait for FA** if the player's value is below the 5th-best
FA at that position (someone similar will clear); otherwise **optional**. Explain
the cost: "Using your #3 priority drops you to #12."

## Providers

Common output is `League` (types.ts). `myTeamId` set when known.

### demo (server/providers/demo.ts)
12 teams named after fake managers. Seeded PRNG (seed param, default 42).
Snake draft over the ECR redraft-overall order with slight randomness (each
pick chooses from the next 4 available with weights 0.55/0.25/0.12/0.08).
Slots: QB,RB,RB,WR,WR,TE,FLEX,K,DEF,BN×6,IR. Scoring: half-PPR (rec 0.5),
passYd .04, passTd 4, passInt −1, rushYd .1, rushTd 6, recYd .1, recTd 6,
twoPt 2, fumLost −2. regularSeasonEnd 14, finalWeek 17. Records random.
Team 1 is "my" team. Free agents = all ranked players not drafted.

### yahoo (server/providers/yahoo.ts)
OAuth2 with PKCE not required; use authorization-code flow.
* Auth URL: `https://api.login.yahoo.com/oauth2/request_auth?client_id=…&redirect_uri=oob&response_type=code&language=en-us`
  (if `YAHOO_REDIRECT_URI` is set, use it instead of `oob` and handle `/auth/yahoo/callback?code=`).
* Token: POST `https://api.login.yahoo.com/oauth2/get_token`, body
  `grant_type=authorization_code&code=…&redirect_uri=oob`, header
  `Authorization: Basic base64(client_id:client_secret)`, form-encoded.
  Refresh with `grant_type=refresh_token`. Tokens persisted to `.data/yahoo-tokens.json`.
  Refresh proactively when `expires_at − now < 60s`; on 401 refresh once and retry.
* API base `https://fantasysports.yahooapis.com/fantasy/v2`, always append `?format=json`.
  Yahoo JSON is arrays of single-key objects with numeric keys; write a
  `flatten()` helper and unit-test it against fixture JSON (author fixtures by
  hand from the documented shapes; comment that they are hand-written).
* Calls:
  * `/users;use_login=1/games;game_keys=nfl/leagues` → league list (league_key, name, season, num_teams, current_week)
  * `/users;use_login=1/games;game_keys=nfl/teams` → my team keys
  * `/league/{key}/settings` → roster_positions (position, count), stat_modifiers (stat_id→value), playoff_start_week, end_week, num_teams, waiver rule fields (`waiver_type`, `uses_playoff_reseeding`, `trade_end_date`)
  * `/league/{key}/standings` → teams with team_key, name, managers[0].nickname, waiver_priority, team_standings.outcome_totals (wins/losses/ties), points_for
  * `/team/{team_key}/roster/players` → players: player_id, name.full, editorial_team_abbr, display_position, eligible_positions, status (Q/D/O/IR/SUSP/NA), injury_note, bye_weeks.week, selected_position.position
  * `/league/{key}/players;status=FA;position={QB|RB|WR|TE|K|DEF};sort=AR;count=25;start=0` (repeat per position, and `status=W` for waivers) → free agents with `percent_owned` when available (`;out=percent_owned`)
* Stat id map (NFL): 4 passYd, 5 passTd, 6 passInt, 9 rushYd, 10 rushTd, 11 rec, 12 recYd, 13 recTd, 16 twoPt, 18 fumLost. Ignore others (bonuses etc.), log them once.
* Slot map: QB,RB,WR,TE,K → same; DEF → DEF; `W/R/T` → FLEX; `W/R` → WRRB; `W/T` → RFLEX; `Q/W/R/T` → SFLEX; BN → BN; IR/IL → IR. Unknown → skip with a log line.
* Player resolution: `db.find({yahoo: player_id, name, pos: display_position, team})`. Unmatched go into `team.unmatched`.
* Rate limits: ≤ 1 request in flight; cache the imported League in `.data/league-{key}.json` with fetchedAt; `/api/league/yahoo/:key?refresh=1` forces refetch.
* Errors from Yahoo must surface as `{error, status, yahooBody}` from the API with a helpful hint (401 → reconnect, 999 → rate limited).

## HTTP API contract (server/api.ts) — the web app depends on exactly this

All JSON. Errors: `{ error: string, hint?: string }` with 4xx/5xx.

```
GET  /api/state                       → { season, currentWeek, lastRegularWeek, dbBuiltAt, playerCount, yahooConfigured: boolean, yahooConnected: boolean }
GET  /api/players/search?q=           → ValuedPlayerLite[] (id, name, pos, team, ecrOverall) — for pickers (uses demo scoring if no league)
GET  /auth/yahoo/start                → { url }            (browser opens Yahoo consent; oob shows a code)
POST /auth/yahoo/code  {code}         → { ok: true }       (exchange oob code)
GET  /auth/yahoo/callback?code=       → redirects to /?connected=1 (redirect-uri mode)
POST /auth/yahoo/disconnect           → { ok: true }
GET  /api/yahoo/leagues               → [{ key, name, season, numTeams, currentWeek, myTeamKey? }]
GET  /api/league/:provider/:id        → League   (provider = demo | yahoo | import; demo id = seed; ?refresh=1)
GET  /api/league/:provider/:id/analysis?team=ID
       → { league, players: Record<id, ValuedPlayer>, teams: TeamAnalysis[], replacement: Record<pos, number>, myTeamId }
GET  /api/league/:provider/:id/trades2?team=ID&mode=now|balanced|playoffs&partner=&wantPos=&maxGive=2&maxGet=2
       → { trades: Trade[] (clear wins), smallerEdges: Trade[], nearMisses: (Trade & { reason })[], mode, summary: string }   (UI uses this)
GET  /api/league/:provider/:id/bench-upgrades?team=ID&mode= → Trade[] (≤ 15 one-for-one bench swaps, v3 engine: benchUpgrades.ts)
POST /api/league/:provider/:id/trade/evaluate  { team, partner, give: string[], get: string[], mode? } → Trade & { verdict: string }  (v3)
GET  /api/league/:provider/:id/waivers?team=ID → { freeAgents: WaiverRow[], myPriority?: number, numTeams, advice: string, rules, faStatusKnown, notes?: string[] }  (see "Waivers v3")
       WaiverTarget = ValuedPlayer & { gain: number, benchGain: number, drop: ValuedPlayer|null, trend: number, recommendation: "claim"|"wait"|"optional"|"pass", why: string, onWaivers: boolean, percentOwned?: number }
GET  /api/league/:provider/:id/values?team=ID  → ValuedPlayer[] sorted by value, rostered flag { ...ValuedPlayer, ownerTeamId?: string }
```

Import provider (docs/IMPORT.md; leagues copied from Yahoo's web pages, no API):

```
POST   /api/import                    body = bookmarklet JSON { id?, name, numTeams, slots, scoring, regularSeasonEnd, finalWeek,
                                        tradeDeadlineWeek?, myTeamId?, waiverPriority?, settingsSource?, teams: [{ id, name, owner?,
                                        players: [{ yahooId?, name, pos, team?, status?, slot? }] }], freeAgents?, importedAt }
                                      or paste mode { text, teamName?, id? } → { id, name, teams, myTeamId, settingsSource, skippedLines? }
                                      limits: 1 MB, 20 teams, 40 players/team
GET    /api/import                    → [{ id, name, importedAt, numTeams, teams, settingsSource }]
GET    /api/import/:id                → stored import (raw rosters + settings)
PUT    /api/import/:id/settings       { scoring?: Partial<Scoring>, slots?: "QB, WR x2, W/R/T, BN x6", waiverPriority?, myTeamId?, name?, tradeDeadlineWeek? }
DELETE /api/import/:id                → { ok: true }
GET    /api/import/bookmarklet.js     → minified bookmarklet (?format=url → { url: "javascript:…" })
GET    /api/docs/import               → docs/IMPORT.md as text
```

Stored in `.data/import-<id>.json` (server/providers/import.ts). Players are
resolved with `db.find` on every load; unmatched names go to `Team.unmatched`;
Yahoo injury tags are applied to player copies (`playerOverrides`). Free agents
= the imported list, else every ranked unrostered player. `League.import`
carries `settingsSource` ("page" | "partial" | "default" | "user"); the UI warns on "default".
The bookmarklet (web/src/import/bookmarklet.ts) shares its pure HTML parsing
(web/src/import/yahooHtml.ts) with node tests; the server bundles it with esbuild.

`ValuedPlayer` (types.ts) gains `why: string` and `trend: number`.
Web reads `myTeamId` from the analysis response and stores the active
provider/id/team in localStorage.

## Web app (web/src)

Tabs: **Connect** (Yahoo connect + league picker + demo button), **My Team**,
**Trade Finder**, **Waivers**, **Values**. Header shows league name, week,
data freshness. Components: `PlayerChip` (name, pos badge, team, injury dot,
value), `LineupTable`, `PositionStrength` (horizontal bars: my group ppg vs
league avg, rank badge), `TradeCard` (two columns give/get, deltas for both,
acceptance %, tags, expandable "why"), `TradeBuilder` (two pickers, evaluate),
`WaiverTable`, `ValueTable` (sortable, position filter, search).
Colours: CSS variables; positive delta green, negative red, neutral grey;
position badges QB red, RB green, WR blue, TE orange, K/DEF grey. No chart lib;
bars are divs. Keep every number to 1 decimal.

## Testing

* `npm test`: unit tests for scoring (known lines), lineup (flex handling,
  superflex), projection (blend weights, replacement), trades (a 2-for-1 that
  helps both is found; a lopsided trade is rejected; K/DEF never traded),
  waivers (claim vs wait logic), yahoo `flatten()` + settings/roster parsing
  from fixtures.
* Integration: start server, hit every endpoint on `demo/42`, assert shapes and
  sanity (top value ≈ 100, no NaN, every team has a full lineup, ≥ 10 trades).
* UI: Playwright (Chromium is at /opt/pw-browsers/chromium; do not install
  browsers) screenshots of each tab at 1280px and 390px into `docs/screenshots/`.

## Definition of done

`npm run typecheck`, `npm test`, `npm run build` all green; `npm run dev` serves
a working demo league; README + docs/YAHOO_SETUP.md explain the Yahoo flow; the
architect's final review passes.

## Amendments after advisor review (these override the sections above)

**Value model**
* Replacement bench term is position-specific (12-team basis, scale by numTeams/12): RB +6, WR +6, QB +2, TE +3, K/DEF +0. In a 1-QB league QB replacement ≈ QB14.
* ECR rank→points curve = 0.5·curve(blend26, games ≥ 2) + 0.5·curve(ppg25, prior.games ≥ 8), then smoothed (window 3).
* Injury: Out → remainingGames −2; Doubtful → −0.7; ACL/Achilles/season/IR or Yahoo IR status → remainingGames 0. Long-term Out players get ECR weight halved so ppg is a healthy rate and games carry the penalty.
* Playoff weeks (15–17) weighted 1.25 in remaining games.

**Trade finder**
* fairness = (valueReceivedByThem + 5) / (valueGivenByThem + 5).
* Keep a trade only if (them.lineupDelta ≥ −0.25 AND fairness ≥ 0.85) OR (fairness ≥ 1.10 AND them.lineupDelta ≥ −1.0); reject if my totalValue drops > 20%.
* After `tradeDeadlineWeek` the finder returns [] and the UI shows a banner.

**Waivers**
* Rolling list: claimThreshold = 1.0 + 1.5·(N−w)/(N−1) ppg of lineup gain (priority #1 needs 2.5, last needs 1.0). FAAB leagues (`usesFaab`) get bid guidance instead of priority cost.
* Drop candidate tie-break: value, then ppg, then ECR; never IR-slot players or the only K/DEF.

**Power rank**: superseded by "Power score v2 (2026-10-26)".

**LeagueSettings** gains optional `usesFaab`, `faabBudget`, `tradeDeadlineWeek`.

**Yahoo API shapes (corrected)**
* Refresh body must include `redirect_uri`.
* `team`/`player`/`league` are arrays whose element 0 is itself an array of single-key meta objects; `selected_position` and `percent_owned` are arrays; `managers[].manager.is_current_login == "1"` identifies my team.
* `roster_positions: [{roster_position:{position,position_type,count,is_starting_position}}]`, `stat_modifiers: {stats:[{stat:{stat_id,value}}]}`; `current_week/start_week/end_week/num_teams` in `league[0]`; playoff/waiver/keeper/trade_end_date fields in `league[1].settings[0]`.
* Standings: `league[1].standings[0].teams["i"].team = [[meta], {team_points}, {team_standings}]`; `waiver_priority`, `faab_balance` in meta.
* Errors may be XML or HTML (999); parse text defensively.
* Yahoo requires https redirect URIs, so the default is the `oob` paste-a-code flow ("Installed Application").
* Free agents: `status=A;out=ownership,percent_owned;sort=OR`, `ownership.ownership_type ∈ {freeagents, waivers}`.
* One call `/users;use_login=1/games;game_keys=nfl/leagues/teams` lists leagues with my team; `/game/nfl` gives the game id to build `{gid}.l.{leagueId}`.

## Trade finder v2 (server/model/rosterScore.ts, tradesV2.ts) — deleted in Model v4 release (b) (roster score and bench upgrades live on, on the v3 engine)

Why: a strong starting lineup made v1 return nothing; managers also value depth, byes, injuries and playoffs.

**Roster score** for any roster: `now` = optimal-lineup effPpg sum (= starterPpg); `season` = mean over every
remaining week of that week's optimal lineup (bye → 0; games removed by the injury model come off the earliest
weeks); `playoffs` = same mean over weeks regularSeasonEnd+1..finalWeek; `depth` = top-K bench players'
max(0, effPpg − replacement[pos]), K = max(3, ceil(starting skill slots / 2)).
`score = wNow·now + wSeason·season + wPlayoffs·playoffs + wDepth·depth` with `MODE_WEIGHTS`:
now {1, 0, 0, 0.15}, balanced {0.4, 0.4, 0.2, 0.25}, playoffs {0.15, 0.25, 0.6, 0.25}.

**Search**: pools = top 14 by value + all my bench + partner bench with value ≥ 1; packages 1–2 per side, plus
3-for-1 / 1-for-3 outside "now" mode; pairs with raw fairness ≥ 0.7 that keep my value ≥ 80%, closest-to-fair
first, capped at 6000 per partner. My delta uses the mode weights; the partner's uses balanced.

**Rules** (V2 config in tradesV2.ts):
* Keep for me: team Δ ≥ 0.5 or now Δ ≥ 0.75; +0.5 on both when I receive more players than I give (my
  fairness nets the player I drop). Giving my #1/#2 most valuable player (value ≥ 20) needs Δ ≥ 2.0 (now Δ in "now"); tag "moving a star".
* Throw-ins (value < 3) in a multi-player package must add ≥ 1.0 to the receiver's score by themselves, else the
  package is dropped (the version without them is searched anyway); tag "throw-in: fills their QB slot".
  Any low-value player adds at most +1.0 to the partner's Δ.
* Players I receive with Questionable / Doubtful / Out count at 0.85 / 0.70 / 0.55 of their ppg in my deltas
  (not in theirs); tag "injury risk".
* Partner: (Δ ≥ −0.25 and fairness ≥ 0.85) or (fairness ≥ 1.10 and Δ ≥ −1.0). Asking for their #1/#2 player (value ≥ 20)
  also needs fairness ≥ 1.05 and Δ ≥ 0, and acceptance × 0.8; tag "asks for their star".
* Main list ("clear wins"): acceptance ≥ 0.45 and my Δ ≥ 1.0, sorted by Δ × acceptance. `smallerEdges`: the rest
  that pass. `nearMisses` (≤ 10): "They'd likely refuse" (partner filter, fairness ≥ 0.7, their Δ ≥ −3),
  "Partner unlikely to accept (<pct>)" (acceptance < 0.45), "Marginal" (0 < Δ < bar with value in my favour, or a
  star moved for too little). `summary` says why the list is short (top-3 groups, where gains come from, byes).
* Bench upgrades: 1-for-1, my bench player (or weakest starter, never my top-2) for a partner bench player, fairness
  to them ≥ 0.9, my season or playoff score up; ranked by my Δ; why cites ppg, trend, expected > actual, playoff byes.
* Value exponent raised 1.15 → 1.35 (star premium); 1-QB leagues: QBs ranked below numTeams get a
  "Backup QB … ~0 trade value" hint in their why.

## Trade finder v3 (server/data/fantasycalc.ts, model/market.ts, tradesV3.ts) — overrides v2 for trades2 / evaluate

Why: v2 suggested trades no manager would send or accept (backup QBs as chips, a stud for two mid pieces,
worthless-for-worthless bench swaps). v3 prices every deal the way the other manager does (market values)
and keeps only deals that also raise my roster by our model.

**Market values** (`getMarketValues(opts)` / `getMarketData(opts)`): FantasyCalc
`/values/current?isDynasty=&numQbs=&numTeams=&ppr=` (numQbs 2 with a superflex or second QB slot; ppr = league
rec rounded to 0 / 0.5 / 1), cached 12 h on disk. Rows match our players by Sleeper id, then normalised
name + position; value scaled so #1 = 100. `attachMarket` sets on each skill ValuedPlayer: `market`,
`marketRank`, `marketPosRank`, `trueMarket` (our `value` mapped onto the market scale by rank — our curve is
far steeper, so raw value − market would call every mid player a "sell-high"), `edge = trueMarket − market`.
Unlisted players get market 0, except ones we rank inside the list (`marketEstimated`: market = trueMarket).
On any fetch failure `valueSource = "model"`: market fields are unset, perceived = our value, the UI warns.

**Eligible pieces**: no K/DEF; not (market < 3 and value < 3); injured players per "Injured trade pieces" below. QBs only
when a team has two QBs ranked ≤ 14 (market position rank) and the other team's best QB ranks > 18 — then the
QB it does not start (lower projection) may move, in either direction.

**Package value** = best + 0.85·second + 0.70·third, market ("perceived") and trueMarket ("true"). The side
receiving more players subtracts a drop cost per cut player = max(3, his value). Consolidation premium: in any
deal that is not 1-for-1, the side receiving the single best player (market) must give ≥ 110% of the other
package. Fairness = partner's perceived received (net) / given; bands fair ±5%, slightly 5–12%, favors > 12%.

**Keep** when: my roster-score Δ (mode weights) ≥ 0.5 and my true change ≥ 3% of the deal's true total; the
partner's perceived change ≥ −3% of the perceived total, their rest-of-season weekly lineup Δ (our projections)
> 0 (or ≥ −0.3 at fairness ≥ 1.05), and not (they give the best player while losing > 5%).
**Acceptance** = logistic(k·edge%), k = ln(0.65/0.35)/5 (+5% → 0.65), × 0.85 per extra player they must
absorb (give − get), × 0.8 when asking for their market #1, × 1.10 when a player I send beats the starter in
their weakest group; capped at 0.95.
**Partners**: complementarity = Σ over RB/WR/TE of their deficit (group ppg below league average; FLEX counts
half) × my bench surplus (vorp, capped) plus the reverse, plus the QB case. Every partner is searched (pools:
top 14 eligible by max(market, true); 1–2 per side; 3-for-1 only when I give quantity to a team at ≤ 1/3 wins).
**Ranking**: score = min(my Δ, their lineup Δ + 2) × P ÷ (1 + 2·max(0, fairness − 1.12)) (the same gain at a
fairer price ranks first); ties by edge. Main list (≤ 10): my Δ ≥ 1.0, P ≥ 0.40, the deal's best player has
market ≥ 8; ≤ 2 per partner, ≤ 2 per player I give, one per (partner, my top piece, their top piece).
`smallerEdges`: the other kept deals. `nearMisses` (≤ 10, with `reason`): "They'd likely refuse: …",
"Partner unlikely to accept (…)", "Marginal: …".
**Cards**: position rank, market and true value per player, my / their weekly lineup Δ, roster score, band and
%, acceptance, a pasteable `pitch`, buy-low / sell-high tags (|edge| ≥ 8), bye-overlap and playoff-week notes.
**Bench upgrades** additionally need both players worth ≥ 3 (market or value) and my season Δ ≥ 0.8.

```
GET  /api/league/:provider/:id/trades2 → TradeFinderResult & { valueSource: "fantasycalc"|"model",
       partners: [{ teamId, complementarity, pitch }] }; Trade gains lineupLabel, marketLabel, yahooView, pitch, packages (release (d): band / bandLabel / fairnessPct removed)
POST /api/league/:provider/:id/trade/evaluate → v3 Trade & { verdict } (labels, acceptance; flags pieces outside the rules)
GET  /api/league/:provider/:id/analysis → … + valueSource;  values rows carry market, marketRank, trueMarket, edge
```

## Breakout Targets (server/model/breakouts.ts, web/src/tabs/TargetsTab.tsx)

Why: find RB / WR / TE whose ROLE is rising before their fantasy points have (cheap now, path to a bigger role).

**Data**: nflverse `depth_charts/depth_charts_<season>.csv` (~55 MB, daily ESPN snapshots since 2025: `dt, team,
gsis_id, pos_abb, pos_slot, pos_rank`; ≤ 2024: `week, depth_team, position`) is streamed once by
`server/data/depthCharts.ts`; only the newest snapshot's QB/RB/WR/TE rows are kept and cached as
`.cache/depth-<season>.json` (12 h). `getDepthChart(season)` → `byPlayer` (order within team + position; WR orders
by slot rank then formation slot) and `byTeamPos` lists; null when unavailable (snap order is used instead).
ffopportunity weekly rows add `WeekLine.opp = { targets: rec_attempt, carries: rush_attempt, airYards: rec_air_yards }`.
Market values: `getMarketData()` from server/data/fantasycalc.ts (league format); none → our value only.

**Pool**: RB/WR/TE with ≥ 1 game, not on my roster, not long-term injured (IR / ACL … / return designation /
remainingGames 0), not established (latest snaps ≥ 75% and actual ppg ≥ 14, or ECR RB/WR ≤ 12, TE ≤ 6), and
relevant (latest snaps ≥ 35%, or ≥ 4.5 expected pts/g over the last 2 weeks, or next man up with a path open).

**Metrics** (league scoring): roleNow = latest snap share; roleTrend = last − mean(earlier) snaps; oppTrend = last −
mean(earlier) expected points; oppLevel = mean expected points last 2 weeks; gap = expected − actual ppg.
**Order / ahead**: depth chart, unless the player out-snaps someone listed ahead of him by ≥ 15 points; then
teammates are ordered by latest snap share and the thesis says "depth chart says TE4". A player ahead who fell
under 15% snaps after ≥ 50% before is tagged "left early / injury?" (ordered by his usual share, situation 0.5).
**Situation**: the player(s) directly ahead (next one for RB/TE, next two for WR) with injury status (Q/D/O/IR) or
a snap drop ≥ 15 points, or a promotion to #1 from < 50% snaps in every earlier week → 1; handcuff (RB2 behind an
RB with ≥ 55% snaps or ECR ≤ 24), committee (two RBs ≥ 40%), WR3 rising, TE1 in waiting, left early → 0.5.
**Score** = 100 × (0.25·n(roleTrend) + 0.25·n(oppTrend) + 0.20·n(oppLevel) + 0.15·n(gap) + 0.15·situation),
n() = 2nd–98th percentile min-max **within position**. Price is not scored: market (FantasyCalc) and our value are
shown; cheap = market < 15 (our value < 12 without a market) drives the "Cheap only" toggle (`?cheap=1`).
**Tiers**: "rising" (oppLevel ≥ 7, TE ≥ 4.5, or roleNow ≥ 50%) listed before "stash"; `limit` applies per tier.
Upside (0.7·clamp((production rank − ECR rank)/24) + 0.3·age ≤ 26) breaks ties.
**Ask**: rostered → the lowest-value bench player of mine with value ≥ 0.9 × target value, else the cheapest bench
pair; FA → "Free agent — claim/add" + the waivers module's call.

```
GET /api/league/:provider/:id/breakouts?team=&pos=RB|WR|TE|all&limit=30&cheap=0|1
  → { targets: BreakoutTarget[], notes: string[] }   (types.ts BreakoutTarget: player, where, tier, score, components, chartSays?,
      weeks, snaps, expPpg, actPpg, touches?, depthLabel?, ahead[], tags[], thesis, ask)
```

## Waivers v2: future starters and injury-aware lineups (2026-10-26) — overrides "Waivers" and "Lineup" where they differ

Why: the owner uses waivers to find players who can *become* starters, not only this week's upgrades. Free-agent
`value` stays 0 below replacement (by design); the waiver calls stop relying on it alone.

* **Breakout signal per free agent**: `api.ts faBreakoutSignals()` runs `findBreakouts` (no market) and passes
  `{ tier, score, situation, oppLevel, thesis }` for unrostered players to `rankWaivers(…, { breakouts })`. The breakouts
  endpoint passes the same map, so its FA "ask" shows the new call.
* **Calls** (order claim > optional > stash > wait > pass; K/DEF rules unchanged):
  * claim: lineup gain ≥ threshold, **or future starter** = breakout score ≥ 55, situation ≥ 0.5 and expected pts/g
    over the last 2 weeks ≥ RB 10 / WR 9 / TE 8 (`FUTURE_STARTER`), or the existing top-3-at-a-need rule.
  * An injured (Q/D/O, or practice "DNP") would-be claim **on waivers** in a rolling-list league becomes **stash** ("confirm his status
    before spending priority, or add him after waivers clear"). As a free agent it stays a claim (no priority cost).
  * stash: not an upgrade today, breakout score ≥ 50 and ≥ 4.5 expected pts/g (`STASH`); otherwise pass.
  * Rows tie-break on breakout score after rankScore. The breakout thesis is appended to `why`.
* **Lineup** (superseded in Model v4 (b) fix round 1: the whole-season haircut `injuryRisk.ts` is deleted, v4's
  next-game availability is the only injury discount): `optimalLineup(slots, roster, { injuryRisk: true })` ranks and
  totals starters on v4 lineup pts/game and only marks a starter whose game THIS week v4 discounts
  (`ValuedPlayer.availThisWeek`: Q 0.85 / D 0.7 / Out 0) with `LineupSlot.riskFactor`; the UI shows "×0.85 · check
  status" or "out this week". IR-slotted players (`Team.irPlayerIds`) never start (`LineupOptions.irIds`).

## Waivers v3: rows + free agents (2026-10-26) — overrides "Waivers", "Waivers v2" and the waivers API line where they differ

Owner: "it shows only waivers, not free agents worth picking up; too much text under Why". Rule for every table: a
1–2 sentence summary under 255 characters per row, details on tap as one-idea lines (CLAUDE.md Rules).

* **Row text**: `WaiverTarget.why` is gone. `summary` = lead fact + action, ≤ 255 chars, 1–2 sentences, built per
  call branch (e.g. "Starts at WR1 over X (+2.8 ppg). Free agent: add now, no priority cost." / "Rising role: 11.4
  expected pts/g, breakout score 68. Claim him before he starts."). `details: DetailItem[]` = `{ label, value, tone? }`
  items ≤ 90 chars each: rule behind the call, lineup slot, gain, drop, value change, expected-points and snap trends,
  injury, breakout score / path / expected pts, the breakout thesis split into one item per fact (`thesisItems`), cost.
  Tests (`summaryProblems`, `detailProblems` in testkit) enforce both on unit fixtures and the demo league.
* **Response**: `{ freeAgents: WaiverRow[], myPriority?, numTeams, advice, rules: DetailItem[], faStatusKnown }`.
  `WaiverRow` is a slim row (only what the tab renders; `drop` is `{ id, name, pos, value }`, no weekly lines) to keep
  the demo payload well under 150 KB (was ~420 KB). `advice` is one line ≤ 255 chars (priority, counts and up to two
  names per group); `rules` feeds the collapsed "How calls work".
* **Free agent vs waivers**: `availability: "fa" | "waivers" | "unknown"` per row; `onWaivers` stays (unknown counts as
  on waivers, the safe assumption). The import bookmarklet reads the Yahoo player list's Owner cell ("FA" / "W (Wed)")
  per row, plus `players?status=W` (offense, K, DEF) as fallback and cross-check (ignored when Yahoo seems to ignore
  the filter; a truncated list never marks non-members as free agents), and now also K and DEF free agents (25 each).
  `StoredImport.freeAgents[].onWaivers` is optional; old imports → `faStatusKnown: false` and the UI says "re-import".
  The markup is reconstructed (fixture `yahoo-web-players.html`), verified on the owner's next real import via the
  `waiverStatus` / `availability` diagnostics. The demo league marks about a third of free agents as on waivers.
* **Ordering**: unchanged (call, then score) — free agents and waiver players interleave; the fix was that nothing was
  ever marked FA. The tab filters All / Free agents / On waivers with a count each, plus position chips.
* **UI**: `web/src/components/ExpandableRow.tsx` (`ExpandableList`, `ExpandableRow`, `DetailList`, `Disclosure`) is the
  reusable summary-row → details pattern (button role, Enter/Space, aria-expanded, ≥ 44 px rows, same look as `.table`).
  1280 px: Player, Summary, PPG, Value, Gain, Call columns; 390 px: a card with name + badge + call, then the summary
  (2-line clamp); numbers move into the details as stat tiles. Everything starts collapsed.
* **Fix round 1 (adversarial review)**:
  - Waivers lists are judged per position group (offense, K, DEF; `WaiverList.groups`): a status=W page that fails
    (HTTP or network error) or hits the page cap makes that group's list partial, so non-members stay unknown; an
    empty group list with no owner-column reading in that group is unknown, never "all free agents". "Yahoo ignored
    the filter" = a W row whose owner cell says FA, or the W set holds every available player read for the group
    (set comparison, not page order). A bare "W" cell is a last-game win, not waivers ("W (Wed)" / "Waivers" are).
    DEF links with a long slug (/nfl/teams/kansas-city/) map to the standard abbreviation via server/data/names.ts.
  - Row cap: the best 60 rows plus the best 5 of every position (`capRows`), so the K and DEF chips always list
    their streaming options. K/DEF with no weekly gain is a pass (never "+0.0 ppg").
  - Long-term injured (projection.ts `injuryKind` "long": IR, PUP, NFI, NA, "Out (IR)", "Out (ACL)") is never a
    claim: a would-be claim is a stash ("confirm his status"); no games left → pass. FAAB leagues: rows, rules, cost
    and tooltips talk about bids, never priority. Missing breakout numbers show "—".
  - Yahoo provider: priority / FAAB balance belong to the connected account's team (`league.myTeamId`) only,
    whoever asks; the waivers cache key includes the team.
  - Imported free agents that match no player are reported in the response `notes` (count + first 5 names) and
    shown as a warning line. `stripLeaguePrefix` is idempotent: on save an ambiguous nested prefix
    ("L - Team - One") is kept; on read only "<stored league name> - " is stripped (imports saved before the rule).

## Discord sign-in, multi-tenant (2026-10-26) — replaces the APP_PASSWORD / APP_PUBLIC gate

Owner request: sign in with Discord like perp.raibot.us; the owner is admin and can act as any user; every other
user is tied to ONE team in ONE league. Users may view everything for their team and re-import their own league;
delete, league settings, Yahoo OAuth and user assignment are admin-only. Reference implementation:
~/perp-copy/src/perp_copy/dashboard/auth.py (Discord OAuth2 `identify`, signed state + state cookie, server-side
sessions, allowlist re-checked per request, Origin + CSRF on writes, sign-in rate limit by CF-Connecting-IP behind
the tunnel). Docs: https://discord.com/developers/docs/topics/oauth2#authorization-code-grant ,
https://discord.com/developers/docs/resources/user#get-current-user ,
https://owasp.org/www-community/SameSite , https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html

**Config** (env, in ~/FantasyFootball-run/.env, never committed): `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
`SESSION_SECRET` (≥ 32 random bytes), `PUBLIC_URL` (https://ff.raibot.us; redirect URI = PUBLIC_URL + /auth/callback,
never derived from request headers). Production without all four → refuse to start (fail closed). Non-production
without Discord config → "dev mode": every request is a built-in admin (tests and `npm run dev` only; logged at start).
APP_PASSWORD, APP_PUBLIC and the Basic-auth middleware are deleted.

**Access list** `.data/access.json` (git-ignored; Discord ids are personal and the repo is public):
`{ "admins": ["<discord id>"], "users": [{ "discordId": "...", "leagueId": "y1405188", "teamId": "4", "note": "..." }] }`
Re-read on every request (tiny file; mtime cache OK), so removing an id locks that user out at once. Missing or
unreadable file = nobody can sign in (fail closed); the owner's id is seeded as admin on first deploy by Claude.

**Sessions**: server-side store `.data/sessions.json` (atomic writes via providers/store.ts): key = SHA-256 of a
random 32-byte id; row `{ uid, name, avatar, csrf, createdMs, expiresMs, actAs? }`; TTL 7 days; logout revokes.
Cookie `td_session` = the random id signed with HMAC-SHA256(SESSION_SECRET), httpOnly, Secure (prod), SameSite=Strict,
Path=/. OAuth state: signed `{nonce, next, exp}` (10 min) in the URL AND in an httpOnly SameSite=Lax cookie; the
callback requires both equal (timingSafeEqual) and a valid signature. `next` must be a same-site path (no `//`, no `\`).

**Who can see what** (one guard, `server/auth/guard.ts`, called by every /api route; unit-tested per route):
* Public: `/healthz`, `/auth/login`, `/auth/callback`, `/api/import/bookmarklet.js`, `/api/docs/import`, static UI.
* Everything else under `/api` and `/auth/yahoo/*`: no session → 401 `{error, code:"signin"}`; id not in access list → 403.
* Admin: everything; `POST /api/auth/act-as {discordId|null}` sets `actAs` on the session (an admin viewing as a user
  sees exactly that user's scope; `null` = back to admin). Admin-only: DELETE /api/import/:id, PUT /api/import/:id/settings,
  /auth/yahoo/*, /api/yahoo/*, /api/access (list users + leagues/teams to pick).
* User (or admin acting as one): league routes only for provider `import` + their `leagueId`; the `team` query param
  is forced to their `teamId` (another team → 403, missing → theirs); demo provider allowed read-only. `GET /api/import`
  lists only their league. `POST /api/import` only when the payload's league is theirs (else 403). History/changes:
  their league only.
* Writes (POST/PUT/DELETE): Origin must equal PUBLIC_URL and `X-CSRF-Token` must equal the session's csrf
  (timingSafeEqual); refusals are 403 with a code. `GET /api/auth/me` → `{ id, name, avatarUrl, role, csrf, scope:
  {leagueId, teamId} | null, actingAs }`.
* Rate limit: `/auth/login` + `/auth/callback` 30/min per client (CF-Connecting-IP only when the TCP peer is loopback,
  else the peer) and 300/min global. Every login / refusal / admin act-as / write is one structured log line
  (`[auth] event=login uid=… result=ok`), never tokens, codes, cookies or secrets.

**UI**: no session → a sign-in screen ("Sign in with Discord"); `?error=not_allowed` → "This Discord account isn't on
the list yet — ask the league owner." Header shows avatar + name + Sign out. Users: the team picker is hidden and the
Connect tab shows only their league (re-import allowed; delete/settings hidden). Admin: a "View as" picker (Admin /
each user) in the header; a banner "Viewing as <user>" while acting. API client sends X-CSRF-Token on writes and
shows the sign-in screen on any 401.

**Amendments after advisor review (override the above where they differ)**
* **Team scope comes only from the guard.** `StoredImport.myTeamId` / `league.myTeamId` is per league (whoever imported),
  not per user. The effective team for a request = access.json (user) or act-as / `team` param (admin). Every
  `myTeamId` use in api.ts (teamParam default, freeAgentInputs priority/FAAB "is this my team", analysis response) goes
  through the guard's scope. A non-admin re-import never writes `myTeamId`. Test: user B re-imports league Y → user A's
  team and the stored `myTeamId` are unchanged.
* **Sessions** load once at start into an in-memory Map (single process) and write through on change with
  `writeJson` (atomic); never read-modify-write the file per request. access.json is read-only with an mtime cache.
* **Deliberate omissions** (unlike perp): no sudo re-auth (nothing here moves money or places orders) and no per-user
  write budget beyond the sign-in limiter. Writes are import / delete / settings / act-as only.
* **Direct localhost writes fail Origin/Host** in production by design (Origin must be PUBLIC_URL). Smoke checks run
  through https://ff.raibot.us.
* **Browser-backup restore** (App.tsx) sends X-CSRF-Token; a 403 means "not your league": stop, no retry.
* **Replace = delete**: APP_PASSWORD / APP_PUBLIC code, their two integration tests, `APP_PUBLIC` in the plist template
  and the installed copy, README / DEPLOY / CLAUDE wording. New tests: production without the four auth vars exits 1;
  production WITH dummy values → `/api/state` without a cookie is 401 (dev mode cannot leak into production); auth unit
  tests with an injected fake Discord client.

**Adversarial test round (2026-10-26) — fixes**
* A user's re-import refreshes rosters and free agents only; league settings (name, slots, scoring, weeks, waiver
  priority, settings source) are kept from the stored league (`leagueSettingsOf` in api.ts).
* Dev mode needs an explicit `NODE_ENV=development` or `test` (`npm run dev` sets it); unset or misspelled NODE_ENV
  requires full Discord config. Auth vars are trimmed; whitespace-only = missing.
* Logout always clears the cookie; if the session file cannot be written it answers 503 and the store retries the
  write (every 5 s, at most 60 times) so a restart cannot revive the session once storage works.

## Import: standings and waiver order (2026-10-26) — release 2 "Import enabler"

Before: every imported team's record showed "—" and waiver priority was "unknown" (the bookmarklet never read them).

* **Bookmarklet**: after the team pages, reads `<league>/standings`, else the league home page (`<league>`), and
  `parseStandingsHtml` (web/src/import/yahooHtml.ts) finds columns by header text — Rank (or an unlabeled first
  column), W-L-T (one "6-1-0" / "6-1" cell, or W / L / T columns), Pts For, Pts Agst, Streak, Waiver, Seed — across
  every division table. Rows are matched to team pages by the `/f1/<league>/<n>` link. Missing columns stay unknown and
  are listed in the `standings` diagnostics (`headers`, `columns`, `missing`, `noRecord`); the overlay says
  "standings: N of M teams · waiver order: …". Fixtures `yahoo-web-standings*.html` are RECONSTRUCTED; the real
  markup is verified on the owner's next import.
* **Payload / StoredImport**: per team optional `record {wins, losses, ties, pointsFor?, pointsAgainst?, rank?, streak?,
  seed?}` and `waiverRank`. Validation (`cleanRecord`): W/L/T whole numbers (≤ 20 games) or no record; each optional
  field dropped alone when invalid; duplicate waiver ranks drop the whole order. Old imports are unchanged.
  `buildImportLeague` copies them onto `Team.record` / `Team.waiverRank` (analysis already sorts on `record.wins`).
* **Waiver priority** (`waiverPriorityOf`): the request team's own `waiverRank`, else the stored `waiverPriority` —
  which belongs to the importer's team (`StoredImport.myTeamId`) only, so a member never sees the importer's number.
  An admin import with no explicit `waiverPriority` stores the importer's team rank; a re-import replaces it unless the
  admin hand-edited settings. A hand-entered priority (PUT settings) also corrects the importer's team rank; the next
  import with a waiver order supersedes it (priority changes every week, the newer fact wins).
* **Who may change what**: standings and ranks live on the teams, so a member's re-import refreshes them (weekly,
  roster-like data); league settings (name, slots, scoring, weeks, stored `waiverPriority`, `myTeamId`) stay admin-only
  (`leagueSettingsOf` in api.ts). A paste-mode roster replacement keeps the team's standings.
* **UI**: My Team "Record" shows "6-1" with "1,043.2 PF" (tooltip says where it came from), "—" when unknown; the
  Waivers header shows "Waiver priority #N of 12" from the team's rank. The League tab (release 3) builds on these.

## League tab (2026-10-26) — release 3; overrides "Team analysis" on the power formula

Owner: "who's ranked above me and why … NO large texts, key information and expand for details; graphs, charts and
tables first." Power rankings moved here from My Team.

* **Power score**: superseded by "Power score v2 (2026-10-26)" (projected starters + actual results; the parts,
  gaps and chart segments below are now "projected" and "results"; bench strength is a tie-breaker bullet).
* **Model** (`server/model/league.ts`, pure): `buildLeagueView(teams, myTeamId)` → `{ myTeamId, numTeams, weights,
  standingsKnown, teams, above, below, summary }`. `teams` rows (by power rank): power score and its two parts,
  starter ppg, bench strength, `standingsRank` (the import's `record.rank` when every recorded team has one, else win%
  with ties = ½ then PF; null without a record), `record` ("6-1", "—" unknown), PF / PA (null unknown, never 0).
  `above` / `below`: per other team, gaps theirs − mine (power, starter, bench, and the weighted parts that sum to the
  power gap), per-group ppg in GROUPS order, their top-2 starters at the (≤ 2) groups they lead most (id, name, pos,
  ppg only), and a ≤ 255-char summary ("+4.9 starter pts/wk, partly offset by your deeper bench (+9.1): stronger WR
  (+5.1) and TE (+3.4); you're better at FLEX and RB." / "Deeper bench (…) outweighs your … starter pts/wk" / below:
  "-0.6 starter pts/wk vs you: weaker RB (-9.5)…"). Team and player names stay out of the summary.
* **API**: `GET /api/league/:provider/:id/league?team=` — same league guard and pinned team as the other league
  routes (a user's `team` is forced; another league or team → 403). Demo payload ≈ 13 KB (test: < 60 KB).
* **UI** (`web/src/tabs/LeagueTab.tsx`): stat cards (power rank, standings place, power score = parts, teams above);
  a stacked horizontal bar chart from zero (starter part, bench part; my row highlighted) beside the standings table
  (#, team, W-L, PF, PA, power rank; PA hidden at phone width), equal height at 1280 px; "Who's above you" and
  "Below you" as collapsed `ExpandableRow`s (rank, team, summary, power gap) that open a mini grouped-bar chart (their
  vs my group ppg) and bullet details. Column headers carry a tappable "?". My Team's Power rank stat opens this tab.


## Collapsed rows everywhere (release 4, 2026-10-26) — Trade Finder, Targets, Values help; overrides earlier text where they differ

Owner: "make each recommendation collapsible … everything starts collapsed, with the key detail like Loveland for Williams";
"one simple row per breakout target, details as bullets"; "what does value mean? … each column should have a help text".

* **Shared helpers**: `server/model/details.ts` (`detailBuilder`, `clampItem`, `toneOf`; limits and `makeSummary` from waivers.ts).
  Tests use `summaryProblems` / `detailProblems` (testkit) on unit fixtures and on every demo-league row.
* **Value bullets**: `projection.ts explainItems` builds `ValuedPlayer.whyItems` from the same numbers as the prose `why`
  (projection, expert rank + weight, 2026, 2025, above replacement, games, consensus, value; `signals.ts` adds the riser
  lines). `/analysis` strips `whyItems` (My Team still renders `why`; release 5).
* **Trades v3** (`tradesV3.ts`): `Trade.summary` = "A for B: your team +x, their lineup +y pts/wk. <band>, ~P% accept."
  (≤ 255); `Trade.details` = one item per fact (score parts, slot loss, risers, their lineup, market packages, cuts,
  fairness, true value, acceptance factors, playoff / bye facts, QB rule, rank score). `why` and `notes` are gone from v3,
  bench-upgrade and evaluate responses (`why` stays optional for the legacy v1 `/trades` and v2 evaluate). Evaluate prepends
  Verdict / For you / For them / Outside the rules items. Partners: `{ teamId, complementarity, summary, details }`
  (`pitch` removed). Finder: `summary` is one short line; the reasons are `summaryDetails`. Near misses keep `reason`
  (one line) plus a "Why not on the list" item. Bench upgrades (`tradesV2.findBenchUpgrades`) build summary + items the same way.
* **Breakouts**: `BreakoutTarget.summary` ("RB2 behind X (Out): 47% snaps (+21 pts), 10.7 expected pts/g lately. Offer Y.")
  and `details` (depth chart, who is ahead, snaps / touches by week, expected vs actual, price, score parts, the offer or
  waivers call). `BreakoutResult.how` (items) replaces the prose `notes`. `thesis` stays server-only (the waivers module
  splits it); `GET /breakouts` returns `BreakoutResponse` rows without `thesis` and with a slim `CardPlayer`
  (demo 216 KB → 160 KB).
* **Values**: `GET /values` rows are `ValueRow` (only rendered fields; demo 1.04 MB → 97 KB, test < 250 KB). `edge` is unset
  unless the market lists him with a real value (not estimated): the UI shows "—" and sorts unknowns last. `?id=<player>`
  returns that one row with `whyItems` (fetched on the first tap of the row "?"). The table renders 100 rows + "Show more".
* **UI**: `components/HelpTip.tsx` (`HelpTip` text / items / lazy `load`, `ColumnHelp` for headers and metric labels; `Why`
  delegates to it; on phones the popup is a bottom sheet so scroll containers never clip it). Every numeric header in Values,
  Trade Finder (Team, Accept, Fit, lineup metrics, fairness, package value) and Targets (Score, Owner, Role, strip labels)
  has a tappable "?". `TradeCard` is an `ExpandableRow` (partner + summary | team Δ | accept %); details = both sides with
  value bullets, the pitch, metrics, lineup changes, the items, tags. Trade Finder: summary notice + "Why" disclosure,
  "How they're ranked", partners as collapsed rows, smaller edges / near misses / bench upgrades as collapsed lists.
  Targets: title + filters + "How it's scored"; one row per target (# · player · score · owner · role), tapping opens the
  summary, snap / expected / actual strips, tags and the items. Screenshots: docs/screenshots/{trades,targets,values}-{390,1280}.png.

## Release 5: My Team, Values, Connect cleanup + "League updated" header (2026-10-26)

* **My Team**: one `LineupTable` for starters and bench (slot column BN / IR from `team.irPlayerIds`; `BenchList` deleted).
  Lineup & bench card beside Position strength + Byes & injuries; `.team-grid` stretches both columns to equal height,
  the last right card flexes. Byes: week grid plus one row per week with starters on bye (weeks without byes hidden).
  Every stat card has a "?". The row "?" shows the value bullets (`ValuedPlayer.whyItems`, release 4's `explainItems`,
  items clamped to 90 chars) instead of the prose `why` — the brief's "whyDetails" is this same list, not a second builder.
  `/analysis` keeps `whyItems` only for the request team's roster (adds < 40 KB; test). `why` stays for chip titles.
* **importedBy**: `StoredImport.importedBy` = the session's Discord display name ("Admin" in dev mode), stamped by POST
  /api/import on every import, re-import and paste (never read from the payload; not an admin setting, so a member's
  re-import sets it). Exposed on `league.import.importedBy`, the POST response and `ImportSummary` (which also gains
  `hasStandings` / `hasFreeAgents`). Older imports show "—".
* **Header**: imported leagues show "League updated <Mon D, h:mm AM> · by <name>" (replaces the "Imported league" status
  pill); the old "Data Xm ago" pill is "Stats <ago>" with a "?" (player stats / expert ranks download time).
* **Values**: Owner column never truncates at desktop; missing numbers are "—" everywhere (`f1` / `signed`).
* **Connect**: instructions collapsed into `Disclosure`s with numbered short steps; imported leagues are `ExpandableRow`s
  with chips (Standings yes/no, Free agents yes/no, Updated <date> by <name>) and label/value details incl. roster moves.
* Removed unused CSS from releases 1–4 (trade cards, target cards/grid, bench list, why-list, …).

## Power score v2 (2026-10-26) — overrides every earlier power formula

Owner: "RxH is #1 in power rankings but his team looks weak and he's 3-3; shouldn't power rankings be determined by
starters?" On the real league the bench added ≤ 2.3 points, and the leader was #1 because (1) a healthy player parked
in his IR slot was counted as a starter, and (2) results were ignored entirely.

* **Formula** (analysis.ts, the one formula): `power = POWER_WEIGHTS.projected (0.7) × projected starter ppg +
  POWER_WEIGHTS.results (0.3) × actual points per game`, where `actualPpg(record)` = `record.pointsFor / (wins + losses
  + ties)` from the imported standings. Unknown results (no record, no points for, or 0 games) → `null`, and that
  team's results part uses its projected starter ppg, so a league without standings ranks purely on projections.
  `TeamAnalysis.resultsPpg` (null = unknown). Ties (on the 2-dp score): bench strength (`benchStrength`, top-3 bench
  VORP, IR excluded), then wins, then team id. Bench strength is no longer in the score.
* **IR slot**: players in `Team.irPlayerIds` never start in any lineup that stands for their team's startable players —
  team analysis (lineup, starter ppg, group ranks, power), trade `teamState` / `applyTrade` / v3 slot-loss lineup,
  `rosterParts` for trade v2/v3 scoring (`activeRoster`: no now/season/playoff lineup or depth points), and the waiver
  base/after lineups. They stay on `bench` (shown as IR), are not bench strength or surplus, keep their trade value,
  and can start for a team that trades for him (he is not in that team's IR slot).
* **League view**: rows carry `projectedPart`, `resultsPart`, `starterPpg`, `resultsPpg`, `benchStrength`; comparisons
  `starterGap`, `resultsGap` (null when either side is unknown), `benchGap`, `projectedPartGap + resultsPartGap =
  powerGap`; `weights {projected, results}`; `resultsUnknown` (count). Summary: "+5.0 projected starter pts/wk and
  +3.1 actual pts/game: stronger FLEX (+6.5) and RB (+5.6)." / "+25.7 actual pts/game outweighs your +6.0 projected
  starter pts/wk…" / "… (results unknown) …" / "Level on power score; ahead on the tie-breakers (bench depth …)".
* **UI**: chart segments "0.7 × projected starter ppg" + "0.3 × actual pts/game" (faded when results are unknown, with
  a "Results unknown for N teams … Re-import standings" notice); detail bullets Power gap (projected, results),
  Projected starters, Actual pts/game ("Results unknown — re-import standings"), "Bench depth: …, tie-breaker only".

## League tab modes (2026-10-27) — Now / Playoffs

Owner: power rankings should not be "done with record in mind"; keep the current view and add "one for pure playoff
projection". A two-button toggle at the top of the League tab (default Now):

* **Now**: unchanged (Power score v2: 0.7 projected starters + 0.3 actual pts/game; wins only as the last tie-break).
* **Playoffs (wks 15–17)**: teams ranked by `TeamAnalysis.playoffStrength` (teamStrength.ts — the same number as My
  Team's "Playoff strength": playoff lineup pts/wk + DEPTH_WEIGHT × bench cover, returns via the scenario mix). Ties:
  lineup part, then team id. No results, no record. `league.ts` `playoffRanks` / `playoffSummary`; view fields
  `LeagueTeamRow.playoff {rank,total,lineup,depth} | null`, `playoffWeeks`, `depthWeight`, `playoffAbove/Below`
  (gap, lineupGap, depthGap, powerRank for contrast, one-line summary ≤ 255 chars). No playoff weeks left → the
  Playoffs button is disabled and every `playoff` is null (never a guessed 0).
* UI: stat row (Playoff rank, Standings, Playoff strength "lineup + bench cover", Teams above), stacked chart (lineup +
  0.25 × bench cover), the standings table's rank column shows the active mode's rank ("Pwr" / "PO"), and "Stronger /
  Weaker in the playoffs" collapsed rows with bullet details (gaps, power rank now, standings).

## Model v4: playoff value, perception gaps, returns (2026-10-26) — design, supersedes the value model for v4 consumers

**Goal (owner):** the strongest possible starting lineup for the fantasy playoffs (weeks 15–17), built through trades,
free agents, waivers and stashes. Points-to-date already exist in Yahoo's evaluator; our edge is forward-looking value:
role, opportunity, context and talent, BEFORE it shows in the box score. Industry practice (sources in the release
notes): expected fantasy points vs actual (luck vs skill, buy-low/sell-high), target share + air-yards share (WOPR),
weighted opportunity for RBs (PPR target ≈ 2.8 carries; snap share ≥ 50% threshold), weeks 15–17 strength of schedule,
contingent (handcuff) value, rest-of-season projections over points-to-date, contender mode.

**Data (all already downloaded):** ffopportunity `ep_weekly_<season>.csv` (per player-week: targets `rec_attempt`,
`rec_air_yards`, `rush_attempt`, expected/actual fantasy points), nflverse `games.csv` (`spread_line`, `total_line`,
`home_qb_id`/`away_qb_id` = the QB who started), `injuries_<season>.csv` (`report_status`, `practice_status` per week),
`roster_<season>.csv` (`status`, `birth_date`, `draft_number`, `rookie_year`), snap counts, FantasyPros ECR (weekly +
ROS). Not available free: routes run (TPRR / YPRR need PFF) → proxy = snap share on team pass plays.

**1. Player signals (server/model/signals/, pure, one module per signal, sibling tests)**
* Opportunity per week: target share and air-yards share (player ÷ team totals from ep_weekly, by posteam+week),
  WOPR = 1.5·tgt share + 0.7·air share; RB weighted opportunity = carries + 2.8·targets (PPR; scale by `scoring.rec`),
  snap share; expected fantasy points under LEAGUE scoring.
* Context flags per game: `qbOut` (team's usual starter not the starting QB per games.csv), `leftEarly` (snap share
  < 15% after ≥ 50% before), `blowout` (|result| ≥ 21). Flagged games get weight 0.25 in rates.
* Recency: exponentially weighted rate over unflagged games, half-life 2 games (the last 3 games carry ~70%).
* Luck: expected − actual points (recency-weighted). Positive = under-producing his usage (buy-low); negative and
  driven by TDs above expected TDs = sell-high. Labels renamed accordingly; the old market-gap tag becomes
  "market undervalues" / "market overvalues".
* Talent prior: last season's expected/actual per game, age (≤ 26 rising), draft capital for rookies (small weight).

**2. Projection v4 (replaces projection.ts ppg as the value base; Replace = delete the old blend)**
`rate = expected points per game from recency-weighted, context-adjusted opportunity × efficiency shrunk toward 1.0`
(efficiency = actual/expected, shrunk by sample size, so TD spikes regress), blended with ECR only as a sanity anchor
(weight 0.25, falling to 0.1 when ≥ 4 unflagged games). Per remaining week w: `pts(w) = rate × matchup(w) × avail(w)`.
* matchup(w): opponent's fantasy points allowed to the position (league scoring, season, shrunk to league average)
  relative to average; when the week's Vegas total exists, scale by implied team total / league average. Bye = 0.
* avail(w): healthy 1; Q 0.85 / D 0.7 for the current week only; Out / IR / suspended → 0 until the estimated return
  week (section 4), then 1.
* Values: `playoffValue = Σ pts(15..17)` (weight 1.0), `seasonValue = Σ pts(current..14)` (weight from mode). Default
  mode for a team in a playoff spot = "playoffs" (0.25 rest of season / 0.75 playoffs); else balanced.

**3. Team objective and move ranking**
* Team strength = expected points of the optimal lineup in weeks 15–17 (IR-slot players excluded; depth term =
  expected points from the bench covering one random starter injury).
* Every move is scored by Δ team strength: free-agent adds (no cost), waiver claims (cost = priority), stashes,
  trades. One "Best moves" list ranks them together (Waivers and Trade Finder keep their own views).

**4. Returns and stashes (Stash watch)**
* Candidate: unrostered (or on my IR) with a healthy-role rate ≥ flex level from pre-absence games / last season and
  status Out / IR / PUP / suspended or 0 snaps the last 2 weeks.
* Return estimate: designated to return / IR minimum / suspension end when known; practice trend (DNP → limited →
  full) ⇒ "back ~week N" with confidence high / medium / low; unknown ⇒ "return date unconfirmed" (never a guess).
* Value = Σ pts(return..17) with playoff weighting. Waivers shows "Stash: add now while free" for free agents and
  flags "about to become a waiver fight" on a practice upgrade. My IR players show "hold: back ~week N".

**5. Trades v4 (perception gaps)**
* Our value = section 2. Their perceived value = Yahoo's rest-of-season projection for the player (captured by the
  bookmarklet; until captured: FantasyPros ROS rank → points) + recency bias (last 3 games actual points) + market.
* Gem = (our value − their perceived value) in my favour on what I get, and the reverse on what I give.
* Acceptance from THEIR view: Yahoo-visible lineup delta for them (dominant), recent points of what they give,
  market edge (minor). A Yahoo-visible loss for them ⇒ low acceptance, never in the main list.
* Rules: no suggestion with my Δ team strength < 1.0 pt/week of playoff lineup; never sell a player whose opportunity
  trend is rising; flag bye/playoff cover lost; pitch = reasons that matter to them (need, bye cover, Yahoo numbers).

**6. League: playoff odds** — simulate the remaining regular season (weekly points ~ team projection ± spread,
10k runs, seeded) → playoff probability per team; shown on the League tab; feeds the default mode in section 2.

**Releases:** (a) signals + context flags (enabler, no UI change); (b) projection v4 + labels + power score v2
(held build) on top; (c) stash watch + returns; (d) bookmarklet captures Yahoo ROS projections (enabler) + trades v4;
(e) playoff odds + "Best moves". Each: developer → adversarial tester → review → deploy → real-league check.
Owner-specific worked cases live outside the repo (public).

**Model v4 — amendments after advisor review and a data check (override the above)**
* Data verified on the cached 2026 files: games.csv `home_qb_name`/`away_qb_name` are filled for played weeks (e.g. a
  team's three backup-QB starts are visible), `total_line`/`spread_line` exist for played weeks and the NEXT week only;
  ep_weekly team target totals are sane (median 32/team-week); injuries `practice_status` ∈ {Full / Limited / Did Not
  Participate In Practice}, `report_status` ∈ {Out, Questionable, Doubtful, ""}; roster `status` ∈ {ACT, RES, INA, DEV,
  CUT, …} (suspensions/IR live there, not in injuries). ep_weekly has no K/DEF rows → K/DEF keep the existing model.
* `qbOut`: the team's most frequent starting QB over the season ≠ this game's starter. If the QB names are missing for
  a game, infer the starter from ep_weekly pass attempts.
* Default matchup factor = opponent points allowed to the position only; next week's Vegas implied total is a bonus.
* **Opportunity trend (single definition, used by trades, stashes and labels):** slope of WOPR (WR/TE) or RB weighted
  opportunity per game over the last 3 unflagged games; "rising" = slope ≥ +0.03 WOPR/game (WR/TE) or ≥ +1.5 weighted
  opportunities/game (RB). Calibration values, revisited after the first real-league run.
* **Efficiency shrinkage:** efficiency = (actual + k·expected)/(expected·(1 + k)) with pseudo-count k = 6 games; caps
  RB/TE 0.75–1.35, WR 0.8–1.3, QB 0.85–1.2. Calibration values.
* **Team-strength function moves to release (b)** (pure, on lineups); release (e) only merges the "Best moves" UI.
* **Until release (d) captures Yahoo projections**, "their perceived value" ≈ FantasyPros ROS, which is close to our
  ECR anchor, so perception gaps are small and the Trade Finder will look quiet: expected, not a bug.
* **Replace scope in (b):** projection v4 is THE value for lineup, analysis, waivers, breakouts, League, trades v3 and
  the evaluate route. Trades v1 (`/trades`) and v2 are deleted in (b) (routes, code, tests, UI references) so the app
  has one valuation.
* **Playoff odds (e):** weekly team points ~ Normal(v4 lineup projection for that week, σ = the team's own weekly
  std-dev this season, shrunk to the league's), 10k seeded runs over the league's remaining schedule. The import does
  not capture the matchup schedule yet → release (e) starts with a bookmarklet step for it.

**Release (a) implemented (2026-10-26) — enabler, no UI or value change**
* `server/data/signalTables.ts`: pure builders `parseEpRows`, `buildTeamTotals` (file `*_team` columns, sum fallback),
  `parseGames`, `buildStarters` (games.csv QB ids, fallback = most pass attempts), `buildUsualStarters`, `buildMargins`,
  `parseStatus`, `parseRoster` (latest week per player + pfr→gsis), `parseSnaps`, `buildPrior`, `buildSignalInputs`;
  loader `getSignalInputs(season)` and `getAllSignals(season, scoring)` / `playerSignals(season, id, scoring)`, computed
  lazily and memoized per process (≤ 8 scorings). Scoring is a required argument (signals are league-specific).
* `server/model/signals/`: `opportunity`, `context`, `recency`, `luck`, `efficiency`, `trend`, `talent`, entry `index`
  (`computePlayerSignals`, `computeAllSignals`), shapes in `types`. Nothing outside tests consumes them yet.
* A game = an ep_weekly row or a snap-count row with offensive snaps (zero opportunity). Unknown snaps / team totals
  stay undefined (never 0). Timing on the 2026 cache: parse all files ≈ 210 ms once per process; batch for all 536
  QB/RB/WR/TE ≈ 3–5 ms.
* Choices (calibration, revisit after the first real-league run):
  - RB target weight = 1.4 + 1.4·`scoring.rec` (2.8 full PPR, 2.1 half, 1.4 standard) — a literal 2.8·rec would make
    a standard-league target worth nothing.
  - Efficiency shrinkage read as totals over n games + k = 6 pseudo-games of his average: (n·raw + k)/(n + k); raw is
    recency-weighted, n counts games (unflagged 1, flagged 0.25, no decay — decayed weights sum to ≤ ~3.4 and would
    never approach k). The literal formula has no sample-size term. Null below 0.5 weighted expected pts/game.
  - `qbOut` is never set on a QB's own games; usual-starter ties go to the earlier starter.
  - `leftEarly` "before" = mean snap share of his earlier games this season with known snaps (constants from breakouts).
  - Luck `driver` = "td" when |TD part| ≥ |yardage part|; fumbles have no expected value, so they count as yardage luck.
  - `halfSnaps` = recency-weighted snap share ≥ 50%.
* Data finding: with the amendment thresholds, 120 of the 356 players with a known trend are "rising" (87 of 263 WR/TE):
  +0.03 WOPR/game is small next to weekly noise, and skipping flagged games can stretch the 3-game window. Re-check
  before release (b)/(d) relies on "rising".
* Known residuals for (b): "most frequent starter" flags a returning opening-day starter's games as `qbOut` (e.g. a
  team whose backup started 5 of 7: the starter's weeks 1 and 7 are flagged); 107 of 536 players carry ≥ 1 qbOut game.
  Signal memos live for the process lifetime (the player DB rebuilds every 6 h) — (b) adds the same staleness window.

**Release (b) implemented (2026-10-26) — projection v4 is the one valuation**
* **One valuation.** `server/model/projectionV4.ts` `valuePlayers(league, pool, tables, mode)` values every player;
  lineups, team analysis and power score v2, League, waivers, breakouts, Trade Finder v3, evaluate and bench upgrades
  all read it. Deleted: the ECR / current / prior blend and the 35% consensus value anchor (projection.ts keeps only
  the helpers v4 reuses: ECR rank→points curve, K/DEF line, replacement ranks, injury classification, convexity), the
  riser ppg blend (`attachRisers`), Trade Finder v1 (`/trades`, trades.ts) and v2 (tradesV2.ts) with their tests, UI
  and mock references. Shared trade helpers moved to `tradeKit.ts`; bench upgrades run on `judge3` (`benchUpgrades.ts`).
* **Rate** = recency-weighted, context-adjusted expected points (signals) × shrunk efficiency, with last season's
  per-game points as 2 pseudo-games (≥ 4 games played), blended with the ECR curve: 25%, 10% from 4 unflagged games,
  100% when he has no game (rookies / no history), none when he has no ECR rank.
* **Matchup(w)** = opponent's points allowed to the position this season (league scoring, actual lines of the
  opponents' players), with 4 pseudo-games of league average, clamped 0.8–1.2; the next game's Vegas implied total
  multiplies it by 1 + 0.5 × (implied / average − 1), total clamp 0.75–1.25. K/DEF: 1.
* **Avail(w)**: Questionable 0.85 / Doubtful 0.7 / Out 0 for his next game only (the first remaining game, not the
  calendar week, which may be a bye or already played); IR / PUP / NFI / NA / long-term
  detail / suspended, and nflverse roster RES (even with a game last week: freshly placed on IR) → 0 for the rest of the
  season ("return unconfirmed", release (c) adds return estimates); designated to return (checked before RES) → 0 for
  his next 4 games, then 1; no NFL team
  → 0. A week without an unplayed game for his team (bye, or already played) → 0.
* **Missing expected data**: ≥ 2 games with expected 0 but actual > 0 and no usable efficiency → the model rate uses
  recency-weighted actual points (same prior pseudo-games and ECR anchor), a "Usage data" warn bullet and a league
  note ("Usage data missing for N players").
* **Fields**: `ppg` = healthy rate × mean matchup (per game played), `effPpg` = mean of `weekly` over his remaining
  games (lineups), `weekly[]` from `weeklyFrom` (= current week, each rounded to 0.1), `seasonPts` (current..regular-season
  end) and `playoffPts` (15..17) = exact sums of the shown weekly numbers, `availThisWeek` (Q 0.85 / D 0.7 / Out 0 when
  this week's game is discounted: the My Team chip), `remainingGames` = Σ availability, `luck` / `luckTd` (only with real usage), `label`,
  `riser` (= the recalibrated opportunity trend), `valueMode`. `whyItems` are short bullets; `why` is one line.
* **Value** = 100 × (raw / max)^1.35 with raw = Σ weeks w_mode × max(0, pts(w) − replacement ppg), `playoffs` mode
  0.25 rest of season / 0.75 playoff weeks, `balanced` 1 / 1. Mode per request team (`defaultMode`): playoffs when its
  standings seed (else rank) is in the top half of the league, otherwise — and when standings are unknown — balanced.
  The API keeps one valued context per (league, mode) on top of a shared base (league + projection tables).
* **Labels** (`labels.ts`): buy-low = luck ≥ +2.0 pts/g; sell-high = luck ≤ −2.0 with the TD part dominant (≥ 3
  sample games), never on a player with no games left (IR / reserve / out for the season); market undervalues /
  overvalues = |edge| ≥ 8. Used by trade tags (a rising player is never tagged
  sell-high / overvalued), Targets tags, bench-upgrade and waiver details, and the Values "Luck" column.
* **Team strength** (`teamStrength.ts`, `TeamAnalysis.playoffStrength`): mean optimal weeks 15–17 lineup from weekly
  points (IR slot excluded) + 0.25 × depth, depth = mean over starters and weeks of the points the bench recovers when
  that starter is out. Shown on My Team as "Playoff lineup strength".
* **Calibration (2026 cache, demo league 42, week 7)**:
  - qbOut: usual starters = most frequent ∪ ≥ 3 of the last 4 ∪ opener-and-latest (the brief's simpler rule leaves
    SEA's returning starter flagged: Darnold weeks 1 and 7 around five Lock starts). Players with a qbOut game 107 → 69.
  - Rising: both steps up, slope ≥ 1.0 × his weekly std-dev, latest ≥ flex level (metric rate at rank RB30 / WR40 /
    TE14). 13 of 361 players with a trend (3.6%; RB 6, WR 4, TE 3) = ~15% of the 84 flex-level roles. 10–15% of all
    361 would need ≤ 0.5 × std-dev and no flex floor (sweep: 0.5 × std, no floor → 42).
  - Mean |v4 ppg − old ppg| over rostered players: QB 1.12, RB 1.31, WR 1.01, TE 1.21, K/DEF 0 (unchanged model).
  - Labels across the pool: 44 buy-low, 22 sell-high. Valuation + analysis 41 ms; projection tables 180 ms per
    scoring (rebuilt with the player DB).
* **One shared refresh** (fix round 1): `getPlayerDb` (memo, `DB_STALE_MS` = 6 h, clock `dataClock`) recomputes the NFL
  calendar from games.csv on every rebuild (`PlayerDb.state`; `getNflState()` reads it, so a server running for days
  advances the week) and bumps `PlayerDb.generation`; the season tables, signals and projection tables are memoized
  per generation, so they rebuild together with the DB (no second timer). Tested with an injected clock
  (`server/data/refresh.test.ts`).
* **Fix round 1 calibration (2026 cache, demo league 42, week 7)**: roster RES now 0 regardless of the last game —
  13 of 45 RES players were projected > 0 before, 0 after; labels 42 buy-low / 20 sell-high; no player hit the
  missing-expected fallback; a QB with ≥ 40% of his team's starts is usual (platoon), players with a qbOut game
  unchanged at 69.
* Known gaps: the 2026 cache has DAL@PHI week 7 unplayed, so `currentWeek` = 7 and most teams show week 7 as "no game";
  the week advances at the next 6-hourly data refresh after the schedule file shows the game scored (up to ~12 h with
  the 6 h schedule download TTL); the Trade Finder `mode` (now / balanced / playoffs roster score) is separate from the value mode;
  `/values` without `?team=` uses the league default team's mode (the UI always sends its team); Trade Finder v3's
  injured-piece games count is bye-only, while v4 counts scheduled games;
  `rosterScore.weeklyPoints` still derives weekly points from ppg for hand-built players without `weekly` (fixtures).

**Release (c) implemented (2026-10-26) — returns and Stash watch** (overrides section 4 and the (b) availability rules)
* **Data reality** (2026 cache, week 7): the injuries file has ONE row per player-week (the week's final practice
  participation + game status), so the "DNP → limited → full" trend is read week over week, not day by day; practice
  strings are matched by prefix (`Full…` / `Limited…` / `Did Not…`). Players on IR are absent from the report until a
  practice window opens: 8 of 110 RES skill players have a week-7 row. Roster `status_description_abbr` is now kept
  (`RosterInfo.statusCode`, `PlayerSignals.rosterCode`): R48 = injured, designated to return (verified: R48 players
  practise in the report and one is ACT again after his window), R01 = injured reserve, R04 = PUP. No suspension code
  exists in the cache: a suspension is detectable only from a Yahoo "SUSP" tag, and its length never is. Skill players
  without a game but on a reserve list or the injury report now get a signal input (empty games) so their code and
  practice series reach the estimator; `ProjectionTables.playedWeeks` (games.csv rows with a result) gives games missed.
* **Return estimator** (`server/model/returns.ts`, pure): input = absence (reserve / designated to return / ruled out /
  suspended / season over), roster status + code, practice series, the team's remaining game weeks ("next game" = the
  first unplayed one, never a bye), games missed, last game week. Rules, in order:
  - full practice this week and not ruled out ⇒ next game, high; full but ruled out ⇒ the game after next, medium;
  - limited this week ⇒ next game (Questionable / Doubtful / no status) or the game after next (Out), medium;
  - designated to return without a full/limited row this week ⇒ inside the 21-day window (start = first practice row
    of this absence, else this week; estimate = 2 weeks after the start, capped at the window end), medium (low with a
    did-not-practise row this week);
  - ruled out of one game, not on a reserve list ⇒ the game after next, medium (low after ≥ 2 missed games);
  - reserve list without a practice signal, suspension, season-ending detail ⇒ unknown ("return unconfirmed"), never a week;
  - IR minimum (4 games, IR / PUP / roster RES) is a floor: an earlier estimate moves to the first eligible game and
    loses "high"; an unknown return still reports "wk N at the earliest". A practice row older than his last game is ignored.
* **Projection v4**: absent ⇒ 0 before the return week, × 0.85 for the first game back after a reserve-list absence
  (not after a one-game "Out"), then 1; unknown ⇒ 0 every week (lineups, value). Replaces "designated to return = 0
  for 4 games" and "RES = 0 for the rest of the season". `ValuedPlayer.ret` = { week | null, confidence, reasons,
  absent, practiceUp, earliestWeek?, healthyRate?, healthySource?, playoffPts?, stashScore?, returnValue?, tradeValue? }.
  - Healthy-role rate = THE projection rate when he has a sample (≥ 2 unflagged games or a ≥ 4-game last season),
    else unknown. A reserve-list / designated-to-return / suspended player with a sample skips the ECR anchor in the
    projection itself (experts drop an absent player's rank, so anchoring would count the absence twice); a one-game
    "Out" keeps it (fix round 2: hold / Stash watch / Values / lineups show one number).
  - Unknown return: `returnValue` = healthy rate × matchup over his games from current week + 4 × 0.5 (stash ranking
    and the IR "hold" line only); `tradeValue` = the same weekly points on the 0–100 value scale (trades only).
  - Stash score = Σ from the return week of healthy rate × matchup × ramp, playoff weeks × 1.0, earlier × 0.33, × the
    confidence weight (high 1, medium 0.85, low 0.7; unknown: the 0.5 already applied). `playoffPts` = weeks 15–17 part.
* **Stash watch** (`server/model/stash.ts`, GET /waivers `stash`, Waivers tab section): unrostered skill players with
  `ret` (absent, or not listed but 0 snaps in his team's last 2 games), an NFL team, a healthy-role rate ≥ the
  position's flex level (healthy rate at the trend's FLEX_RANK — RB30 / WR40 / TE14 — QB at league size; a points
  version of release (b)'s flex level, which is defined on the opportunity metric and needs ≥ 3 games), ranked by
  stash score, max 10. Calls: free agent "Add now while free", on waivers "On waivers — claim only if priority is
  cheap" (FAAB: "bid only a little"), not captured "Status unknown — add only if he is a free agent". Flag "practice
  upgrade: about to become a waiver fight" when this week's participation beats last week's (limited or full).
  Availability comes from the free-agent input (import / Yahoo / demo list); a player outside it is "status unknown".
* **My Team**: an IR / Out / reserve player shows "hold: back ~wk N (conf)" or "hold: return unconfirmed" with playoff
  points on return and a "?" with the evidence. The analysis payload carries `ret` for the request team only.
* **Trades v3**: `tradeValueOf(p) = max(value, ret.tradeValue)` feeds true value (`trueOf`), the market quantile
  mapping and `marketOf`'s fallback, so an injured star is not worth 0; the card adds "Injured, you give / get".
  Finder eligibility: superseded by "Injured trade pieces (owner 2026-10-26)".
* **Counts (2026 cache, demo league 42, week 7)**: 128 absent players with an estimate — 2 high, 24 medium, 2 low,
  100 return unconfirmed; 1 flex-level 0-snap player; flex levels QB 19.1 / RB 10.2 / WR 8.6 / TE 8.0 pts/game;
  3 Stash watch candidates (the demo's 12 full rosters hold most injured starters).
* Fix round 1: "practice upgrade" needs a real absence (a player hurt in last week's game who practises limited this
  week is trending down, not returning); "Missed" says "all N games this season" for a player without a game.
* Fix round 2: duplicate rows for one week merge to the most severe (lowest known practice, worst game status), in
  any order; designated to return past the 21-day window with no practice this week ⇒ unknown (window bullet kept);
  "IR minimum … no eligible game left this season" instead of "wk —"; a known return's `playoffPts` / stash score are
  sums of the projection's own shown weekly points (one number in My Team hold, Stash watch, Values, lineups); no
  market `edge` (so no "market undervalues / overvalues" tag, Values Edge "—") and no value pitch on a player whose
  return is unconfirmed (the pitch calls the deal a bet on his recovery); an IR tag only the league source gives
  (Yahoo / import "Out" in an IR slot, nflverse active) is absent, return unconfirmed, evidence "league lists him on
  IR"; Stash watch skips any player matching an unmatched roster line (normalized name + position when given).
  Counts after fix round 2 (demo league 42, week 7): flex levels QB 19.2 / RB 10.3 / WR 8.6 / TE 8.2, 2 Stash watch
  candidates (was 3), return confidences unchanged (2 high, 24 medium, 2 low, 100 unconfirmed).
  Real-cache check (week 7): all 238 top-60 skill players tagged "Out" in an IR slot get a `ret`; 14 have no
  healthy-rate source (rookies / backup QBs without a qualifying sample) and show "playoff pts —".
* Known gaps: practice is one row per week (no Wednesday→Friday trend); suspension length is never known; the 0-snap
  rule uses his current team's games (a traded player's old team is not consulted); Finder suggestions still skip
  injured players; the 21-day window start is a guess when the practice row is missing; a designated-to-return player
  in the practice branch (full / limited but still Out) is not capped at his window end (past it he reverts to
  season-ending IR); games missed count weeks before `currentWeek`, so in the mid-week data state (week 7 with one
  game unplayed) a player who already missed week 7 shows one game fewer and the IR floor lands a game late until the
  next refresh; an unmatched roster line without a position hides every same-named player from Stash watch.

**Release (d) implemented (2026-10-26) — Yahoo projections in the import + Trades v4** (overrides section 5 and
"Trade finder v3" on acceptance, partner checks, ranking, pitch and labels)
* **Import v3 (enabler)**: the bookmarklet (box and button now "Trade Desk import v4": old bookmarks keep old code) reads
  this week's Yahoo projection from the roster page's "Proj" column on the team pages it already fetches, and Yahoo's
  rest-of-season projection (import v4, 2026-10-26, path verified on the owner's real Yahoo pages): on each team page
  it follows the link whose text is "Projected Stats", then that page's "Remaining Games" link (found by anchor text,
  never by URL params; links outside `/f1/<league>/` are rejected; 2 extra fetches per team). A value counts only when
  the "Remaining Games" nav `li` carries the class token "Selected" ("Week N" Default-selected is ignored); points =
  "Fan Pts" from every stat table that has it (legend table skipped; K and DEF tables too). "Remaining Games" includes
  the current unplayed week (the stored projWeek), which is what perception divides by. Every step is a
  `step: "projections"` diagnostics entry naming a failure ("no Projected Stats link", "no Remaining Games link",
  "view not selected", "no Fan Pts column", "fetch failed"); yahooProj stays absent on failure, never 0. The overlay
  says "Yahoo projections: N of M players rest of season, W this week". Free agents are not read (trades need rostered
  players only). Fixtures `yahoo-web-team-nav.html`, `yahoo-web-team-proj.html`, `yahoo-web-team-proj-remaining.html`
  are reconstructed from the verified page structure; body-cell alignment is checked on the owner's next import.
* **Payload**: per player optional `yahooProj` (0–450) and `yahooProjWeekly` (0–60), finite numbers, dropped alone when
  invalid (never a guessed 0); old imports unchanged. `buildImportLeague` copies them onto the player override, so
  `Player.yahooProj` reaches every ValuedPlayer.
* **Perceived value** (`server/model/perception.ts`, attached once per valued context in api.ts, cached per player
  object, never serialised): base = yahooProj ÷ his scheduled games from the current week to the league's final week
  (assumption: Yahoo's "remaining season" ends there; if it runs to NFL week 18 the per-game rate reads ~10% high —
  check against yahooProjWeekly on the first real import), else `ValuedPlayer.ecrPts` (projection v4's ECR curve at
  his FantasyPros rank, set even when the projection skipped the anchor), else our effPpg. Rate = 0.7 × base + 0.3 ×
  mean actual points of his last ≤ 3 games inside the last 4 weeks. Weekly = rate in game weeks (estimate: only where our
  model has him available — the rank does not price an absence); Yahoo's weekly number (when captured, either source) replaces the current week.
  Gap = our playoff-weighted rate (value mode weights over his game weeks) − perceived rate. Spike = last game ≥ 5 pts
  and ≥ 1.5 × perceived rate.
* **Their view of a trade**: `perceivedLineupTotal` = Σ over remaining weeks of the optimal lineup on perceived weekly
  points (team strength's greedy `weekLineup`, IR slot excluded, unscaled rosters), after − before, for both sides.
  Card line "What Yahoo shows them: you +x, them −y pts" (source "yahoo" only when every player in the deal was
  captured; else "What Yahoo likely shows them … (estimate)" and a "Their view from" bullet).
* **Acceptance v4** = min(0.95, (0.8 × logistic(their perceived Δ per week; +1 → 0.70) + 0.2 × market curve (+5% → 0.65))
  × 0.7 per player they give right after a spike × 0.85 per extra player × 0.8 for their most valued player × 1.1 when
  it fixes their weakest slot); a perceived loss (rest-of-season Δ < 0 after rounding) caps it at 0.25 and fails the
  partner check ("Yahoo shows them −y pts rest of season") — a near miss, never the main list. Deleted: the market-loss,
  best-player-loss and our-projection lineup-floor partner checks and the overpay divisor (the consolidation premium
  stays).
* **Gem score** = acceptance × (my Δ team strength + 0.25 × min(4, perception gaps in my favour)), team strength = the
  release (b) playoff lineup (+ 0.25 depth). Gate for any list: Δ team strength ≥ 1.0 pt/week (was the mode score;
  fix round 1: a "marginal" near miss — my side fails its bar — needs only Δ > 0);
  the mode score still has to clear +0.5 / main list +1.0. Never sell a riser (unchanged).
* **Cover lost** (`coverLost`): giving my best bench player at a starter's position for that starter's bye week ahead
  (current → final week) with nothing kept or received covering it within 0.5 pts ⇒ "Bye cover lost" bullet; giving my
  only usable QB / TE backup ⇒ "Playoff cover lost". Tag "loses bye cover". Flag only (no score change).
* **Pitch** = reasons for them, ≤ 3: the slot it fills (their weakest), a backup I send who covers a starter's bye they
  keep, their perceived lineup gain ("Yahoo projects your lineup +x pts over the rest of the season", estimate: "the
  projections put …"), recent production of a player they get (≥ 10 pts and ≥ his perceived rate last game); the
  unconfirmed-return bet first. Never a market-value claim (tested on every list and evaluate).
* **Labels**: `bandLabel` / `band` / `fairnessPct` and `FairnessBand` deleted; `lineupLabel` = "Lineup impact: good
  for you (playoffs +x/wk, season +s/wk; them −y/wk season)" (our projections; verdict from the playoff number, fix
  round 1), `marketLabel` = "Market value: they get
  +z%" (help: FantasyCalc, matters only a little), `yahooView`. Row summary: "A for B: playoff lineup +x/wk, your team
  +y. Yahoo shows them +z pts, ~P% accept." Finder headline bullets "Their view" (captured N of M / estimate) and
  "Market values".
* **IR in trades**: an unconfirmed return's `tradeValue` = 0.5 × the 0–100 value of his FULL healthy surplus from current
  week + 4 (was the surplus of half his points, which fell below replacement for most players ⇒ 0); cards say "a bet on
  his recovery". Finder eligibility: superseded by "Injured trade pieces (owner 2026-10-26)".
* **Demo league (2026 cache, week 7, no Yahoo projections → estimate)**: finder 250–410 ms per team (was ~50 ms; the
  perceived lineup runs ~10 greedy week lineups per side per candidate); first three teams 7 / 6 / 5 main-list trades.
* Known gaps: the stat-view URLs and the real markup of the projected view are unverified (diagnostics on the next
  import); Yahoo's projections exist only for rostered players read on import day (no refresh until re-import);
  Yahoo's weekly evaluator may use per-week projections we approximate by an even split; K/DEF perceived = our rate
  (never traded); calibration values (0.8 / 0.2, +1 pt/wk → 0.70, spike 1.5×, gap bonus 0.25) to revisit after the first
  real-league run.
* **Fix round 1 (2026-10-26, adversarial tests 971a642)**: judge3 always computes my playoff-lineup Δ (evaluate showed
  "+0.0/wk" on a losing trade; marginal near misses were all gated out) — clear / edge / refuse / unlikely keep the
  ≥ 1.0 gate, marginal needs > 0. Bench upgrades drop a perceived loss for the partner (same rule as the main list).
  Perception: weeks our model has a flagged (`ret`) player out are 0 on the captured-Yahoo view too, Yahoo's total is
  divided over the games it covers (from `Player.yahooProjWeek`, the capture week; games since played count by bye),
  and a Yahoo 0 stays 0 (no recency). Known gap: a player our model has out all season but Yahoo projects > 0 now
  perceives 0. Import: `StoredImport.projWeek` stamped by the server on POST (never the payload); this week's number
  only while capture week = current week; unknown week (older stored imports — none carry projections, (d) was not
  deployed) drops the weekly number and keeps the total as of the current week (no date→week table to derive it from
  `importedAt`). `yahooCoverage` counts weekly-only captures. `lineupLabel` verdict follows the playoff number.
  Returns: a player ruled out of his next game (this week's report, or his own Out tag via `tagOut`) is never back for
  it on any path (the designated-to-return window could).
  Perf: the finder's search skips the team-strength simulation for a candidate no list can take (`judge3` lazy).

## Injured trade pieces (owner 2026-10-26) — overrides every earlier finder-eligibility rule

Owner: injured players are trade pieces in both directions when he has a few weeks left to play; never one out for
the season. `ineligibleReason` (tradesV3.ts), K/DEF and the QB rule unchanged:
* **Back with a week** (`ret.absent`, `ret.week` set): eligible with ≥ `V3.minGamesBack` = 3 of his games from
  `ret.week` through `finalWeek` (his bye excluded; bye-only, no schedule table). Else "back ~wk N: only n games left".
* **Return unconfirmed** (`ret.week` null): eligible when `ret.tradeValue` > 0 (a bet on his recovery, ½ of healthy)
  and ≥ 3 games from the week that value assumes (current week + 4, or the IR-minimum `earliestWeek` if later).
* **Out for the season**: `ReturnInfo.seasonOver` (projection v4 absence "seasonOver" = injury kind "long" with
  "season" in the detail; without `ret`, the same detail test). The only explicit signal: a Yahoo "IR" with no detail
  is not season-ending (it is a return-unconfirmed bet when it has a trade value).
* The IR slot alone is never a reason. The waiver check (market < 3 and value < 3) uses `tradeValueOf` (tradeValue for
  an unconfirmed return); bench upgrades' "real asset" checks too. Bench upgrades still take only players with games
  left (`tradeable`), so an unconfirmed return is not a bench swap.
* **Roster spots** (`tradeKit.rosterExcess`, used by `applyTrade` and `judge3`): cuts = gets − gives + (players I give
  from my IR slot) − (incoming IR-eligible players that fit my free IR slots). IR-eligible = in the partner's IR slot
  or listed IR / PUP / NFI (conservative; a plain Out tag is not). Lineups still score an incoming player from his
  return week (he is activated then; the later roster crunch is not modelled). Drop cost, the "extra players"
  acceptance factor, "You cut" / "They must cut" follow these cuts.
* **Cards**: every list (main, smaller edges, near misses, bench upgrades, evaluate) has the "Injured, you give / get"
  line (return week, or "a bet on his recovery"); row summaries mark the piece "(injured, back ~wk N)" /
  "(injured, return unconfirmed)" (`markedNames`). The partner's perceived view already has him at 0 in his out
  weeks (fix round 1), tested at trade level. No riser sales and the ≥ 1.0 playoff gain still hold.
* **Search**: every partner is searched (the top-8 early stop hid a real best trade once injured pieces filled the
  first eight).
* **Owner import (week 8, team 4, after the change)**: 18 suggestions, 13 with an injured piece (4 of 6 main, 3 of 5
  smaller edges, 6 of 7 near misses); pieces: two return-unconfirmed players I give; four I get (one return
  unconfirmed, three back ~wk 9–10); bench upgrades still empty. trades2 first call ~0.73 s (was ~0.51 s).
* **Fix round 1 — a returner is never free** (one rule in the shared lineup code, every list and side): a returning
  player's expected weekly points = his healthy rate × availability. Back ~wk N: projection v4's own weekly points from
  wk N (0 before, × 0.85 first game; no confidence factor — that one is stash ranking only). Return unconfirmed
  (superseded by fix round 2 below — the scenario mix replaces the ½-rate weeks):
  `ReturnInfo.expWeekly` = healthy × matchup × 0.5 from current week + 4 (0.1-rounded; `returnValue` / `playoffPts`
  are its sums), added by `rosterScore.weeklyPoints` — so team strength, the roster score (judge3 / teamV3) and cover
  checks count it; projection v4's `weekly` / value stay 0 for him (no double discount; `tradeValue` unchanged). Out for
  the season → 0. IR slot (`activeRoster` → `irSlotView`, test `irSlotReturns`): never this week or bench depth
  (effPpg 0), counts from his return week (he leaves the slot when healthy); no `ret` or out for the season → never.
  Roster cuts (`rosterExcess`) unchanged. Partner's view (`perceive` / `perceivedLineupTotal`): an unconfirmed return
  is our expected points on both sources (Yahoo projects an IR player ~0; the ECR rank does not price a recovery);
  IR-slot players follow the same rule (week 1 always 0). A lineup model only loses the MARGINAL: a ½-rate returner
  below my starters and bench cover costs ~0, by design. Side effect: League tab playoff strength (analysis.ts) counts
  IR-slot returners too.
* **Owner import after fix round 1 (snapshot, team 4)**: the 18 suggestions and every playoff gain are unchanged
  (13 with an injured piece: 11 where I give one, 5 where I get one; distinct pieces still two unconfirmed I give, four
  I get). The owner's example (a healthy RB + an injured RB with return unconfirmed for two RBs) stays +2.8/wk: his expected
  5.9 / 7.2 / 6.6 pts in weeks 15–17 (healthy 12 × ½) sit below my FLEX starters (≥ 9.6) and my bench RB cover
  (7.2–9.0), so he adds nothing to my playoff lineup — the rule prices him and the price is small (trade value 2.4).
  17 detail lines moved (season, team score, Yahoo view "you", their weekly lineup). trades2 first call 0.80 s (old
  code, same run: 0.74 s); analysis payload +0.2 KB. Open: pricing the upside (a 50% chance he is back at full rate and
  starts) would be an option-value rule, not this one — owner's call.
* **Fix round 2 — the scenario mix (Jensen)**: a lineup is a max over players, so averaging an unconfirmed return's
  RATE first (½ × healthy) understated him: a 12-pt returner became a 6-pt player who never beat a 9.6 FLEX, so giving
  him away cost ~0. Now (one rule, `rosterScore` "return scenarios"): E[lineup] = p × lineup(him back at his full
  healthy × matchup from current week + 4) + (1 − p) × lineup(without him), p = `RETURNS.unknownWeight` = ½ (the
  existing unconfirmed convention, exported as `RETURN_BACK_P`). Who: `ret.week` null, absent, not out for the season,
  healthy rate known (`returnBackPoints`). `weeklyPoints` is his "not back" scenario (0); `ReturnInfo.backWeekly`
  (projection v4, replaces `expWeekly`) is the back scenario (0.1-rounded; fixtures without it: healthy rate outside the
  bye from current week + 4). Only weeks where a returner has back points branch. Confirmed returns stay deterministic
  (projection v4 weekly from wk N); out for the season 0; `returnValue` / `playoffPts` / `tradeValue` unchanged (stash
  ranking, IR hold line, finder eligibility).
  - **k returners on one roster**: k ≤ `EXACT_RETURNS` = 2 → exact 2^k mix per week. Beyond 2: the two with the most
    back points (ties by id) are mixed exactly, the rest count at their expected points p × back (deterministic). This
    is bounded — never below the all-½ lineup, never above the exact 2^k mix (true for the optimal lineup, which is convex in the players'
    points; the greedy matches it in the tested cases). A marginal-sum alternative (Σ each player's mix over a common base) was rejected: with three 12-pt
    returners competing for one slot it gives 15 > the 12 any lineup can hold.
  - **Where**: `rosterParts` (roster score: judge3 / teamV3, season and playoff columns; "now" and bench depth never
    branch — he is out this week), `teamStrength` (lineup, and depth = each scenario's bench cover weighted by its
    probability; via `mixedWeekLineup`), `perceivedLineupTotal` (the partner's view: perceived weekly is his "not back"
    0 on both sources, the back scenario is our points on both — Yahoo projects an IR player ~0 and the experts' rank
    does not price a recovery). League tab playoff strength (analysis.ts) follows via `teamStrength`. Per-player
    comparisons (bye cover lost / their bye cover) use `expectedWeeklyPoints` = weekly + p × (back − weekly), never
    inside a lineup max.
  - Tests: 12-pt over a 9.6 FLEX → ½ × 2.4 per playoff week (team strength, roster score, perceived view, trade
    level with a 10-pt starter → ½ × 2); a returner who starts at any rate → ½ × his rate; depth weighting; k = 3 / 4
    inside [all-½, exact]; roster score = team strength for k = 1–3; confirmed return 77 (unchanged); season over 0.
* **Owner import after fix round 2 (snapshot, team 4)**: the owner's example (a healthy RB + an injured RB with return
  unconfirmed for two RBs) +2.8 → +2.0/wk in weeks 15–17 (season +2.5 → +2.0; Yahoo view "you" −6.3 → −11.7): his
  12-pt back scenario starts in my playoff lineup, so giving him away now costs ~0.8/wk. Still 18 suggestions; with an
  injured piece 13 → 12; where I give an unconfirmed-return player 11 → 11 (the set changed: pairs of two unconfirmed
  pieces now appear, single-for-single swaps of them dropped); the top gains fell 0.4–1.4/wk (my kept returners now fill some of the slots an incoming player would). trades2 first call
  0.77–0.79 s (same run, old code 0.75 s; budget 1.2 s): `weekLineup` now reads each player's points once, which paid
  for the 2–4 lineups per affected week (1.21 s before that).
* Known gaps: the later roster crunch when an IR-slot player returns (someone must be cut) is not modelled; our rate
  for the perception gap (`ourRate`) still excludes an unconfirmed return's expected weeks. Yahoo's IR-slot
  eligibility list is not verified (docs not checked); the set above is the conservative one.

## Fix: one playoff engine + small-sample prior (2026-10-27)

* **One playoff engine**: a trade card showed "playoff lineup +3.1/wk" (team strength) next to "Playoffs +0.5/wk"
  (roster score) for the same trade. Cause: `rosterParts` multiplied every column by the v3.1 floor factor
  (0.8 × ppg + 0.2 × floor), `teamStrength` scores plain expected points (on a real-league roster 129.3 vs 136.2 pts/wk;
  without the factor 136.23 = 136.2). Now the floor factor applies only to the "now" column (this week's lineup and
  bench depth); the weekly columns (season, playoffs, return scenarios) are projection v4 weekly points, so
  `parts.playoffs` = `teamStrength(...).lineup` on the same active roster (tested on every demo team, ≤ 0.05).
  Season and the finder's mode scores follow (volatile players are no longer discounted there).
* **Trade card labels**: summary, "Lineup impact" label and the "Playoff lineup" bullet all show the lineup delta
  (`myParts.playoffs`); the team-strength total the finder ranks and gates on (`strengthDelta` ≥ `V3.minMyGain`) is
  its own bullet "Playoff strength: +x pts/wk (lineup + 0.25 × bench cover)"; the duplicate "Playoffs" bullet is gone.
* **Small-sample prior**: last season's rate (≥ `priorMinGames` games) entered the model rate as `V4.priorK` = 2
  pseudo-games whatever this season's sample. A 3-game player (one flagged) was then ~75% this season. Now the prior
  weighs `max(V4.priorK, V4.priorKSmall − sample games)` pseudo-games, `priorKSmall` = 8 (calibration value): 2.25
  sample games → 5.75, ≥ 6 games → 2 (unchanged, so risers and breakouts with full samples keep their rate; rookies
  have no prior), and never more than the prior season's own games (fix round 2: a 4-game 2025 counts as ≤ 4). The
  why-line "2025: x pts/game, counts as N games" shows the actual weight. Test: a 3-game 10-ppg
  player with an 18-ppg prior moves ≥ 1 pt toward it; a 7-game player is unchanged.
* **Cover lost counts FLEX starters**: "Playoff cover lost: X is your only TE backup" ignored a TE starting at W/R/T.
  Now a same-position starter in a FLEX-type slot counts as a backup (the claim needs every such player given and none
  received); for a starter's bye he moves over and the FLEX is refilled from the bench, so the bye cover is the best
  bench player eligible for that FLEX slot, as for a FLEX starter's own bye (giving a bench TE while a TE plays FLEX
  loses no bye cover; giving the best bench RB while an RB plays FLEX still does). Giving the FLEX mate himself is a
  lost bye cover when the best same-position player left is > 0.5 pts below him that week (fix round 2).
* **Expected touchdowns regress (per opportunity, fix round 2)**: TD rate is the noisiest part of fantasy scoring.
  Per kind — passing TDs per attempt (league pass-TD points, e.g. 4), rushing TDs per carry, receiving TDs per target
  (`tdRegression.ts`, pure) — this season's expected TDs per opportunity (recency-weighted) are pulled toward a
  baseline per opportunity with `V4.tdK` = 8 games × his own opportunity rate of weight, then multiplied by his current
  opportunity rate: regressed/g = (n × xTD/g + tdK × baseline/opp × opp/g) / (n + tdK), n = sample games (unflagged 1,
  flagged 0.25). Baseline = last season's ACTUAL TDs per opportunity when he played ≥ `priorMinGames` (prior
  opportunities summed from ep_weekly), else the position's mean ACTUAL TDs per opportunity this season over the
  games of players with ≥ `priorMinGames` games, his own games left out. Scaling the baseline to this year's volume
  keeps a grown role from being dragged to last year's per-game TDs; a kind he has no opportunity at gets a 0
  baseline. Unknown opportunities (player-DB priors, fixtures) fall back to per-game rates. Not applied: no prior and
  fewer than `priorMinGames` sample games (a 1-game backup QB is no longer lifted to the QB average), the actual-points
  fallback, K / DEF. The non-TD part, finishing, the prior blend and the ECR anchor are unchanged. Why-line
  "Touchdowns: 0.97 expected/g regressed to 0.88 (last season 0.83)" — the baseline shown is per game at this year's
  volume. Fix round 1 regressed per game toward the position's mean EXPECTED TDs (mismatched with the actual prior;
  lifted 1-game backups ~+5 pts/g) — replaced. Tests: tdRegression.test.ts (role growth, per-kind points, skip rule,
  leave-one-out baseline), projectionV4.test.ts, fix1027.adversarial.test.ts.

## Fix: role-change prior + mode-aware listing (2026-10-27)

* **Role change exempts the small-sample prior boost** (`projectionV4.ts` `isRoleUp`, `priorWeight`): a backup who
  became his team's lead back (≈ 19% snaps, then 56–84% with 17–25 carries) lost ~0.7 pts/g because his small 2026
  sample gave his backup-role 2025 prior `priorKSmall` weight. Now, when this season's recency-weighted expected
  pts/game, TD part regressed (a one-off goal-line spike is not a new role), is ≥ `V4.roleUpRatio` (1.5) × last
  season's expected pts/game on ≥ `V4.roleUpMinGames` (2) unflagged games, the prior keeps only `V4.priorK` = 2
  pseudo-games (still ≤ the prior's own games). Falling or steady usage with a tiny sample (an injury-shortened season)
  and one fill-in start keep the boost; rookies have no prior; the actual-points fallback is not tested for a role
  change. Why-line: "2025: 3.3 pts/game, counts as 2.8 games (role grew: 15.2 vs 3.5 expected/g)".
* **TD regression checked, unchanged**: the baseline is per opportunity and is multiplied by this season's volume, so
  a grown role is not dragged to last season's per-game TDs. For the lead-back case the remaining TD pull comes from
  his very high expected TDs (1.47/g regressed to 1.15), not from the small role: his 2025 TD rate per carry is above
  the RB average (the position baseline, 0.64/g at his volume, would regress him to 0.97, harder than 1.15), so
  swapping the baseline or capping its pseudo-carries would not help him. Not changed.
* **Mode-aware listing** (`tradesV3.ts` `modeGain`, `listsInMode`): the finder's lists used `strengthDelta ≥
  V3.minMyGain` in every mode. Now each mode lists on its own measure (owner: a deal that helps now but not in the
  playoffs — injured-now players who return before the playoffs, sold for one healthy player — may list in Win now /
  Balanced, never in Playoffs):
  * Playoffs: playoff strength (team strength, lineup + 0.25 × bench cover) ≥ `minMyGain`.
  * Balanced: the mode's team score (`myDelta`: MODE_WEIGHTS of now / season / playoffs / depth, minus slot-loss
    aversion) ≥ `minMyGain`, and playoff strength ≥ `V3.playoffFloor.balanced` (−0.5).
  * Win now: the Win-now team score (`myDelta` under now weights: this week's lineup + 0.15 × depth − slot loss) ≥
    `minMyGain`, and playoff strength ≥ `V3.playoffFloor.now` (−1.0): never a deal that wrecks the playoffs.
  * Marginal near misses need the same mode gain > 0 and the same floor; smaller edges and the main list share the
    gate. The rank score is (mode gain + gap bonus) × acceptance (Playoffs: unchanged). Evaluate adds one bullet
    "<Mode> bar: clears / fails: …"; the Trade Finder's "How they're ranked" help names the mode's bar.
* **Fix round 1 (tester f1a1571)**:
  * Role change bar = max(`roleUpRatio` × last season's expected pts/game, last season's + `V4.roleUpMinGain` (3));
    last season's must be > 0 (a zero-usage player never reads "role grew: 0.0 vs 0.0").
  * The rate AND each of his last `roleUpMinGames` (2) unflagged games' expected points must clear the bar: the
    recency-weighted rate alone let 3 backup games + one fill-in start read as a role change.
  * The listing bar compares the 0.1-rounded gain, the number the card prints (a +0.96 team score no longer reads
    "fails: team score +1.0 (needs +1.0)"); a marginal near miss needs a rounded gain > 0 (no "+0.0" near misses).
  * Evaluate's "<Mode> bar" bullet is green only when the verdict is Accept, else neutral (it is one bar of several).
  * Win now help: the "now" part is the lineup's average points per game from now on (missed games counted, the
    availability-weighted rate), plus a little bench depth — not literally this week's points.

## Available-player projections (2026-10-28) — import v6; overrides "Waivers v3" on K / DEF streaming

Before: available players carried no Yahoo projection, so K / DEF streaming fell back to season numbers and called
almost every K / DEF "pass".

* **Bookmarklet** (`web/src/import/bookmarklet.ts` `readListProj`): after the available-player lists (K, DEF first,
  then offense), the first page of each list is searched for the players page's "Stats" control by visible text
  (`yahooHtml.ts` `findStatsView`, `LIST_VIEW`): "Week N (proj)" (seen on the real site: owner screenshot, DEF list,
  column "Fan Pts") and, only if present, "Remaining/Rest of Season (proj)" ("Season (proj)" includes played weeks
  and is never read). Several projected weeks → the lowest N (the current week). The URL comes only from the markup:
  an `<a href>`; an `<option>` whose value / data-url is a same-league URL; or a named `<select>` inside a GET
  `<form>` → the form's action with the list page's own params, the form's other fields and `<select name>=<value>`
  (what submitting the form sends). POST form, no form, unnamed select, other league → a note, nothing fetched.
  Paging repeats the list's own `count=` param, at most as many pages as the list showed players on: ≤ 2 extra fetches
  (week + rest of season) per list page, so ~2 each for K and DEF and up to ~12 for a full offense list.
* **Fail closed**: `parseListProjectionHtml` reads "Fan Pts" only when the fetched page shows exactly that view as
  selected (`<option selected>` or a selected link); otherwise "Fan Pts" might be actual points and nothing is kept.
  Week ≤ 60, rest of season ≤ 450, plain numbers only. A Yahoo markup change degrades to "absent", never to wrong
  numbers. Each step writes a `faProjections` diagnostics entry (`candidates`, `view`, `how`, `field` / `value`,
  `url`, `viewIndicator`, `note`); a summary entry counts `week` / `ros` and names the view read. The overlay says
  "N available players with this week's projection". Rostered defenses now get this week's "Proj" too (by team).
* **Payload / server**: `freeAgents[].yahooProjWeekly` / `yahooProj` optional; `validateImport` keeps them under the
  rostered-player bounds and drops an unusable one with a `{ step: "validate", level: "warning" }` diagnostics entry
  (never 0). `importFreeAgents` applies `projectionsFor` (same rule as rosters: this week's number only while the
  server's capture week `projWeek` is the current week). The week N the bookmarklet read is not sent; verify it
  equals the stored `projWeek` on the owner's re-import (diagnostics `view` vs `projWeek`).
* **Waivers** (`waivers.ts` `KDEF_STREAM`, `WeekStream`): when the free agent and every non-IR K / DEF of mine carry
  this week's Yahoo projection, `gain` = his projection − my best one (none of mine → his projection) and the row
  carries `weekStream { proj, mine, gain, best, opponent? }` (`weekOpponent` from the weekly consensus file).
  Free agent with gain ≥ `KDEF_STREAM.minGain` (1.0) → optional ("Best DEF stream this week (@ NYJ): Yahoo proj 7.1
  vs your 4.0."); on waivers or unknown → pass (never priority); smaller → pass "Not a streaming upgrade this week".
  The best free stream per position (highest projection) is `best`, named in the advice line ("stream X (DEF) this
  week") and in the rules ("Best DEF this week"). The same constant gates the call and the name. Missing on either
  side → the season-number call as before, with "(no weekly projection)" and a "This week (Yahoo)" detail.
* **UI**: K / DEF rows show a "wk 7.1" chip ("wk —" when not captured) with a why tooltip; the tapped details show a
  "This week" tile. Rows stay one line.
* **Unverified**: the real players-page markup (form vs links, option values, selected marker). Check on the owner's
  next v6 import: the `faProjections` entries' `how`, `url`, `viewIndicator` and `note`.

## Fix: vacated role, spikes, depth and roster need (2026-10-28) — overrides "Waivers v2" / "Breakout Targets" where they differ

Owner (week 8 Waivers): the top claims were a TE3 whose targets went 0 → 5 in ONE game the week the team's WR2 was out,
a WR4 with one 87%-snap fill-in game on a bottom-3 offense, and a TE2 behind a healthy TE1; a TE "bench upgrade" was
optional with three TEs rostered; claim rows showed VALUE 0.0 / GAIN 0.0. Trades had the same root cause (an RB's one
big game valued as a breakout).

* **Borrowed (vacated) role** (`signals/vacated.ts` `vacatedGames`, the one definition; projection v4 and breakouts
  both call it): a game is vacated when a same-team teammate in his competing group (WR/TE share targets; RBs share
  carries + targets), still on the team, with more prior usage (mean before that week ≥ his + `VACATED.minMargin` and ≥
  `minUsage` 4 targets / 8 touches) did not play or left early (< 15% snaps after ≥ 50%), AND his own usage jumped (≥
  max(1.5 × his earlier mean, + 2)), AND every earlier game of his in that absence stretch was a jump too (an absence
  that began before a quiet game does not explain a later jump). No earlier game of his = unknown, never flagged.
  * Signals: `GameFlags.vacated` (not part of `isFlagged`: still a real game in the sample and the trend); the game
    weighs `VACATED.weight` (0.4) in the rates; `PlayerSignals.vacated` keeps the weeks, who was out and the full-weight
    expected rate. The role-change exemption (`isRoleUp`) ignores vacated games.
  * Projection v4: per remaining week, × min(2, full ÷ settled rate) while the teammate is out (the full rate is the
    same model, prior and ECR anchor with the borrowed games at full weight, so it never exceeds the old rate) (his return week from
    `returns.ts`; unknown return / no team = out for good → every week), 1 after: the projection reverts to the
    pre-absence role once he is back. Why-lines "Borrowed role: usage rose while X was out (wk 7): counts 40%" and
    "While he is out: ×1.25 for 3 games (X back wk 10)".
* **One-game spike** (`usageShape`, expected pts per game): elevated = ≥ max(1.25 × the mean before the last 3 games
  (none: the lowest of the window), that mean + 1.5, 0.5 × the window's best game). Sustained = elevated in ≥ 2 of the
  last 3 (a borrowed game counts 0.4 while its teammate is back or due back); a spike = a jump that is not sustained.
  Projection: an isolated elevated game in the last 3 has its recency capped at `SPIKE.maxRecency` (0.5, as if 2 games
  old); why-line "One-game jump: wk 7 counts like a game 2 weeks old". Exempt: a climbing opportunity share (trend.ts
  steps + slope rule without the flex-level bar: WOPR / weighted touches up 3 straight unflagged games) is a breakout,
  not a spike (acceptance: a WR whose target share rose 3 games then broke out keeps his value).
* **Role check** (`roleCheck.ts`, `RoleCheck` on every breakout target and `WaiverBreakout.role`): sustained / spike,
  borrowed role (+ back?), depth-chart rank (chart order) and effective rank (minus players ahead who are Out / D / IR
  / PUP / suspended: the chart "moved him up"), share with the starters healthy (targets, RB touches; last 4 games
  without a borrowed role, ≥ 2 games else unknown), team offense (skill players' actual fantasy pts per team game,
  ranked of 32, ≥ 3 team weeks else unknown). `futureStarterBlock` (order): borrowed role whose teammate is back →
  spike → not sustained → effective rank below starter level (TE2+ / WR4+ / RB3+) → share below `ROLE_ENV.minShare`
  (RB 20% / WR 15% / TE 12%; × 1.25 on a bottom-8 offense). Unknown inputs never block. All shown in details (depth
  rank, share, offense, borrowed role, one-game jump; "Unknown" when missing).
* **Calls**: a would-be future starter that is blocked → stash "Watch, not a claim: one strong game, not a role yet
  (breakout score 78)." Breakouts' "rising" tier excludes spikes and borrowed roles (tags "one-game jump", "borrowed
  role"). Snaps overrule the depth chart only when he out-snaps the player ahead by ≥ 15 points in ≥ 2 of his last 3
  games, counting only games that player played (≥ 15% snaps).
* **Roster need** (`rankWaivers` `coverAt`): my starters fill every slot of his position (FLEX-type starters at that
  position count) and a bench player there projects ≥ his pts/game → a role claim (future starter / top-3 at a need),
  stash or bench-only add is pass "Trade chip only: you start 2 TEs and X covers (9.8 vs his 8.6 ppg)." A lineup-gain
  claim is never downgraded. A bench-only add that projects above my cover reads "Better TE cover than X (11.4 vs 9.8
  ppg), dropping Y."
* **Rows**: `gainNote` (gain ≈ 0, not a K/DEF stream) / `valueNote` (value ≈ 0, below replacement) → the Waivers tab
  shows "—" with the note as tooltip in both layouts.
* **Weak position line** (`weakPositions`, `gapLines`; response `gaps`): the analysis needs plus my worst-ranked
  QB/RB/WR/TE group when it ranks in the bottom half; if no row there adds lineup points and the best free agent does
  not measure above my weakest starter there (Yahoo week projection when both have one, else our pts/game), one line
  "RB: no free agent beats yours (best: X 7.3 this week vs your W/R/T2 9.6). Look at trades."
* **Not done**: "buy the high" acceptance (the partner's view of a spike, `perception.ts` ×0.7) is unchanged. The depth
  chart is one snapshot, so "moved up" means injured players ahead, not a change between snapshots. An RB whose lead
  back was out but who had the larger prior role himself is not a borrowed role by definition (spike rule + TD
  regression apply).

### Fix round 1 (2026-10-28) — overrides the section above where they differ

Adversarial review found the borrowed-role discount and the spike cap hitting settled starters and players who took
over a role for good. Decisions (coordinator):

* **The inherited role is his** unless the teammate comes back inside the projection window. The discount applies only
  while EVERY teammate he filled in for plays again or has a known return week (`returns.ts`, always ≤ the final week).
  Out for the season, no return week, or gone from the team → projection v4 uses his signals without detection
  (`PlayerSignals.vacated.own`): no 40% weight, the role-change exemption (`isRoleUp`) sees those games. Why-lines
  "Borrowed role: … counts in full" and "While he is out: the role is his: X has no return week this season (return
  unknown)". Role check: those weeks stay in his share; the detail reads "…: no return week, the role is his"; no
  "borrowed role" tag.
* **A bigger role needs evidence** (`vacatedGames`): the teammate's usage comes from ≥ `VACATED.mateMinGames` (2) of
  his games for the team before that week, else last season's per-game opportunities with ≥ 4 games
  (`VacPlayer.prior`, signals path only: the player DB has no prior opportunities, so breakouts treat a one-game
  teammate as unknown). A one-game sample is unknown → no flag. Only games for his CURRENT team count. A player who
  missed his team's game right before the stretch is back from his own absence → not borrowed.
* **One spike definition** (`usageShape`, called by signals AND `roleCheck`, enforced by a test that feeds the same
  series to both): elevated = ≥ max(1.25 × base, base + 1.5, 0.5 × the best EARLIER game of the window) — a bigger
  latest game never makes an earlier one look less elevated; a higher game followed by a game below the base did not
  hold (unless he left that game early, < 15% snaps); a climb (both steps of the last 3 up ≥ `SPIKE.climbStep` 1 pt,
  latest elevated, no discounted borrowed game) is sustained. The trend.ts opportunity exemption in signals is gone
  (it could not run in the role check).
* **Settled roles never spike**: QBs, and mean snap share ≥ `SPIKE.settledSnap` (65%) over the last 4 games with a
  known share (≥ 2; games under 15% snaps = left early, ignored). A spike that is also a borrowed game takes the
  stronger single discount (`recencyWeights`: min(cap, recency × 0.4)), never the product.
* **Riser's share**: when his usage is sustained, the share with the starters healthy uses his last
  `ROLE_ENV.riserShareGames` (2) games; `RoleCheck.shareGames` says which (detail "last 2 games").
* **Cover must be available**: a bench player Out / Doubtful / IR / PUP / suspended or due back after this week is not
  cover. **A better cover is not a pickup**: at a position where my starters and an available cover are rostered, a
  free agent is offered only if he would start over one of my starters there (lineup gain, or ppg above my weakest
  starter at that position incl. FLEX); else pass "Trade chip only: you start 2 TEs and X covers; he would not start
  (11.4 vs your FLEX1 14.6 ppg)." The "Better TE cover than X" call above is removed.
* **Weak-position line**: one measure for both sides — Yahoo's week projection when every starter there and a free
  agent have one, else pts/game — and the weakest starter is picked on that same measure.
