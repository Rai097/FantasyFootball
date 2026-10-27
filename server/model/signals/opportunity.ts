// Per player-week opportunity: target share, air-yards share, WOPR, RB weighted opportunity, snap share,
// expected / actual fantasy points under the LEAGUE's scoring (from the stat components, not the file's totals).
import { score } from "../scoring.js";
import type { Scoring } from "../types.js";
import type { PlayerGame, SkillPos, WeekOpportunity } from "./types.js";

/** WOPR = 1.5 · target share + 0.7 · air-yards share (Josh Hermsmeyer's weighted opportunity rating). */
export const WOPR = { target: 1.5, air: 0.7 } as const;
/**
 * RB weighted opportunity = carries + targetWeight · targets. In full PPR a target ≈ 2.8 carries (Scott Barrett);
 * scaled by scoring.rec relative to 1.0 with a standard-scoring floor: weight = STD + (PPR − STD) · rec.
 * STD = 1.4 (half the PPR premium) is a calibration value, revisited after the first real-league run.
 */
export const RB_TARGET = { ppr: 2.8, std: 1.4 } as const;

export function targetWeight(s: Scoring): number {
  const rec = Math.max(0, s.rec);
  return RB_TARGET.std + (RB_TARGET.ppr - RB_TARGET.std) * rec;
}

const share = (x: number, total: number | undefined): number | undefined => (total && total > 0 ? x / total : undefined);

export function weekOpportunity(g: PlayerGame, pos: SkillPos, s: Scoring): WeekOpportunity {
  const targetShare = share(g.targets, g.teamTotals?.targets);
  const airShare = share(g.airYards, g.teamTotals?.airYards);
  const wopr = targetShare === undefined ? undefined : WOPR.target * targetShare + WOPR.air * (airShare ?? 0);
  return {
    targetShare,
    airShare,
    wopr,
    weightedOpp: g.carries + targetWeight(s) * g.targets,
    snapShare: g.snapShare,
    expPts: score(s, g.expected, pos),
    actPts: score(s, g.actual, pos),
  };
}
