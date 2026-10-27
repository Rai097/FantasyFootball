// Team strength (docs/DESIGN.md "Model v4" section 3, release (b)): what a roster is worth in the fantasy playoffs.
//  - lineup: expected points per week of the optimal starting lineup in the playoff weeks (projection v4 weekly
//    points; players in the team's IR slot excluded);
//  - depth: the points the bench recovers, per week, when one random starter is out (mean over starters and weeks of
//    lineup-without-him − (lineup − his points));
//  - total = lineup + DEPTH_WEIGHT × depth. Pure: rosters in, numbers out.
import type { LeagueSettings, ValuedPlayer } from "./types.js";
import { SLOT_ELIGIBILITY } from "./lineup.js";
import { fillOrder, weeklyPoints } from "./rosterScore.js";

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
  const sorted = [...roster].sort((a, b) => pts(b) - pts(a) || (a.id < b.id ? -1 : 1));
  const used = new Set<string>();
  const starters: ValuedPlayer[] = [];
  let total = 0;
  for (const slot of order) {
    const pick = sorted.find((p) => !used.has(p.id) && SLOT_ELIGIBILITY[slot].includes(p.pos));
    if (!pick) continue;
    used.add(pick.id);
    starters.push(pick);
    total += pts(pick);
  }
  return { total, starters };
}

export function teamStrength(S: LeagueSettings, roster: ValuedPlayer[], irIds: ReadonlySet<string> = new Set()): TeamStrength {
  const weeks: number[] = [];
  for (let w = Math.max(S.currentWeek, S.regularSeasonEnd + 1); w <= S.finalWeek; w++) weeks.push(w);
  const active = roster.filter((p) => !irIds.has(p.id));
  if (!weeks.length || !active.length) return { lineup: 0, depth: 0, total: 0, weeks };
  const order = fillOrder(S.slots);
  let lineupSum = 0;
  let recovered = 0;
  let cases = 0;
  for (const w of weeks) {
    const pts = (p: ValuedPlayer) => weeklyPoints(p, S)[w - S.currentWeek] ?? 0;
    const full = weekLineup(order, active, pts);
    lineupSum += full.total;
    for (const s of full.starters) {
      const without = weekLineup(order, active.filter((p) => p.id !== s.id), pts);
      recovered += without.total - (full.total - pts(s));
      cases++;
    }
  }
  const lineup = lineupSum / weeks.length;
  const depth = cases ? recovered / cases : 0;
  return { lineup: r1(lineup), depth: r1(depth), total: r1(lineup + DEPTH_WEIGHT * depth), weeks };
}
