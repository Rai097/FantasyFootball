// Team strength (docs/DESIGN.md "Model v4" section 3, release (b)): what a roster is worth in the fantasy playoffs.
//  - lineup: expected points per week of the optimal starting lineup in the playoff weeks (rosterScore.weeklyPoints:
//    projection v4 weekly; IR-slot players from their return week, irSlotView); an unconfirmed return enters through
//    the scenario mix (rosterScore "return scenarios": p × lineup with him back + (1 − p) × lineup without him);
//  - depth: the points the bench recovers, per week, when one random starter is out (mean over starters and weeks of
//    lineup-without-him − (lineup − his points)), each return scenario weighted by its probability;
//  - total = lineup + DEPTH_WEIGHT × depth. Pure: rosters in, numbers out.
import type { LeagueSettings, ValuedPlayer } from "./types.js";
import { SLOT_ELIGIBILITY } from "./lineup.js";
import { activeRoster, fillOrder, returnSplit, scenarioPoints, weekScenarios, weeklyPoints, type ReturnSplit } from "./rosterScore.js";

/** Weight of the depth term (calibration value; the roster score's depth weight in playoffs mode is also 0.25). */
export const DEPTH_WEIGHT = 0.25;

export interface TeamStrength {
  /** Optimal playoff lineup, points per week. */
  lineup: number;
  /** Bench cover for one injured starter, points per week. */
  depth: number;
  total: number;
  /** The playoff weeks still ahead (empty after the season: all numbers 0). */
  weeks: number[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Greedy optimal lineup for one week (same fill order as optimalLineup): total points and the starters. */
export function weekLineup(order: ReturnType<typeof fillOrder>, roster: ValuedPlayer[], pts: (p: ValuedPlayer) => number): { total: number; starters: ValuedPlayer[] } {
  // Points read once per player (the comparator would call pts twice per comparison).
  const vals = roster.map(pts);
  const idx = roster.map((_, k) => k).sort((a, b) => vals[b] - vals[a] || (roster[a].id < roster[b].id ? -1 : 1));
  const used = new Uint8Array(roster.length);
  const starters: ValuedPlayer[] = [];
  let total = 0;
  for (const slot of order) {
    const elig = SLOT_ELIGIBILITY[slot];
    const k = idx.find((j) => !used[j] && elig.includes(roster[j].pos));
    if (k === undefined) continue;
    used[k] = 1;
    starters.push(roster[k]);
    total += vals[k];
  }
  return { total, starters };
}

/**
 * Expected greedy lineup total of remaining week i over the return scenarios (rosterScore "return scenarios"):
 * Σ prob × weekLineup with each unconfirmed return back or not. `base` = a player's points when not back (team
 * strength: weeklyPoints; the partner's view: perceived weekly). `each` (optional) sees every scenario's lineup.
 */
export function mixedWeekLineup(
  order: ReturnType<typeof fillOrder>,
  roster: ValuedPlayer[],
  split: ReturnSplit,
  i: number,
  base: (p: ValuedPlayer) => number,
  each?: (prob: number, full: { total: number; starters: ValuedPlayer[] }, pts: (p: ValuedPlayer) => number) => void,
): number {
  let total = 0;
  for (const sc of weekScenarios(split, i)) {
    const pts = split.branch.length || split.fixed.size ? (p: ValuedPlayer) => scenarioPoints(split, i, sc, p, base(p)) : base;
    const full = weekLineup(order, roster, pts);
    total += sc.prob * full.total;
    each?.(sc.prob, full, pts);
  }
  return total;
}

export function teamStrength(S: LeagueSettings, roster: ValuedPlayer[], irIds: ReadonlySet<string> = new Set()): TeamStrength {
  const weeks: number[] = [];
  for (let w = Math.max(S.currentWeek, S.regularSeasonEnd + 1); w <= S.finalWeek; w++) weeks.push(w);
  const active = activeRoster(roster, irIds);
  if (!weeks.length || !active.length) return { lineup: 0, depth: 0, total: 0, weeks };
  const order = fillOrder(S.slots);
  let lineupSum = 0;
  let recovered = 0;
  let cases = 0;
  const split = returnSplit(S, active);
  for (const w of weeks) {
    const i = w - S.currentWeek;
    lineupSum += mixedWeekLineup(order, active, split, i, (p) => weeklyPoints(p, S)[i] ?? 0, (prob, full, pts) => {
      for (const s of full.starters) {
        const without = weekLineup(order, active.filter((p) => p.id !== s.id), pts);
        recovered += prob * (without.total - (full.total - pts(s)));
        cases += prob;
      }
    });
  }
  const lineup = lineupSum / weeks.length;
  const depth = cases ? recovered / cases : 0;
  return { lineup: r1(lineup), depth: r1(depth), total: r1(lineup + DEPTH_WEIGHT * depth), weeks };
}
