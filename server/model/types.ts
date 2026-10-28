// Shared types between server and web. Keep this file dependency-free.

export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DEF";
export const SKILL_POSITIONS: Position[] = ["QB", "RB", "WR", "TE"];

/** Per-unit fantasy scoring. Normalised across Yahoo / Sleeper / demo. */
export interface Scoring {
  passYd: number;
  passTd: number;
  passInt: number;
  rushYd: number;
  rushTd: number;
  rec: number;
  recYd: number;
  recTd: number;
  twoPt: number;
  fumLost: number;
  /** Extra points per reception for tight ends (TE premium). */
  teRec: number;
}

export interface StatLine {
  passYd: number;
  passTd: number;
  passInt: number;
  rushYd: number;
  rushTd: number;
  rec: number;
  recYd: number;
  recTd: number;
  twoPt: number;
  fumLost: number;
}

export interface WeekLine {
  season: number;
  week: number;
  team: string;
  actual: StatLine;
  expected: StatLine;
  /** Raw opportunity that week (ffopportunity): targets (rec_attempt), carries (rush_attempt), receiving air yards. */
  opp?: { targets: number; carries: number; airYards: number };
}

export interface PlayerIds {
  gsis?: string;
  sleeper?: string;
  espn?: string;
  yahoo?: string;
  fantasypros?: string;
}

export interface Player {
  id: string; // internal id: gsis id when known, otherwise "fp:<id>" / "yahoo:<id>" etc.
  name: string;
  pos: Position;
  team: string; // NFL team abbreviation, "FA" if none
  age?: number;
  ids: PlayerIds;
  bye?: number;
  /** Fantasy-eligible positions from the league provider (e.g. Yahoo "WR,RB"), when known. */
  eligible?: Position[];
  injury?: { status: string; detail?: string; week: number };
  /** Rest-of-season expert consensus rank (FantasyPros, PPR overall). */
  ecrOverall?: number;
  ecrPos?: number;
  /** This week's FantasyPros consensus projected points (PPR). */
  weekProj?: number;
  /** This week's projected points per scoring format, when the source has them. */
  weekProjByFormat?: { std?: number; half?: number; ppr?: number };
  weekOpponent?: string;
  /** Offensive snap share by week, current season. */
  snapShare: Record<number, number>;
  /** Dynasty trade value (DynastyProcess, 1QB / superflex). */
  dynasty?: { value1qb: number; value2qb: number };
  weeks: WeekLine[]; // current season
  prior: { games: number; line: StatLine } | null; // previous season totals
  headshot?: string;
  /** Yahoo's projected fantasy points for the rest of the season (league scoring), captured by the import bookmarklet. */
  yahooProj?: number;
  /** Yahoo's projected fantasy points for the current week, captured by the import bookmarklet (set only while the
   *  capture week is the current NFL week: a stale weekly number is dropped). */
  yahooProjWeekly?: number;
  /** NFL week the rest-of-season total starts at (the capture week); unset = the current week (unknown age). */
  yahooProjWeek?: number;
}

/** Player + league-specific numbers. */
export interface ValuedPlayer extends Player {
  ppg: number; // projected points per game rest-of-season, league scoring
  /**
   * Availability-adjusted ppg used for lineups: ppg × remainingGames / weeksLeft
   * (weeksLeft = weeks to finalWeek minus the bye). Equals ppg for healthy players.
   * Always set by the server; optional only so hand-made fixtures stay valid.
   */
  effPpg?: number;
  ppg26: number; // actual PPG this season under league scoring
  ppgExp26: number; // expected PPG this season (opportunity-based)
  ppg25: number; // prior season PPG
  games: number; // games played this season
  vorp: number; // ppg above positional replacement
  value: number; // trade value, 0-100 scale
  posRank: number; // by projected ppg within position
  remainingGames: number;
  /** One-sentence explanation of how ppg and value were derived. */
  why: string;
  /** The same explanation as short "label: value" items (UI bullets). Set by the valuation; optional for fixtures. */
  whyItems?: DetailItem[];
  /** Expected pts/game over the last 2 weeks minus season expected pts/game. */
  trend: number;
  /**
   * Market (perceived) trade value, 0-100 with the market's #1 = 100 (FantasyCalc redraft values
   * for the league's format). 0 = outside the market's list. Unset when market values are
   * unavailable (valueSource "model") and for K / DEF.
   */
  market?: number;
  /** Market overall rank / position rank (unset when the player is not in the market list). */
  marketRank?: number;
  marketPosRank?: number;
  /**
   * Our value on the market's scale: the market value at the player's rank by our `value`
   * (quantile mapping; our value curve is steeper than the market's). Set with `market`.
   */
  trueMarket?: number;
  /** True when the market list omits a player we rank inside it: `market` is then our trueMarket (no edge). */
  marketEstimated?: boolean;
  /** trueMarket − market (positive = the market undervalues him); set with `market`. */
  edge?: number;
  /** 25th percentile of weekly league-scored actual points (prior + current season, ≥ 6 games). */
  floor?: number;
  /** floor / mean weekly points (0..1; higher = steadier). */
  consistency?: number;
  /** Opportunity trend rising (Model v4 signals: WOPR / weighted touches up 3 straight games, beyond his noise, at flex level). */
  riser?: boolean;
  // ---- Projection v4 (always set by the server; optional so hand-made fixtures stay valid)
  /** Projected points per remaining week, weeks weeklyFrom..finalWeek (0 = no game, or not available). */
  weekly?: number[];
  /** First week of `weekly` (the league's current week). */
  weeklyFrom?: number;
  /** Σ weekly over the rest of the regular season / over the playoff weeks. */
  seasonPts?: number;
  playoffPts?: number;
  /** Value weighting used for `value`: playoffs (playoff weeks 75%) or balanced (every week the same). */
  valueMode?: "playoffs" | "balanced";
  /** Recency-weighted expected − actual points per game (+ = he is due for more by his usage); unset = unknown. */
  luck?: number;
  /** Part of `luck` from touchdowns. */
  luckTd?: number;
  /** buy-low (luck ≥ +2) / sell-high (luck ≤ −2, TD-driven), see labels.ts. */
  label?: "buy-low" | "sell-high";
  /**
   * Availability v4 applied to his game in the CURRENT week when an injury report discounts it (Questionable 0.85 /
   * Doubtful 0.7 / Out 0). Unset when healthy, on a bye, or when his next game is in a later week.
   */
  availThisWeek?: number;
  /**
   * Release (c) return estimate: set for absent players (reserve list, designated to return, ruled out, suspended)
   * and for flex-level players with 0 snaps in their team's last 2 games. Unset for everyone else.
   */
  ret?: ReturnInfo;
  /** Points per game the FantasyPros rest-of-season rank stands for (projection v4's ECR curve); unset = unranked. */
  ecrPts?: number;
}

/** Return estimate + stash numbers (server/model/returns.ts, projectionV4.ts). */
export interface ReturnInfo {
  /** Week of his first game back; null = return unconfirmed (never guessed). */
  week: number | null;
  confidence: "high" | "medium" | "low" | "unknown";
  /** Evidence bullets (≤ 90 chars). */
  reasons: DetailItem[];
  /** true = absent per the reports; false = not listed but no snaps in his team's last 2+ games. */
  absent: boolean;
  /** Out for the season per the report (injury detail says "season", projection v4 absence "seasonOver"): never a trade piece. */
  seasonOver?: true;
  /** Practice participation improved this week (about to become a waiver fight). */
  practiceUp: boolean;
  /** Earliest week under the IR minimum, when it binds. */
  earliestWeek?: number;
  /** Healthy-role rate (pts/game, league scoring) and its source; unset = unknown. */
  healthyRate?: number;
  healthySource?: "season" | "prior";
  /** Only when week is null: healthy rate × games from current week + 4 × 0.5. Stash ranking and the IR "hold" line only. */
  returnValue?: number;
  /** Points in the playoff weeks on his return at the healthy rate (unknown return: × 0.5). */
  playoffPts?: number;
  /** Playoff-weighted points from the return week (playoff weeks 1.0, earlier 0.33, × confidence): stash rank. */
  stashScore?: number;
  /** 0–100 trade value from returnValue (week null, absent only): what trades use instead of 0. */
  tradeValue?: number;
  /**
   * Only when week is null (absent, not out for the season, healthy rate known): his points per remaining week IF he
   * is back (weeks currentWeek..finalWeek, 0.1-rounded) = healthy rate × matchup from current week + 4, 0 before and on
   * byes. Lineups, team strength and the partner's view mix this scenario with probability RETURNS.unknownWeight
   * against "not back" (owner 2026-10-26, injured trade pieces fix round 2, rosterScore "return scenarios");
   * returnValue / playoffPts are sums of r1(back × 0.5). `weekly` stays 0 (value is not discounted twice).
   */
  backWeekly?: number[];
}

export type SlotKind = "QB" | "RB" | "WR" | "TE" | "K" | "DEF" | "FLEX" | "SFLEX" | "RFLEX" | "WRRB" | "BN" | "IR";

export interface LeagueSettings {
  name: string;
  season: number;
  currentWeek: number;
  /** Last week of the fantasy regular season (playoffs start the week after). */
  regularSeasonEnd: number;
  /** Final week that matters (last playoff week). */
  finalWeek: number;
  numTeams: number;
  slots: SlotKind[]; // starting slots + BN/IR
  scoring: Scoring;
  isDynasty: boolean;
  /** Last week in which trades are allowed (trade finder returns [] afterwards). */
  tradeDeadlineWeek?: number;
  /** Free-agent budget waivers instead of a rolling priority list. */
  usesFaab?: boolean;
  faabBudget?: number;
}

export interface TeamRecord {
  wins: number;
  losses: number;
  ties: number;
  pointsFor?: number;
  pointsAgainst?: number;
  /** Standings rank (1 = first). */
  rank?: number;
  /** Current streak as Yahoo shows it, e.g. "W3" / "L1". */
  streak?: string;
  /** Playoff seed, when the standings page shows one. */
  seed?: number;
}

export interface Team {
  id: string;
  name: string;
  owner: string;
  playerIds: string[]; // internal player ids
  unmatched: string[]; // names we could not map to our player db
  /** Season record. Points and the extras are absent when the source did not show them (unknown, never 0). */
  record?: TeamRecord;
  /** Place in the league's rolling waiver order (1 = first claim), when the import captured it. */
  waiverRank?: number;
  /** Players currently parked in an IR/IL slot (never suggested as drops). */
  irPlayerIds?: string[];
  /** Remaining FAAB budget, when the league uses FAAB. */
  faabRemaining?: number;
}

/** Extra facts about a league imported from Yahoo's web pages (provider "import"). */
export interface ImportMeta {
  /** Where settings came from: read from Yahoo's page, partly read, Yahoo defaults, or edited by the user. */
  settingsSource: "page" | "partial" | "default" | "user";
  importedAt: string;
  waiverPriority?: number;
  /** Yahoo league number, when imported by the bookmarklet. */
  leagueId?: string;
  /** Who ran the latest import (Discord display name, "Admin" in dev mode); absent on older imports. */
  importedBy?: string;
}

export interface League {
  provider: "yahoo" | "sleeper" | "demo" | "import";
  id: string;
  settings: LeagueSettings;
  teams: Team[];
  myTeamId?: string;
  fetchedAt: string;
  /** Present for provider "import" only. */
  import?: ImportMeta;
}

export interface LineupSlot {
  slot: SlotKind;
  player: ValuedPlayer | null;
  /**
   * Projection v4's availability for this starter's game THIS week when it is discounted (Questionable 0.85 /
   * Doubtful 0.7 / Out 0); absent otherwise. Display only ("check status" chip): weekly / effPpg already include it.
   */
  riskFactor?: number;
}

export interface TeamAnalysis {
  team: Team;
  lineup: LineupSlot[];
  bench: ValuedPlayer[];
  starterPpg: number;
  benchValue: number;
  totalValue: number;
  /** Starter ppg per position group and league rank (1 = best). */
  groups: Record<string, { ppg: number; rank: number; count: number; leagueAvg: number }>;
  needs: string[];
  surplus: string[];
  powerRank: number;
  /** Power-rank score: 0.7 × starterPpg + 0.3 × resultsPpg (starterPpg when results are unknown). */
  powerScore: number;
  /** Actual fantasy points per game this season (pointsFor / games); null = unknown (no standings). */
  resultsPpg: number | null;
  /** Sum of the top-3 playable bench players' VORP, IR excluded. Power-rank tie-breaker only. */
  benchStrength: number;
  /** Remaining week -> number of current starters on bye. */
  byeExposure: Record<number, number>;
  /** Human-readable injury notes for rostered players. */
  injuryFlags: string[];
  /**
   * Playoff lineup strength (teamStrength.ts): optimal weeks 15–17 lineup pts/week (IR slot excluded), bench cover for
   * one injured starter, total = lineup + 0.25 × depth. Optional so hand-made fixtures stay valid.
   */
  playoffStrength?: { lineup: number; depth: number; total: number; weeks: number[] };
}

export interface TradeSide {
  teamId: string;
  gives: ValuedPlayer[];
  valueGiven: number;
  lineupDelta: number; // starter ppg change for this team
  lineupChanges: string[]; // human-readable slot changes
  /** Players this side must release to stay at roster size (lowest-value bench). */
  drops?: ValuedPlayer[];
  /**
   * Trade Finder roster-score deltas (1 decimal). scoreDelta is the mode-weighted
   * total for me and the "balanced" total for the partner. Set by trades2, bench-upgrades
   * and evaluate; optional so older clients / fixtures stay valid.
   */
  scoreDelta?: number;
  /** Optimal-lineup ppg change this week (= lineupDelta, 1 decimal). */
  nowDelta?: number;
  /** Mean weekly lineup points over all remaining weeks (byes / injuries applied). */
  seasonDelta?: number;
  /** Mean weekly lineup points over the playoff weeks. */
  playoffDelta?: number;
  /** Top bench players' ppg above replacement. */
  depthDelta?: number;
}

export interface Trade {
  key: string;
  me: TradeSide;
  them: TradeSide;
  fairness: number; // value they receive / value they give
  acceptance: number; // 0..1 rough likelihood partner accepts
  score: number;
  /** Row text: "A for B: your team +x, their lineup +y pts/wk. Fair, ~62% accept." (≤ 255 chars, 1–2 sentences). */
  summary: string;
  /** v3 / bench upgrades / evaluate: the full analysis, one short "label: value" item per fact (shown on tap). */
  details?: DetailItem[];
  tags: string[];
  /** Trade Finder mode the trade was scored under. */
  mode?: "now" | "balanced" | "playoffs";
  /** Near misses only: why the trade did not make the main list. */
  reason?: string;
  // ---- Trade Finder v3 (market-value packages); optional so hand-made fixtures stay valid.
  /** "Lineup impact: good for you (playoffs +1.3/wk, season +0.0/wk; them −0.3/wk season)" — our projections; the
   *  verdict follows my playoff-lineup change. */
  lineupLabel?: string;
  /** "Market value: they get +16%" — FantasyCalc package values (a minor part of acceptance). */
  marketLabel?: string;
  /**
   * The rest-of-season lineup change Yahoo's evaluator would show (perceived values): you / them in total points,
   * source "yahoo" when every player in the deal has a captured Yahoo projection, else "estimate".
   */
  yahooView?: { you: number; them: number; source: "yahoo" | "estimate"; label: string };
  /** One line I could paste to the other manager. */
  pitch?: string;
  /** Package values (best + 0.85·second + 0.70·third), market and true, net of drop cost on the receiving side. */
  packages?: { marketGive: number; marketGet: number; trueGive: number; trueGet: number; myTrueChange: number; theirMarketChange: number };
}

/** GET /trades2 response. */
export interface TradeFinderResult {
  /** Clear wins: my team score +1.0 or more at ≥ 45% acceptance, best first (my delta × acceptance). */
  trades: Trade[];
  /** Trades that clear the bar (+0.5 team score or +0.75 this week) but add < 1.0; collapsed in the UI. */
  smallerEdges: Trade[];
  /** Up to 10 trades that just missed (partner would likely refuse, or marginal for me), each with `reason`. */
  nearMisses: Trade[];
  mode: "now" | "balanced" | "playoffs";
  /** One short line on what the finder found (≤ 255 chars); the reasons are in `summaryDetails`. */
  summary: string;
  /** v3: mode, weakest spot, best fits, why the list is empty, value source — one item each (shown on tap). */
  summaryDetails?: DetailItem[];
  /** v3: where perceived (market) values came from; "model" = FantasyCalc unavailable, our values used. */
  valueSource?: "fantasycalc" | "model";
  /** v3: partners ranked by roster complementarity (best first). */
  partners?: { teamId: string; complementarity: number; summary: string; details: DetailItem[] }[];
}

/** One line of a details panel: a short label and a short value (≤ ~90 chars, one idea, never a paragraph). */
export interface DetailItem {
  label: string;
  value: string;
  /** Optional colour hint for the value. */
  tone?: "pos" | "neg" | "warn";
}

export type StashCall = "add" | "claim-cheap" | "check";

/** One Stash watch row (GET /waivers `stash`): a ≤ 255-char summary + short bullets; numbers carry their own "why". */
export interface StashRow {
  id: string;
  name: string;
  pos: Position;
  team: string;
  injury?: ValuedPlayer["injury"];
  /** "Name · POS · TEAM · back ~wk N (conf) · playoff value X". */
  summary: string;
  call: StashCall;
  callText: string;
  availability: Availability;
  /** "practice upgrade: about to become a waiver fight" when his practice improved this week. */
  flag?: string;
  backWeek: number | null;
  confidence: ReturnInfo["confidence"];
  /** Points in weeks 15–17 on his return (unconfirmed return: × 0.5). */
  playoffPts: number;
  /** Healthy-role pts/game. */
  healthyRate: number;
  /** Rank score: playoff weeks 1.0, earlier weeks 0.33, × return confidence. */
  stashScore: number;
  details: DetailItem[];
}

/** Where a free agent sits on Yahoo: free to add now, on waivers (needs a claim), or not captured (old import). */
export type Availability = "fa" | "waivers" | "unknown";

export interface WaiverTarget extends Omit<ValuedPlayer, "why"> {
  gain: number; // starter ppg gain if added (and `drop` released)
  /** Set when `gain` is not the point of the call (≈ 0): the UI shows "—" with this tooltip instead of 0.0. */
  gainNote?: string;
  /** Set when `value` is ≈ 0 (below replacement): the UI shows "—" with this tooltip. */
  valueNote?: string;
  benchGain: number; // value - dropped value
  drop: ValuedPlayer | null;
  trend: number;
  /** Last-week snap share minus average of earlier weeks (0..1 scale). */
  snapTrend: number;
  /** stash = not a lineup upgrade yet, but his role is rising (Breakout Targets signal). */
  recommendation: "claim" | "optional" | "stash" | "wait" | "pass";
  /** 1–2 plain sentences, ≤ 255 chars, most important fact first (the row text). */
  summary: string;
  /** The full analysis, one short item per line (shown when the row is tapped). */
  details: DetailItem[];
  /** true = needs a claim (also when unknown: the safe assumption). */
  onWaivers: boolean;
  availability: Availability;
  percentOwned?: number;
  /** Ranking score: max(gain*3, benchGain/10). */
  rankScore: number;
  /** Breakout Targets signal for this free agent, when he is in that pool. */
  breakout?: WaiverBreakout;
  /** K / DEF only, when both he and my K / DEF carry this week's Yahoo projection (waivers.ts WeekStream). */
  weekStream?: { proj: number; mine: number | null; gain: number; best: boolean; opponent?: string };
}

/**
 * One row of GET /waivers: only what the Waivers tab renders (the full WaiverTarget carries weekly stat lines
 * and a whole ValuedPlayer as `drop`, ~7 KB a row; this is well under 1 KB).
 */
export type WaiverRow = Pick<
  WaiverTarget,
  "id" | "name" | "pos" | "team" | "injury" | "ppg" | "value" | "gain" | "gainNote" | "valueNote" | "benchGain" | "recommendation" | "summary" | "details" | "onWaivers" | "availability" | "percentOwned" | "rankScore"
> & {
  drop: { id: string; name: string; pos: Position; value: number } | null;
  breakout?: Omit<WaiverBreakout, "thesis">;
  weekStream?: WaiverTarget["weekStream"];
  /** This week's Yahoo projection (K / DEF rows), when captured. */
  yahooProjWeekly?: number;
};

/** The part of a BreakoutTarget the waivers module uses. */
export interface WaiverBreakout {
  tier: "rising" | "stash";
  /** 0..100 breakout score. */
  score: number;
  /** 0 / 0.5 / 1: how open his path to a bigger role is. */
  situation: number;
  /** Mean expected fantasy points over the last 2 weeks (league scoring). */
  oppLevel: number;
  thesis: string;
  /** Is the jump a real role (spike, borrowed role, depth chart, share, offense)? Absent = not checked (old callers). */
  role?: RoleCheck;
}

/** Breakout Targets (GET /breakouts): a player whose role is rising before his fantasy points have. */
export interface BreakoutAhead {
  id: string;
  name: string;
  /** Depth-chart order (1 = first at the position), when known. */
  depth?: number;
  /** Injury report status (Questionable / Doubtful / Out / IR …). */
  status?: string;
  detail?: string;
  /** Last-week snap share minus the mean of earlier weeks (0..1 scale). */
  snapTrend: number;
  /** Latest snap share (0..1). */
  snapsNow?: number;
  /** Under 15% snaps last week after ≥ 50% before: probably left the game hurt. */
  leftEarly?: boolean;
}

export interface BreakoutComponents {
  /** Latest-week offensive snap share (0..1). */
  roleNow: number;
  /** Last-week snap share − mean of earlier weeks (0..1 scale; 0 with < 2 weeks). */
  roleTrend: number;
  /** Last-week expected points − mean of earlier weeks (league scoring). */
  oppTrend: number;
  /** Mean expected points over the last 2 weeks (league scoring). */
  oppLevel: number;
  /** Expected ppg − actual ppg this season (positive = producing less than usage suggests). */
  gap: number;
  /** 0, 0.5 (handcuff / committee / WR3 rising / TE1 in waiting / starter left early) or 1 (starter hurt / slipping / promoted). */
  situation: number;
  /** Market value < 15 (our value < 12 without a market). Not scored; used by the "cheap only" filter. */
  cheap: boolean;
  /** Our trade value (0-100) and the market value when a market source is connected. */
  value: number;
  marketValue?: number;
  /** Positional rank by actual ppg this season, ECR positional rank, and the difference (production − ECR). */
  prodRank: number;
  ecrPos?: number;
  ecrEdge?: number;
  age?: number;
  /** Tie-break only: 0.7·clamp(ecrEdge/24) + 0.3·(age ≤ 26). */
  upside: number;
  /** Normalised (0..1 within position over the candidate pool) inputs. */
  nRoleTrend: number;
  nOppTrend: number;
  nOppLevel: number;
  nGap: number;
  /** Weighted contributions to the score (sum × 100 = score). */
  parts: { roleTrend: number; oppTrend: number; oppLevel: number; gap: number; situation: number };
}

/**
 * Is a usage jump a real role? (roleCheck.ts; DESIGN "Fix: vacated role, spikes, depth and roster need (2026-10-28)").
 * Missing inputs are unknown (undefined), never a block.
 */
export interface RoleCheck {
  /** Higher usage in ≥ 2 of the last 3 games (a borrowed-role game counts VACATED.weight while the teammate is back / due back). */
  sustained: boolean;
  /** The latest jump is one game only: watch, never a claim. */
  spike: boolean;
  /** Borrowed role: the weeks, who was out, and whether he is back (playing, or a return week is known). */
  vacated?: { weeks: number[]; by: string[]; back: boolean };
  /** Depth-chart rank (chart order, not snaps) and the rank after players ahead who are out; undefined = unknown. */
  chartRank?: number;
  chartEffective?: number;
  /** Effective rank below starter level (TE2+ / WR4+ / RB3+); undefined = chart unknown. */
  belowStarter?: boolean;
  /** Target share (RB: share of team carries + targets) in his last games with the teammates healthy; undefined = unknown. */
  healthyShare?: number;
  /** Team offense: skill players' fantasy pts/game (league scoring) and rank (1 = best) of `of` teams; undefined = unknown. */
  offense?: { ppg: number; rank: number; of: number };
}

export interface BreakoutTarget {
  player: ValuedPlayer;
  where: { type: "fa" } | { type: "roster"; teamId: string; teamName: string };
  /** "rising": ≥ 7 expected pts/g last 2 weeks (TE 4.5) or ≥ 50% snaps; "stash": everyone else in the pool. */
  tier: "rising" | "stash";
  /** 0..100 = 100 × (0.25·nRoleTrend + 0.25·nOppTrend + 0.20·nOppLevel + 0.15·nGap + 0.15·situation). */
  score: number;
  components: BreakoutComponents;
  /** Week labels for the per-week arrays below (weeks the player appeared). */
  weeks: number[];
  snaps: number[];
  expPpg: number[];
  actPpg: number[];
  /** Targets (WR/TE) or carries + targets (RB) per week, when the opportunity columns exist. */
  touches?: number[];
  /** "RB2", "WR3" … from the depth chart (or snap order when the chart is missing). */
  depthLabel?: string;
  /** Depth-chart slot when snap shares overruled it (e.g. listed "TE4" but out-snapping the TE ahead). */
  chartSays?: string;
  ahead: BreakoutAhead[];
  tags: string[];
  /** Is the jump a real role (roleCheck.ts). */
  role: RoleCheck;
  /** Prose thesis; server-only (the waivers module splits it into items). Not in the /breakouts response. */
  thesis: string;
  /** Row text: role + usage, then the move (≤ 255 chars, 2 sentences). */
  summary: string;
  /** One fact per item: depth chart, who is ahead, weekly snaps / touches, price, score parts, the offer. */
  details: DetailItem[];
  /** Short move: "Offer X (value 6.0)" / "Free agent: waivers call claim". */
  ask?: string;
}

export interface BreakoutResult {
  targets: BreakoutTarget[];
  /** "How it's scored": one rule per item. */
  how: DetailItem[];
}

/** The slim player a card row needs (no weekly stat lines): what PlayerChip and the bullets render. */
export type CardPlayer = Pick<ValuedPlayer, "id" | "name" | "pos" | "team" | "value" | "ppg" | "injury" | "whyItems">;

/**
 * GET /values row: only what the Values tab renders (no weekly stat lines, prose why or ids; ~1 MB → < 250 KB).
 * `edge` is unset when the market value is missing or estimated (the UI shows "—", never 0).
 */
export type ValueRow = Pick<
  ValuedPlayer,
  "id" | "name" | "pos" | "team" | "injury" | "value" | "market" | "marketRank" | "marketEstimated" | "edge" | "ppg" | "ppg26" | "ppgExp26" | "games" | "posRank" | "ecrOverall" | "luck" | "label" | "whyItems"
> & { ownerTeamId?: string; rostered: boolean };

/** GET /breakouts row: no prose thesis, slim player. */
export type BreakoutTargetRow = Omit<BreakoutTarget, "thesis" | "player"> & { player: CardPlayer };
export interface BreakoutResponse {
  targets: BreakoutTargetRow[];
  how: DetailItem[];
}
