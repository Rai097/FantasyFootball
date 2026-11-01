// Pure view helpers for the Matchup tab (docs/DESIGN.md "Matchups and results log"). Missing numbers are "—", never 0.
import type { MatchupCell, MatchupPairing, MatchupSideView, RecordGame } from "../../../server/model/matchup";
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

/** Both sides or a single "–" (an unknown side is never shown next to a number as if it were a result). */
export function pairOrDash(a: number | null | undefined, b: number | null | undefined): string {
  return a == null || b == null ? "–" : pair(a, b);
}

/** Track-record total for one source: the pair when complete, else "n not projected" (n = most missing on either side), else "–". */
export function recordPair(v: [number | null, number | null], missing: [number, number]): string {
  if (v[0] != null && v[1] != null) return pair(v[0], v[1]);
  const n = Math.max(missing[0], missing[1]);
  return n > 0 ? `${n} not projected` : "–";
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

// ---------------------------------------------------------------- display totals (never the record)
type SideTotals = Pick<MatchupSideView, "ours" | "oursIncomplete" | "oursPartial">;

/** Our team total for display: the full sum; when starters are unprojected the partial sum plus a "+ n not projected"
 *  note (never a silent sum, never 0 for unknown); "—" when nothing is projected. */
export function oursText(s: SideTotals): { value: string; note: string | null } {
  if (s.ours != null) return { value: f1(s.ours), note: null };
  const n = s.oursIncomplete;
  if (n > 0 && s.oursPartial != null) return { value: f1(s.oursPartial), note: `+ ${n} not projected` };
  return { value: "—", note: incompleteLabel(n) };
}

/** One side for a one-line row: "98.2", "98.2 (+3)" (3 starters not projected) or "—". */
export function oursShort(s: SideTotals): string {
  const t = oursText(s);
  return t.note && t.value !== "—" ? `${t.value} (+${s.oursIncomplete})` : t.value;
}

/** Both sides for a one-line row; a single "–" when neither side has any projection. */
export function oursPairShort(a: SideTotals, b: SideTotals): string {
  const x = oursShort(a);
  const y = oursShort(b);
  return x === "—" && y === "—" ? "–" : `${x} – ${y}`;
}

export type YahooKind = "lock" | "live" | "none";
/** Yahoo's column for a pairing: the pre-game lock when both sides have it, else Yahoo's current projected total for
 *  both sides (one source per row, labelled live), else unknown. A final week shows Yahoo's page totals. */
export function yahooColumn(
  a: Pick<MatchupSideView, "yahoo" | "yahooLive">,
  b: Pick<MatchupSideView, "yahoo" | "yahooLive">,
  final: boolean,
): { label: string; kind: YahooKind; a: number | null; b: number | null } {
  if (a.yahoo != null && b.yahoo != null) return { label: final ? "Yahoo (page)" : "Yahoo", kind: "lock", a: a.yahoo, b: b.yahoo };
  if (a.yahooLive != null || b.yahooLive != null) return { label: final ? "Yahoo (page)" : "Yahoo (live)", kind: "live", a: a.yahooLive, b: b.yahooLive };
  return { label: "Yahoo", kind: "none", a: null, b: null };
}

/** Any per-player points in the pairing (others normally have none: Yahoo's page is read only for my matchup). */
export function hasPlayerPoints(p: Pick<MatchupPairing, "rows" | "bench">): boolean {
  return [...p.rows, ...p.bench].some((r) => r.a?.points != null || r.b?.points != null);
}
