// Injury-risk haircut shared by lineups (analysis), waivers and trades (rosterScore / tradesV3).
import type { ValuedPlayer } from "./types.js";
import { injuryKind } from "./projection.js";

/** Haircut on a player's rate: Questionable 0.85, Doubtful 0.70, Out (incl. designated to return) 0.55. */
export const INJURY_RISK = { questionable: 0.85, doubtful: 0.7, out: 0.55 } as const;

export function riskStatus(p: ValuedPlayer): keyof typeof INJURY_RISK | null {
  if (!p.injury) return null;
  const k = injuryKind(p.injury);
  if (k === "out" || k === "return") return "out";
  if (k === "doubtful") return "doubtful";
  const st = p.injury.status.trim().toUpperCase();
  if (st === "Q" || st === "QUESTIONABLE") return "questionable";
  return null;
}

/** Multiplier for a player's rate (1 when healthy). */
export const riskFactor = (p: ValuedPlayer): number => {
  const st = riskStatus(p);
  return st ? INJURY_RISK[st] : 1;
};

const riskClones = new WeakMap<ValuedPlayer, ValuedPlayer>();
/** The player with ppg / effPpg / weekly scaled by the injury-risk haircut (value unchanged); same object when healthy. */
export function riskAdjusted(p: ValuedPlayer): ValuedPlayer {
  const f = riskFactor(p);
  if (f === 1) return p;
  let c = riskClones.get(p);
  if (!c) {
    c = { ...p, ppg: p.ppg * f, effPpg: (p.effPpg ?? p.ppg) * f, ...(p.weekly ? { weekly: p.weekly.map((x) => x * f) } : {}) };
    riskClones.set(p, c);
  }
  return c;
}
