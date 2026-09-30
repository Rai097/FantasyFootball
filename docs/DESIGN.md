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
orders teams by `0.7·starterPpg + 0.3·benchValue/10`, ties by record.
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
POST /api/league/:provider/:id/trade/evaluate  { team, partner, give: string[], get: string[] } → Trade & { verdict: string }
GET  /api/league/:provider/:id/waivers?team=ID → { freeAgents: WaiverTarget[], myPriority?: number, numTeams, advice: string }
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

**Power rank** = 0.7·starterPpg + 0.3·(sum of top-3 bench vorp).

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
