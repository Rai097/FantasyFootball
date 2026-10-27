// Shared trade helpers (the one trade engine is Trade Finder v3, tradesV3.ts; bench upgrades reuse it).
import type { League, TeamAnalysis, ValuedPlayer } from "./types.js";
import { effPpg, optimalLineup, slotLabels, type LineupResult } from "./lineup.js";
import { irSet, rosterOf } from "./analysis.js";

export interface TradeContext {
  league: League;
  players: Map<string, ValuedPlayer>;
  teams: TeamAnalysis[];
  /** Replacement ppg per position (depth term, waiver vorp tie-breaks); optional. */
  replacement?: Partial<Record<ValuedPlayer["pos"], number>>;
}

export const fmtSigned = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;
export const tradeable = (p: ValuedPlayer) => p.pos !== "K" && p.pos !== "DEF" && p.remainingGames > 0;
export const names = (ps: ValuedPlayer[]) => ps.map((p) => p.name).join(" + ") || "nothing";

/**
 * Roster after a trade, dropping lowest-value bench players (never incoming or IR) to keep size. `irIds` = this team's
 * IR slot: those players never start (an IR player received from the partner is not in it, so he can start here).
 */
export function applyTrade(slots: League["settings"]["slots"], roster: ValuedPlayer[], gives: ValuedPlayer[], gets: ValuedPlayer[], irIds: Set<string>) {
  const giveIds = new Set(gives.map((p) => p.id));
  let after = roster.filter((p) => !giveIds.has(p.id)).concat(gets);
  let lu = optimalLineup(slots, after, { irIds });
  const drops: ValuedPlayer[] = [];
  let excess = gets.length - gives.length;
  if (excess > 0) {
    const getIds = new Set(gets.map((p) => p.id));
    const cands = lu.bench
      .filter((p) => !getIds.has(p.id) && !irIds.has(p.id))
      .sort((a, b) => a.value - b.value || a.ppg - b.ppg || (b.ecrOverall ?? 999) - (a.ecrOverall ?? 999));
    while (excess-- > 0 && cands.length) drops.push(cands.shift()!);
    if (drops.length) {
      const dropIds = new Set(drops.map((p) => p.id));
      after = after.filter((p) => !dropIds.has(p.id));
      // Dropping bench players never changes the optimal lineup, but keep bench accurate.
      lu = { ...lu, bench: lu.bench.filter((p) => !dropIds.has(p.id)) };
    }
  }
  return { roster: after, lineup: lu, drops };
}

export function lineupChanges(before: LineupResult, after: LineupResult): string[] {
  const labels = slotLabels(before.lineup);
  const out: string[] = [];
  before.lineup.forEach((l, i) => {
    const a = after.lineup[i]?.player ?? null;
    const b = l.player;
    if ((a?.id ?? null) === (b?.id ?? null)) return;
    const fmt = (p: ValuedPlayer | null) => (p ? `${p.name} ${effPpg(p).toFixed(1)}` : "empty");
    out.push(`${labels[i]}: ${fmt(b)} → ${fmt(a)}`);
  });
  return out;
}

export function* combos<T>(items: T[], maxSize: number): Generator<T[]> {
  const n = items.length;
  for (let i = 0; i < n; i++) {
    yield [items[i]];
    if (maxSize >= 2) for (let j = i + 1; j < n; j++) yield [items[i], items[j]];
  }
  if (maxSize >= 3) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) yield [items[i], items[j], items[k]];
  }
}

/** A team's roster and optimal lineup (IR-slotted players never start for their team; they can still be traded). */
export function teamState(ctx: TradeContext, teamId: string) {
  const team = ctx.league.teams.find((t) => t.id === teamId);
  if (!team) throw Object.assign(new Error(`Unknown team ${teamId}`), { status: 404 });
  const roster = rosterOf(team, ctx.players);
  const base = optimalLineup(ctx.league.settings.slots, roster, { irIds: irSet(team) });
  return { team, roster, base };
}

export function tradeDeadlinePassed(league: League): boolean {
  const d = league.settings.tradeDeadlineWeek;
  return d !== undefined && league.settings.currentWeek > d;
}
