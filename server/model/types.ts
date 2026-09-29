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
  injury?: { status: string; detail?: string; week: number };
  /** Rest-of-season expert consensus rank (FantasyPros, PPR overall). */
  ecrOverall?: number;
  ecrPos?: number;
  /** This week's FantasyPros consensus projected points (PPR). */
  weekProj?: number;
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
  ppg26: number; // actual PPG this season under league scoring
  ppgExp26: number; // expected PPG this season (opportunity-based)
  ppg25: number; // prior season PPG
  games: number; // games played this season
  vorp: number; // ppg above positional replacement
  value: number; // trade value, 0-100 scale
  posRank: number; // by projected ppg within position
  remainingGames: number;
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
}

export interface Team {
  id: string;
  name: string;
  owner: string;
  playerIds: string[]; // internal player ids
  unmatched: string[]; // names we could not map to our player db
  record?: { wins: number; losses: number; ties: number; pointsFor?: number };
}

export interface League {
  provider: "yahoo" | "sleeper" | "demo";
  id: string;
  settings: LeagueSettings;
  teams: Team[];
  myTeamId?: string;
  fetchedAt: string;
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
}

export interface TradeSide {
  teamId: string;
  gives: ValuedPlayer[];
  valueGiven: number;
  lineupDelta: number; // starter ppg change for this team
  lineupChanges: string[]; // human-readable slot changes
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
}
