// Roster score: the team objective used by Trade Finder v2. See docs/DESIGN.md "Trade finder v2".
import type { LeagueSettings, Position, SlotKind, ValuedPlayer } from "./types.js";
import { effPpg, isStartingSlot, SLOT_ELIGIBILITY, usable } from "./lineup.js";
import { floorFactor } from "./signals.js";
import { RETURNS } from "./returns.js";

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
 * Expected points per remaining week (weeks currentWeek..finalWeek): projection v4's `weekly` (bye / no game = 0,
 * availability and matchups applied). Hand-built players without a projection (test fixtures) derive it from ppg:
 * 0 on the bye, healthy ppg otherwise, with the games the injury model removed (weeksLeft − remainingGames) taken
 * from the earliest weeks. A player whose return is unconfirmed is 0 here (his "not back" scenario): lineups add his
 * return scenario through the scenario mix below, never as a per-week average.
 */
export function weeklyPoints(p: ValuedPlayer, S: LeagueSettings): Float64Array {
  let byS = weeklyCache.get(S);
  if (!byS) weeklyCache.set(S, (byS = new WeakMap()));
  const hit = byS.get(p);
  if (hit) return hit;
  const n = Math.max(0, S.finalWeek - S.currentWeek + 1);
  const out = new Float64Array(n);
  if (p.weekly && p.weeklyFrom !== undefined) {
    for (let i = 0; i < n; i++) {
      const v = p.weekly[S.currentWeek + i - p.weeklyFrom];
      out[i] = v !== undefined && Number.isFinite(v) && v > 0 ? v : 0;
    }
  } else if (usable(p)) {
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

// ---------------------------------------------------------------- return scenarios (injured trade pieces fix round 2)
//
// A player whose return is unconfirmed (ret.week null, absent, not out for the season, healthy rate known) is either
// back at his full healthy rate from current week + 4 (probability RETURN_BACK_P) or not back at all. A lineup is a
// max over players, so the expected lineup is the SCENARIO MIX p × lineup(him back) + (1 − p) × lineup(without him) —
// averaging his rate first (½ × healthy) would understate him (Jensen). Up to EXACT_RETURNS such players per roster
// are mixed exactly (2^k lineups, only in weeks where one of them has points); any beyond count at their expected
// points p × back (deterministic). That partial mix is bounded: never below the all-deterministic lineup, never above
// the exact 2^k mix (lineup value is convex in the players' points). The beyond-2 players are the ones with the
// fewest return-scenario points (ties by id). Confirmed returns stay deterministic (projection v4 weekly from wk N).

/** Probability an unconfirmed return is back (the existing unconfirmed convention, RETURNS.unknownWeight = ½). */
export const RETURN_BACK_P = RETURNS.unknownWeight;
/** Unconfirmed returns per roster mixed exactly; the rest count at their expected points. */
export const EXACT_RETURNS = 2;

const backCache = new WeakMap<LeagueSettings, WeakMap<ValuedPlayer, Float64Array | null>>();

/**
 * His points per remaining week IF he is back: `ret.backWeekly` (projection v4: healthy rate × matchup from current
 * week + 4), never below his base weekly points; fixtures without it: healthy rate outside the bye from current week
 * + 4. undefined = not an unconfirmed return (no ret, confirmed week, not absent, out for the season, no healthy rate).
 */
export function returnBackPoints(p: ValuedPlayer, S: LeagueSettings): Float64Array | undefined {
  const r = p.ret;
  if (!r || r.week !== null || !r.absent || r.seasonOver || r.healthyRate === undefined) return undefined;
  let byS = backCache.get(S);
  if (!byS) backCache.set(S, (byS = new WeakMap()));
  const hit = byS.get(p);
  if (hit !== undefined) return hit ?? undefined;
  const base = weeklyPoints(p, S);
  const out = new Float64Array(base.length);
  let any = false;
  for (let i = 0; i < out.length; i++) {
    const w = S.currentWeek + i;
    let v: number;
    if (r.backWeekly) {
      const x = r.backWeekly[i];
      v = x !== undefined && Number.isFinite(x) && x > 0 ? x : 0;
    } else v = w < S.currentWeek + RETURNS.unknownOffset || p.bye === w ? 0 : r.healthyRate;
    out[i] = Math.max(base[i], v);
    if (out[i] > base[i]) any = true;
  }
  byS.set(p, any ? out : null);
  return any ? out : undefined;
}

/**
 * Expected points per remaining week for PER-PLAYER comparisons (bye cover): weekly + p × (back − weekly). Never use
 * it inside a lineup max — lineups take the scenario mix (returnSplit / weekScenarios / scenarioPoints).
 */
const expCache = new WeakMap<Float64Array, Float64Array>();
export function expectedWeeklyPoints(p: ValuedPlayer, S: LeagueSettings): Float64Array {
  const back = returnBackPoints(p, S);
  const base = weeklyPoints(p, S);
  if (!back) return base;
  let e = expCache.get(back);
  if (!e) expCache.set(back, (e = base.map((b, i) => b + RETURN_BACK_P * (back[i] - b))));
  return e;
}

export interface ReturnSplit {
  /** Unconfirmed returns mixed exactly (≤ EXACT_RETURNS), with their return-scenario and base (not back) points. */
  branch: { p: ValuedPlayer; back: Float64Array; base: Float64Array }[];
  /** Unconfirmed returns beyond EXACT_RETURNS: counted at their expected points. */
  fixed: Map<ValuedPlayer, Float64Array>;
}

const backTotal = (b: Float64Array) => b.reduce((a, x) => a + x, 0);

/** The unconfirmed returns on a roster, split into the exactly mixed ones and the rest (see the section note). */
export function returnSplit(S: LeagueSettings, roster: readonly ValuedPlayer[]): ReturnSplit {
  const cands: { p: ValuedPlayer; back: Float64Array; t: number }[] = [];
  for (const p of roster) {
    const back = returnBackPoints(p, S);
    if (back) cands.push({ p, back, t: backTotal(back) });
  }
  cands.sort((a, b) => b.t - a.t || (a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0));
  return { branch: cands.slice(0, EXACT_RETURNS).map(({ p, back }) => ({ p, back, base: weeklyPoints(p, S) })), fixed: new Map(cands.slice(EXACT_RETURNS).map(({ p, back }) => [p, back])) };
}

export interface WeekScenario {
  prob: number;
  /** Bitmask over split.branch: who is back in this scenario. */
  on: number;
}

const ALL_OUT: WeekScenario[] = [{ prob: 1, on: 0 }];

/** The scenarios of remaining week i: only branch players with return-scenario points that week vary. */
export function weekScenarios(split: ReturnSplit, i: number): WeekScenario[] {
  let vary = 0;
  for (let b = 0; b < split.branch.length; b++) if (split.branch[b].back[i] > split.branch[b].base[i]) vary |= 1 << b;
  if (!vary) return ALL_OUT;
  const out: WeekScenario[] = [];
  for (let on = 0; on < 1 << split.branch.length; on++) {
    if (on & ~vary) continue;
    let prob = 1;
    for (let b = 0; b < split.branch.length; b++) if (vary & (1 << b)) prob *= on & (1 << b) ? RETURN_BACK_P : 1 - RETURN_BACK_P;
    out.push({ prob, on });
  }
  return out;
}

/** Player p's points in remaining week i under scenario sc, given his base points (weeklyPoints or a perceived view). */
export function scenarioPoints(split: ReturnSplit, i: number, sc: WeekScenario, p: ValuedPlayer, base: number): number {
  for (let b = 0; b < split.branch.length; b++) if (split.branch[b].p === p) return sc.on & (1 << b) ? Math.max(base, split.branch[b].back[i]) : base;
  const f = split.fixed.get(p);
  return f ? base + RETURN_BACK_P * Math.max(0, f[i] - base) : base;
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

/** Bitmask of week indexes where the player's points differ from his healthy rate (bye / injury / matchup). */
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
/** back = return-scenario weekly points × floor factor (unconfirmed returns only), backMask = weeks it differs. */
interface Rec { row: Float64Array; bit: number; irr: number; back?: Float64Array; backT: number; backMask: number }
const recCache = new WeakMap<LeagueSettings, WeakMap<ValuedPlayer, Rec>>();

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
  const recOf: Rec[] = new Array(n);
  for (let j = 0; j < n; j++) {
    const p = roster[j];
    let rec = recs.get(p);
    if (!rec) {
      const pts = weeklyPoints(p, S);
      const row = new Float64Array(stride);
      row[0] = effPpg(p);
      row[1] = usable(p) ? p.ppg : 0;
      row.set(pts, 2);
      // v3.1: lineup contribution = 0.8·ppg + 0.2·floor when the weekly floor is known.
      const ff = floorFactor(p);
      if (ff !== 1) for (let c = 0; c < stride; c++) row[c] *= ff;
      rec = { row, bit: POS_BIT[p.pos] ?? 0, irr: irregular(p, pts), backT: 0, backMask: 0 };
      const back = returnBackPoints(p, S);
      if (back) {
        rec.back = back.map((v) => v * ff);
        rec.backT = backTotal(back);
        for (let i = 0; i < back.length; i++) if (rec.back[i] > row[i + 2]) rec.backMask |= i < 31 ? 1 << i : 0;
      }
      recs.set(p, rec);
    }
    bits[j] = rec.bit;
    table.set(rec.row, j * stride);
    scratch.irr[j] = rec.irr;
    recOf[j] = rec;
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
  // Healthy lineup (every player at his full rate). A week reuses it only when no remaining player's points differ
  // from his healthy rate that week; v4 matchups make most weeks irregular, so those get their own lineup.
  const irrOf = scratch.irr;
  used.set(removed.subarray(0, n));
  const healthy = greedy(P.masks, bits, table, stride, 1, n, used);
  let recompute = 0;
  for (let j = 0; j < n; j++) if (!removed[j]) recompute |= irrOf[j];
  // Return scenarios (section note above): the top EXACT_RETURNS unconfirmed returns branch, the rest count at their
  // expected points (written into the scratch table); their weeks always get their own lineups.
  const ret: number[] = [];
  for (let j = 0; j < n; j++) if (!removed[j] && recOf[j].back) ret.push(j);
  ret.sort((a, b) => recOf[b].backT - recOf[a].backT || (roster[a].id < roster[b].id ? -1 : roster[a].id > roster[b].id ? 1 : 0));
  const branch = ret.slice(0, EXACT_RETURNS);
  for (const j of ret.slice(EXACT_RETURNS)) {
    const back = recOf[j].back!;
    for (let wi = 0; wi < P.nW; wi++) {
      const c = j * stride + wi + 2;
      table[c] += RETURN_BACK_P * Math.max(0, back[wi] - table[c]);
    }
  }
  for (const j of ret) recompute |= recOf[j].backMask;
  let seasonSum = 0;
  let poSum = 0;
  for (let wi = 0; wi < P.nW; wi++) {
    let v = healthy;
    if (wi >= 31 || recompute & (1 << wi)) {
      let vary = 0;
      for (let b = 0; b < branch.length; b++) if (recOf[branch[b]].back![wi] > table[branch[b] * stride + wi + 2]) vary |= 1 << b;
      if (!vary) {
        used.set(removed.subarray(0, n));
        v = greedy(P.masks, bits, table, stride, wi + 2, n, used);
      } else {
        // p × lineup(back) + (1 − p) × lineup(not back), per varying branch player.
        const saved = branch.map((j) => table[j * stride + wi + 2]);
        v = 0;
        for (let on = 0; on < 1 << branch.length; on++) {
          if (on & ~vary) continue;
          let prob = 1;
          for (let b = 0; b < branch.length; b++) {
            if (!(vary & (1 << b))) continue;
            const isOn = on & (1 << b);
            prob *= isOn ? RETURN_BACK_P : 1 - RETURN_BACK_P;
            table[branch[b] * stride + wi + 2] = isOn ? recOf[branch[b]].back![wi] : saved[b];
          }
          used.set(removed.subarray(0, n));
          v += prob * greedy(P.masks, bits, table, stride, wi + 2, n, used);
        }
        branch.forEach((j, b) => (table[j * stride + wi + 2] = saved[b]));
      }
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

/** May an IR-slot player play again this season (a return estimate, not out for the season)? The one IR-slot test. */
export const irSlotReturns = (p: ValuedPlayer): boolean => !!p.ret && !p.ret.seasonOver;

const irViews = new WeakMap<ValuedPlayer, ValuedPlayer>();
const NO_WEEKS: number[] = [];

/**
 * A player in his team's IR slot as that team's lineups see him (owner 2026-10-26, injured trade pieces fix round 1):
 * never a starter or bench depth this week (effPpg 0); from his return week his weekly points count — he leaves the
 * IR slot when healthy (projection v4 has him at 0 before it; an unconfirmed return enters the return-scenario mix). Without a
 * return estimate (no `ret`) or out for the season he never plays. Cached per player object (one view each).
 */
export function irSlotView(p: ValuedPlayer): ValuedPlayer {
  let v = irViews.get(p);
  if (!v) {
    if (irSlotReturns(p)) v = { ...p, effPpg: 0 };
    else {
      const { ret: _ret, ...rest } = p;
      v = { ...rest, effPpg: 0, remainingGames: 0, weekly: NO_WEEKS, weeklyFrom: 0 };
    }
    irViews.set(p, v);
  }
  return v;
}

/** The roster a team's lineups score: IR-slot players as irSlotView (back from their return week, never this week). */
export function activeRoster(roster: ValuedPlayer[], irIds: ReadonlySet<string>): ValuedPlayer[] {
  return irIds.size ? roster.map((p) => (irIds.has(p.id) ? irSlotView(p) : p)) : roster;
}

/** Score any roster under league settings (no drops). */
export function rosterScore(S: LeagueSettings, roster: ValuedPlayer[], replacement: Replacement = {}): ScoreParts {
  return rosterParts(S, roster, replacement).parts;
}

export function partsDelta(after: ScoreParts, before: ScoreParts): ScoreParts {
  return { now: after.now - before.now, season: after.season - before.season, playoffs: after.playoffs - before.playoffs, depth: after.depth - before.depth };
}

