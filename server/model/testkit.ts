// Helpers shared by the model unit tests (not used at runtime).
import type { League, Player, Position, SlotKind, StatLine, Team, ValuedPlayer } from "./types.js";
import { HALF_PPR } from "./scoring.js";

export const line = (o: Partial<StatLine> = {}): StatLine => ({
  passYd: 0, passTd: 0, passInt: 0, rushYd: 0, rushTd: 0, rec: 0, recYd: 0, recTd: 0, twoPt: 0, fumLost: 0, ...o,
});

/** A ValuedPlayer with explicit ppg/value (for lineup / trade / waiver tests). */
export function vp(id: string, pos: Position, ppg: number, value: number, extra: Partial<ValuedPlayer> = {}): ValuedPlayer {
  return {
    id, name: id, pos, team: "KC", ids: {}, snapShare: {}, weeks: [], prior: null,
    ppg, ppg26: ppg, ppgExp26: ppg, ppg25: ppg, games: 3, vorp: Math.max(0, ppg - 5), value, posRank: 1,
    remainingGames: 13, why: "", trend: 0, ...extra,
  };
}

/** A raw Player (for projection tests). */
export function rawPlayer(id: string, pos: Position, extra: Partial<Player> = {}): Player {
  return { id, name: id, pos, team: "KC", ids: {}, snapShare: {}, weeks: [], prior: null, ...extra };
}

export const SMALL_SLOTS: SlotKind[] = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "IR"];

export function league(teams: Team[], slots: SlotKind[] = SMALL_SLOTS, over: Partial<League["settings"]> = {}): League {
  return {
    provider: "demo",
    id: "test",
    settings: {
      name: "Test", season: 2026, currentWeek: 4, regularSeasonEnd: 14, finalWeek: 17, numTeams: teams.length,
      slots, scoring: { ...HALF_PPR }, isDynasty: false, ...over,
    },
    teams,
    myTeamId: teams[0]?.id,
    fetchedAt: "2026-09-29T00:00:00Z",
  };
}

export const team = (id: string, players: ValuedPlayer[] | string[], extra: Partial<Team> = {}): Team => ({
  id, name: `Team ${id}`, owner: id, playerIds: players.map((p) => (typeof p === "string" ? p : p.id)), unmatched: [], ...extra,
});

/**
 * Row-summary rule (CLAUDE.md): ≤ 255 chars, one line, 1–2 sentences. Returns the problems (empty = fine).
 * Initials and abbreviations in names ("A.J. Brown", "St. Brown", "Jr.") are not sentence ends.
 */
export function summaryProblems(s: string): string[] {
  const out: string[] = [];
  if (!s.trim()) out.push("empty");
  if (s.length > 255) out.push(`${s.length} chars`);
  if (/[\n\r]/.test(s)) out.push("newline");
  const norm = s
    .replace(/\b(?:[A-Z]\.){1,3}(?=\s|[A-Z])/g, "X")
    .replace(/\b(?:St|Jr|Sr|Mr|vs|No)\./g, "X")
    .replace(/\d\.\d/g, "0");
  const sentences = (norm.match(/[.!?…](?=\s|$)/g) ?? []).length || 1;
  if (sentences > 2) out.push(`${sentences} sentences`);
  return out;
}

/** Details rule: every item is one short idea (≤ 90 chars), never a ";" / "·" chain or a paragraph. */
export function detailProblems(items: { label: string; value: string }[]): string[] {
  const out: string[] = [];
  for (const d of items) {
    if (!d.label || !d.value) out.push(`empty item ${JSON.stringify(d)}`);
    if (d.value.length > 90) out.push(`${d.label}: ${d.value.length} chars`);
    if (/;\s|\s·\s|\n/.test(d.value)) out.push(`${d.label}: chained "${d.value}"`);
  }
  return out;
}
