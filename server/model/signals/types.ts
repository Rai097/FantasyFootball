// Model v4 player signals: input and output shapes (docs/DESIGN.md "Model v4", section 1 + amendments).
// Inputs are built by server/data/signalTables.ts from cached nflverse / ffopportunity files.
import type { Position, StatLine } from "../types.js";

export type SkillPos = Extract<Position, "QB" | "RB" | "WR" | "TE">;
export const SKILL_POS: readonly SkillPos[] = ["QB", "RB", "WR", "TE"];

/** Team totals of one team-week (ep_weekly, all players of `posteam`). */
export interface TeamTotals {
  targets: number;
  airYards: number;
  carries: number;
}

/** One game a player appeared in (an ep_weekly row and/or offensive snaps). */
export interface PlayerGame {
  week: number;
  gameId: string;
  team: string;
  targets: number;
  carries: number;
  airYards: number;
  passAttempts: number;
  actual: StatLine;
  expected: StatLine;
  /** Team totals that week; undefined when the team had no ep_weekly rows. */
  teamTotals?: TeamTotals;
  /** Offensive snap share 0..1; undefined when the snap file has no row / id mapping (unknown, never 0). */
  snapShare?: number;
  /** Final margin from this player's team's view (positive = his team won); undefined when unknown. */
  teamMargin?: number;
  /** gsis id of the QB who started this game for his team (games.csv, fallback most pass attempts). */
  starterQbId?: string;
  /** gsis id of the team's most frequent starting QB this season. */
  usualQbId?: string;
}

/** Injury report / practice participation for one week. */
export interface StatusWeek {
  week: number;
  report?: string; // Out | Questionable | Doubtful
  practice?: string; // Full / Limited / Did Not Participate In Practice
}

export interface RosterInfo {
  status?: string; // ACT, RES, INA, DEV, CUT, ...
  birthDate?: string; // YYYY-MM-DD
  draftNumber?: number; // overall pick; undefined = undrafted / unknown
  rookieYear?: number;
  pos?: string;
  team?: string;
  name?: string;
}

/** Last season's regular-season totals (ep_weekly season-1). */
export interface PriorSeason {
  games: number;
  actual: StatLine;
  expected: StatLine;
}

export interface PlayerSignalInput {
  id: string;
  name: string;
  pos: SkillPos;
  team: string;
  /** This season's games, any order (sorted by week internally). */
  games: PlayerGame[];
  roster?: RosterInfo;
  status: StatusWeek[];
  prior?: PriorSeason;
}

export interface GameFlags {
  qbOut: boolean;
  leftEarly: boolean;
  blowout: boolean;
}

export interface WeekOpportunity {
  targetShare?: number;
  airShare?: number;
  wopr?: number;
  weightedOpp: number;
  snapShare?: number;
  expPts: number;
  actPts: number;
}

export interface WeekSignal extends WeekOpportunity {
  week: number;
  gameId: string;
  team: string;
  flags: GameFlags;
  flagged: boolean;
  /** Recency weight × context weight (0.25 when flagged). */
  weight: number;
}

export type RateKey = keyof WeekOpportunity;
export type Rates = Record<RateKey, number | null>;

export interface Luck {
  /** Recency-weighted expected − actual points per game (league scoring). Positive = under-producing usage. */
  points: number;
  /** Part of `points` from touchdowns: expected TD points − actual TD points per game. */
  tdPart: number;
  /** Remainder: yardage, receptions, interceptions, 2-pt, fumbles. */
  yardagePart: number;
  /** Season count: actual TDs − expected TDs (unweighted). */
  tdsOverExpected: number;
  driver: "td" | "yardage";
}

export interface Efficiency {
  /** Weighted actual / expected points. */
  raw: number;
  /** Shrunk toward 1.0 with pseudo-count k games, then capped per position. */
  shrunk: number;
  /** Effective sample size (sum of weights). */
  n: number;
}

export interface Trend {
  metric: "wopr" | "weightedOpp";
  /** Least-squares slope per game over the last 3 unflagged games. */
  slope: number;
  rising: boolean;
  weeks: number[];
}

export interface TalentPrior {
  priorGames: number;
  priorExpPpg: number | null;
  priorActPpg: number | null;
  age: number | null;
  ageRising: boolean | null;
  rookie: boolean;
  /** Overall draft pick for rookies; null when not a rookie or undrafted. */
  draftNumber: number | null;
}

export interface PlayerSignals {
  id: string;
  name: string;
  pos: SkillPos;
  team: string;
  weeks: WeekSignal[];
  /** Recency-weighted rates (half-life 2 games, flagged games × 0.25); null = no data. */
  rates: Rates;
  /** Plain unweighted season means; null = no data. */
  seasonAvg: Rates;
  /** Recency-weighted snap share ≥ 50%; null when snaps are unknown. */
  halfSnaps: boolean | null;
  luck: Luck | null;
  efficiency: Efficiency | null;
  trend: Trend | null;
  talent: TalentPrior;
  rosterStatus?: string;
  status: StatusWeek[];
}
