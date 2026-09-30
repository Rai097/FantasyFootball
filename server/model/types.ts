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
  /** Expected pts/game over the last 2 weeks minus season expected pts/game. */
  trend: number;
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

export interface Team {
  id: string;
  name: string;
  owner: string;
  playerIds: string[]; // internal player ids
  unmatched: string[]; // names we could not map to our player db
  record?: { wins: number; losses: number; ties: number; pointsFor?: number };
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
  /** Power-rank score: 0.7*starterPpg + 0.3*(sum of top-3 bench vorp). */
  powerScore: number;
  /** Remaining week -> number of current starters on bye. */
  byeExposure: Record<number, number>;
  /** Human-readable injury notes for rostered players. */
  injuryFlags: string[];
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
   * Trade Finder v2 roster-score deltas (1 decimal). scoreDelta is the mode-weighted
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
  summary: string;
  tags: string[];
  /** Explanation of deltas, fairness and acceptance. */
  why: string;
  /** Trade Finder v2 mode the trade was scored under. */
  mode?: "now" | "balanced" | "playoffs";
  /** Near misses only: why the trade did not make the main list. */
  reason?: string;
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
  /** One or two sentences on what the finder found and why the list is short when it is. */
  summary: string;
}

export interface WaiverTarget extends ValuedPlayer {
  gain: number; // starter ppg gain if added (and `drop` released)
  benchGain: number; // value - dropped value
  drop: ValuedPlayer | null;
  trend: number;
  /** Last-week snap share minus average of earlier weeks (0..1 scale). */
  snapTrend: number;
  recommendation: "claim" | "wait" | "optional" | "pass";
  why: string;
  onWaivers: boolean;
  percentOwned?: number;
  /** Ranking score: max(gain*3, benchGain/10). */
  rankScore: number;
}
