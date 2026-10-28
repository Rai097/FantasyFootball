// Model v4 player signals (docs/DESIGN.md "Model v4", section 1 + amendments). Pure: inputs come from
// server/data/signalTables.ts; nothing in the app consumes these yet (release (a) is an enabler).
import type { Scoring } from "../types.js";
import { contextFlags, FLAGGED_WEIGHT, isFlagged } from "./context.js";
import { efficiencyOf } from "./efficiency.js";
import { luckOf } from "./luck.js";
import { weekOpportunity } from "./opportunity.js";
import { plainMean, recencyWeights, weightedRate } from "./recency.js";
import { talentPrior } from "./talent.js";
import { score } from "../scoring.js";
import { SPIKE, usageShape, VACATED, vacatedGames } from "./vacated.js";
import { flexLevels, metricOf, trendOf } from "./trend.js";
import type { PlayerSignalInput, PlayerSignals, RateKey, Rates, SkillPos, WeekSignal } from "./types.js";

export type * from "./types.js";

const RATE_KEYS: RateKey[] = ["targetShare", "airShare", "wopr", "weightedOpp", "snapShare", "expPts", "actPts", "passAtt", "carries", "targets", "expPassTd", "expRushTd", "expRecTd"];
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
  // Vacated-role games weigh VACATED.weight; an isolated one-game jump in the last 3 games has its recency capped
  // (DESIGN "Fix: vacated role, spikes, depth and roster need"); a game with both gets the stronger discount only.
  const vacW = flags.map((f) => (f.vacated ? VACATED.weight : 1));
  // Over all his games (a low flagged game still shows his usage level), oldest first: the one spike definition
  // (vacated.ts usageShape), shared with the waiver role check.
  const shape = usageShape(
    games.map((g) => score(ctx.scoring, g.expected, p.pos)),
    vacW,
    { pos: p.pos, snaps: games.map((g) => g.snapShare) },
  );
  const opps = games.map((g) => weekOpportunity(g, p.pos, ctx.scoring));
  const capped = new Set(shape.spikeIdx);
  const fullWeights = recencyWeights(flagged, { capped, cap: SPIKE.maxRecency });
  const weights = recencyWeights(flagged, { capped, cap: SPIKE.maxRecency, factor: vacW });
  shape.spikeIdx.forEach((i) => (flags[i] = { ...flags[i], spike: true }));
  const weeks: WeekSignal[] = games.map((g, i) => ({
    week: g.week,
    gameId: g.gameId,
    team: g.team,
    ...opps[i],
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
  const vacIdx = games.map((g, i) => (g.vacated?.length ? i : -1)).filter((i) => i >= 0);
  const by = new Map<string, { id: string; name: string; pos: string }>();
  for (const i of vacIdx) for (const t of games[i].vacated!) by.set(t.id, t);
  const fullExp = vacIdx.length ? weightedRate(weeks.map((w) => w.expPts), fullWeights) : null;
  // The same player with no borrowed-role detection: the projection uses it when the teammate is not expected back
  // in the projection window (fix round 1: then the role is his own).
  const own = vacIdx.length ? computePlayerSignals({ ...p, games: p.games.map(({ vacated: _v, ...g }) => g) }, ctx) : null;
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
    ...(fullExp !== null ? { vacated: { weeks: vacIdx.map((i) => games[i].week), by: [...by.values()], fullExpPts: fullExp, own: own! } } : {}),
    ...(shape.spike ? { spike: true } : {}),
  };
}

/** Inputs with each game's `vacated` teammates stamped (vacated.ts, one definition for signals and breakouts). */
export function stampVacated(inputs: PlayerSignalInput[]): PlayerSignalInput[] {
  const vac = vacatedGames(inputs);
  return inputs.map((p) => {
    const m = vac.get(p.id);
    if (!m) return p;
    return { ...p, games: p.games.map((g) => (m.has(g.week) && m.get(g.week)!.length && g.team ? { ...g, vacated: m.get(g.week) } : g)) };
  });
}

/** Batch over every skill player in the inputs; the trend's flex levels come from the batch itself (two passes). */
export function computeAllSignals(inputs: Iterable<PlayerSignalInput>, ctx: SignalContext): Map<string, PlayerSignals> {
  const out = new Map<string, PlayerSignals>();
  const { flexLevels: _ignored, ...base } = ctx;
  for (const p of stampVacated([...inputs])) out.set(p.id, computePlayerSignals(p, base));
  const levels = flexLevels(
    [...out.values()].map((s) => {
      const m = metricOf(s.pos);
      return { pos: s.pos, rate: m ? s.rates[m] : null, games: m ? s.weeks.filter((w) => w[m] !== undefined).length : 0 };
    }),
  );
  for (const s of out.values()) {
    s.trend = trendOf(s.weeks, s.pos, levels[s.pos]);
    if (s.vacated) s.vacated.own.trend = trendOf(s.vacated.own.weeks, s.pos, levels[s.pos]);
  }
  return out;
}
