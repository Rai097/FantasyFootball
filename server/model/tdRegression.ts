// Expected-touchdown regression (docs/DESIGN.md "Fix: one playoff engine + small-sample prior", fix round 2).
// Touchdowns are the noisiest part of fantasy scoring. Per kind — passing TDs per attempt, rushing TDs per carry,
// receiving TDs per target — this season's expected TD rate per opportunity is pulled toward a baseline rate per
// opportunity with tdK games × his own opportunity rate of weight, then multiplied by his current opportunity rate.
// In per-game terms: regressed = (n × xTD/g + tdK × baseline/opp × opp/g) / (n + tdK). The baseline is last season's
// ACTUAL TDs per opportunity (≥ minGames games), else the position's mean ACTUAL TDs per opportunity this season.
// Unknown opportunities (a source without attempts / carries / targets) fall back to per-game rates. Pure.
import type { ByTdKind, PlayerSignals } from "./signals/types.js";
import type { Position, Scoring } from "./types.js";

export const TD_KINDS = ["pass", "rush", "rec"] as const;
export type TdKind = (typeof TD_KINDS)[number];

/** Signal week fields per kind: opportunities, expected TDs, actual TDs. */
const FIELDS = {
  pass: { opp: "passAtt", exp: "expPassTd", act: "actPassTd" },
  rush: { opp: "carries", exp: "expRushTd", act: "actRushTd" },
  rec: { opp: "targets", exp: "expRecTd", act: "actRecTd" },
} as const;

/** League points per TD of each kind. */
export const tdPointsOf = (s: Scoring): ByTdKind => ({ pass: s.passTd, rush: s.rushTd, rec: s.recTd });

export interface PositionTdBase {
  /** Actual TDs per opportunity (null = no opportunity data for this kind). */
  perOpp: Record<TdKind, number | null>;
  /** Actual TDs per game (fallback when his opportunities are unknown). */
  perGame: ByTdKind;
}

interface TdSums {
  td: ByTdKind;
  opp: ByTdKind;
  games: number;
}

const zero = (): TdSums => ({ td: { pass: 0, rush: 0, rec: 0 }, opp: { pass: 0, rush: 0, rec: 0 }, games: 0 });

function sumsOf(sig: PlayerSignals, into: TdSums = zero()): TdSums {
  for (const w of sig.weeks) {
    for (const k of TD_KINDS) {
      into.td[k] += w[FIELDS[k].act];
      into.opp[k] += w[FIELDS[k].opp];
    }
    into.games++;
  }
  return into;
}

/**
 * Position means of ACTUAL TDs per opportunity / per game over every game of players with ≥ minGames games. `of(pos,
 * sig)` leaves the player's own games out (no player regresses toward himself); undefined = no other games.
 */
export function positionTdBaselines(players: Iterable<{ pos: Position; sig: PlayerSignals | null }>, minGames: number) {
  const acc = new Map<Position, TdSums>();
  for (const { pos, sig } of players) {
    if (!sig || sig.weeks.length < minGames) continue;
    let a = acc.get(pos);
    if (!a) acc.set(pos, (a = zero()));
    sumsOf(sig, a);
  }
  return {
    of(pos: Position, sig: PlayerSignals | null): PositionTdBase | undefined {
      const a = acc.get(pos);
      if (!a) return undefined;
      const own = sig && sig.weeks.length >= minGames ? sumsOf(sig) : zero();
      const games = a.games - own.games;
      if (games <= 0) return undefined;
      const perOpp = {} as Record<TdKind, number | null>;
      const perGame = {} as ByTdKind;
      for (const k of TD_KINDS) {
        const opp = a.opp[k] - own.opp[k];
        const td = a.td[k] - own.td[k];
        perOpp[k] = opp > 1e-9 ? td / opp : null;
        perGame[k] = td / games;
      }
      return { perOpp, perGame };
    },
  };
}

export interface TdShrink {
  /** Expected TDs per game this season (recency-weighted), after regression, and the baseline at his volume. */
  raw: number;
  regressed: number;
  base: number;
  source: "prior" | "position";
  /** Expected points per game removed (negative = added) by the regression. */
  ptsDelta: number;
}

export interface TdInput {
  /** Recency-weighted expected TDs and opportunities per game this season, by kind. */
  xTd: ByTdKind;
  opp: ByTdKind;
  /** Sample games (unflagged 1, flagged 0.25) and pseudo-games of the baseline. */
  n: number;
  k: number;
  /** Last season (≥ minGames games): actual TDs per game and opportunities per game (null = unknown). */
  prior: { tds: ByTdKind; opps: ByTdKind | null } | null;
  position: PositionTdBase | undefined;
  minGames: number;
  points: ByTdKind;
}

/** The regression, or null when it does not apply (no sample, or under minGames sample games without a prior). */
export function regressTds(x: TdInput): TdShrink | null {
  if (!(x.n > 0)) return null;
  if (!x.prior && (x.n < x.minGames || !x.position)) return null;
  let raw = 0;
  let regressed = 0;
  let base = 0;
  let ptsDelta = 0;
  // Per opportunity when his opportunities are known (any > 0); a kind he has no opportunity at gets a 0 baseline.
  const known = x.opp.pass + x.opp.rush + x.opp.rec > 0;
  for (const kind of TD_KINDS) {
    const xg = x.xTd[kind];
    const og = x.opp[kind];
    const posRate = x.position?.perOpp[kind] ?? null;
    let b: number;
    if (x.prior) {
      const po = x.prior.opps?.[kind];
      if (!known || po === undefined) b = x.prior.tds[kind];
      else if (po > 0) b = (x.prior.tds[kind] / po) * og;
      else b = og > 0 ? (posRate !== null ? posRate * og : xg) : 0; // no such opportunity last season
    } else b = known && posRate !== null ? posRate * og : x.position!.perGame[kind];
    const r = (x.n * xg + x.k * b) / (x.n + x.k);
    raw += xg;
    regressed += r;
    base += b;
    ptsDelta += x.points[kind] * (xg - r);
  }
  return { raw, regressed, base, source: x.prior ? "prior" : "position", ptsDelta };
}
