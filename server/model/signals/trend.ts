// Opportunity trend (single definition, Model v4 amendments + release (b) calibration): WOPR (WR/TE) or RB weighted
// opportunity over the last 3 unflagged games. "Rising" needs all three (calibration values, DESIGN "Release (b)"):
//  - both steps up (each game above the previous one);
//  - OLS slope ≥ RISING.stdMult × the player's own weekly std-dev of the metric (all his unflagged games), so a
//    jump inside his normal week-to-week noise is not a trend;
//  - the latest value ≥ the position's flex level (the metric's recency-weighted rate at rank FLEX_RANK[pos]),
//    so a part-timer going from 2 to 4 targets is not "rising".
import type { SkillPos, Trend } from "./types.js";

export const TREND_GAMES = 3;
export const RISING = { stdMult: 1.0, stepsUp: 2 } as const;
/** Rank (within position, by recency-weighted metric) that marks a flex-level role. Calibration values. */
export const FLEX_RANK: Record<Exclude<SkillPos, "QB">, number> = { RB: 30, WR: 40, TE: 14 };

export type TrendMetric = Trend["metric"];
export const metricOf = (pos: SkillPos): TrendMetric | null => (pos === "QB" ? null : pos === "RB" ? "weightedOpp" : "wopr");

/** OLS slope of ys against 0..n-1. */
export function slope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  ys.forEach((y, i) => {
    num += (i - mx) * (y - my);
    den += (i - mx) ** 2;
  });
  return num / den;
}

/** Population standard deviation (0 for < 2 values). */
export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
}

/**
 * Games sorted by week. Null for QBs and when fewer than 3 unflagged games carry the metric.
 * `flexLevel` comes from the batch (flexLevels); without it the player is never "rising" (fail closed).
 */
export function trendOf(
  games: { week: number; flagged: boolean; wopr?: number; weightedOpp: number }[],
  pos: SkillPos,
  flexLevel?: number,
): Trend | null {
  const metric = metricOf(pos);
  if (!metric) return null;
  const all = games.filter((g) => !g.flagged && g[metric] !== undefined).map((g) => ({ week: g.week, v: g[metric] as number }));
  const pts = all.slice(-TREND_GAMES);
  if (pts.length < TREND_GAMES) return null;
  const ys = pts.map((p) => p.v);
  const s = slope(ys);
  const std = stdDev(all.map((p) => p.v));
  let steps = 0;
  for (let i = 1; i < ys.length; i++) if (ys[i] > ys[i - 1]) steps++;
  const latest = ys[ys.length - 1];
  const rising = steps >= RISING.stepsUp && std > 0 && s >= RISING.stdMult * std && flexLevel !== undefined && latest >= flexLevel;
  return { metric, slope: s, std, latest, rising, weeks: pts.map((p) => p.week), ...(flexLevel !== undefined ? { flexLevel } : {}) };
}

/**
 * Flex level per position: the FLEX_RANK-th highest recency-weighted metric rate among players with ≥ 3 games carrying
 * it. Positions with too few players get no level (nobody there is "rising").
 */
export function flexLevels(players: { pos: SkillPos; rate: number | null; games: number }[]): Partial<Record<SkillPos, number>> {
  const out: Partial<Record<SkillPos, number>> = {};
  for (const pos of ["RB", "WR", "TE"] as const) {
    const xs = players.filter((p) => p.pos === pos && p.rate !== null && p.games >= TREND_GAMES).map((p) => p.rate as number).sort((a, b) => b - a);
    if (xs.length >= FLEX_RANK[pos]) out[pos] = xs[FLEX_RANK[pos] - 1];
  }
  return out;
}
