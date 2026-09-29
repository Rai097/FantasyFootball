// Rest-of-season value model. See docs/DESIGN.md "Value model" (+ architect amendments).
import type { League, Player, Position, Scoring, SlotKind, ValuedPlayer } from "./types.js";
import { SKILL_POSITIONS } from "./types.js";
import { recFormat, score } from "./scoring.js";

export const POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

/** Blend weights (before renormalisation over available components). */
export const WEIGHTS = { ecr: 0.65, current: 0.22, prior: 0.13 };
/** Games at which the current-season component reaches its full weight. */
export const CURRENT_FULL_GAMES = 5;
/** Min games for a player to feed the current-season rank→points curve. */
export const CURVE_MIN_GAMES = 3;
/** Cap on the current-season curve relative to the prior-season curve at the same rank. */
export const CURVE_CURRENT_CAP = 1.15;
/** Games deducted for Out / Doubtful / Yahoo "designated to return" players. */
export const INJURY_CUT = { out: 2, doubtful: 0.7, return: 4 } as const;
/** Kicker / defense ppg straight from ECR positional rank. */
export const KDEF_CURVE: Record<"K" | "DEF", { base: number; slope: number }> = {
  K: { base: 9, slope: 0.1 },
  DEF: { base: 8.5, slope: 0.15 },
};
/** Share of each flex slot type expected to be filled by each position. */
export const FLEX_SHARE: Partial<Record<SlotKind, Partial<Record<Position, number>>>> = {
  FLEX: { RB: 0.45, WR: 0.45, TE: 0.1 },
  SFLEX: { QB: 0.7, RB: 0.12, WR: 0.12, TE: 0.06 },
  RFLEX: { WR: 0.6, TE: 0.4 },
  WRRB: { RB: 0.5, WR: 0.5 },
};
/** Bench-depth term of the replacement rank, for a 12-team league (scaled by numTeams/12). */
export const BENCH_DEPTH: Record<Position, number> = { QB: 2, RB: 6, WR: 6, TE: 3, K: 0, DEF: 0 };
export const PLAYOFF_WEIGHT = 1.25;
/** Weight of the overall-ECR implied value in the final value (model value gets the rest). */
export const CONSENSUS_WEIGHT = 0.35;
const CONVEXITY = 1.15;
const LONG_TERM_RE = /ACL|Achilles|season|\bIR\b|^NA\b/i;
const RETURN_RE = /return designation/i;

export interface Valuation {
  players: Map<string, ValuedPlayer>;
  replacement: Record<Position, number>;
  /** Value a player that was not in the pool (e.g. a Yahoo-only free agent). */
  valueOf(p: Player): ValuedPlayer;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Centered moving average, window 3 (edges use the available neighbours). */
export function smooth(xs: number[], window = 3): number[] {
  const h = Math.floor(window / 2);
  return xs.map((_, i) => mean(xs.slice(Math.max(0, i - h), i + h + 1)));
}

/** Value at fractional 1-based rank with linear interpolation; clamps past the ends. */
export function curveAt(curve: number[], rank: number): number {
  if (!curve.length) return 0;
  const idx = Math.max(0, rank - 1);
  const lo = Math.min(Math.floor(idx), curve.length - 1);
  const hi = Math.min(lo + 1, curve.length - 1);
  const f = Math.min(1, idx - Math.floor(idx));
  return curve[lo] + (curve[hi] - curve[lo]) * (idx >= curve.length - 1 ? 0 : f);
}

/**
 * Classify an injury status (nflverse report or Yahoo code).
 *  - long: IR / PUP / NFI / Yahoo NA, or Out/Doubtful with an ACL/Achilles/season/IR/NA detail → 0 games
 *  - return: Yahoo "-R" designation (IR-R etc., detail "return designation", not IR) → Out, −4 games
 *  - out / doubtful: −2 / −0.7 games
 */
export type InjuryKind = "long" | "return" | "out" | "doubtful";
export function injuryKind(inj: Player["injury"]): InjuryKind | null {
  if (!inj) return null;
  const st = inj.status.trim().toUpperCase();
  const detail = (inj.detail ?? "").trim();
  const isOut = st === "OUT" || st === "O";
  const isDoubtful = st === "DOUBTFUL" || st === "D";
  if (/^(IR|PUP|NFI)-R$/.test(st)) return "return";
  if (st === "IR" || st.startsWith("PUP") || st === "NFI" || st === "NA") return "long";
  // Detail-based classification only applies when the player is actually out/doubtful.
  if ((isOut || isDoubtful) && RETURN_RE.test(detail) && !/\bIR\b/.test(detail)) return "return";
  if ((isOut || isDoubtful) && LONG_TERM_RE.test(detail)) return "long";
  if (isOut || st === "SUSP") return "out";
  if (isDoubtful) return "doubtful";
  return null;
}

interface Base {
  p: Player;
  games: number;
  ppg26: number;
  ppgExp26: number;
  ppg25: number;
  hasPrior: boolean;
  trend: number;
  ecrRank?: number; // positional
  ecrRankDerived: boolean;
  ecrPts?: number;
  ecrUnranked: boolean;
  ppg: number;
  remainingGames: number;
  /** Game weeks left ignoring injuries (bye removed): denominator of effPpg. */
  weeksLeft: number;
  weightedGames: number;
  gameNotes: string[];
  wEcr: number;
  wCur: number;
  wPrior: number;
  injKind: ReturnType<typeof injuryKind>;
}

/** Replacement rank (1-based) per position for a league's starting slots. */
export function replacementRanks(slots: SlotKind[], numTeams: number): Record<Position, number> {
  const out = {} as Record<Position, number>;
  for (const pos of POSITIONS) {
    const dedicated = slots.filter((s) => s === pos).length;
    let flex = 0;
    for (const s of slots) flex += FLEX_SHARE[s]?.[pos] ?? 0;
    out[pos] = Math.max(1, Math.round(numTeams * dedicated + flex * numTeams + (BENCH_DEPTH[pos] * numTeams) / 12));
  }
  return out;
}

/**
 * Compute ValuedPlayer for every player in `pool` under the league's scoring and
 * calendar. Deterministic; does not mutate the input players.
 */
export function valuePlayers(league: League, pool: Iterable<Player>): Valuation {
  const S = league.settings;
  const scoring: Scoring = S.scoring;
  const fmt = recFormat(scoring);
  const all = [...pool];
  const playoffStart = S.regularSeasonEnd + 1;

  const stats = (p: Player) => {
    const weeks = [...p.weeks].sort((a, b) => a.week - b.week);
    const act = weeks.map((w) => score(scoring, w.actual, p.pos));
    const exp = weeks.map((w) => score(scoring, w.expected, p.pos));
    const ppg26 = mean(act);
    const ppgExp26 = mean(exp);
    const hasPrior = !!p.prior && p.prior.games >= 4;
    const ppg25 = hasPrior ? score(scoring, p.prior!.line, p.pos) / p.prior!.games : 0;
    const trend = weeks.length >= 3 ? mean(exp.slice(-2)) - ppgExp26 : 0;
    return { games: weeks.length, ppg26, ppgExp26, ppg25, hasPrior, trend, priorGames: p.prior?.games ?? 0 };
  };

  // --- 1. per-player raw stats
  const raw = new Map<string, ReturnType<typeof stats>>();
  for (const p of all) raw.set(p.id, stats(p));

  // --- 2. rank -> points curves (0.5 * 2026 blend curve + 0.5 * 2025 ppg curve, smoothed)
  const curves = {} as Record<Position, number[]>;
  for (const pos of SKILL_POSITIONS) {
    const a: number[] = [];
    const b: number[] = [];
    for (const p of all) {
      if (p.pos !== pos) continue;
      const s = raw.get(p.id)!;
      if (s.games >= CURVE_MIN_GAMES) a.push(0.6 * s.ppgExp26 + 0.4 * s.ppg26);
      if (s.priorGames >= 8) b.push(s.ppg25);
    }
    a.sort((x, y) => y - x);
    b.sort((x, y) => y - x);
    // Early-season outliers: the current-season curve may not exceed the prior curve by >15% at a rank.
    for (let i = 0; i < Math.min(a.length, b.length); i++) a[i] = Math.min(a[i], CURVE_CURRENT_CAP * b[i]);
    const n = Math.max(a.length, b.length);
    const combined: number[] = [];
    for (let i = 0; i < n; i++) {
      if (a.length && b.length) combined.push(0.5 * a[Math.min(i, a.length - 1)] + 0.5 * b[Math.min(i, b.length - 1)]);
      else combined.push((a.length ? a : b)[i]);
    }
    curves[pos] = smooth(combined, 3);
  }

  // --- 3. positional ECR ranks (derive from overall order when only overall is known)
  const derivedRank = new Map<string, number>();
  const maxRank = {} as Record<Position, number>;
  for (const pos of POSITIONS) {
    const withOverall = all.filter((p) => p.pos === pos && p.ecrOverall !== undefined).sort((x, y) => x.ecrOverall! - y.ecrOverall!);
    withOverall.forEach((p, i) => derivedRank.set(p.id, i + 1));
    let m = 0;
    for (const p of all) if (p.pos === pos) m = Math.max(m, p.ecrPos ?? derivedRank.get(p.id) ?? 0);
    maxRank[pos] = m;
  }

  const makeBase = (p: Player): Base => {
    const s = raw.get(p.id) ?? stats(p);
    const injKind = injuryKind(p.injury);
    const ecrRankDerived = p.ecrPos === undefined && derivedRank.has(p.id);
    const ecrRank = p.ecrPos ?? derivedRank.get(p.id);

    // Remaining games (count) and playoff-weighted games.
    const gameNotes: string[] = [];
    let remaining = 0;
    let weighted = 0;
    let byeInWindow = false;
    for (let w = S.currentWeek; w <= S.finalWeek; w++) {
      if (p.bye === w) {
        byeInWindow = true;
        continue;
      }
      remaining += 1;
      weighted += w >= playoffStart ? PLAYOFF_WEIGHT : 1;
    }
    if (byeInWindow) gameNotes.push(`bye wk ${p.bye}`);
    const weeksLeft = remaining;
    if (p.team === "FA" && p.pos !== "DEF") {
      remaining = weighted = 0;
      gameNotes.push("no NFL team");
    } else if (injKind === "long") {
      remaining = weighted = 0;
      gameNotes.push(`${p.injury!.status}${p.injury!.detail ? ` (${p.injury!.detail})` : ""}: long-term, 0 games counted`);
    } else if (injKind === "out" || injKind === "doubtful" || injKind === "return") {
      const cut = INJURY_CUT[injKind];
      remaining = Math.max(0, remaining - cut);
      weighted = Math.max(0, weighted - cut);
      gameNotes.push(`${p.injury!.status}${injKind === "return" ? " (designated to return)" : ""} −${cut}`);
    }

    let ppg = 0;
    let ecrPts: number | undefined;
    let ecrUnranked = false;
    let wEcr = 0;
    let wCur = 0;
    let wPrior = 0;
    if (p.pos === "K" || p.pos === "DEF") {
      const c = KDEF_CURVE[p.pos];
      const rank = ecrRank ?? maxRank[p.pos] + 1;
      ecrUnranked = ecrRank === undefined;
      ecrPts = Math.max(0, c.base - c.slope * (rank - 1));
      ppg = ecrPts;
      wEcr = 1;
    } else {
      const curve = curves[p.pos] ?? [];
      if (ecrRank !== undefined) ecrPts = curveAt(curve, ecrRank);
      else if ((s.games > 0 || s.hasPrior) && maxRank[p.pos] > 0) {
        // Unranked by the experts but has production: anchor to the curve just past the last ranked player.
        ecrPts = curveAt(curve, maxRank[p.pos] + 1);
        ecrUnranked = true;
      }
      const comps: { v: number; w: number }[] = [];
      if (ecrPts !== undefined) {
        wEcr = WEIGHTS.ecr * (injKind === "long" ? 0.5 : 1);
        comps.push({ v: ecrPts, w: wEcr });
      }
      if (s.games > 0) {
        wCur = (WEIGHTS.current * Math.min(s.games, CURRENT_FULL_GAMES)) / CURRENT_FULL_GAMES;
        comps.push({ v: 0.6 * s.ppgExp26 + 0.4 * s.ppg26, w: wCur });
      }
      if (s.hasPrior) {
        wPrior = WEIGHTS.prior;
        comps.push({ v: s.ppg25, w: wPrior });
      }
      const tw = comps.reduce((a, c) => a + c.w, 0);
      ppg = tw > 0 ? comps.reduce((a, c) => a + c.v * c.w, 0) / tw : 0;
      const norm = tw || 1;
      wEcr /= norm;
      wCur /= norm;
      wPrior /= norm;
    }
    return {
      p,
      games: s.games,
      ppg26: s.ppg26,
      ppgExp26: s.ppgExp26,
      ppg25: s.ppg25,
      hasPrior: s.hasPrior,
      trend: s.trend,
      ecrRank,
      ecrRankDerived,
      ecrPts,
      ecrUnranked,
      ppg: Math.max(0, ppg),
      remainingGames: remaining,
      weeksLeft,
      weightedGames: weighted,
      gameNotes,
      wEcr,
      wCur,
      wPrior,
      injKind,
    };
  };

  const bases = all.map(makeBase);

  // --- 4. replacement level per position
  const replRank = replacementRanks(S.slots, S.numTeams);
  const byPos = {} as Record<Position, number[]>;
  for (const pos of POSITIONS) byPos[pos] = [];
  for (const b of bases) if (b.remainingGames > 0) byPos[b.p.pos].push(b.ppg);
  const replacement = {} as Record<Position, number>;
  const posSorted = {} as Record<Position, number[]>;
  for (const pos of POSITIONS) {
    const arr = byPos[pos].sort((x, y) => y - x);
    replacement[pos] = r2(arr[Math.min(replRank[pos], arr.length) - 1] ?? 0);
    posSorted[pos] = bases.filter((b) => b.p.pos === pos).map((b) => b.ppg).sort((x, y) => y - x);
  }

  // --- 5. value scale
  const rawValue = (b: Base) => Math.max(0, b.ppg - replacement[b.p.pos]) * b.weightedGames;
  let maxRaw = 0;
  for (const b of bases) maxRaw = Math.max(maxRaw, rawValue(b));
  const modelValueOf = (b: Base) => {
    const rv = rawValue(b);
    return maxRaw > 0 && rv > 0 ? 100 * Math.pow(rv / maxRaw, CONVEXITY) : 0;
  };

  // --- 6. consensus anchor: blend model value with the value implied by overall ECR rank.
  const isSkill = (b: Base) => b.p.pos !== "K" && b.p.pos !== "DEF";
  const valueAtRank = bases.filter(isSkill).map(modelValueOf).sort((x, y) => y - x);
  const anchorOf = (b: Base): Anchor => {
    const model = modelValueOf(b);
    if (!isSkill(b) || b.p.ecrOverall === undefined || !valueAtRank.length) return { model, blended: model };
    // Implied value at the player's overall rank, scaled by availability (IR / injuries / no team still cost value).
    const avail = b.weeksLeft > 0 ? Math.min(1, b.remainingGames / b.weeksLeft) : 0;
    const implied = curveAt(valueAtRank, b.p.ecrOverall) * avail;
    return { model, implied, rank: b.p.ecrOverall, blended: (1 - CONSENSUS_WEIGHT) * model + CONSENSUS_WEIGHT * implied };
  };
  let maxBlended = 0;
  for (const b of bases) maxBlended = Math.max(maxBlended, anchorOf(b).blended);
  const scale = maxBlended > 0 ? 100 / maxBlended : 0;

  const posRankOf = (pos: Position, ppg: number) => {
    // number of players at pos with strictly higher ppg, +1
    const arr = posSorted[pos];
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] > ppg) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };

  const finalize = (b: Base, posRank: number): ValuedPlayer => {
    const p = b.p;
    const vorp = Math.max(0, b.ppg - replacement[p.pos]);
    const anchor = anchorOf(b);
    const value = r1(Math.min(100, anchor.blended * scale));
    const weekProj = p.weekProjByFormat?.[fmt] ?? p.weekProj;
    const effPpg = effPpgOf(b);
    return {
      ...p,
      weekProj,
      ppg: r2(b.ppg),
      effPpg: r2(effPpg),
      ppg26: r2(b.ppg26),
      ppgExp26: r2(b.ppgExp26),
      ppg25: r2(b.ppg25),
      games: b.games,
      vorp: r2(vorp),
      value,
      posRank,
      remainingGames: r1(b.remainingGames),
      trend: r2(b.trend),
      why: explain(b, replacement[p.pos], vorp, value, anchor, scale),
    };
  };

  const poolById = new Map(all.map((p) => [p.id, p]));
  const players = new Map<string, ValuedPlayer>();
  for (const b of bases) players.set(b.p.id, finalize(b, posRankOf(b.p.pos, b.ppg)));

  return {
    players,
    replacement,
    valueOf(p: Player) {
      // Same object as in the pool → reuse; otherwise (e.g. Yahoo copy with fresher injury) re-value.
      const hit = players.get(p.id);
      if (hit && poolById.get(p.id) === p) return hit;
      const b = makeBase(p);
      return finalize(b, posRankOf(p.pos, b.ppg));
    },
  };
}

/** Note shown once per analysis response (instead of in every why string). */
export function valuationNotes(league: League): string[] {
  const notes: string[] = [];
  if (recFormat(league.settings.scoring) !== "ppr") notes.push("ECR ranks are PPR; points use league scoring.");
  return notes;
}

/**
 * Availability-adjusted ppg used for lineups: ppg × remainingGames / weeksLeft, where
 * weeksLeft = weeks currentWeek..finalWeek minus the bye. Healthy players: effPpg = ppg.
 */
function effPpgOf(b: Pick<Base, "ppg" | "remainingGames" | "weeksLeft">): number {
  if (b.weeksLeft <= 0) return 0;
  return Math.max(0, b.ppg) * Math.min(1, b.remainingGames / b.weeksLeft);
}

interface Anchor {
  model: number;
  implied?: number;
  rank?: number;
  blended: number;
}

function explain(b: Base, repl: number, vorp: number, value: number, anchor: Anchor, scale: number): string {
  const p = b.p;
  const f1 = (x: number) => x.toFixed(1);
  const parts: string[] = [];
  if (p.pos === "K" || p.pos === "DEF") {
    const rank = b.ecrRank !== undefined ? `${p.pos}${Math.round(b.ecrRank)}` : `unranked ${p.pos}`;
    parts.push(`Proj ${f1(b.ppg)} ppg from ECR ${rank} (${p.pos} scale ${KDEF_CURVE[p.pos].base} − ${KDEF_CURVE[p.pos].slope}/rank)`);
  } else {
    const comps: string[] = [];
    if (b.ecrPts !== undefined) {
      const lbl = b.ecrUnranked ? "unranked (tail of curve)" : `${p.pos}${Math.round(b.ecrRank! * 10) / 10}${b.ecrRankDerived ? " via overall" : ""}`;
      comps.push(`ECR ${lbl} (${f1(b.ecrPts)}, ${Math.round(b.wEcr * 100)}%)`);
    }
    if (b.games > 0) comps.push(`2026 exp ${f1(b.ppgExp26)} / act ${f1(b.ppg26)} in ${b.games} g (${Math.round(b.wCur * 100)}%)`);
    if (b.hasPrior) comps.push(`2025 ${f1(b.ppg25)} (${Math.round(b.wPrior * 100)}%)`);
    parts.push(comps.length ? `Proj ${f1(b.ppg)} ppg = ${comps.join(" · ")}` : "No ECR, 2026 or 2025 data → 0 ppg");
  }
  let s = parts.join("") + ".";
  const games = b.remainingGames;
  s += ` ${p.pos} replacement ${f1(repl)} → +${f1(vorp)}/g × ${Math.round(games * 10) / 10} games`;
  if (b.gameNotes.length) s += ` (${b.gameNotes.join("; ")})`;
  if (anchor.implied !== undefined && anchor.rank !== undefined) {
    s += ` → model ${f1(anchor.model * scale)} · consensus #${Math.round(anchor.rank * 10) / 10} (implies ${f1(anchor.implied * scale)}, ${Math.round(CONSENSUS_WEIGHT * 100)}%) pulls to ${f1(value)}.`;
  } else s += ` → value ${f1(value)}.`;
  const eff = effPpgOf(b);
  if (b.remainingGames > 0 && b.remainingGames < b.weeksLeft) {
    s += ` Lineup ppg ${f1(eff)} = ${f1(b.ppg)} × ${Math.round(b.remainingGames * 10) / 10}/${b.weeksLeft} games (availability-adjusted).`;
  }
  if (b.injKind === "long" && p.pos !== "K" && p.pos !== "DEF") s += " Long-term injury: ECR weight halved so ppg reads as a healthy rate; games carry the penalty.";
  return s;
}
