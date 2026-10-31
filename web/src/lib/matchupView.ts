// Pure view helpers for the Matchup tab (docs/DESIGN.md "Matchups and results log"). Missing numbers are "—", never 0.
import type { MatchupCell, RecordGame } from "../../../server/model/matchup";
import { f1 } from "./format";

/** "1 starter not projected" / "3 starters not projected"; null when complete. */
export function incompleteLabel(n: number): string | null {
  if (!(n > 0)) return null;
  return `${n} starter${n === 1 ? "" : "s"} not projected`;
}

/** A record call: true = ✓ (projected winner won), false = ✗, null = no call. */
export function callMark(c: boolean | null): string {
  return c === true ? "✓" : c === false ? "✗" : "—";
}

/** "128.4 – 121.0"; an unknown side shows "—" (never 0). */
export function pair(a: number | null | undefined, b: number | null | undefined): string {
  return `${f1(a)} – ${f1(b)}`;
}

/** Win chances for both sides ("62%" / "38%"); null when unknown. */
export function winPcts(winPct: number | null | undefined): [string, string] | null {
  if (winPct == null || !Number.isFinite(winPct)) return null;
  const a = Math.round(winPct * 100);
  return [`${a}%`, `${100 - a}%`];
}

/** A record game with the request team first (swaps all pairs when it is listed on the right). */
export type OrientedGame = RecordGame;
export function orientGame(g: RecordGame, myTeamId: string): OrientedGame {
  if (!g.mine || g.teams[0] === myTeamId) return { ...g };
  const sw = <T,>(p: [T, T]): [T, T] => [p[1], p[0]];
  return {
    ...g,
    teams: sw(g.teams),
    ours: sw(g.ours),
    yahoo: sw(g.yahoo),
    yahooPage: sw(g.yahooPage),
    oursMissing: sw(g.oursMissing),
    yahooMissing: sw(g.yahooMissing),
    points: sw(g.points),
  };
}

/** True when ours is unknown for the whole game because the week was never captured (an incomplete week is not this). */
export const notRecorded = (g: Pick<RecordGame, "ours"> & Partial<Pick<RecordGame, "oursMissing">>): boolean =>
  g.ours[0] == null && g.ours[1] == null && !(g.oursMissing?.[0] || g.oursMissing?.[1]);

/** A record game's "n starters not projected" (the most on either side, ours or Yahoo's); null when complete. */
export function recordIncompleteLabel(g: Pick<RecordGame, "oursMissing" | "yahooMissing">): string | null {
  return incompleteLabel(Math.max(...g.oursMissing, ...g.yahooMissing));
}

/** Full word for the injury chip. */
export function chipTitle(c: Pick<MatchupCell, "status">): string | undefined {
  if (!c.status) return undefined;
  return { Q: "Questionable", D: "Doubtful", O: "Out", IR: "Injured reserve / suspended" }[c.status];
}
