// Recency weighting: exponential, half-life 2 games (by game order, byes don't count); flagged games × 0.25.
import { FLAGGED_WEIGHT } from "./context.js";

export const HALF_LIFE_GAMES = 2;

/**
 * Weight per game, oldest first; the latest game has recency 1. `capped` games (isolated one-game spikes) have their
 * recency capped at `cap` (SPIKE.maxRecency); `factor` multiplies a game's weight (vacated-role games).
 */
export function recencyWeights(flagged: boolean[], opts: { capped?: ReadonlySet<number>; cap?: number; factor?: readonly number[] } = {}): number[] {
  const n = flagged.length;
  return flagged.map((f, i) => {
    let rec = Math.pow(0.5, (n - 1 - i) / HALF_LIFE_GAMES);
    if (opts.capped?.has(i) && opts.cap !== undefined) rec = Math.min(rec, opts.cap);
    return rec * (f ? FLAGGED_WEIGHT : 1) * (opts.factor?.[i] ?? 1);
  });
}

/** Weighted mean over the entries whose value is known; null when none is. */
export function weightedRate(values: (number | undefined)[], weights: number[]): number | null {
  let sw = 0;
  let sx = 0;
  values.forEach((v, i) => {
    if (v === undefined || !Number.isFinite(v)) return;
    sw += weights[i];
    sx += weights[i] * v;
  });
  return sw > 0 ? sx / sw : null;
}

export const plainMean = (values: (number | undefined)[]): number | null => weightedRate(values, values.map(() => 1));
