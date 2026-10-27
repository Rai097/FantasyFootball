// Projection v4: THE valuation of the app (docs/DESIGN.md "Model v4" section 2 + amendments + "Release (b) implemented").
// Per player and remaining week w: pts(w) = rate × matchup(w) × avail(w).
//  - rate: recency-weighted, context-adjusted expected points × shrunk efficiency (signals), a light last-season prior,
//    blended with the ECR rank→points curve as a sanity anchor (25%, 10% from 4 unflagged games; 100% with no games).
//  - matchup: opponent's points allowed to the position (league scoring), shrunk to the league average; the next game's
//    Vegas implied team total adds a half-strength bonus.
//  - avail: Q 0.85 / D 0.7 / Out 0 for his next game only; IR / long-term / suspended / reserve → 0 for the rest of the season
//    (return unconfirmed); designated to return → 0 for 4 games, then 1.
// K / DEF keep the ECR-rank line (no stat model). Value = surplus over replacement of mode-weighted weekly points.
import type { DetailItem, League, Player, Position, ValuedPlayer } from "./types.js";
import { SKILL_POSITIONS } from "./types.js";
import { recFormat, score } from "./scoring.js";
import { clampItem } from "./details.js";
import { CONVEXITY, KDEF_CURVE, POSITIONS, curveAt, ecrCurve, injuryKind, isQuestionable, replacementRanks, valuationNotes } from "./projection.js";
import { computePlayerSignals } from "./signals/index.js";
import type { PlayerSignalInput, PlayerSignals, SkillPos } from "./signals/types.js";
import { luckLabel, luckText } from "./labels.js";


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

export const emptyTables = (): ProjectionTables => ({ signals: new Map(), schedule: new Map(), allowed: new Map(), leagueAllowed: {} });

// ---------------------------------------------------------------- config (calibration values)

export const V4 = {
  /** ECR anchor weight: 25%, 10% once he has ≥ lateGames unflagged games; 100% without any game. */
  anchor: 0.25,
  anchorLate: 0.1,
  lateGames: 4,
  /** Last season's per-game points enter the model rate as this many pseudo-games (when he played ≥ priorMinGames). */
  priorK: 2,
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
  /** Designated to return: games at 0 before he counts again (the old −4 games). */
  returnGames: 4,
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

type Avail = "noTeam" | "long" | "return" | "out" | "doubtful" | "questionable" | "healthy";

function availKind(p: Player, sig: PlayerSignals | null): Avail {
  if (p.team === "FA" && p.pos !== "DEF") return "noTeam";
  const k = injuryKind(p.injury);
  const st = p.injury?.status.trim().toUpperCase() ?? "";
  if (k === "long" || st === "SUSP" || st === "SUSPENDED") return "long";
  // Designated to return beats the roster file (he is still RES there until activated).
  if (k === "return") return "return";
  // nflverse roster RES (reserve / IR / PUP / NFI): 0 until a return estimate exists (release (c)), even when he
  // played last week and Yahoo has no tag yet (freshly placed on IR).
  if (sig?.rosterStatus === "RES") return "long";
  if (k === "out") return "out";
  if (k === "doubtful") return "doubtful";
  if (isQuestionable(p.injury)) return "questionable";
  return "healthy";
}

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
  rate: number;
  availKind: Avail;
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
    if (base.kdef) return { ...base, sig: null, model: null, expRate: null, eff: 1, effRaw: null, sampleGames: 0, missingExp: 0, unflagged: 0, flagged: 0, priorRate: null };
    const sig = signalsOf(p);
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
    let model: number | null = null;
    if (expRate !== null && sampleGames > 0) {
      const cur = expRate * eff;
      model = priorRate !== null ? (sampleGames * cur + V4.priorK * priorRate) / (sampleGames + V4.priorK) : cur;
    } else if (priorRate !== null) model = priorRate;
    return { ...base, sig, model, expRate, eff, effRaw: sig?.efficiency?.raw ?? null, sampleGames, missingExp, unflagged, flagged, priorRate };
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
      } else if (ecrPts === undefined) rate = b.model;
      else {
        wAnchor = b.unflagged >= V4.lateGames ? V4.anchorLate : V4.anchor;
        rate = (1 - wAnchor) * b.model + wAnchor * ecrPts;
      }
    }
    rate = Math.max(0, Number.isFinite(rate) ? rate : 0);
    const kind = availKind(p, b.sig);
    const sched = tables.schedule.size ? tables.schedule.get(p.team) : undefined;
    const weeks: WeekProj[] = [];
    let gameIdx = 0;
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
      if (kind === "noTeam" || kind === "long") avail = 0;
      else if (kind === "return") avail = gameIdx < V4.returnGames ? 0 : 1;
      else if (next && kind === "out") avail = 0;
      else if (next && kind === "doubtful") avail = V4.doubtful;
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
      rate,
      availKind: kind,
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

  // --- value: surplus over replacement of mode-weighted weekly points, convex 0–100 scale
  const rawOf = (x: Proj) => {
    const repl = replacement[x.p.pos];
    let raw = 0;
    for (const w of x.weeks) if (w.game && w.avail > 0) raw += (w.week >= playoffStart ? W.playoffs : W.season) * Math.max(0, w.pts - repl);
    return raw;
  };
  let maxRaw = 0;
  for (const x of projs) maxRaw = Math.max(maxRaw, rawOf(x));
  const valueOfProj = (x: Proj) => {
    const raw = rawOf(x);
    return maxRaw > 0 && raw > 0 ? Math.min(100, 100 * Math.pow(raw / maxRaw, CONVEXITY)) : 0;
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
    if (x.sig?.trend?.rising) out.riser = true;
    const now = x.weeks[0];
    if (now?.game && now.avail < 1 && (x.availKind === "out" || x.availKind === "doubtful" || x.availKind === "questionable")) out.availThisWeek = now.avail;
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

const AVAIL_TEXT: Record<Avail, string | null> = {
  noTeam: "No NFL team: 0 for the rest of the season",
  long: "IR / out long-term: 0 for the rest of the season (return unconfirmed)",
  return: `Designated to return: 0 for his next ${V4.returnGames} games, then full`,
  out: "Out: 0 for his next game, full after",
  doubtful: `Doubtful: ×${V4.doubtful} for his next game`,
  questionable: `Questionable: ×${V4.questionable} for his next game`,
  healthy: null,
};

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
    if (x.ecrPts !== undefined) add("Experts (ECR)", `${x.ecrUnranked ? "unranked" : `${p.pos}${Math.round(x.ecrRank! * 10) / 10}`}: ${f1(x.ecrPts)} pts/game, ${pct(x.wAnchor)} weight`);
    if (x.missingExp) add("Usage data", `missing for ${x.missingExp} games: rate from actual points`, "warn");
    else if (x.expRate !== null) add("Usage", `${f1(x.expRate)} expected pts/game, latest games weigh most`);
    if (x.effRaw !== null) add("Finishing", `×${x.eff.toFixed(2)} (actual ÷ expected ${x.effRaw.toFixed(2)}, pulled toward 1)`);
    if (x.flagged > 0) add("Odd games", `${x.flagged} count 25%: backup QB, left early or blowout`);
    if (x.priorRate !== null) add("2025", `${f1(x.priorRate)} pts/game, counts as ${V4.priorK} games`);
  }
  if (x.gamesLeft > 0 && Math.abs(x.avgMatchup - 1) >= 0.01) add("Matchups", `×${x.avgMatchup.toFixed(2)} on average (opponents' points allowed)`);
  const next = x.weeks.find((w) => w.game);
  if (next?.game?.opp && !x.kdef) add("Next game", `wk ${next.week} vs ${next.game.opp}: ×${next.matchup.toFixed(2)}${next.game.implied !== undefined ? ` (Vegas ${f1(next.game.implied)} pts)` : ""}`);
  const avail = AVAIL_TEXT[x.availKind];
  if (avail) add("Availability", avail, "warn");
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
