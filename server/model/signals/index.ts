// Model v4 player signals (docs/DESIGN.md "Model v4", section 1 + amendments). Pure: inputs come from
// server/data/signalTables.ts; nothing in the app consumes these yet (release (a) is an enabler).
import type { Scoring } from "../types.js";
import { contextFlags, FLAGGED_WEIGHT, isFlagged } from "./context.js";
import { efficiencyOf } from "./efficiency.js";
import { luckOf } from "./luck.js";
import { weekOpportunity } from "./opportunity.js";
import { plainMean, recencyWeights, weightedRate } from "./recency.js";
import { talentPrior } from "./talent.js";
import { trendOf } from "./trend.js";
import type { PlayerSignalInput, PlayerSignals, RateKey, Rates, WeekSignal } from "./types.js";

export type * from "./types.js";

const RATE_KEYS: RateKey[] = ["targetShare", "airShare", "wopr", "weightedOpp", "snapShare", "expPts", "actPts"];
const HALF_SNAPS = 0.5;

export interface SignalContext {
  season: number;
  scoring: Scoring;
  /** Reference date for ages (pass a fixed date in tests). */
  asOf: Date;
}

export function computePlayerSignals(p: PlayerSignalInput, ctx: SignalContext): PlayerSignals {
  const games = [...p.games].sort((a, b) => a.week - b.week);
  const flags = contextFlags(games, p.pos);
  const flagged = flags.map(isFlagged);
  const weights = recencyWeights(flagged);
  const weeks: WeekSignal[] = games.map((g, i) => ({
    week: g.week,
    gameId: g.gameId,
    team: g.team,
    ...weekOpportunity(g, p.pos, ctx.scoring),
    flags: flags[i],
    flagged: flagged[i],
    weight: weights[i],
  }));
  const rates = {} as Rates;
  const seasonAvg = {} as Rates;
  for (const k of RATE_KEYS) {
    const vals = weeks.map((w) => w[k]);
    rates[k] = weightedRate(vals, weights);
    seasonAvg[k] = plainMean(vals);
  }
  const luckGames = weeks.map((w, i) => ({
    expPts: w.expPts,
    actPts: w.actPts,
    expected: games[i].expected,
    actual: games[i].actual,
    weight: w.weight,
    sample: w.flagged ? FLAGGED_WEIGHT : 1,
  }));
  return {
    id: p.id,
    name: p.name,
    pos: p.pos,
    team: p.team,
    weeks,
    rates,
    seasonAvg,
    halfSnaps: rates.snapShare === null ? null : rates.snapShare >= HALF_SNAPS,
    luck: luckOf(luckGames, ctx.scoring),
    efficiency: efficiencyOf(luckGames, p.pos),
    trend: trendOf(weeks, p.pos),
    talent: talentPrior(p.pos, p.prior, p.roster, ctx.season, ctx.asOf, ctx.scoring),
    rosterStatus: p.roster?.status,
    status: [...p.status].sort((a, b) => a.week - b.week),
  };
}

/** Batch over every skill player in the inputs. */
export function computeAllSignals(inputs: Iterable<PlayerSignalInput>, ctx: SignalContext): Map<string, PlayerSignals> {
  const out = new Map<string, PlayerSignals>();
  for (const p of inputs) out.set(p.id, computePlayerSignals(p, ctx));
  return out;
}
