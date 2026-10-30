// Perceived value (Model v4 release (d), docs/DESIGN.md "Model v4" section 5; evaluator view per "Fix: Yahoo evaluator
// emulation (2026-10-30)"): how the OTHER manager sees a player.
// Managers judge trades by Yahoo's Evaluate Trade tool (each team's projected optimal lineup in every remaining fantasy
// week after this one, Yahoo's weekly projections, byes 0) and by recent box scores, not by market values.
//   weekly = the evaluator's per-week points (no recency: Yahoo's tool is pure projection):
//            captured Yahoo  — the rest-of-season total covers the capture week through the NFL's last regular-season
//            week (18), not the league's final week. With this week's number captured this week, the rest after it
//            (total − this week) spreads evenly over his games from next week through week 18; otherwise the whole
//            total spreads over his games from the capture week. Byes 0. Yahoo's number already prices injuries, so
//            our availability is NOT applied (except to IR-slot players, perceivedLineupTotal);
//            estimate (FantasyPros rank read as points, else our rate) — base in every game week our model has him
//            available; a return-unconfirmed player is 0 here and perceivedLineupTotal mixes in his return scenario
//            (our healthy × matchup), since the rank does not price a recovery;
//            week index 0 (this week) = Yahoo's weekly number when captured; the evaluator total skips it (trades
//            process next week).
//   rate   = 0.7 × base + 0.3 × his last 3 games' actual points (recency bias of the manager; games in the last 4
//            weeks only); a Yahoo projection of 0 stays 0. Used for the perception gap and spike checks only.
//   gap    = our playoff-weighted rate − perceived rate (+ = they underrate him).
// Pure. The weekly arrays are cached per player object (never serialised: the Values payload stays small).
import type { LeagueSettings, ValuedPlayer } from "./types.js";
import { effPpg } from "./lineup.js";
import { score } from "./scoring.js";
import { fillOrder, irSlotReturns, returnBackPoints, returnSplit } from "./rosterScore.js";
import { mixedWeekLineup } from "./teamStrength.js";

export const PERCEPTION = {
  /** Weight of the last games' actual points in the perceived rate. */
  recencyWeight: 0.3,
  /** Games averaged for the recency term. */
  recentGames: 3,
  /** Only games this many weeks back or fewer count as "recent" (an injured player has no recent box score). */
  recentWindow: 4,
  /** A last game ≥ this × his perceived rate is a spike: his manager will not sell right after it. */
  spikeRatio: 1.5,
  /** Value-mode weights for our rate (projection v4: playoffs 0.25 rest of season / 0.75 playoff weeks). */
  playoffWeights: { season: 0.25, playoffs: 0.75 },
  /** Last NFL regular-season week: Yahoo's rest-of-season total runs through it (the schedule's last week wins). */
  nflLastWeek: 18,
  /** Yahoo's evaluator starts next week: a trade processes after this week's games ("even" this week). */
  evaluatorSkipsCurrentWeek: true,
} as const;

export type PerceptionSource = "yahoo" | "ecr" | "model";

export interface Perception {
  /** Where the base came from: Yahoo's projection (captured), the FantasyPros rank (estimate), or our rate. */
  source: PerceptionSource;
  /** Their per-game view before recency. */
  base: number;
  /** Mean actual points of his last ≤ 3 games inside the window; undefined = no recent game. */
  recent?: number;
  recentGames: number;
  /** Actual points of his latest game (inside the window) and its week. */
  lastGamePts?: number;
  lastGameWeek?: number;
  /** Perceived points per game (base blended with recency): gap and spike checks. */
  rate: number;
  /** Yahoo evaluator points per remaining week, weeks currentWeek..finalWeek (0 = no game / out); no recency. */
  weekly: number[];
  /** Σ weekly. */
  total: number;
  /** Our playoff-weighted per-game rate. */
  ourRate: number;
  /** ourRate − rate: positive = they underrate him. */
  gap: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Does his NFL team play in week w? `schedule` = unplayed games per team (empty / undefined = every week but the bye). */
export type GameCheck = ((p: ValuedPlayer, week: number) => boolean) & { lastWeek?: number };
export const byeOnly: GameCheck = (p, w) => p.team !== "FA" && p.bye !== w && w <= PERCEPTION.nflLastWeek;
export function scheduleCheck(schedule: Map<string, Map<number, unknown>> | undefined): GameCheck {
  if (!schedule || !schedule.size) return byeOnly;
  let last = 0;
  for (const m of schedule.values()) for (const w of m.keys()) last = Math.max(last, w);
  const check: GameCheck = (p, w) => !!schedule.get(p.team)?.has(w);
  check.lastWeek = last;
  return check;
}

/** Remaining-week indices (i = week − currentWeek) the evaluator sums: next week through the league's final week. */
export function evaluatorWeeks(S: LeagueSettings): number {
  const n = Math.max(0, S.finalWeek - S.currentWeek + 1);
  return PERCEPTION.evaluatorSkipsCurrentWeek ? Math.max(0, n - 1) : n;
}

/** Our points in remaining week index i (projection v4 weekly; fixtures without it: effPpg outside the bye). */
function ourWeek(p: ValuedPlayer, S: LeagueSettings, i: number): number {
  const w = S.currentWeek + i;
  if (p.weekly && p.weeklyFrom !== undefined) {
    const v = p.weekly[w - p.weeklyFrom];
    return v !== undefined && Number.isFinite(v) && v > 0 ? v : 0;
  }
  return p.bye === w ? 0 : effPpg(p);
}

/** His recent actual points (league scoring): last ≤ 3 games in the window before the current week. */
export function recentGames(p: ValuedPlayer, S: LeagueSettings): { week: number; pts: number }[] {
  const lo = S.currentWeek - PERCEPTION.recentWindow;
  return (p.weeks ?? [])
    .filter((g) => g.season === S.season && g.week >= lo && g.week < S.currentWeek)
    .sort((a, b) => a.week - b.week)
    .slice(-PERCEPTION.recentGames)
    .map((g) => ({ week: g.week, pts: score(S.scoring, g.actual, p.pos) }));
}

export function perceive(p: ValuedPlayer, S: LeagueSettings, hasGame: GameCheck = byeOnly): Perception {
  const n = Math.max(0, S.finalWeek - S.currentWeek + 1);
  const games: boolean[] = [];
  for (let i = 0; i < n; i++) games.push(hasGame(p, S.currentWeek + i));

  // Our playoff-weighted rate over the weeks he has a game.
  const playoffStart = S.regularSeasonEnd + 1;
  const wts = p.valueMode === "balanced" ? { season: 1, playoffs: 1 } : PERCEPTION.playoffWeights;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    if (!games[i]) continue;
    const wt = S.currentWeek + i >= playoffStart ? wts.playoffs : wts.season;
    num += wt * ourWeek(p, S, i);
    den += wt;
  }
  const ourRate = den > 0 ? num / den : 0;

  let source: PerceptionSource;
  let base: number;
  // Yahoo: per game for the weeks after this one (the evaluator's weeks), see the header.
  const lastWeek = Math.max(S.finalWeek, hasGame.lastWeek ?? PERCEPTION.nflLastWeek);
  const gamesIn = (from: number, to: number) => {
    let k = 0;
    for (let w = from; w <= to; w++) if (w < S.currentWeek ? byeOnly(p, w) : hasGame(p, w)) k++;
    return k;
  };
  const wk = p.yahooProjWeekly !== undefined && Number.isFinite(p.yahooProjWeekly) ? Math.max(0, p.yahooProjWeekly) : undefined;
  if (p.yahooProj !== undefined && Number.isFinite(p.yahooProj)) {
    source = "yahoo";
    const from = Math.min(p.yahooProjWeek ?? S.currentWeek, S.currentWeek);
    if (wk !== undefined && from === S.currentWeek) {
      const covered = gamesIn(S.currentWeek + 1, lastWeek);
      base = covered ? Math.max(0, p.yahooProj - wk) / covered : 0;
    } else {
      const covered = gamesIn(from, lastWeek);
      base = covered ? p.yahooProj / covered : 0;
    }
  } else if (p.ecrPts !== undefined && Number.isFinite(p.ecrPts)) {
    source = "ecr";
    base = p.ecrPts;
  } else {
    source = "model";
    base = effPpg(p);
  }
  base = Math.max(0, base);

  const recent = recentGames(p, S);
  const recentMean = recent.length ? recent.reduce((a, g) => a + g.pts, 0) / recent.length : undefined;
  const yahooZero = source === "yahoo" && base <= 0;
  const rate = yahooZero ? 0 : Math.max(0, recentMean !== undefined ? (1 - PERCEPTION.recencyWeight) * base + PERCEPTION.recencyWeight * recentMean : base);

  // The estimate follows our availability (the experts' rank does not price a week he is out); a return-unconfirmed
  // player is 0 here (his "not back" scenario: perceivedLineupTotal mixes in the return). Yahoo's number is used as is.
  const unconfirmed = returnBackPoints(p, S) !== undefined;
  const weekly: number[] = [];
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (games[i]) v = source === "yahoo" ? base : !unconfirmed && ourWeek(p, S, i) > 0 ? base : 0;
    // Yahoo's own number for this week wins whenever captured (also when the rest-of-season view was not found).
    if (i === 0 && wk !== undefined) v = games[0] ? wk : 0;
    weekly.push(r2(v));
  }
  const last = recent[recent.length - 1];
  return {
    source,
    base: r2(base),
    ...(recentMean !== undefined ? { recent: r2(recentMean) } : {}),
    recentGames: recent.length,
    ...(last ? { lastGamePts: r2(last.pts), lastGameWeek: last.week } : {}),
    rate: r2(rate),
    weekly,
    total: r2(weekly.reduce((a, v) => a + v, 0)),
    ourRate: r2(ourRate),
    gap: r2(ourRate - rate),
  };
}

// ---------------------------------------------------------------- cache (per player object and settings)

const cache = new WeakMap<LeagueSettings, WeakMap<ValuedPlayer, Perception>>();

/** Compute and cache every player's perception for a league (call once per valued context, after valuation). */
export function attachPerception(players: Iterable<ValuedPlayer>, S: LeagueSettings, schedule?: Map<string, Map<number, unknown>>): void {
  const check = scheduleCheck(schedule);
  let byS = cache.get(S);
  if (!byS) cache.set(S, (byS = new WeakMap()));
  for (const p of players) byS.set(p, perceive(p, S, check));
}

/** A player's perception: the attached one, else computed now (bye weeks only) and cached. */
export function perceptionOf(p: ValuedPlayer, S: LeagueSettings): Perception {
  let byS = cache.get(S);
  if (!byS) cache.set(S, (byS = new WeakMap()));
  let hit = byS.get(p);
  if (!hit) byS.set(p, (hit = perceive(p, S)));
  return hit;
}

/** Last game ≥ 1.5 × his perceived rate (and a real game: ≥ 5 points). */
export function isSpike(pc: Perception): boolean {
  return pc.lastGamePts !== undefined && pc.lastGamePts >= 5 && pc.lastGamePts >= PERCEPTION.spikeRatio * Math.max(pc.rate, 1);
}

/**
 * The lineup total Yahoo's Evaluate Trade tool would show a roster: Σ over the evaluator's weeks (next week through
 * the final week; this week is "even" because a trade processes after it) of the optimal lineup by perceived weekly
 * points, the same greedy fill as team strength (byes 0). IR-slot players follow team strength's rule (irSlotView):
 * only weeks our model has them back; no return estimate or out for the season → never. An estimate-sourced
 * unconfirmed return enters through the same scenario mix as team strength (mixedWeekLineup, his return scenario at
 * our points); a Yahoo-sourced player counts at Yahoo's number.
 */
export function perceivedLineupTotal(S: LeagueSettings, roster: ValuedPlayer[], irIds: ReadonlySet<string> = new Set()): number {
  return perceivedLineupWeeks(S, roster, irIds).reduce((a, v) => a + v, 0);
}

/** The evaluator's first week (next week when it skips the current one). */
export function evaluatorFirstWeek(S: LeagueSettings): number {
  return S.finalWeek - evaluatorWeeks(S) + 1;
}

/**
 * perceivedLineupTotal week by week (weeks evaluatorFirstWeek..finalWeek, unrounded): the per-week strip of Yahoo's
 * Evaluate Trade view. Σ = perceivedLineupTotal exactly.
 */
export function perceivedLineupWeeks(S: LeagueSettings, roster: ValuedPlayer[], irIds: ReadonlySet<string> = new Set()): number[] {
  const order = fillOrder(S.slots);
  const active = roster.filter((p) => !irIds.has(p.id) || irSlotReturns(p));
  const n = Math.max(0, S.finalWeek - S.currentWeek + 1);
  const split = returnSplit(S, active.filter((p) => perceptionOf(p, S).source !== "yahoo"));
  const out: number[] = [];
  for (let i = n - evaluatorWeeks(S); i < n; i++) {
    out.push(mixedWeekLineup(order, active, split, i, (p) => (irIds.has(p.id) && ourWeek(p, S, i) <= 0 ? 0 : (perceptionOf(p, S).weekly[i] ?? 0))));
  }
  return out;
}

/** How many rostered skill players carry a captured Yahoo projection, rest of season or this week ("captured" vs "not captured yet"). */
export function yahooCoverage(players: ValuedPlayer[]): { captured: number; total: number } {
  const skill = players.filter((p) => p.pos !== "K" && p.pos !== "DEF");
  return { captured: skill.filter((p) => p.yahooProj !== undefined || p.yahooProjWeekly !== undefined).length, total: skill.length };
}
