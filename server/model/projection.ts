// Valuation helpers kept from the original value model and reused by projection v4 (projectionV4.ts, THE valuation):
// ECR rank → points curve (the anchor), K/DEF rank line, replacement ranks, injury classification, value convexity.
import type { League, Player, Position, SlotKind } from "./types.js";
import { recFormat } from "./scoring.js";

export const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

/** Cap on the current-season curve relative to the prior-season curve at the same rank. */
export const CURVE_CURRENT_CAP = 1.15;
/** Kicker / defense ppg straight from ECR positional rank. */
export const KDEF_CURVE: Record<"K" | "DEF", { base: number; slope: number }> = {
  K: { base: 9, slope: 0.1 },
  DEF: { base: 8.5, slope: 0.15 },
};
/** Share of each flex slot type expected to be filled by each position. */
export const FLEX_SHARE: Partial<Record<SlotKind, Partial<Record<Position, number>>>> = {
  FLEX: { RB: 0.45, WR: 0.45, TE: 0.1 },
  SFLEX: { QB: 0.7, RB: 0.12, WR: 0.12, TE: 0.06 },
  RFLEX: { WR: 0.6, TE: 0.4 },
  WRRB: { RB: 0.5, WR: 0.5 },
};
/** Bench-depth term of the replacement rank, for a 12-team league (scaled by numTeams/12). */
export const BENCH_DEPTH: Record<Position, number> = { QB: 2, RB: 6, WR: 6, TE: 3, K: 0, DEF: 0 };
/** Value exponent (star premium): value = 100·(surplus / max)^CONVEXITY. Raised 1.15 → 1.35 so stars outweigh depth. */
export const CONVEXITY = 1.35;
const LONG_TERM_RE = /ACL|Achilles|season|\bIR\b|^NA\b/i;
const RETURN_RE = /return designation/i;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Centered moving average, window 3 (edges use the available neighbours). */
export function smooth(xs: number[], window = 3): number[] {
  const h = Math.floor(window / 2);
  return xs.map((_, i) => mean(xs.slice(Math.max(0, i - h), i + h + 1)));
}

/** Value at fractional 1-based rank with linear interpolation; clamps past the ends. */
export function curveAt(curve: number[], rank: number): number {
  if (!curve.length) return 0;
  const idx = Math.max(0, rank - 1);
  const lo = Math.min(Math.floor(idx), curve.length - 1);
  const hi = Math.min(lo + 1, curve.length - 1);
  const f = Math.min(1, idx - Math.floor(idx));
  return curve[lo] + (curve[hi] - curve[lo]) * (idx >= curve.length - 1 ? 0 : f);
}

/**
 * ECR rank → points curve for one position (the anchor of projection v4): 0.5 × this season's curve (players with
 * ≥ 3 games) + 0.5 × last season's curve (≥ 8 games), the current one capped at 1.15× the prior one at each rank
 * (early-season outliers), smoothed (window 3). Inputs: per-player points per game, any order.
 */
export function ecrCurve(current: number[], prior: number[]): number[] {
  const a = [...current].sort((x, y) => y - x);
  const b = [...prior].sort((x, y) => y - x);
  for (let i = 0; i < Math.min(a.length, b.length); i++) a[i] = Math.min(a[i], CURVE_CURRENT_CAP * b[i]);
  const n = Math.max(a.length, b.length);
  const combined: number[] = [];
  for (let i = 0; i < n; i++) {
    if (a.length && b.length) combined.push(0.5 * a[Math.min(i, a.length - 1)] + 0.5 * b[Math.min(i, b.length - 1)]);
    else combined.push((a.length ? a : b)[i]);
  }
  return smooth(combined, 3);
}

/**
 * Classify an injury status (nflverse report or Yahoo code).
 *  - long: IR / PUP / NFI / Yahoo NA, or Out/Doubtful with an ACL/Achilles/season/IR/NA detail (v4: 0 rest of season)
 *  - return: Yahoo "-R" designation (IR-R etc., detail "return designation", not IR) (v4: 0 for 4 games)
 *  - out / doubtful (v4: 0 / ×0.7 this week); SUSP is "out" here, projection v4 treats it as long-term
 */
export type InjuryKind = "long" | "return" | "out" | "doubtful";
export function injuryKind(inj: Player["injury"]): InjuryKind | null {
  if (!inj) return null;
  const st = inj.status.trim().toUpperCase();
  const detail = (inj.detail ?? "").trim();
  const isOut = st === "OUT" || st === "O";
  const isDoubtful = st === "DOUBTFUL" || st === "D";
  if (/^(IR|PUP|NFI)-R$/.test(st)) return "return";
  if (st === "IR" || st.startsWith("PUP") || st === "NFI" || st === "NA") return "long";
  // Detail-based classification only applies when the player is actually out/doubtful.
  if ((isOut || isDoubtful) && RETURN_RE.test(detail) && !/\bIR\b/.test(detail)) return "return";
  if ((isOut || isDoubtful) && LONG_TERM_RE.test(detail)) return "long";
  if (isOut || st === "SUSP") return "out";
  if (isDoubtful) return "doubtful";
  return null;
}

/** Replacement rank (1-based) per position for a league's starting slots. */
export function replacementRanks(slots: SlotKind[], numTeams: number): Record<Position, number> {
  const out = {} as Record<Position, number>;
  for (const pos of POSITIONS) {
    const dedicated = slots.filter((s) => s === pos).length;
    let flex = 0;
    for (const s of slots) flex += FLEX_SHARE[s]?.[pos] ?? 0;
    out[pos] = Math.max(1, Math.round(numTeams * dedicated + flex * numTeams + (BENCH_DEPTH[pos] * numTeams) / 12));
  }
  return out;
}

/** Note shown once per analysis response (instead of in every why string). */
export function valuationNotes(league: League): string[] {
  const notes: string[] = [];
  if (recFormat(league.settings.scoring) !== "ppr") notes.push("ECR ranks are PPR; points use league scoring.");
  return notes;
}
