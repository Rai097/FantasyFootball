import type { Position, Scoring, StatLine } from "./types.js";

/** Half-PPR scoring used by the demo league (and as a fallback). */
export const HALF_PPR: Scoring = {
  passYd: 0.04,
  passTd: 4,
  passInt: -1,
  rushYd: 0.1,
  rushTd: 6,
  rec: 0.5,
  recYd: 0.1,
  recTd: 6,
  twoPt: 2,
  fumLost: -2,
  teRec: 0,
};

/** Fantasy points for a stat line under the given scoring. `pos` enables TE premium. */
export function score(s: Scoring, l: StatLine, pos?: Position): number {
  const pts =
    s.passYd * l.passYd +
    s.passTd * l.passTd +
    s.passInt * l.passInt +
    s.rushYd * l.rushYd +
    s.rushTd * l.rushTd +
    (s.rec + (pos === "TE" ? s.teRec : 0)) * l.rec +
    s.recYd * l.recYd +
    s.recTd * l.recTd +
    s.twoPt * l.twoPt +
    s.fumLost * l.fumLost;
  return Number.isFinite(pts) ? pts : 0;
}

/** "ppr" | "half" | "std" bucket for a league's reception scoring. */
export function recFormat(s: Scoring): "ppr" | "half" | "std" {
  if (s.rec >= 0.75) return "ppr";
  if (s.rec >= 0.25) return "half";
  return "std";
}
