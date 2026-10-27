// Model v4 player signals (docs/DESIGN.md "Model v4", section 1 + amendments). Pure: inputs come from
// server/data/signalTables.ts; nothing in the app consumes these yet (release (a) is an enabler).
import type { Scoring } from "../types.js";
import { contextFlags, FLAGGED_WEIGHT, isFlagged } from "./context.js";
import { efficiencyOf } from "./efficiency.js";
import { luckOf } from "./luck.js";
import { weekOpportunity } from "./opportunity.js";
import { plainMean, recencyWeights, weightedRate } from "./recency.js";
import { talentPrior } from "./talent.js";
import { flexLevels, metricOf, trendOf } from "./trend.js";
import type { PlayerSignalInput, PlayerSignals, RateKey, Rates, SkillPos, WeekSignal } from "./types.js";

export type * from "./types.js";

const RATE_KEYS: RateKey[] = ["targetShare", "airShare", "wopr", "weightedOpp", "snapShare", "expPts", "actPts"];
const HALF_SNAPS = 0.5;

export interface SignalContext {
  season: number;
  scoring: Scoring;
  /** Reference date for ages (pass a fixed date in tests). */
  asOf: Date;
  /** Flex level of the trend metric per position (trend.ts flexLevels; set by computeAllSignals). Absent → never rising. */
  flexLevels?: Partial<Record<SkillPos, number>>;
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
    trend: trendOf(weeks, p.pos, ctx.flexLevels?.[p.pos]),
    talent: talentPrior(p.pos, p.prior, p.roster, ctx.season, ctx.asOf, ctx.scoring),
    rosterStatus: p.roster?.status,
    ...(p.roster?.statusCode ? { rosterCode: p.roster.statusCode } : {}),
    status: [...p.status].sort((a, b) => a.week - b.week),
  };
}

/** Batch over every skill player in the inputs; the trend's flex levels come from the batch itself (two passes). */
export function computeAllSignals(inputs: Iterable<PlayerSignalInput>, ctx: SignalContext): Map<string, PlayerSignals> {
  const out = new Map<string, PlayerSignals>();
  const { flexLevels: _ignored, ...base } = ctx;
  for (const p of inputs) out.set(p.id, computePlayerSignals(p, base));
  const levels = flexLevels(
    [...out.values()].map((s) => {
      const m = metricOf(s.pos);
      return { pos: s.pos, rate: m ? s.rates[m] : null, games: m ? s.weeks.filter((w) => w[m] !== undefined).length : 0 };
    }),
  );
  for (const s of out.values()) s.trend = trendOf(s.weeks, s.pos, levels[s.pos]);
  return out;
}
