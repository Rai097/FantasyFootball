// Efficiency = actual / expected points, shrunk toward 1.0 by sample size, capped per position.
// Amendment formula (actual + k·expected)/(expected·(1 + k)) read with actual/expected as totals over n games and
// k pseudo-games of his average expected: shrunk = (n·raw + k) / (n + k). raw is recency-weighted; n counts GAMES
// (unflagged 1, flagged 0.25, no recency decay — decayed weights sum to ≤ ~3.4 and would never approach k).
import type { Efficiency, SkillPos } from "./types.js";

export const SHRINK_K = 6;
/** Below this weighted expected points per game the ratio is noise → null (calibration value). */
export const MIN_EXP_PPG = 0.5;
export const EFF_CAPS: Record<SkillPos, [number, number]> = {
  RB: [0.75, 1.35],
  TE: [0.75, 1.35],
  WR: [0.8, 1.3],
  QB: [0.85, 1.2],
};

export function efficiencyOf(
  games: { expPts: number; actPts: number; weight: number; sample: number }[],
  pos: SkillPos,
): Efficiency | null {
  let n = 0;
  let w = 0;
  let e = 0;
  let a = 0;
  for (const g of games) {
    n += g.sample;
    w += g.weight;
    e += g.weight * g.expPts;
    a += g.weight * g.actPts;
  }
  if (!(n > 0) || !(w > 0) || e / w < MIN_EXP_PPG) return null; // too little usage for a ratio to mean anything
  const raw = a / e;
  const [lo, hi] = EFF_CAPS[pos];
  const shrunk = Math.min(hi, Math.max(lo, (n * raw + SHRINK_K) / (n + SHRINK_K)));
  return { raw, shrunk, n };
}
