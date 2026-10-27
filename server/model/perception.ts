// Perceived value (Model v4 release (d), docs/DESIGN.md "Model v4" section 5): how the OTHER manager sees a player.
// Managers judge trades by Yahoo's evaluator (Yahoo's projections in weekly optimal lineups) and by recent box
// scores, not by market values. Their view of a player:
//   base   = Yahoo's rest-of-season projection ÷ his remaining games (captured by the bookmarklet), else the
//            FantasyPros rest-of-season rank read as points (projection v4's ECR curve), else our own rate;
//   rate   = 0.7 × base + 0.3 × his last 3 games' actual points (recency bias; games in the last 4 weeks only);
//   weekly = rate in every remaining week he has a game (estimate: only weeks our model has him available —
//            the experts' rank does not price a week he is out); Yahoo's own weekly projection, when captured,
//            replaces this week on either source.
//   gap    = our playoff-weighted rate − perceived rate (+ = they underrate him).
// Pure. The weekly arrays are cached per player object (never serialised: the Values payload stays small).
import type { LeagueSettings, ValuedPlayer } from "./types.js";
import { effPpg } from "./lineup.js";
import { score } from "./scoring.js";
import { fillOrder } from "./rosterScore.js";
import { weekLineup } from "./teamStrength.js";

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
  /** Perceived points per game (base blended with recency). */
  rate: number;
  /** Perceived points per remaining week, weeks currentWeek..finalWeek (0 = no game / out). */
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
export type GameCheck = (p: ValuedPlayer, week: number) => boolean;
export const byeOnly: GameCheck = (p, w) => p.team !== "FA" && p.bye !== w;
export function scheduleCheck(schedule: Map<string, Map<number, unknown>> | undefined): GameCheck {
  if (!schedule || !schedule.size) return byeOnly;
  return (p, w) => !!schedule.get(p.team)?.has(w);
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
  const gameCount = games.filter(Boolean).length;

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
  if (p.yahooProj !== undefined && Number.isFinite(p.yahooProj)) {
    source = "yahoo";
    base = gameCount ? p.yahooProj / gameCount : 0;
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
  const rate = Math.max(0, recentMean !== undefined ? (1 - PERCEPTION.recencyWeight) * base + PERCEPTION.recencyWeight * recentMean : base);

  const weekly: number[] = [];
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (games[i]) {
      // Yahoo's rest-of-season total already prices his absences; the experts' rank does not, so the estimate
      // follows our availability (an IR player is not shown starting for them).
      if (source === "yahoo") v = rate;
      else v = ourWeek(p, S, i) > 0 ? rate : 0;
    }
    // Yahoo's own number for this week wins whenever captured (also when the rest-of-season view was not found).
    if (i === 0 && p.yahooProjWeekly !== undefined && Number.isFinite(p.yahooProjWeekly)) v = games[0] ? Math.max(0, p.yahooProjWeekly) : 0;
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
 * The lineup total Yahoo's evaluator would show a roster: Σ over remaining weeks of the optimal lineup by perceived
 * weekly points (IR-slot players excluded), the same greedy fill as team strength.
 */
export function perceivedLineupTotal(S: LeagueSettings, roster: ValuedPlayer[], irIds: ReadonlySet<string> = new Set()): number {
  const order = fillOrder(S.slots);
  const active = roster.filter((p) => !irIds.has(p.id));
  const n = Math.max(0, S.finalWeek - S.currentWeek + 1);
  let total = 0;
  for (let i = 0; i < n; i++) total += weekLineup(order, active, (p) => perceptionOf(p, S).weekly[i] ?? 0).total;
  return total;
}

/** How many rostered skill players carry a captured Yahoo projection (for "captured" vs "estimate" labels). */
export function yahooCoverage(players: ValuedPlayer[]): { captured: number; total: number } {
  const skill = players.filter((p) => p.pos !== "K" && p.pos !== "DEF");
  return { captured: skill.filter((p) => p.yahooProj !== undefined).length, total: skill.length };
}
