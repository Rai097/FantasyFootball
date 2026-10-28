// Vacated role and one-game spikes (DESIGN "Fix: vacated role, spikes, depth and roster need (2026-10-28)").
// Pure, ONE definition shared by the signals (projection v4: rates, role-change exemption) and Breakout Targets
// (waiver calls): a usage jump while a same-team teammate with more prior usage at a competing position was absent
// is a borrowed role; a jump in only one of the last 3 games is a spike, not a trend.
import type { Position } from "../types.js";

/** Calibration values (config, not hard-coded at call sites). */
export const VACATED = {
  /** A vacated-role game counts this much of its weight once the absent teammate is back (or due back). */
  weight: 0.4,
  /** The jump: usage ≥ max(ratio × his earlier mean, earlier mean + minGain) (targets; RB: carries + targets). */
  jumpRatio: 1.5,
  jumpMinGain: 2,
  /** The teammate's earlier mean usage must beat his by at least this (a real competitor, not a fringe player). */
  minMargin: 1,
  /** ...and be a real role: at least this many targets (pass catchers) / touches (RBs) per game before. */
  minUsage: { PC: 4, RB: 8 },
  /** Left early = under this snap share after ≥ `leftEarlyBefore` on average before (counts as absent). */
  leftEarlyLast: 0.15,
  leftEarlyBefore: 0.5,
  /** Projection: the full (borrowed-role) rate over the settled one is clamped to at most this factor. */
  maxFactor: 2,
} as const;

/** "Higher usage in at least 2 of the last 3 games" (expected points per game, league scoring). */
export const SPIKE = {
  window: 3,
  minGames: 2,
  /** Elevated = ≥ max(ratio × earlier mean, earlier mean + minGain) expected pts. */
  ratio: 1.25,
  minGain: 1.5,
  /** ...and at least this share of the window's best game (a 5.5 next to a 16.2 is not the new role). */
  peakShare: 0.5,
  /** An isolated spike game's recency weight is capped at this (as if it were 2 games old). */
  maxRecency: 0.5,
} as const;

/** Competing group: pass catchers (WR / TE) compete for targets, RBs for touches. */
export const competingGroup = (pos: Position | string): "PC" | "RB" | null => (pos === "WR" || pos === "TE" ? "PC" : pos === "RB" ? "RB" : null);

export interface VacGame {
  week: number;
  team: string;
  targets: number;
  carries: number;
  /** Offensive snap share 0..1; undefined = unknown. */
  snapShare?: number;
}

export interface VacPlayer {
  id: string;
  name: string;
  pos: Position | string;
  /** Current team: a teammate who has since left the team vacated the role for good (not a borrowed role). */
  team: string;
  games: VacGame[];
}

export interface VacatedBy {
  id: string;
  name: string;
  pos: string;
}

const usageOf = (g: VacGame, group: "PC" | "RB") => (group === "RB" ? g.carries + g.targets : g.targets);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Per player: week → the absent teammates whose role he borrowed that week. A game is "vacated" when
 *  - a same-team teammate in his competing group (still on the team) with higher earlier usage (mean over his games
 *    for this team before that week, ≥ his own + minMargin) did not play that week or left early, and
 *  - his own usage that week jumped over his earlier mean (games before that week that were not vacated), and
 *  - every earlier game of his in the same absence stretch was a jump too (the absence explains the jump).
 * Unknown baselines (no earlier game) never flag: missing data is not a borrowed role.
 */
export function vacatedGames(players: VacPlayer[]): Map<string, Map<number, VacatedBy[]>> {
  const groups = new Map<string, VacPlayer[]>();
  for (const p of players) {
    const g = competingGroup(p.pos);
    if (!g) continue;
    for (const team of new Set(p.games.map((x) => x.team))) {
      const k = `${team}|${g}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
    }
  }
  const out = new Map<string, Map<number, VacatedBy[]>>();
  for (const [k, mates] of groups) {
    const [team, group] = k.split("|") as [string, "PC" | "RB"];
    const gamesOf = (p: VacPlayer) => p.games.filter((g) => g.team === team).sort((a, b) => a.week - b.week);
    for (const p of mates) {
      const mine = gamesOf(p);
      const flagged = new Set<number>();
      const jumps = new Set<number>();
      const absentAt = (t: VacPlayer, week: number): boolean => {
        const tg = gamesOf(t);
        const before = tg.filter((x) => x.week < week);
        const that = tg.find((x) => x.week === week);
        if (!that) return true;
        const snapsBefore = before.map((x) => x.snapShare).filter((s): s is number => s !== undefined);
        return that.snapShare !== undefined && that.snapShare < VACATED.leftEarlyLast && snapsBefore.length > 0 && mean(snapsBefore) >= VACATED.leftEarlyBefore;
      };
      for (const g of mine) {
        const earlier = mine.filter((x) => x.week < g.week && !flagged.has(x.week));
        if (!earlier.length) continue;
        const base = mean(earlier.map((x) => usageOf(x, group)));
        const u = usageOf(g, group);
        if (u < Math.max(VACATED.jumpRatio * base, base + VACATED.jumpMinGain) - 1e-9) continue;
        jumps.add(g.week);
        const by: VacatedBy[] = [];
        for (const t of mates) {
          if (t.id === p.id || t.team !== team) continue;
          const before = gamesOf(t).filter((x) => x.week < g.week);
          if (!before.length) continue;
          const tMean = mean(before.map((x) => usageOf(x, group)));
          if (tMean < base + VACATED.minMargin || tMean < VACATED.minUsage[group]) continue;
          if (!absentAt(t, g.week)) continue;
          // The absence must explain the jump: no game of his without a jump earlier in the same absence stretch
          // (a teammate out since week 4 does not explain a week-6 jump after a quiet week 5).
          let explained = true;
          for (const x of [...mine].reverse()) {
            if (x.week >= g.week) continue;
            if (!absentAt(t, x.week)) break;
            if (!jumps.has(x.week)) {
              explained = false;
              break;
            }
          }
          if (explained) by.push({ id: t.id, name: t.name, pos: String(t.pos) });
        }
        if (!by.length) continue;
        flagged.add(g.week);
        const m = out.get(p.id) ?? out.set(p.id, new Map()).get(p.id)!;
        m.set(g.week, by);
      }
    }
  }
  return out;
}

export interface UsageShape {
  /** Earlier mean the window is compared with (null = unknown: a single game). */
  base: number | null;
  /** Elevated threshold (null when base is unknown). */
  bar: number | null;
  /** Per game of the last `SPIKE.window`: elevated over the earlier role. */
  elevated: boolean[];
  /** Elevated games of the window, each × its weight (a vacated game counts VACATED.weight). */
  count: number;
  /** The latest game is elevated (a usage jump). */
  jump: boolean;
  /** Higher usage in ≥ SPIKE.minGames of the last SPIKE.window games. */
  sustained: boolean;
  /** A jump in exactly one game of the window (or a single game): a spike, watch only. */
  spike: boolean;
  /** Indices (into the input) of isolated spike games: the projection caps their recency weight. */
  spikeIdx: number[];
}

/**
 * Usage shape over expected points per game, oldest first. Base = mean of the games before the last 3; with none,
 * the lowest game of the window (a 2-game player going 1 → 8 is one jump, not a trend). Elevated = ≥ max(ratio × base,
 * base + minGain, peakShare × the window's best game). `weights` (default 1) discount
 * games in the count (vacated-role games while the teammate is back).
 */
export function usageShape(us: number[], weights?: number[]): UsageShape {
  const n = us.length;
  const from = Math.max(0, n - SPIKE.window);
  const win = us.slice(from);
  const before = us.slice(0, from);
  if (!n) return { base: null, bar: null, elevated: [], count: 0, jump: false, sustained: false, spike: false, spikeIdx: [] };
  const base = before.length ? mean(before) : win.length >= 2 ? Math.min(...win) : null;
  const peak = Math.max(...win);
  const bar = base === null ? null : Math.max(SPIKE.ratio * base, base + SPIKE.minGain, SPIKE.peakShare * peak) - 1e-9;
  // A single game with no baseline is "elevated" only if it is a real game at all (> 0): one game, unsustained.
  const elevated = win.map((u) => (bar === null ? u > 0 : u >= bar));
  const count = elevated.reduce((a, e, i) => a + (e ? (weights?.[from + i] ?? 1) : 0), 0);
  const jump = elevated[elevated.length - 1] ?? false;
  const sustained = count >= SPIKE.minGames - 1e-9;
  const nElev = elevated.filter(Boolean).length;
  const spike = elevated.some(Boolean) && !sustained && (jump || nElev === 1);
  const spikeIdx = nElev === 1 ? [from + elevated.indexOf(true)] : [];
  return { base, bar: bar === null ? null : bar + 1e-9, elevated, count, jump, sustained, spike, spikeIdx };
}
