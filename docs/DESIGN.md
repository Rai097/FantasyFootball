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
server/model/projection.ts   ValuedPlayer computation for a league
server/model/lineup.ts       optimal lineup + slot eligibility
server/model/analysis.ts     TeamAnalysis for every team, power ranks, needs/surplus
server/model/trades.ts       trade finder + evaluator
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

## Value model (server/model/projection.ts)

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

## Trade finder (server/model/trades.ts)

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
GET  /api/league/:provider/:id/trades?team=ID&partner=&wantPos=&maxGive=2&maxGet=2 → Trade[]
GET  /api/league/:provider/:id/trades2?team=ID&mode=now|balanced|playoffs&partner=&wantPos=&maxGive=2&maxGet=2
       → { trades: Trade[] (clear wins), smallerEdges: Trade[], nearMisses: (Trade & { reason })[], mode, summary: string }   (UI uses this)
GET  /api/league/:provider/:id/bench-upgrades?team=ID&mode= → Trade[] (≤ 15 one-for-one bench swaps)
POST /api/league/:provider/:id/trade/evaluate  { team, partner, give: string[], get: string[], mode? } → Trade & { verdict: string }  (v2 scoring)
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

## Trade finder v2 (server/model/rosterScore.ts, tradesV2.ts) — overrides "Trade finder" for trades2 / evaluate

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

**Eligible pieces**: no K/DEF; not (market < 3 and value < 3); not IR / long-term / out ≥ 4 weeks. QBs only
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
half) × my bench surplus (vorp, capped) plus the reverse, plus the QB case. Top 8 partners searched first
(pools: top 14 eligible by max(market, true); 1–2 per side; 3-for-1 only when I give quantity to a team at
≤ 1/3 wins); the rest only if < 6 main-list trades were found.
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
       partners: [{ teamId, complementarity, pitch }] }; Trade gains band, bandLabel, fairnessPct, pitch, notes, packages
POST /api/league/:provider/:id/trade/evaluate → v3 Trade & { verdict } (band, acceptance; flags pieces outside the rules)
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
* **Lineup**: `optimalLineup(slots, roster, { injuryRisk: true })` ranks and totals starters on the injury-risk rate
  (`injuryRisk.ts`: Q 0.85 / D 0.70 / O 0.55, shared with trades). Used by team analysis (My Team, power ranks, group
  ranks) for every team; IR-slotted players (`Team.irPlayerIds`) never start (`LineupOptions.irIds`, see "Power score
  v2"). `LineupSlot.riskFactor` marks discounted starters; the UI shows "×0.85 · check status".
  Trade and waiver lineups are unchanged; `value` is unchanged.

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
