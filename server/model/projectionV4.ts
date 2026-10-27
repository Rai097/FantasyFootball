// Projection v4: THE valuation of the app (docs/DESIGN.md "Model v4" section 2 + amendments + "Release (b) implemented").
// Per player and remaining week w: pts(w) = rate × matchup(w) × avail(w).
//  - rate: recency-weighted, context-adjusted expected points × shrunk efficiency (signals), a light last-season prior,
//    blended with the ECR rank→points curve as a sanity anchor (25%, 10% from 4 unflagged games; 100% with no games).
//  - matchup: opponent's points allowed to the position (league scoring), shrunk to the league average; the next game's
//    Vegas implied team total adds a half-strength bonus.
//  - avail: Q 0.85 / D 0.7 for his next game only; absent (Out / IR / reserve / designated to return / suspended) → 0
//    before the estimated return week (returns.ts), × 0.85 for the first game back after a reserve-list absence, then 1;
//    return unconfirmed → 0 in `weekly` / value (the player gets `ret.returnValue` / `ret.tradeValue`, and
//    `ret.backWeekly` = healthy × matchup from current week + 4 if he returns; lineups mix that scenario with ½ weight:
//    rosterScore "return scenarios").
// K / DEF keep the ECR-rank line (no stat model). Value = surplus over replacement of mode-weighted weekly points.
import type { DetailItem, League, Player, Position, ReturnInfo, ValuedPlayer } from "./types.js";
import { SKILL_POSITIONS } from "./types.js";
import { recFormat, score } from "./scoring.js";
import { clampItem } from "./details.js";
import { CONVEXITY, KDEF_CURVE, POSITIONS, curveAt, ecrCurve, injuryKind, isQuestionable, replacementRanks, valuationNotes } from "./projection.js";
import { computePlayerSignals } from "./signals/index.js";
import type { PlayerSignalInput, PlayerSignals, SkillPos } from "./signals/types.js";
import { luckLabel, luckText } from "./labels.js";
import { RETURNS, estimateReturn, returnText, type Absence, type ReturnEstimate } from "./returns.js";
import { FLEX_RANK } from "./signals/trend.js";
import { positionTdBaselines, regressTds, tdPointsOf, type TdShrink } from "./tdRegression.js";


// ---------------------------------------------------------------- inputs

export interface ScheduledGame {
  opp: string;
  home: boolean;
  /** Vegas implied team total, when the line exists (nflverse: next week only). */
  implied?: number;
}

export interface Allowed {
  /** League-scored points the defense allowed to the position, summed over `games`. */
  pts: number;
  games: number;
}

/** Everything projection v4 reads besides the league and the player pool (server/data/signalTables.ts builds it). */
export interface ProjectionTables {
  signals: Map<string, PlayerSignals>;
  /** Unplayed games per NFL team and week. Empty map = unknown schedule (tests): every week but the bye is a game. */
  schedule: Map<string, Map<number, ScheduledGame>>;
  /** Weeks each team has played (games missed / 0-snap stashes). Absent = weeks 1..current−1 minus the bye (tests). */
  playedWeeks?: Map<string, number[]>;
  allowed: Map<string, Partial<Record<SkillPos, Allowed>>>;
  leagueAllowed: Partial<Record<SkillPos, number>>;
}

/**
 * Pseudo-games last season's rate counts as next to `sampleGames` of this season: small samples lean on it more, unless
 * his role grew (`roleUp`: last season came from a smaller role, so it keeps only the base weight V4.priorK).
 */
export const priorWeight = (sampleGames: number, roleUp = false): number => (roleUp ? V4.priorK : Math.max(V4.priorK, V4.priorKSmall - sampleGames));

/**
 * Role change (fix 2026-10-27): this season's recency-weighted expected points/game (TD part regressed) reaches the bar
 * max(V4.roleUpRatio × last season's, last season's + V4.roleUpMinGain), last season's > 0, on ≥ V4.roleUpMinGames
 * unflagged games (one fill-in start is not a new role).
 */
export function isRoleUp(expPpg: number, priorExpPpg: number, unflagged: number): boolean {
  if (!(priorExpPpg > 0) || !Number.isFinite(expPpg) || unflagged < V4.roleUpMinGames) return false;
  // 1e-9: 1.5 × a non-representable prior (e.g. 6.6) must still accept exactly 1.5×.
  return expPpg >= Math.max(V4.roleUpRatio * priorExpPpg, priorExpPpg + V4.roleUpMinGain) - 1e-9;
}

export const emptyTables = (): ProjectionTables => ({ signals: new Map(), schedule: new Map(), allowed: new Map(), leagueAllowed: {} });

// ---------------------------------------------------------------- config (calibration values)

export const V4 = {
  /** ECR anchor weight: 25%, 10% once he has ≥ lateGames unflagged games; 100% without any game. */
  anchor: 0.25,
  anchorLate: 0.1,
  lateGames: 4,
  /** Last season's per-game points enter the model rate as this many pseudo-games (when he played ≥ priorMinGames). */
  priorK: 2,
  /** Small samples lean on last season more: prior weight = max(priorK, priorKSmall − sample games) (≥ 6 games: priorK). */
  priorKSmall: 8,
  /** Role grew: this season's expected pts/game ≥ this × last season's (≥ roleUpMinGames unflagged games) → priorK only. */
  roleUpRatio: 1.5,
  /** ...and at least this many expected pts/game above last season (a 0-pt or tiny 2025 never reads as a ratio jump). */
  roleUpMinGain: 3,
  roleUpMinGames: 2,
  /** Expected TDs per opportunity regress toward a baseline with this many games × his opportunity rate (last season's
   *  actual TDs per opportunity when he played ≥ priorMinGames, else the position's mean actual rate this season). */
  tdK: 8,
  priorMinGames: 4,
  /** Points allowed: pseudo-games of league average, and the factor's clamp. */
  matchupK: 4,
  matchupClamp: [0.8, 1.2] as const,
  /** Next game's Vegas implied total: factor × (1 + vegasWeight × (implied / average − 1)); total clamp. */
  vegasWeight: 0.5,
  totalClamp: [0.75, 1.25] as const,
  /** Next-game availability for Questionable / Doubtful (Out = 0). */
  questionable: 0.85,
  doubtful: 0.7,
  /** Stash rank: weight of a pre-playoff week vs a playoff week (1.0), and the weight per return confidence. */
  stashEarlyWeight: 0.33,
  stashConfidence: { high: 1, medium: 0.85, low: 0.7, unknown: RETURNS.unknownWeight } as Record<ReturnInfo["confidence"], number>,
  /** A player with 0 snaps in this many of his team's latest games is a stash candidate even without a report. */
  stashMissedGames: 2,
  /** Missing expected data: games with expected 0 but actual > 0 needed before the rate falls back to actual points. */
  missingExpGames: 2,
} as const;

export type ValueMode = "playoffs" | "balanced";
/** Value weights on Σ weekly surplus: rest-of-season weeks vs playoff weeks. */
export const VALUE_MODE_WEIGHTS: Record<ValueMode, { season: number; playoffs: number }> = {
  playoffs: { season: 0.25, playoffs: 0.75 },
  balanced: { season: 1, playoffs: 1 },
};
export const VALUE_MODE_TEXT: Record<ValueMode, string> = {
  playoffs: "playoff weeks 75%, rest of season 25%",
  balanced: "every remaining week counts the same",
};

/**
 * Default value mode for a team: "playoffs" when the imported standings put it in a playoff spot (seed, else rank,
 * within the top half of the league), else "balanced". Unknown standings → "balanced" (never assume a team is in).
 */
export function defaultMode(league: League, teamId: string | undefined, playoffTeams = Math.floor(league.settings.numTeams / 2)): ValueMode {
  const rec = league.teams.find((t) => t.id === teamId)?.record;
  const place = rec?.seed ?? rec?.rank;
  return place !== undefined && place >= 1 && place <= playoffTeams ? "playoffs" : "balanced";
}

// ---------------------------------------------------------------- helpers

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const f1 = (x: number) => x.toFixed(1);
const clamp = (x: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const isSkill = (pos: Position): pos is SkillPos => (SKILL_POSITIONS as Position[]).includes(pos);

/** Signal input from a Player's own weekly lines (players outside the season tables, and unit tests). */
export function signalInputFromPlayer(p: Player): PlayerSignalInput | null {
  if (!isSkill(p.pos)) return null;
  return {
    id: p.id,
    name: p.name,
    pos: p.pos,
    team: p.team,
    games: [...p.weeks]
      .sort((a, b) => a.week - b.week)
      .map((w) => ({
        week: w.week,
        gameId: `${w.season}_${w.week}_${w.team}`,
        team: w.team,
        targets: w.opp?.targets ?? 0,
        carries: w.opp?.carries ?? 0,
        airYards: w.opp?.airYards ?? 0,
        passAttempts: 0,
        actual: w.actual,
        expected: w.expected,
        snapShare: p.snapShare[w.week],
      })),
    status: [],
    // The player DB keeps last season's actual line only: use it for both (a talent prior, not a luck signal).
    prior: p.prior && p.prior.games > 0 ? { games: p.prior.games, actual: p.prior.line, expected: p.prior.line } : undefined,
  };
}

type Avail = "noTeam" | "absent" | "doubtful" | "questionable" | "healthy";

/** Availability class and, for an absent player, why (the return estimator's input). */
function availKind(p: Player, sig: PlayerSignals | null): { kind: Avail; absence?: Absence } {
  if (p.team === "FA" && p.pos !== "DEF") return { kind: "noTeam" };
  const k = injuryKind(p.injury);
  const st = p.injury?.status.trim().toUpperCase() ?? "";
  if (st === "SUSP" || st === "SUSPENDED") return { kind: "absent", absence: "suspended" };
  if (k === "long" && /season/i.test(p.injury?.detail ?? "")) return { kind: "absent", absence: "seasonOver" };
  // Designated to return (Yahoo IR-R or roster code R48) beats the reserve list (he is RES until activated).
  if (k === "return" || (sig?.rosterStatus === "RES" && sig.rosterCode === "R48")) return { kind: "absent", absence: "dtr" };
  // IR / PUP / NFI / NA / long-term detail, or nflverse roster RES even with a game last week (freshly placed on IR).
  if (k === "long" || sig?.rosterStatus === "RES") return { kind: "absent", absence: "reserve" };
  if (k === "out") return { kind: "absent", absence: "out" };
  if (k === "doubtful") return { kind: "doubtful" };
  if (isQuestionable(p.injury)) return { kind: "questionable" };
  return { kind: "healthy" };
}

/**
 * Absent on the league source's word only (a Yahoo / import IR tag: "IR", "PUP", "NA", or "Out" in an IR slot) while
 * nflverse does not list him on a reserve list: the estimator says so instead of "on a reserve list".
 */
const leagueOnlyIr = (p: Player, sig: PlayerSignals | null) => {
  const st = p.injury?.status.trim().toUpperCase() ?? "";
  return sig?.rosterStatus !== "RES" && (/^(IR|PUP|NFI|NA)\b/.test(st) || /\bIR\b/.test(p.injury?.detail ?? ""));
};

/** On IR / PUP per the league source or the nflverse roster (the IR minimum applies). */
const onIr = (p: Player, sig: PlayerSignals | null) => {
  const st = p.injury?.status.trim().toUpperCase() ?? "";
  return sig?.rosterStatus === "RES" || /^(IR|PUP|NFI)/.test(st);
};

interface WeekProj {
  week: number;
  game: ScheduledGame | null;
  matchup: number;
  avail: number;
  pts: number;
}

interface Base {
  p: Player;
  sig: PlayerSignals | null;
  kdef: boolean;
  /** Signal model rate before the ECR anchor (null = no game this season and no usable prior). */
  model: number | null;
  expRate: number | null;
  eff: number;
  effRaw: number | null;
  sampleGames: number;
  /** Games with expected 0 but actual > 0 when the rate fell back to actual points (missing expected data); else 0. */
  missingExp: number;
  unflagged: number;
  flagged: number;
  priorRate: number | null;
  /** Pseudo-games last season's rate counts as (priorWeight). */
  priorW: number;
  /** His role grew since last season (isRoleUp): the prior keeps the base weight only. */
  roleUp: boolean;
  /** Expected-TD regression (null = not applied: no expected TD data, actual-points fallback, K / DEF). */
  td: TdShrink | null;
  games: number;
  ppg26: number;
  ppgExp26: number;
  ppg25: number;
  trend: number;
}

interface Proj extends Base {
  ecrRank?: number;
  ecrPts?: number;
  ecrUnranked: boolean;
  wAnchor: number;
  /** Absent with a sample: the ECR anchor is not used (the rank prices the absence). */
  anchorSkipped: boolean;
  rate: number;
  availKind: Avail;
  absence?: Absence;
  est?: ReturnEstimate;
  /** Team games played since his last game (null = unknown / no team). */
  gamesMissed: number | null;
  healthyRate: number | null;
  healthySource?: "season" | "prior";
  weeks: WeekProj[];
  gamesLeft: number;
  remainingGames: number;
  ppg: number;
  effPpg: number;
  seasonPts: number;
  playoffPts: number;
  avgMatchup: number;
}

export interface Valuation {
  players: Map<string, ValuedPlayer>;
  replacement: Record<Position, number>;
  mode: ValueMode;
  /** League-level diagnostics shown with the analysis (scoring caveats, players rated on actual points). */
  notes: string[];
  /** Healthy-role rate (pts/game) at the position's flex rank (RB30 / WR40 / TE14, QB = league size): stash floor. */
  flexLevel: Partial<Record<Position, number>>;
  /** Value a player that was not in the pool (e.g. a Yahoo-only free agent or a fresher injury copy). */
  valueOf(p: Player): ValuedPlayer;
}

// ---------------------------------------------------------------- the valuation

/**
 * Value every player in `pool` under the league's scoring and calendar. Deterministic for fixed inputs; does not
 * mutate the input players. `tables` empty → signals from each player's own weeks, a game every week but the bye.
 */
export function valuePlayers(league: League, pool: Iterable<Player>, tables: ProjectionTables = emptyTables(), mode: ValueMode = "balanced"): Valuation {
  const S = league.settings;
  const scoring = S.scoring;
  const fmt = recFormat(scoring);
  const all = [...pool];
  const playoffStart = S.regularSeasonEnd + 1;
  const oneQb = S.slots.filter((s) => s === "QB").length === 1 && !S.slots.includes("SFLEX");
  const W = VALUE_MODE_WEIGHTS[mode];
  const ctx = { season: S.season, scoring, asOf: new Date(`${S.season}-12-01T00:00:00Z`) };

  // Average Vegas implied total over every scheduled game with a line (the bonus is relative to it).
  const implied: number[] = [];
  for (const m of tables.schedule.values()) for (const g of m.values()) if (g.implied !== undefined) implied.push(g.implied);
  const impliedAvg = implied.length ? mean(implied) : 0;

  // --- pass 1: signal model rate per player
  const signalsOf = (p: Player): PlayerSignals | null => {
    const hit = tables.signals.get(p.id);
    if (hit) return hit;
    const input = signalInputFromPlayer(p);
    return input && input.games.length + (input.prior ? 1 : 0) > 0 ? computePlayerSignals(input, ctx) : null;
  };
  const sigMemo = new Map<Player, PlayerSignals | null>();
  const sigOf = (p: Player): PlayerSignals | null => {
    if (!sigMemo.has(p)) sigMemo.set(p, p.pos === "K" || p.pos === "DEF" ? null : signalsOf(p));
    return sigMemo.get(p)!;
  };
  // Position TD baselines: ACTUAL TDs per opportunity over every game of players with ≥ priorMinGames games
  // (players without a usable prior regress toward them; tdRegression.ts).
  const tdBaseline = positionTdBaselines(all.map((p) => ({ pos: p.pos, sig: sigOf(p) })), V4.priorMinGames);
  const makeBase = (p: Player): Base => {
    const weeks = [...p.weeks].sort((a, b) => a.week - b.week);
    const act = weeks.map((w) => score(scoring, w.actual, p.pos));
    const exp = weeks.map((w) => score(scoring, w.expected, p.pos));
    const hasPrior = !!p.prior && p.prior.games >= 4;
    const base = {
      p,
      kdef: p.pos === "K" || p.pos === "DEF",
      games: weeks.length,
      ppg26: mean(act),
      ppgExp26: mean(exp),
      ppg25: hasPrior ? score(scoring, p.prior!.line, p.pos) / p.prior!.games : 0,
      trend: weeks.length >= 3 ? mean(exp.slice(-2)) - mean(exp) : 0,
    };
    if (base.kdef) return { ...base, sig: null, model: null, expRate: null, eff: 1, effRaw: null, sampleGames: 0, missingExp: 0, unflagged: 0, flagged: 0, priorRate: null, priorW: 0, roleUp: false, td: null };
    const sig = sigOf(p);
    // Missing expected data (ffopportunity has no usage for him while he scores): rate on recency-weighted actual
    // points, with the usual prior / ECR shrinkage, instead of ~0 usage.
    const ghost = sig ? sig.weeks.filter((w) => w.expPts === 0 && w.actPts > 0).length : 0;
    const missingExp = ghost >= V4.missingExpGames && !sig?.efficiency && (sig?.rates.actPts ?? 0) > 0 ? ghost : 0;
    const expRate = missingExp ? (sig!.rates.actPts ?? null) : (sig?.rates.expPts ?? null);
    const eff = sig?.efficiency?.shrunk ?? 1;
    const unflagged = sig ? sig.weeks.filter((w) => !w.flagged).length : 0;
    const flagged = sig ? sig.weeks.length - unflagged : 0;
    const sampleGames = unflagged + 0.25 * flagged;
    const t = sig?.talent;
    const priorRate =
      t && t.priorGames >= V4.priorMinGames && t.priorExpPpg !== null && t.priorActPpg !== null ? (t.priorExpPpg + t.priorActPpg) / 2 : null;
    // Touchdowns are the noisiest part of expected points: the TD part regresses per opportunity (tdRegression.ts),
    // the rest is unchanged. Not on the actual-points fallback (no expected TDs there).
    let td: TdShrink | null = null;
    if (!missingExp && expRate !== null && sig) {
      const r = sig.rates;
      const usePrior = !!t && t.priorGames >= V4.priorMinGames && t.priorTds !== null;
      td = regressTds({
        xTd: { pass: r.expPassTd ?? 0, rush: r.expRushTd ?? 0, rec: r.expRecTd ?? 0 },
        opp: { pass: r.passAtt ?? 0, rush: r.carries ?? 0, rec: r.targets ?? 0 },
        n: sampleGames,
        k: V4.tdK,
        prior: usePrior ? { tds: t!.priorTds!, opps: t!.priorOpps } : null,
        position: tdBaseline.of(p.pos, sig),
        minGames: V4.priorMinGames,
        points: tdPointsOf(scoring),
      });
    }
    // A backup-turned-starter: last season's smaller role must not outweigh his new one. Usage = expected points after
    // the TD regression (a one-off goal-line spike is not a new role); not on the actual-points fallback.
    const roleUp = priorRate !== null && !missingExp && expRate !== null && isRoleUp(expRate - (td?.ptsDelta ?? 0), t!.priorExpPpg!, unflagged);
    // Never more pseudo-games than the prior season actually had (a 4-game 2025 counts as ≤ 4 games).
    const priorW = priorRate !== null ? Math.min(priorWeight(sampleGames, roleUp), t!.priorGames) : 0;
    let model: number | null = null;
    if (expRate !== null && sampleGames > 0) {
      const cur = (expRate - (td?.ptsDelta ?? 0)) * eff;
      model = priorRate !== null ? (sampleGames * cur + priorW * priorRate) / (sampleGames + priorW) : cur;
    } else if (priorRate !== null) model = priorRate;
    return { ...base, sig, model, expRate, eff, effRaw: sig?.efficiency?.raw ?? null, sampleGames, missingExp, unflagged, flagged, priorRate, priorW, roleUp, td };
  };
  const bases = all.map(makeBase);
  const baseById = new Map(bases.map((b) => [b.p.id, b]));

  // --- ECR rank → points curves (the anchor): this season's model rates (≥ 3 games) and last season's ppg (≥ 8 games)
  const curves = {} as Record<Position, number[]>;
  for (const pos of SKILL_POSITIONS) {
    const cur: number[] = [];
    const prior: number[] = [];
    for (const b of bases) {
      if (b.p.pos !== pos) continue;
      if (b.games >= 3 && b.model !== null) cur.push(b.model);
      if ((b.p.prior?.games ?? 0) >= 8) prior.push(b.ppg25);
    }
    curves[pos] = ecrCurve(cur, prior);
  }
  const derivedRank = new Map<string, number>();
  const maxRank = {} as Record<Position, number>;
  for (const pos of POSITIONS) {
    const withOverall = all.filter((p) => p.pos === pos && p.ecrOverall !== undefined).sort((x, y) => x.ecrOverall! - y.ecrOverall!);
    withOverall.forEach((p, i) => derivedRank.set(p.id, i + 1));
    let m = 0;
    for (const p of all) if (p.pos === pos) m = Math.max(m, p.ecrPos ?? derivedRank.get(p.id) ?? 0);
    maxRank[pos] = m;
  }

  // --- pass 2: rate, weekly points
  const project = (b: Base): Proj => {
    const p = b.p;
    const ecrRank = p.ecrPos ?? derivedRank.get(p.id);
    let ecrPts: number | undefined;
    let ecrUnranked = false;
    let rate = 0;
    let wAnchor = 0;
    const { kind, absence } = availKind(p, b.sig);
    // A sample behind his rate: ≥ 2 unflagged games with a model rate, or a ≥ 4-game last season.
    const sampled = !b.kdef && b.model !== null && (b.unflagged >= 2 || (b.sig?.talent.priorExpPpg != null && b.sig.talent.priorGames >= V4.priorMinGames));
    // Reserve list / designated to return / suspended with a sample: no ECR anchor — experts drop an absent player's
    // rank, so anchoring would count the absence twice (it is already in avail). A one-game "Out" keeps the anchor.
    const anchorSkipped = sampled && (absence === "reserve" || absence === "dtr" || absence === "suspended");
    if (b.kdef) {
      const c = KDEF_CURVE[p.pos as "K" | "DEF"];
      const rank = ecrRank ?? maxRank[p.pos] + 1;
      ecrUnranked = ecrRank === undefined;
      ecrPts = Math.max(0, c.base - c.slope * (rank - 1));
      rate = ecrPts;
      wAnchor = 1;
    } else {
      const curve = curves[p.pos] ?? [];
      if (ecrRank !== undefined) ecrPts = curveAt(curve, ecrRank);
      else if (b.model !== null && maxRank[p.pos] > 0) {
        // Unranked by the experts but has production: anchor just past the last ranked player.
        ecrPts = curveAt(curve, maxRank[p.pos] + 1);
        ecrUnranked = true;
      }
      if (b.model === null) {
        wAnchor = ecrPts !== undefined ? 1 : 0;
        rate = ecrPts ?? 0;
      } else if (ecrPts === undefined || anchorSkipped) rate = b.model;
      else {
        wAnchor = b.unflagged >= V4.lateGames ? V4.anchorLate : V4.anchor;
        rate = (1 - wAnchor) * b.model + wAnchor * ecrPts;
      }
    }
    rate = Math.max(0, Number.isFinite(rate) ? rate : 0);
    const sched = tables.schedule.size ? tables.schedule.get(p.team) : undefined;
    // His team's remaining game weeks and the games he has missed since his last game.
    const gameWeeks: number[] = [];
    for (let w = S.currentWeek; w <= S.finalWeek; w++) if (sched ? sched.has(w) : p.bye !== w) gameWeeks.push(w);
    let gamesMissed: number | null = null;
    if (p.team !== "FA" && !b.kdef) {
      const played = tables.playedWeeks?.get(p.team) ?? Array.from({ length: Math.max(0, S.currentWeek - 1) }, (_, i) => i + 1).filter((w) => w !== p.bye);
      const own = b.sig ? b.sig.weeks.map((w) => w.week) : p.weeks.map((w) => w.week);
      const last = own.length ? Math.max(...own) : 0;
      gamesMissed = played.filter((w) => w > last && w < S.currentWeek).length;
    }
    // Healthy-role rate = THE projection rate (one definition), so My Team hold, Stash watch, Values and lineups show
    // one number for the same player and return week. Known only with a sample (else unknown: no stash candidate on
    // an expert rank alone).
    let healthyRate: number | null = null;
    let healthySource: "season" | "prior" | undefined;
    if (!b.kdef && b.unflagged >= 2 && b.model !== null) [healthyRate, healthySource] = [rate, "season"];
    else if (!b.kdef && b.sig?.talent.priorExpPpg != null && b.sig.talent.priorGames >= V4.priorMinGames) [healthyRate, healthySource] = [rate, "prior"];
    let est: ReturnEstimate | undefined;
    if (kind === "absent" && absence) {
      const own = b.sig ? b.sig.weeks.map((w) => w.week) : p.weeks.map((w) => w.week);
      est = estimateReturn({
        absence,
        rosterStatus: b.sig?.rosterStatus,
        rosterCode: b.sig?.rosterCode,
        onIr: onIr(p, b.sig),
        ...(absence === "reserve" && leagueOnlyIr(p, b.sig) ? { leagueOnly: true } : {}),
        status: b.sig?.status ?? [],
        currentWeek: S.currentWeek,
        gameWeeks,
        gamesMissed,
        ...(own.length ? { lastGameWeek: Math.max(...own) } : {}),
        ...(/^(O|OUT)$/.test(p.injury?.status.trim().toUpperCase() ?? "") ? { tagOut: true } : {}),
      });
    }
    const ramp = absence !== "out";
    const weeks: WeekProj[] = [];
    let gameIdx = 0;
    let backIdx = 0;
    for (let w = S.currentWeek; w <= S.finalWeek; w++) {
      const game: ScheduledGame | null = sched ? (sched.get(w) ?? null) : p.bye === w ? null : { opp: "", home: false };
      if (!game) {
        weeks.push({ week: w, game: null, matchup: 0, avail: 0, pts: 0 });
        continue;
      }
      let matchup = 1;
      if (!b.kdef && isSkill(p.pos)) {
        const a = tables.allowed.get(game.opp)?.[p.pos];
        const avg = tables.leagueAllowed[p.pos];
        if (a && avg && avg > 0) matchup = clamp((a.pts + V4.matchupK * avg) / (a.games + V4.matchupK) / avg, V4.matchupClamp);
        if (game.implied !== undefined && impliedAvg > 0) matchup = clamp(matchup * (1 + V4.vegasWeight * (game.implied / impliedAvg - 1)), V4.totalClamp);
      }
      // The injury report is about his NEXT game: the first remaining one (not the calendar week, which can be a
      // bye or a game his team already played).
      const next = gameIdx === 0;
      let avail = 1;
      if (kind === "noTeam") avail = 0;
      else if (kind === "absent") {
        const rw = est?.returnWeek ?? null;
        if (rw === null || w < rw) avail = 0;
        else avail = backIdx++ === 0 && ramp ? RETURNS.ramp : 1;
      } else if (next && kind === "doubtful") avail = V4.doubtful;
      else if (next && kind === "questionable") avail = V4.questionable;
      gameIdx++;
      weeks.push({ week: w, game, matchup, avail, pts: rate * matchup * avail });
    }
    const played = weeks.filter((x) => x.game);
    const gamesLeft = played.length;
    const avgMatchup = gamesLeft ? mean(played.map((x) => x.matchup)) : 1;
    const total = played.reduce((a, x) => a + x.pts, 0);
    return {
      ...b,
      ecrRank,
      ecrPts,
      ecrUnranked,
      wAnchor,
      anchorSkipped,
      rate,
      availKind: kind,
      ...(absence ? { absence } : {}),
      ...(est ? { est } : {}),
      gamesMissed,
      healthyRate,
      ...(healthySource ? { healthySource } : {}),
      weeks,
      gamesLeft,
      remainingGames: played.reduce((a, x) => a + x.avail, 0),
      ppg: rate * avgMatchup,
      effPpg: gamesLeft ? total / gamesLeft : 0,
      seasonPts: weeks.filter((x) => x.week < playoffStart).reduce((a, x) => a + x.pts, 0),
      playoffPts: weeks.filter((x) => x.week >= playoffStart).reduce((a, x) => a + x.pts, 0),
      avgMatchup,
    };
  };
  const projs = bases.map(project);

  // --- replacement level per position (rank the pool by healthy ppg among players with games left)
  const replRank = replacementRanks(S.slots, S.numTeams);
  const replacement = {} as Record<Position, number>;
  const posSorted = {} as Record<Position, number[]>;
  for (const pos of POSITIONS) {
    const arr = projs.filter((x) => x.p.pos === pos && x.remainingGames > 0).map((x) => x.ppg).sort((a, b) => b - a);
    replacement[pos] = r2(arr[Math.min(replRank[pos], arr.length) - 1] ?? 0);
    posSorted[pos] = projs.filter((x) => x.p.pos === pos).map((x) => x.ppg).sort((a, b) => b - a);
  }

  // --- stash floor: healthy-role rate at the flex rank per position (QB: the league's starters)
  const flexLevel: Partial<Record<Position, number>> = {};
  for (const pos of SKILL_POSITIONS) {
    const rank = pos === "QB" ? S.numTeams : FLEX_RANK[pos as Exclude<SkillPos, "QB">];
    const arr = projs.filter((x) => x.p.pos === pos && x.healthyRate !== null).map((x) => x.healthyRate!).sort((a, b) => b - a);
    if (rank && arr.length >= rank) flexLevel[pos] = r2(arr[rank - 1]);
  }

  // --- value: surplus over replacement of mode-weighted weekly points, convex 0–100 scale
  const rawOf = (x: Proj) => {
    const repl = replacement[x.p.pos];
    let raw = 0;
    for (const w of x.weeks) if (w.game && w.avail > 0) raw += (w.week >= playoffStart ? W.playoffs : W.season) * Math.max(0, w.pts - repl);
    return raw;
  };
  let maxRaw = 0;
  for (const x of projs) maxRaw = Math.max(maxRaw, rawOf(x));
  const scaled = (raw: number) => (maxRaw > 0 && raw > 0 ? Math.min(100, 100 * Math.pow(raw / maxRaw, CONVEXITY)) : 0);
  const valueOfProj = (x: Proj) => scaled(rawOf(x));

  /** Return estimate + stash numbers at the healthy-role rate (release (c)); undefined when not relevant. */
  const returnInfo = (x: Proj): ReturnInfo | undefined => {
    const absent = x.availKind === "absent";
    const missing = !absent && x.availKind !== "noTeam" && x.gamesMissed !== null && x.gamesMissed >= V4.stashMissedGames;
    const floor = flexLevel[x.p.pos];
    if (!absent && !(missing && x.healthyRate !== null && floor !== undefined && x.healthyRate >= floor)) return undefined;
    const week = absent ? (x.est?.returnWeek ?? null) : null;
    const confidence = absent ? (x.est?.confidence ?? "unknown") : "unknown";
    const reasons = absent ? (x.est?.reasons ?? []) : [{ label: "Snaps", value: `none in his team's last ${x.gamesMissed} games, no injury listed`, tone: "warn" as const }];
    const info: ReturnInfo = { week, confidence, reasons, absent, practiceUp: absent && !!x.est?.practiceUp };
    if (x.est?.earliestWeek !== undefined) info.earliestWeek = x.est.earliestWeek;
    if (x.absence === "seasonOver") info.seasonOver = true;
    const hr = x.healthyRate;
    if (hr === null || x.absence === "seasonOver") return info;
    info.healthyRate = r2(hr);
    if (x.healthySource) info.healthySource = x.healthySource;
    // Weekly points on his return: known week → the projection's own (shown, 0.1-rounded) weekly points — 0 before,
    // ramp, full — so hold / stash and Values agree exactly; unknown → healthy rate from current + 4 at × 0.5.
    const from = week ?? S.currentWeek + RETURNS.unknownOffset;
    let total = 0;
    let playoff = 0;
    let stash = 0;
    let raw = 0;
    const repl = replacement[x.p.pos];
    const exp: number[] = [];
    for (const w of x.weeks) {
      if (!w.game || w.week < from) {
        exp.push(0);
        continue;
      }
      const full = week === null ? hr * w.matchup : r1(w.pts);
      // Unknown return: back = his full (0.1-rounded) points if he returns (the lineups' return scenario); the stash /
      // hold sums count the shown expected points (× 0.5, 0.1-rounded), unchanged by fix round 2.
      const pts = week === null ? r1(full * RETURNS.unknownWeight) : full;
      exp.push(r1(full));
      const po = w.week >= playoffStart;
      total += pts;
      if (po) playoff += pts;
      stash += pts * (po ? 1 : V4.stashEarlyWeight);
      // Trade value: surplus over replacement at his FULL healthy points, then × 0.5 below (release (d) fix — halving
      // the points first pushed most players under replacement, so an injured starter was worth 0 in trades).
      raw += (po ? W.playoffs : W.season) * Math.max(0, full - repl);
    }
    info.playoffPts = r1(playoff);
    info.stashScore = r1(stash * (week === null ? 1 : V4.stashConfidence[confidence]));
    if (week === null) {
      info.returnValue = r1(total);
      if (absent) {
        info.tradeValue = r1(RETURNS.unknownWeight * scaled(raw));
        info.backWeekly = exp;
      }
    }
    return info;
  };

  const posRankOf = (pos: Position, ppg: number) => {
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

  const finalize = (x: Proj): ValuedPlayer => {
    const p = x.p;
    // Totals are sums of the shown (0.1-rounded) weekly numbers, so the UI's weeks always add up.
    const weekly = x.weeks.map((w) => r1(w.pts));
    const sumWeeks = (inPlayoffs: boolean) => r1(weekly.reduce((a, v, i) => a + ((x.weeks[i].week >= playoffStart) === inPlayoffs ? v : 0), 0));
    x = { ...x, seasonPts: sumWeeks(false), playoffPts: sumWeeks(true) };
    const repl = replacement[p.pos];
    const vorp = Math.max(0, x.ppg - repl);
    const value = r1(valueOfProj(x));
    const posRank = posRankOf(p.pos, x.ppg);
    const backupQb = p.pos === "QB" && oneQb && posRank > S.numTeams && value < 3;
    // Luck only means something with real usage (the efficiency ratio's threshold); otherwise unknown, not 0.
    const luck = x.sig?.efficiency ? (x.sig.luck ?? null) : null;
    // No buy-low / sell-high on a player with no games left (IR / reserve / out for the season): nothing to trade for.
    const label = x.remainingGames > 0 ? luckLabel(luck, x.sampleGames) : null;
    const out: ValuedPlayer = {
      ...p,
      weekProj: p.weekProjByFormat?.[fmt] ?? p.weekProj,
      ppg: r2(x.ppg),
      effPpg: r2(x.effPpg),
      ppg26: r2(x.ppg26),
      ppgExp26: r2(x.ppgExp26),
      ppg25: r2(x.ppg25),
      games: x.games,
      vorp: r2(vorp),
      value,
      posRank,
      remainingGames: r1(x.remainingGames),
      trend: r2(x.trend),
      weekly,
      weeklyFrom: S.currentWeek,
      seasonPts: x.seasonPts,
      playoffPts: x.playoffPts,
      valueMode: mode,
      why: `${f1(x.ppg)} pts/game projected: ${f1(x.seasonPts)} rest of season, ${f1(x.playoffPts)} in the playoffs; value ${f1(value)}.`,
      whyItems: explainItems(x, S.currentWeek, S.regularSeasonEnd, S.finalWeek, repl, vorp, value, mode, backupQb, label),
    };
    if (luck) {
      out.luck = r1(luck.points);
      out.luckTd = r1(luck.tdPart);
    }
    if (label) out.label = label;
    // The experts' rank read as points (release (d) perceived value), even when the projection skipped the anchor.
    if (x.ecrPts !== undefined && !x.ecrUnranked) out.ecrPts = r2(x.ecrPts);
    if (x.sig?.trend?.rising) out.riser = true;
    const now = x.weeks[0];
    if (now?.game && now.avail < 1 && (x.absence === "out" || x.availKind === "doubtful" || x.availKind === "questionable")) out.availThisWeek = now.avail;
    const ret = returnInfo(x);
    if (ret) out.ret = ret;
    return out;
  };

  const poolById = new Map(all.map((p) => [p.id, p]));
  const players = new Map<string, ValuedPlayer>();
  for (const x of projs) players.set(x.p.id, finalize(x));

  const notes = valuationNotes(league);
  const missing = projs.filter((x) => x.missingExp > 0).length;
  if (missing) notes.push(`Usage data missing for ${missing} player${missing > 1 ? "s" : ""}: rated on actual points.`);

  return {
    players,
    replacement,
    mode,
    notes,
    flexLevel,
    valueOf(p: Player) {
      const hit = players.get(p.id);
      if (hit && poolById.get(p.id) === p) return hit;
      // A copy (fresher injury) reuses the pooled player's signals; a new player gets his own.
      const b0 = baseById.get(p.id);
      const b = b0 ? { ...b0, p } : makeBase(p);
      return finalize(project(b));
    },
  };
}

// ---------------------------------------------------------------- "?" bullets (≤ 90 chars each, no prose)

const AVAIL_TEXT: Record<Exclude<Avail, "absent">, string | null> = {
  noTeam: "No NFL team: 0 for the rest of the season",
  doubtful: `Doubtful: ×${V4.doubtful} for his next game`,
  questionable: `Questionable: ×${V4.questionable} for his next game`,
  healthy: null,
};

/** Availability bullet for an absent player: the return estimate and what it does to his weekly points. */
function absentText(x: Proj): string {
  const e = x.est;
  if (!e || e.returnWeek === null) return `${x.absence === "seasonOver" ? "out for the season" : "return unconfirmed"}: 0 for every week`;
  return `${returnText(e.returnWeek, e.confidence)}: 0 before${x.absence !== "out" ? `, ×${RETURNS.ramp} first game` : ""}`;
}

function explainItems(
  x: Proj,
  currentWeek: number,
  regEnd: number,
  finalWeek: number,
  repl: number,
  vorp: number,
  value: number,
  mode: ValueMode,
  backupQb: boolean,
  label: ReturnType<typeof luckLabel>,
): DetailItem[] {
  const p = x.p;
  const out: DetailItem[] = [];
  const add = (l: string, v: string, tone?: DetailItem["tone"]) => out.push(tone ? { label: l, value: clampItem(v), tone } : { label: l, value: clampItem(v) });
  const pct = (w: number) => `${Math.round(w * 100)}%`;
  if (x.kdef) {
    add("Rate", `${f1(x.rate)} pts/game from experts' ${x.ecrRank !== undefined ? `${p.pos}${Math.round(x.ecrRank)}` : `unranked ${p.pos}`}`);
  } else if (x.model === null && x.ecrPts === undefined) {
    add("Rate", "0: no game this season, no expert rank, no 2025 history");
  } else {
    add("Rate", `${f1(x.rate)} pts/game before matchups`);
    if (x.model !== null) add("Our model", `${f1(x.model)} pts/game, ${pct(1 - x.wAnchor)} weight`);
    if (x.ecrPts !== undefined)
      add("Experts (ECR)", `${x.ecrUnranked ? "unranked" : `${p.pos}${Math.round(x.ecrRank! * 10) / 10}`}: ${f1(x.ecrPts)} pts/game, ${x.anchorSkipped ? "not used: the rank prices his absence" : `${pct(x.wAnchor)} weight`}`);
    if (x.missingExp) add("Usage data", `missing for ${x.missingExp} games: rate from actual points`, "warn");
    else if (x.expRate !== null) add("Usage", `${f1(x.expRate)} expected pts/game, latest games weigh most`);
    if (x.td && Math.abs(x.td.raw - x.td.regressed) >= 0.005)
      add("Touchdowns", `${x.td.raw.toFixed(2)} expected/g regressed to ${x.td.regressed.toFixed(2)} (${x.td.source === "prior" ? "last season" : `${p.pos} average`} ${x.td.base.toFixed(2)})`);
    if (x.effRaw !== null) add("Finishing", `×${x.eff.toFixed(2)} (actual ÷ expected ${x.effRaw.toFixed(2)}, pulled toward 1)`);
    if (x.flagged > 0) add("Odd games", `${x.flagged} count 25%: backup QB, left early or blowout`);
    if (x.priorRate !== null) {
      const w = Number.isInteger(x.priorW) ? x.priorW : x.priorW.toFixed(1);
      const grew = x.roleUp && x.expRate !== null ? ` (role grew: ${f1(x.expRate - (x.td?.ptsDelta ?? 0))} vs ${f1(x.sig!.talent.priorExpPpg!)} expected/g)` : "";
      add("2025", `${f1(x.priorRate)} pts/game, counts as ${w} games${grew}`);
    }
  }
  if (x.gamesLeft > 0 && Math.abs(x.avgMatchup - 1) >= 0.01) add("Matchups", `×${x.avgMatchup.toFixed(2)} on average (opponents' points allowed)`);
  const next = x.weeks.find((w) => w.game);
  if (next?.game?.opp && !x.kdef) add("Next game", `wk ${next.week} vs ${next.game.opp}: ×${next.matchup.toFixed(2)}${next.game.implied !== undefined ? ` (Vegas ${f1(next.game.implied)} pts)` : ""}`);
  const avail = x.availKind === "absent" ? absentText(x) : AVAIL_TEXT[x.availKind];
  if (avail) add("Availability", avail, "warn");
  if (x.availKind === "absent") for (const r of x.est?.reasons ?? []) if (r.label !== "Return") add(r.label, r.value, r.tone);
  const byes = x.weeks.filter((w) => !w.game).map((w) => w.week);
  if (byes.length && byes.length < x.weeks.length) add("No game", `week${byes.length > 1 ? "s" : ""} ${byes.join(", ")}`);
  if (currentWeek <= regEnd) add("Rest of season", `${f1(x.seasonPts)} pts in weeks ${currentWeek}–${regEnd}`);
  add("Playoffs", `${f1(x.playoffPts)} pts in weeks ${regEnd + 1}–${finalWeek}`);
  add("Lineup pts/game", `${f1(x.effPpg)} over ${x.gamesLeft} games left (availability applied)`);
  add("Above replacement", `+${f1(vorp)} pts/game over the ${p.pos} replacement (${f1(repl)})`);
  if (x.sig?.luck && x.sig.efficiency && !x.kdef) add("Luck", luckText(x.sig.luck.points, label), label === "buy-low" ? "pos" : label === "sell-high" ? "warn" : undefined);
  if (x.sig?.trend?.rising) add("Opportunity", `rising: ${x.sig.trend.metric === "wopr" ? "WOPR" : "weighted touches"} up 3 straight games`, "pos");
  add("Value", `${f1(value)} of 100 (${VALUE_MODE_TEXT[mode]})`);
  if (backupQb) add("Backup QB", "~0 trade value in a 1-QB league");
  return out;
}
