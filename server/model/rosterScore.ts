// Roster score: the team objective used by Trade Finder v2. See docs/DESIGN.md "Trade finder v2".
import type { LeagueSettings, Position, SlotKind, ValuedPlayer } from "./types.js";
import { effPpg, isStartingSlot, SLOT_ELIGIBILITY, usable } from "./lineup.js";
import { injuryKind } from "./projection.js";

export type TradeMode = "now" | "balanced" | "playoffs";
export const TRADE_MODES: TradeMode[] = ["now", "balanced", "playoffs"];

export interface ScoreWeights {
  now: number;
  season: number;
  playoffs: number;
  depth: number;
}

/** Weights per finder mode (architect's Trade Finder v2 design). */
export const MODE_WEIGHTS: Record<TradeMode, ScoreWeights> = {
  now: { now: 1, season: 0, playoffs: 0, depth: 0.15 },
  balanced: { now: 0.4, season: 0.4, playoffs: 0.2, depth: 0.25 },
  playoffs: { now: 0.15, season: 0.25, playoffs: 0.6, depth: 0.25 },
};

export const MODE_BLURB: Record<TradeMode, string> = {
  now: "Win now: this week's starting lineup, with a little credit for bench depth.",
  balanced: "Balanced: this week, the rest of the season (byes and injuries included) and the playoffs.",
  playoffs: "Playoffs: your lineup in the playoff weeks first, then the rest of the season.",
};

export function parseMode(x: unknown): TradeMode {
  const s = String(x ?? "").toLowerCase();
  return (TRADE_MODES as string[]).includes(s) ? (s as TradeMode) : "balanced";
}

export interface ScoreParts {
  /** Optimal-lineup effPpg sum (= starterPpg). */
  now: number;
  /** Mean weekly optimal-lineup points over every remaining week (byes / injuries applied). */
  season: number;
  /** Mean weekly optimal-lineup points over the playoff weeks. */
  playoffs: number;
  /** Top-K bench players' ppg above positional replacement. */
  depth: number;
}

export const combine = (p: ScoreParts, w: ScoreWeights) => w.now * p.now + w.season * p.season + w.playoffs * p.playoffs + w.depth * p.depth;

export type Replacement = Partial<Record<Position, number>>;

/** Weeks the score looks at, and which of them are playoff weeks. */
export function scoreWeeks(S: LeagueSettings): { weeks: number[]; playoff: boolean[] } {
  const weeks: number[] = [];
  const playoff: boolean[] = [];
  for (let w = S.currentWeek; w <= S.finalWeek; w++) {
    weeks.push(w);
    playoff.push(w > S.regularSeasonEnd);
  }
  return { weeks, playoff };
}

const weeklyCache = new WeakMap<LeagueSettings, WeakMap<ValuedPlayer, Float64Array>>();

/**
 * Expected points per remaining week: 0 on the bye; healthy ppg otherwise, with the
 * games the injury model removed (weeksLeft − remainingGames) taken from the earliest weeks.
 */
export function weeklyPoints(p: ValuedPlayer, S: LeagueSettings): Float64Array {
  let byS = weeklyCache.get(S);
  if (!byS) weeklyCache.set(S, (byS = new WeakMap()));
  const hit = byS.get(p);
  if (hit) return hit;
  const n = Math.max(0, S.finalWeek - S.currentWeek + 1);
  const out = new Float64Array(n);
  if (usable(p)) {
    let weeksLeft = 0;
    for (let w = S.currentWeek; w <= S.finalWeek; w++) if (p.bye !== w) weeksLeft++;
    let missing = Math.max(0, weeksLeft - p.remainingGames);
    for (let i = 0; i < n; i++) {
      const w = S.currentWeek + i;
      if (p.bye === w) continue;
      const miss = Math.min(1, missing);
      missing -= miss;
      out[i] = p.ppg * (1 - miss);
    }
  }
  byS.set(p, out);
  return out;
}

const FILL_ORDER: SlotKind[] = ["QB", "RB", "WR", "TE", "K", "DEF", "WRRB", "RFLEX", "FLEX", "SFLEX"];

/** Starting slots in greedy fill order (same order as optimalLineup). */
export function fillOrder(slots: SlotKind[]): SlotKind[] {
  const starting = slots.filter(isStartingSlot);
  return FILL_ORDER.flatMap((k) => starting.filter((s) => s === k));
}

const POS_BIT: Record<Position, number> = { QB: 1, RB: 2, WR: 4, TE: 8, K: 16, DEF: 32 };
const slotMask = (s: SlotKind) => SLOT_ELIGIBILITY[s].reduce((m, p) => m | POS_BIT[p], 0);

/** Bench players counted for depth: ceil(starting skill slots / 2), at least 3. */
export function depthCount(slots: SlotKind[]): number {
  const skill = slots.filter((s) => isStartingSlot(s) && s !== "K" && s !== "DEF").length;
  return Math.max(3, Math.ceil(skill / 2));
}

interface Prepared {
  masks: Int32Array;
  nW: number;
  playoff: Uint8Array;
  poN: number;
  K: number;
}
const prepCache = new WeakMap<LeagueSettings, Prepared>();
function prep(S: LeagueSettings): Prepared {
  let p = prepCache.get(S);
  if (!p) {
    const { weeks, playoff } = scoreWeeks(S);
    p = {
      masks: Int32Array.from(fillOrder(S.slots).map(slotMask)),
      nW: weeks.length,
      playoff: Uint8Array.from(playoff.map(Number)),
      poN: playoff.filter(Boolean).length,
      K: depthCount(S.slots),
    };
    prepCache.set(S, p);
  }
  return p;
}

/**
 * Greedy lineup total over column `col` of a flat points table (stride = columns per player),
 * same greedy as optimalLineup. Marks starters in `used`.
 */
function greedy(masks: Int32Array, bits: Int32Array, table: Float64Array, stride: number, col: number, n: number, used: Uint8Array): number {
  let total = 0;
  for (let si = 0; si < masks.length; si++) {
    const m = masks[si];
    let best = -1;
    let bestPts = -1;
    for (let j = 0; j < n; j++) {
      if (used[j] || !(bits[j] & m)) continue;
      const v = table[j * stride + col];
      if (v > bestPts) {
        bestPts = v;
        best = j;
      }
    }
    if (best >= 0) {
      used[best] = 1;
      total += bestPts;
    }
  }
  return total;
}

/** Bitmask of week indexes where the player's points differ from his healthy rate (bye / injury). */
const irregularCache = new WeakMap<Float64Array, number>();
function irregular(p: ValuedPlayer, pts: Float64Array): number {
  let m = irregularCache.get(pts);
  if (m === undefined) {
    m = 0;
    const healthy = usable(p) ? p.ppg : 0;
    for (let i = 0; i < pts.length && i < 31; i++) if (pts[i] !== healthy) m |= 1 << i;
    if (pts.length > 31) m |= ~0 << 31; // beyond 31 weeks: treat as irregular (never happens in the NFL)
    irregularCache.set(pts, m);
  }
  return m;
}

/** Per-player row [effPpg, healthy ppg, ...weekly points], position bit and irregular-week mask. */
const recCache = new WeakMap<LeagueSettings, WeakMap<ValuedPlayer, { row: Float64Array; bit: number; irr: number }>>();

/** Scratch buffers reused across calls (single-threaded; no call retains them). */
let scratch = { table: new Float64Array(1024), bits: new Int32Array(64), used: new Uint8Array(64), starters: new Uint8Array(64), removed: new Uint8Array(64), irr: new Int32Array(64) };

export interface DropRule {
  /** How many bench players must be released. */
  count: number;
  /** Players that may not be dropped (incoming players, IR). */
  keep: (p: ValuedPlayer) => boolean;
}

/**
 * Score a roster: now (effPpg lineup), season / playoffs (weekly lineups with byes and
 * injuries), depth (top-K bench above replacement). When `drop` is given, the lowest-value
 * bench players (value, then ppg, then ECR) are released first, as applyTrade does.
 */
export function rosterParts(S: LeagueSettings, roster: ValuedPlayer[], replacement: Replacement = {}, drop?: DropRule): { parts: ScoreParts; drops: ValuedPlayer[] } {
  const P = prep(S);
  const n = roster.length;
  // Columns: 0 = effPpg ("now"), 1 = healthy ppg (weeks without byes / injuries), 2.. = weekly points.
  const stride = P.nW + 2;
  if (scratch.table.length < n * stride) scratch.table = new Float64Array(n * stride * 2);
  if (scratch.bits.length < n) scratch = { table: scratch.table, bits: new Int32Array(n * 2), used: new Uint8Array(n * 2), starters: new Uint8Array(n * 2), removed: new Uint8Array(n * 2), irr: new Int32Array(n * 2) };
  const { table, bits, used, starters, removed } = scratch;
  if (scratch.irr.length < n) scratch.irr = new Int32Array(n * 2);
  let recs = recCache.get(S);
  if (!recs) recCache.set(S, (recs = new WeakMap()));
  for (let j = 0; j < n; j++) {
    const p = roster[j];
    let rec = recs.get(p);
    if (!rec) {
      const pts = weeklyPoints(p, S);
      const row = new Float64Array(stride);
      row[0] = effPpg(p);
      row[1] = usable(p) ? p.ppg : 0;
      row.set(pts, 2);
      rec = { row, bit: POS_BIT[p.pos] ?? 0, irr: irregular(p, pts) };
      recs.set(p, rec);
    }
    bits[j] = rec.bit;
    table.set(rec.row, j * stride);
    scratch.irr[j] = rec.irr;
  }
  used.fill(0);
  removed.fill(0);
  const now = greedy(P.masks, bits, table, stride, 0, n, used);
  starters.set(used);
  const drops: ValuedPlayer[] = [];
  if (drop && drop.count > 0) {
    const cands: number[] = [];
    for (let j = 0; j < n; j++) if (!starters[j] && !drop.keep(roster[j])) cands.push(j);
    cands.sort((a, b) => roster[a].value - roster[b].value || roster[a].ppg - roster[b].ppg || (roster[b].ecrOverall ?? 999) - (roster[a].ecrOverall ?? 999));
    for (const j of cands.slice(0, drop.count)) {
      removed[j] = 1;
      drops.push(roster[j]);
    }
  }
  // Healthy lineup (every player at his full rate). Weekly points never exceed the healthy
  // rate, so a week only needs its own lineup when a healthy-lineup starter is on bye / hurt.
  const irrOf = scratch.irr;
  used.set(removed.subarray(0, n));
  const healthy = greedy(P.masks, bits, table, stride, 1, n, used);
  let recompute = 0;
  for (let j = 0; j < n; j++) if (used[j] && !removed[j]) recompute |= irrOf[j];
  let seasonSum = 0;
  let poSum = 0;
  for (let wi = 0; wi < P.nW; wi++) {
    let v = healthy;
    if (wi >= 31 || recompute & (1 << wi)) {
      used.set(removed.subarray(0, n));
      v = greedy(P.masks, bits, table, stride, wi + 2, n, used);
    }
    seasonSum += v;
    if (P.playoff[wi]) poSum += v;
  }
  const bench: number[] = [];
  for (let j = 0; j < n; j++) {
    const p = roster[j];
    if (starters[j] || removed[j] || p.pos === "K" || p.pos === "DEF") continue;
    bench.push(Math.max(0, table[j * stride] - (replacement[p.pos] ?? 0)));
  }
  bench.sort((a, b) => b - a);
  let depth = 0;
  for (let i = 0; i < Math.min(P.K, bench.length); i++) depth += bench[i];
  const season = P.nW ? seasonSum / P.nW : now;
  return {
    parts: { now: Math.round(now * 100) / 100, season, playoffs: P.poN ? poSum / P.poN : season, depth },
    drops,
  };
}

/** Score any roster under league settings (no drops). */
export function rosterScore(S: LeagueSettings, roster: ValuedPlayer[], replacement: Replacement = {}): ScoreParts {
  return rosterParts(S, roster, replacement).parts;
}

export function partsDelta(after: ScoreParts, before: ScoreParts): ScoreParts {
  return { now: after.now - before.now, season: after.season - before.season, playoffs: after.playoffs - before.playoffs, depth: after.depth - before.depth };
}

// ---------------------------------------------------------------- injury risk

/** Haircut on players I receive: Questionable 0.85, Doubtful 0.70, Out (incl. designated to return) 0.55. */
export const INJURY_RISK = { questionable: 0.85, doubtful: 0.7, out: 0.55 } as const;

export function riskStatus(p: ValuedPlayer): keyof typeof INJURY_RISK | null {
  if (!p.injury) return null;
  const k = injuryKind(p.injury);
  if (k === "out" || k === "return") return "out";
  if (k === "doubtful") return "doubtful";
  const st = p.injury.status.trim().toUpperCase();
  if (st === "Q" || st === "QUESTIONABLE") return "questionable";
  return null;
}

const riskClones = new WeakMap<ValuedPlayer, ValuedPlayer>();
/** The player with ppg / effPpg scaled by the injury-risk haircut (value unchanged); same object when healthy. */
export function riskAdjusted(p: ValuedPlayer): ValuedPlayer {
  const st = riskStatus(p);
  if (!st) return p;
  let c = riskClones.get(p);
  if (!c) {
    const f = INJURY_RISK[st];
    c = { ...p, ppg: p.ppg * f, effPpg: (p.effPpg ?? p.ppg) * f };
    riskClones.set(p, c);
  }
  return c;
}
