// Trade finder v3.1 player signals: weekly floor / consistency, role risers, same-NFL-team overlap.
import type { LeagueSettings, Position, Scoring, StatLine, ValuedPlayer } from "./types.js";
import { score } from "./scoring.js";
import { BREAKOUT_POS, LEFT_EARLY, roleMetrics, snapSeries } from "./breakouts.js";

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

export const FLOOR = { minGames: 6, weight: 0.2, highFloor: 0.7, highFloorPpg: 10, volatile: 0.45 } as const;
export const RISER = { snapTrend: 0.12, expTrend: 2, blend: 0.3, maxEarlierShare: 0.65, noisyLow: 0.25 } as const;

/** 25th percentile (linear interpolation). */
export function percentile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Floor (25th percentile) and consistency (floor / mean) of weekly points; null under minGames. */
export function floorOf(weekly: number[]): { floor: number; consistency: number } | null {
  if (weekly.length < FLOOR.minGames) return null;
  const mean = weekly.reduce((a, b) => a + b, 0) / weekly.length;
  const floor = Math.max(0, percentile(weekly, 0.25));
  return { floor: r1(floor), consistency: mean > 0 ? r2(Math.min(1, floor / mean)) : 0 };
}

/** Set floor / consistency from prior-season weekly lines + this season's weeks (league scoring). */
export function attachFloor(players: Map<string, ValuedPlayer>, prior: Map<string, StatLine[]>, s: Scoring): void {
  for (const p of players.values()) {
    delete p.floor;
    delete p.consistency;
    if (p.pos === "K" || p.pos === "DEF") continue;
    const pts = [...(prior.get(p.id) ?? []), ...p.weeks.map((w) => w.actual)].map((l) => score(s, l, p.pos));
    const f = floorOf(pts);
    if (f) {
      p.floor = f.floor;
      p.consistency = f.consistency;
    }
  }
}

/** Lineup rate with the floor blended in: 0.8·x + 0.2·floor·(x / ppg), i.e. ppg scaled by (0.8 + 0.2·floor/ppg). */
export function floorFactor(p: ValuedPlayer): number {
  if (p.floor === undefined || !(p.ppg > 0)) return 1;
  return 1 - FLOOR.weight + (FLOOR.weight * p.floor) / p.ppg;
}

/**
 * Rising role: snap share +12 pts AND expected points +2 (last week vs the earlier mean), by the breakouts
 * module's roleMetrics. The breakouts "rising" tier alone (any 50%-snap starter) is far too broad to count.
 * Not risers: in-and-out snap histories (an earlier week < 25% next to one ≥ 50%: injury / left early),
 * players already full-time before (earlier mean ≥ 65%), and anyone whose last week is not a season high.
 */
export function riserSignal(p: ValuedPlayer, s: Scoring): { riser: boolean; oppLevel: number; roleTrend: number; oppTrend: number } {
  if (!BREAKOUT_POS.includes(p.pos)) return { riser: false, oppLevel: 0, roleTrend: 0, oppTrend: 0 };
  const m = roleMetrics(p, s);
  const earlier = snapSeries(p).shares.slice(0, -1);
  const noisy = earlier.some((x) => x < RISER.noisyLow) && earlier.some((x) => x >= LEFT_EARLY.before);
  const mean = earlier.length ? earlier.reduce((a, b) => a + b, 0) / earlier.length : 1;
  const newHigh = earlier.every((x) => m.roleNow > x);
  const riser = !noisy && newHigh && mean < RISER.maxEarlierShare && m.roleTrend >= RISER.snapTrend && m.oppTrend >= RISER.expTrend;
  return { riser, oppLevel: m.oppLevel, roleTrend: m.roleTrend, oppTrend: m.oppTrend };
}

/** Mark risers and blend 30% of their last-2-week expected ppg into ppg / effPpg (in place). */
export function attachRisers(players: Map<string, ValuedPlayer>, S: LeagueSettings): void {
  for (const p of players.values()) {
    if (p.riser) continue; // already applied to this object
    const r = riserSignal(p, S.scoring);
    if (!r.riser || !(p.ppg > 0)) continue;
    const ppg = (1 - RISER.blend) * p.ppg + RISER.blend * r.oppLevel;
    const ratio = ppg / p.ppg;
    p.riser = true;
    p.why += ` Riser: snaps ${r.roleTrend >= 0 ? "+" : ""}${Math.round(r.roleTrend * 100)} pts, expected pts ${r.oppTrend >= 0 ? "+" : ""}${r1(r.oppTrend)} last week; ppg ${r1(p.ppg)} → ${r1(ppg)} (30% last-2-week expected ${r1(r.oppLevel)}).`;
    p.ppg = r2(ppg);
    if (p.effPpg !== undefined) p.effPpg = r2(p.effPpg * ratio);
  }
}

// ---------------------------------------------------------------- same-NFL-team overlap

export const OVERLAP = { shared: 0.85, stack: 1.03 } as const;
type Group = "QB" | "RB" | "PC" | null;
export const groupOf = (pos: Position): Group => (pos === "QB" ? "QB" : pos === "RB" ? "RB" : pos === "WR" || pos === "TE" ? "PC" : null);

/**
 * Factor on an incoming player's contribution: ×0.85 when he shares NFL team and group (RB, or WR/TE
 * "pass-catchers") with one of the receiver's `core` players; ×1.03 for a QB–pass-catcher stack with a starter.
 */
export function overlapFactor(p: ValuedPlayer, core: ValuedPlayer[], starters: ValuedPlayer[]): { f: number; tag?: string } {
  const g = groupOf(p.pos);
  if (!g || !p.team || p.team === "FA") return { f: 1 };
  if (g !== "QB") {
    const mate = core.find((c) => c.id !== p.id && c.team === p.team && groupOf(c.pos) === g);
    if (mate) return { f: OVERLAP.shared, tag: `shares ${g === "RB" ? "carries" : "targets"} with ${mate.name}` };
  }
  const stackMate = starters.find((c) => c.id !== p.id && c.team === p.team && ((g === "QB" && groupOf(c.pos) === "PC") || (g === "PC" && c.pos === "QB")));
  if (stackMate) return { f: OVERLAP.stack, tag: `stack with ${stackMate.name}` };
  return { f: 1 };
}

const scaled = new WeakMap<ValuedPlayer, Map<number, ValuedPlayer>>();
/** The player with ppg / effPpg × f (same object when f = 1); cached so roster-score caches stay warm. */
export function scaledPlayer(p: ValuedPlayer, f: number): ValuedPlayer {
  if (f === 1) return p;
  let m = scaled.get(p);
  if (!m) scaled.set(p, (m = new Map()));
  let c = m.get(f);
  if (!c) {
    c = { ...p, ppg: p.ppg * f, effPpg: (p.effPpg ?? p.ppg) * f };
    m.set(f, c);
  }
  return c;
}
