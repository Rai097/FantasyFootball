// Opportunity trend (single definition, Model v4 amendments): least-squares slope of WOPR (WR/TE) or RB weighted
// opportunity per game over the last 3 unflagged games. Rising thresholds are calibration values.
import type { SkillPos, Trend } from "./types.js";

export const TREND_GAMES = 3;
export const RISING = { wopr: 0.03, weightedOpp: 1.5 } as const;

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

/** Games sorted by week. Null for QBs and when fewer than 3 unflagged games carry the metric. */
export function trendOf(
  games: { week: number; flagged: boolean; wopr?: number; weightedOpp: number }[],
  pos: SkillPos,
): Trend | null {
  if (pos === "QB") return null;
  const metric = pos === "RB" ? "weightedOpp" : "wopr";
  const pts = games.filter((g) => !g.flagged && g[metric] !== undefined).slice(-TREND_GAMES);
  if (pts.length < TREND_GAMES) return null;
  const s = slope(pts.map((g) => g[metric] as number));
  return { metric, slope: s, rising: s >= RISING[metric], weeks: pts.map((g) => g.week) };
}
