// Context flags per game (Model v4 amendments): qbOut, leftEarly, blowout. Flagged games weigh 0.25 in rates.
import { LEFT_EARLY } from "../breakouts.js";
import type { GameFlags, PlayerGame, SkillPos } from "./types.js";

export const BLOWOUT_MARGIN = 21;
export const FLAGGED_WEIGHT = 0.25;
export { LEFT_EARLY };

/** "Started ≥ RECENT_STARTS.min of the team's last RECENT_STARTS.of games" also makes a QB usual. */
export const RECENT_STARTS = { min: 3, of: 4 } as const;

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
 * Every QB whose starts are "normal" for the team (a game started by any of them is not qbOut):
 *  - the most frequent starter (usualStarter);
 *  - a QB who started ≥ 3 of the team's last 4 games (the current starter after a change);
 *  - a QB who started both the opener and the latest game (a returning starter: SEA 2026, Darnold weeks 1 and 7
 *    around five backup starts, is never flagged).
 * Sorted for stable output.
 */
export function usualStarters(starts: { week: number; qbId: string }[]): string[] {
  if (!starts.length) return [];
  const sorted = [...starts].sort((a, b) => a.week - b.week);
  const out = new Set<string>();
  const mode = usualStarter(sorted);
  if (mode) out.add(mode);
  const recent = sorted.slice(-RECENT_STARTS.of);
  const n = new Map<string, number>();
  for (const s of recent) n.set(s.qbId, (n.get(s.qbId) ?? 0) + 1);
  for (const [id, c] of n) if (c >= RECENT_STARTS.min) out.add(id);
  if (sorted[0].qbId === sorted[sorted.length - 1].qbId) out.add(sorted[0].qbId);
  return [...out].sort();
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
      qbOut: pos !== "QB" && !!g.starterQbId && !!g.usualQbIds?.length && !g.usualQbIds.includes(g.starterQbId),
      leftEarly,
      blowout: g.teamMargin !== undefined && Math.abs(g.teamMargin) >= BLOWOUT_MARGIN,
    };
  });
}

export const isFlagged = (f: GameFlags): boolean => f.qbOut || f.leftEarly || f.blowout;
