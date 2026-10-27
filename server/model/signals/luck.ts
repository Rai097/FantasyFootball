// Luck = recency-weighted expected − actual points per game (league scoring), split into a TD part and the rest.
// Positive = under-producing his usage (buy-low); negative and TD-driven = sell-high.
// Fumbles have no expected counterpart in ffopportunity, so a lost fumble shows up as (yardage-part) bad luck.
import type { Scoring, StatLine } from "../types.js";
import type { Luck } from "./types.js";

export const tdPoints = (s: Scoring, l: StatLine): number => s.passTd * l.passTd + s.rushTd * l.rushTd + s.recTd * l.recTd;
const tdCount = (l: StatLine): number => l.passTd + l.rushTd + l.recTd;

export interface LuckGame {
  expPts: number;
  actPts: number;
  expected: StatLine;
  actual: StatLine;
  weight: number;
}

export function luckOf(games: LuckGame[], s: Scoring): Luck | null {
  const sw = games.reduce((a, g) => a + g.weight, 0);
  if (!(sw > 0)) return null;
  let pts = 0;
  let td = 0;
  let tdsOver = 0;
  for (const g of games) {
    pts += g.weight * (g.expPts - g.actPts);
    td += g.weight * (tdPoints(s, g.expected) - tdPoints(s, g.actual));
    tdsOver += tdCount(g.actual) - tdCount(g.expected);
  }
  const points = pts / sw;
  const tdPart = td / sw;
  const yardagePart = points - tdPart;
  return { points, tdPart, yardagePart, tdsOverExpected: tdsOver, driver: Math.abs(tdPart) >= Math.abs(yardagePart) ? "td" : "yardage" };
}
