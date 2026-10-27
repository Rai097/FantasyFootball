// Context flags per game (Model v4 amendments): qbOut, leftEarly, blowout. Flagged games weigh 0.25 in rates.
import { LEFT_EARLY } from "../breakouts.js";
import type { GameFlags, PlayerGame, SkillPos } from "./types.js";

export const BLOWOUT_MARGIN = 21;
export const FLAGGED_WEIGHT = 0.25;
export { LEFT_EARLY };

/**
 * The team's most frequent starting QB over the season. Ties go to the QB who started first
 * (the opening-day starter keeps "usual" status until someone out-starts him).
 */
export function usualStarter(starts: { week: number; qbId: string }[]): string | undefined {
  const count = new Map<string, { n: number; first: number }>();
  for (const s of starts) {
    const c = count.get(s.qbId) ?? { n: 0, first: s.week };
    c.n += 1;
    c.first = Math.min(c.first, s.week);
    count.set(s.qbId, c);
  }
  let best: string | undefined;
  let bc = { n: 0, first: Infinity };
  for (const [id, c] of count) if (c.n > bc.n || (c.n === bc.n && c.first < bc.first)) [best, bc] = [id, c];
  return best;
}

/**
 * Flags for each game (games sorted by week). qbOut is never set for QBs themselves: a backup QB's own
 * starts are his opportunity, not a context distortion.
 * leftEarly: snap share < 15% while the mean of his earlier games' snap shares (known ones) is ≥ 50%.
 */
export function contextFlags(games: PlayerGame[], pos: SkillPos): GameFlags[] {
  const seen: number[] = [];
  return games.map((g) => {
    const before = seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : undefined;
    const leftEarly = g.snapShare !== undefined && before !== undefined && g.snapShare < LEFT_EARLY.last && before >= LEFT_EARLY.before;
    if (g.snapShare !== undefined) seen.push(g.snapShare);
    return {
      qbOut: pos !== "QB" && !!g.starterQbId && !!g.usualQbId && g.starterQbId !== g.usualQbId,
      leftEarly,
      blowout: g.teamMargin !== undefined && Math.abs(g.teamMargin) >= BLOWOUT_MARGIN,
    };
  });
}

export const isFlagged = (f: GameFlags): boolean => f.qbOut || f.leftEarly || f.blowout;
