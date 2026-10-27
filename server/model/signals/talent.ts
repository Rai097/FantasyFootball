// Talent prior inputs: last season expected / actual points per game (league scoring), age, rookie draft capital.
import { score } from "../scoring.js";
import { tdCount, tdPoints } from "./luck.js";
import type { Scoring } from "../types.js";
import type { PriorSeason, RosterInfo, SkillPos, TalentPrior } from "./types.js";

export const AGE_RISING_MAX = 26;

/** Age in years at `asOf`; null when the birth date is unknown or unparsable. */
export function ageAt(birthDate: string | undefined, asOf: Date): number | null {
  if (!birthDate) return null;
  const t = Date.parse(birthDate);
  if (!Number.isFinite(t)) return null;
  return (asOf.getTime() - t) / (365.25 * 864e5);
}

export function talentPrior(
  pos: SkillPos,
  prior: PriorSeason | undefined,
  roster: RosterInfo | undefined,
  season: number,
  asOf: Date,
  s: Scoring,
): TalentPrior {
  const g = prior?.games ?? 0;
  const age = ageAt(roster?.birthDate, asOf);
  const rookie = roster?.rookieYear === season;
  return {
    priorGames: g,
    priorExpPpg: g > 0 ? score(s, prior!.expected, pos) / g : null,
    priorActPpg: g > 0 ? score(s, prior!.actual, pos) / g : null,
    priorTdPts: g > 0 ? tdPoints(s, prior!.actual) / g : null,
    priorTds: g > 0 ? tdCount(prior!.actual) / g : null,
    age: age === null ? null : Math.round(age * 10) / 10,
    ageRising: age === null ? null : age <= AGE_RISING_MAX,
    rookie,
    draftNumber: rookie && roster?.draftNumber !== undefined ? roster.draftNumber : null,
  };
}
