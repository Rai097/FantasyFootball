// Roster score: the team objective used by Trade Finder v2. See docs/DESIGN.md "Trade finder v2".
import type { LeagueSettings, Position, SlotKind, ValuedPlayer } from "./types.js";
import { effPpg, isStartingSlot, optimalLineup, SLOT_ELIGIBILITY, usable, type LineupResult } from "./lineup.js";

export type TradeMode = "now" | "balanced" | "playoffs";
export const TRADE_MODES: TradeMode[] = ["now", "balanced", "playoffs"];

export interface ScoreWeights {
  now: number;
  season: number;
  playoffs: number;
  depth: number;
}

/** Weights per finder mode (architect's Trade Finder v2 design). */
export const MODE_WEIGHTS: Record<TradeMode, ScoreWeights> = {
  now: { now: 1, season: 0, playoffs: 0, depth: 0.15 },
  balanced: { now: 0.4, season: 0.4, playoffs: 0.2, depth: 0.25 },
  playoffs: { now: 0.15, season: 0.25, playoffs: 0.6, depth: 0.25 },
};

export const MODE_BLURB: Record<TradeMode, string> = {
  now: "Win now: this week's starting lineup, with a little credit for bench depth.",
  balanced: "Balanced: this week, the rest of the season (byes and injuries included) and the playoffs.",
  playoffs: "Playoffs: your lineup in the playoff weeks first, then the rest of the season.",
};

export function parseMode(x: unknown): TradeMode {
  const s = String(x ?? "").toLowerCase();
  return (TRADE_MODES as string[]).includes(s) ? (s as TradeMode) : "balanced";
}

export interface ScoreParts {
  /** Optimal-lineup effPpg sum (= starterPpg). */
  now: number;
  /** Mean weekly optimal-lineup points over every remaining week (byes / injuries applied). */
  season: number;
  /** Mean weekly optimal-lineup points over the playoff weeks. */
  playoffs: number;
  /** Top-K bench players' ppg above positional replacement. */
  depth: number;
}

export interface RosterScore extends ScoreParts {
  lineup: LineupResult;
}

export const combine = (p: ScoreParts, w: ScoreWeights) => w.now * p.now + w.season * p.season + w.playoffs * p.playoffs + w.depth * p.depth;

export type Replacement = Partial<Record<Position, number>>;

/** Weeks the score looks at, and which of them are playoff weeks. */
export function scoreWeeks(S: LeagueSettings): { weeks: number[]; playoff: boolean[] } {
  const weeks: number[] = [];
  const playoff: boolean[] = [];
  for (let w = S.currentWeek; w <= S.finalWeek; w++) {
    weeks.push(w);
    playoff.push(w > S.regularSeasonEnd);
  }
  return { weeks, playoff };
}

const weeklyCache = new WeakMap<LeagueSettings, WeakMap<ValuedPlayer, Float64Array>>();

/**
 * Expected points per remaining week: 0 on the bye; healthy ppg otherwise, with the
 * games the injury model removed (weeksLeft − remainingGames) taken from the earliest weeks.
 */
export function weeklyPoints(p: ValuedPlayer, S: LeagueSettings): Float64Array {
  let byS = weeklyCache.get(S);
  if (!byS) weeklyCache.set(S, (byS = new WeakMap()));
  const hit = byS.get(p);
  if (hit) return hit;
  const n = Math.max(0, S.finalWeek - S.currentWeek + 1);
  const out = new Float64Array(n);
  if (usable(p)) {
    let weeksLeft = 0;
    for (let w = S.currentWeek; w <= S.finalWeek; w++) if (p.bye !== w) weeksLeft++;
    let missing = Math.max(0, weeksLeft - p.remainingGames);
    for (let i = 0; i < n; i++) {
      const w = S.currentWeek + i;
      if (p.bye === w) continue;
      const miss = Math.min(1, missing);
      missing -= miss;
      out[i] = p.ppg * (1 - miss);
    }
  }
  byS.set(p, out);
  return out;
}

const FILL_ORDER: SlotKind[] = ["QB", "RB", "WR", "TE", "K", "DEF", "WRRB", "RFLEX", "FLEX", "SFLEX"];

/** Starting slots in greedy fill order (same order as optimalLineup). */
export function fillOrder(slots: SlotKind[]): SlotKind[] {
  const starting = slots.filter(isStartingSlot);
  return FILL_ORDER.flatMap((k) => starting.filter((s) => s === k));
}

/** Greedy optimal-lineup points for week index `wi`, using weekly points. */
function weekLineup(order: SlotKind[], roster: ValuedPlayer[], pts: Float64Array[], wi: number, used: Uint8Array): number {
  used.fill(0);
  let total = 0;
  for (const s of order) {
    const elig = SLOT_ELIGIBILITY[s];
    let best = -1;
    let bestPts = -1;
    for (let j = 0; j < roster.length; j++) {
      if (used[j] || !elig.includes(roster[j].pos)) continue;
      const v = pts[j][wi];
      if (v > bestPts) {
        bestPts = v;
        best = j;
      }
    }
    if (best >= 0) {
      used[best] = 1;
      total += bestPts;
    }
  }
  return total;
}

/** Bench players counted for depth: ceil(starting skill slots / 2), at least 3. */
export function depthCount(slots: SlotKind[]): number {
  const skill = slots.filter((s) => isStartingSlot(s) && s !== "K" && s !== "DEF").length;
  return Math.max(3, Math.ceil(skill / 2));
}

/** Score any roster under league settings. `lineup` may be passed when already computed. */
export function rosterScore(S: LeagueSettings, roster: ValuedPlayer[], replacement: Replacement = {}, lineup?: LineupResult): RosterScore {
  const lu = lineup ?? optimalLineup(S.slots, roster);
  const order = fillOrder(S.slots);
  const pts = roster.map((p) => weeklyPoints(p, S));
  const { weeks, playoff } = scoreWeeks(S);
  const used = new Uint8Array(roster.length);
  let seasonSum = 0;
  let poSum = 0;
  let poN = 0;
  for (let i = 0; i < weeks.length; i++) {
    const v = weekLineup(order, roster, pts, i, used);
    seasonSum += v;
    if (playoff[i]) {
      poSum += v;
      poN++;
    }
  }
  const K = depthCount(S.slots);
  const depth = lu.bench
    .filter((p) => p.pos !== "K" && p.pos !== "DEF")
    .map((p) => Math.max(0, effPpg(p) - (replacement[p.pos] ?? 0)))
    .sort((a, b) => b - a)
    .slice(0, K)
    .reduce((a, b) => a + b, 0);
  return {
    lineup: lu,
    now: lu.starterPpg,
    season: weeks.length ? seasonSum / weeks.length : lu.starterPpg,
    playoffs: poN ? poSum / poN : weeks.length ? seasonSum / weeks.length : lu.starterPpg,
    depth,
  };
}

export function partsDelta(after: ScoreParts, before: ScoreParts): ScoreParts {
  return { now: after.now - before.now, season: after.season - before.season, playoffs: after.playoffs - before.playoffs, depth: after.depth - before.depth };
}
