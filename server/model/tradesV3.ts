// Trade Finder v3 → v4 (Model v4 release (d)): packages another manager would actually accept.
// Acceptance comes from THEIR view: the lineup change Yahoo's evaluator would show them (perceived values: Yahoo
// projections / FantasyPros rank + recent games, perception.ts), then a recent spike of what they give, market value
// (FantasyCalc) only as a minor term. True value = our model. See docs/DESIGN.md "Trade finder v3" and "Release (d)".
import type { DetailItem, LeagueSettings, Position, SlotKind, Team, TeamAnalysis, Trade, TradeFinderResult, TradeSide, ValuedPlayer } from "./types.js";
import { FLEX_SLOTS, SLOT_ELIGIBILITY, effPpg, eligible, optimalLineup, slotLabels, usable, type LineupResult } from "./lineup.js";
import { applyTrade, combos, fmtSigned, lineupChanges, names, rosterExcess, teamState, tradeDeadlinePassed, type TradeContext } from "./tradeKit.js";
import { irSet } from "./analysis.js";
import { MODE_WEIGHTS, activeRoster, combine, partsDelta, rosterParts, type ScoreParts, type TradeMode } from "./rosterScore.js";
import { injuryKind } from "./projection.js";
import { edgeOf, marketOf, returnUnconfirmed, tradeValueOf, trueOf, type ValueSource } from "./market.js";
import { FLOOR, overlapFactor, scaledPlayer } from "./signals.js";
import { detailBuilder, makeSummary, toneOf } from "./details.js";
import { marketTag } from "./labels.js";
import { RETURNS, returnText } from "./returns.js";
import { isSpike, perceivedLineupTotal, perceptionOf, yahooCoverage } from "./perception.js";
import { DEPTH_WEIGHT, teamStrength } from "./teamStrength.js";
import { expectedWeeklyPoints } from "./rosterScore.js";

/** Config for Trade Finder v3 (architect's design after user feedback on v2). */
export const V3 = {
  /** Eligibility: a piece needs market or true value ≥ this (waiver level below). */
  minPieceValue: 3,
  /** Injured pieces (owner 2026-10-26): an absent player is tradeable when he has ≥ this many games left from his return. */
  minGamesBack: 3,
  /**
   * QB rule (fix 2026-10-30): a QB moves only from a team whose top two QBs both PROJECT (our posRank) ≤ qbDepthRank,
   * to a team that needs one: the spare QB projects ≥ qbUpgradeMin pts/g (effPpg) above its best usable QB, or its best
   * QB's market rank is > qbNeedRank (the old rule, kept as an OR).
   */
  qbNeedRank: 18,
  qbDepthRank: 14,
  /** Calibration value: pts/g a spare QB must project above the receiver's best QB to count as an upgrade. */
  qbUpgradeMin: 1.0,
  /** Package value = best + 0.85·second + 0.70·third. */
  pkgWeights: [1, 0.85, 0.7],
  /** Drop cost per player the receiving side must cut: that player's value, at least this. */
  minDropCost: 3,
  /** The side receiving the single best player in an uneven deal (give count ≠ get count) must give ≥ 110% of the other package; even swaps carry no premium. */
  consolidationPremium: 1.1,
  /** Need model. */
  minMyDelta: 0.5,
  /** My side's true-value bar, as a share of the deal's total true value (fix 2026-10-30): Playoffs mode may cost up
   *  to 3% (the playoff-strength bar decides), Balanced / Win now must gain 3%. */
  minMyTrueGain: { now: 0.03, balanced: 0.03, playoffs: -0.03 } as Record<TradeMode, number>,
  /** v4 acceptance, dominant term: logistic in their perceived lineup change per week, +1 pt/wk → 0.70. */
  accLineupK: Math.log(0.7 / 0.3),
  /** Market term: logistic(k · market edge %), +5% → 0.65, weighted 20% (FantasyCalc matters only a little). */
  accK: Math.log(0.65 / 0.35) / 5,
  marketWeight: 0.2,
  /** Each player they give right after a spike game (≥ 1.5× his perceived rate): × 0.7. */
  spikeMult: 0.7,
  /** A perceived loss for them caps acceptance here (and keeps the deal off the main list). */
  perceivedLossCap: 0.25,
  extraPlayerMult: 0.85,
  loseTopMult: 0.8,
  fixesWorstMult: 1.1,
  accCap: 0.95,
  /** Gem bonus: perception gaps in my favour (pts/game, capped) × this, added to my playoff-lineup gain. */
  gapBonus: 0.25,
  gapCap: 4,
  perPartner: 2,
  perGive: 2,
  limit: 10,
  clearDelta: 1.0,
  /** Main list only: the deal's best player must have market value ≥ this (else it is a smaller edge, not a headline trade). */
  minHeadliner: 8,
  minAcceptance: 0.4,
  nearMissLimit: 10,
  /** v3.1: a starting slot losing ≥ this many ppg counts ×1.5 (extra 0.5 × loss), −1.0 more when thin + injured. */
  slotLossMin: 3,
  slotLossExtra: 0.5,
  thinPenalty: 1.0,
  /** v3.1: giving a riser costs ×1.15 of his value (selling upside); same for the partner. */
  riserPremium: 1.15,
  /** No suggestion below this playoff-lineup (team strength) gain for me, pts/week — except a "marginal" near miss
   *  (my side fails its bar), which needs only a positive gain. */
  minMyGain: 1.0,
  /** Mode-aware listing (fix 2026-10-27): outside Playoffs mode the playoff strength may fall at most this much. */
  playoffFloor: { now: -1.0, balanced: -0.5 } as Partial<Record<TradeMode, number>>,
  /** Search bounds. */
  poolSize: 14,
  comboCap: 4000,
  preFairLo: 0.75,
  preFairHi: 1.45,
} as const;

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * The gain a mode lists and ranks on (fix 2026-10-27): Playoffs = playoff strength (team strength, pts/wk); Balanced /
 * Win now = the mode's team score (MODE_WEIGHTS of now / season / playoffs / depth, minus slot-loss aversion).
 */
export const modeGain = (j: Pick<Judged3, "strengthDelta" | "myDelta">, mode: TradeMode): number => (mode === "playoffs" ? j.strengthDelta : j.myDelta);

/**
 * May a judged deal appear on the finder's lists in this mode? Its mode gain ≥ V3.minMyGain (a "marginal" near miss,
 * where my side fails its bar: > 0), and outside Playoffs mode the playoff strength not below V3.playoffFloor[mode]:
 * a deal that helps now but not in the playoffs may list in Win now / Balanced, never in Playoffs.
 */
export function listsInMode(j: Pick<Judged3, "strengthDelta" | "myDelta">, mode: TradeMode, marginal = false): boolean {
  const g = modeGain(j, mode);
  // The bar compares the gain as the card shows it (0.1-rounded), so the bullet and the gate never disagree; a marginal
  // near miss needs a gain that shows as at least +0.1.
  if (!(marginal ? r1(g) > 0 : r1(g) >= V3.minMyGain)) return false;
  const floor = V3.playoffFloor[mode];
  return floor === undefined || j.strengthDelta >= floor;
}

/** Whether a deal clears this mode's listing bar (listsInMode), as one bullet value (evaluate). */
export function modeBarText(j: Pick<Judged3, "strengthDelta" | "myDelta">, mode: TradeMode): string {
  const g = r1(modeGain(j, mode));
  const what = mode === "playoffs" ? "playoff strength" : "team score";
  const floor = V3.playoffFloor[mode];
  if (g < V3.minMyGain) return `fails: ${what} ${fmtSigned(g)} (needs +${V3.minMyGain.toFixed(1)})`;
  if (floor !== undefined && j.strengthDelta < floor) return `fails: playoff strength ${fmtSigned(j.strengthDelta)} (floor ${fmtSigned(floor)})`;
  return `clears: ${what} ${fmtSigned(g)}${floor !== undefined ? `, playoff strength ${fmtSigned(j.strengthDelta)}` : ""}`;
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (x: number) => `${Math.round(x * 100)}%`;

// ---------------------------------------------------------------- package math (exported for tests)

/** best + 0.85·second + 0.70·third (values sorted high → low; a 4th piece adds nothing). */
export function packageValue(values: number[]): number {
  const s = [...values].sort((a, b) => b - a);
  let v = 0;
  for (let i = 0; i < Math.min(s.length, V3.pkgWeights.length); i++) v += V3.pkgWeights[i] * s[i];
  return v;
}

/** Cost of the roster spots a side must free: each cut player's value, at least minDropCost. */
export function dropCost(cutValues: number[]): number {
  return cutValues.reduce((a, v) => a + Math.max(V3.minDropCost, v), 0);
}

const pctSigned = (p: number) => `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(0)}%`;

/** "Market value: they get +16%" — FantasyCalc package value they receive vs give (ratio = received / given). */
export function marketLabel(ratio: number): string {
  return `Market value: they get ${pctSigned((ratio - 1) * 100)}`;
}

/**
 * "Lineup impact: good for you (playoffs +1.3/wk, season +0.0/wk; them −0.3/wk season)" — our projections. The verdict
 * follows my playoff-lineup change (the row summary leads with it; the finder ranks on playoff strength).
 */
export function lineupLabel(playoffs: number, season: number, theirs: number): string {
  const verdict = playoffs > 0.05 ? "good for you" : playoffs < -0.05 ? "bad for you" : "neutral for you";
  return `Lineup impact: ${verdict} (playoffs ${fmtSigned(playoffs)}/wk, season ${fmtSigned(season)}/wk; them ${fmtSigned(theirs)}/wk season)`;
}

/** Market term of acceptance: logistic in the partner's market edge (percent), +5% → 0.65. */
export function acceptCurve(edgePct: number): number {
  return 1 / (1 + Math.exp(-V3.accK * edgePct));
}

/** Lineup term of acceptance: logistic in their perceived lineup change per week, +1 → 0.70, 0 → 0.5. */
export function lineupCurve(perWeek: number): number {
  return 1 / (1 + Math.exp(-V3.accLineupK * perWeek));
}

export interface AcceptFactors {
  /** Their perceived (Yahoo-style) lineup change, points per remaining week. */
  perceivedPerWeek: number;
  /** Their perceived lineup change over the rest of the season < 0 (rounded to 0.1). */
  perceivedLoss: boolean;
  /** Their market edge in percent: (market received / given − 1) × 100. */
  marketEdgePct: number;
  /** Players they give right after a spike game. */
  spikes: number;
  /** Roster spots the partner must free (players I give beyond what I get, IR slots counted: rosterExcess). */
  extraGiven: number;
  losesTheirTop: boolean;
  fixesWorst: boolean;
}

/**
 * v4 acceptance from THEIR view: 80% their perceived lineup change, 20% market edge, × 0.7 per player they give after
 * a spike game, × 0.85 per extra player, × 0.8 for their best player, × 1.1 when it fixes their weakest slot; cap 0.95.
 * A perceived loss caps it at 0.25.
 */
export function acceptanceV4(f: AcceptFactors): number {
  let p = (1 - V3.marketWeight) * lineupCurve(f.perceivedPerWeek) + V3.marketWeight * acceptCurve(f.marketEdgePct);
  p *= Math.pow(V3.spikeMult, Math.max(0, f.spikes));
  p *= Math.pow(V3.extraPlayerMult, Math.max(0, f.extraGiven));
  if (f.losesTheirTop) p *= V3.loseTopMult;
  if (f.fixesWorst) p *= V3.fixesWorstMult;
  p = Math.min(V3.accCap, p);
  return f.perceivedLoss ? Math.min(V3.perceivedLossCap, p) : p;
}

// ---------------------------------------------------------------- eligibility

/** His games (bye excluded) from week `from` through the final week. */
export function gamesFrom(p: ValuedPlayer, S: LeagueSettings, from: number): number {
  let n = 0;
  for (let w = Math.max(from, S.currentWeek); w <= S.finalWeek; w++) if (p.bye !== w) n++;
  return n;
}

/** Out for the season: ReturnInfo.seasonOver, or (no return estimate) an injury kind "long" whose detail says "season". */
/** My side's true-value fail text, naming this mode's bar (V3.minMyTrueGain). */
export function trueBarFail(myTrueChange: number, trueTotal: number, mode: TradeMode): string {
  const share = V3.minMyTrueGain[mode];
  const bar = share * trueTotal;
  const pctTxt = `${Math.round(Math.abs(share) * 100)}% of the deal`;
  return share < 0
    ? `you give away value: true value ${fmtSigned(myTrueChange)} (${MODE_LABEL[mode]} allows down to ${fmtSigned(bar)}, ${pctTxt})`
    : `you pay market price: true value ${fmtSigned(myTrueChange)} (${MODE_LABEL[mode]} needs ${fmtSigned(bar)}, ${pctTxt})`;
}

export const seasonEnding = (p: ValuedPlayer): boolean =>
  !!p.ret?.seasonOver || (!p.ret && injuryKind(p.injury) === "long" && /season/i.test(p.injury?.detail ?? ""));

/**
 * Why a player cannot be a trade piece (empty string when he can), QB rule aside. Injured players (owner 2026-10-26)
 * are pieces in both directions when he has a few weeks left to play: back with ≥ minGamesBack games through the final
 * week, or return unconfirmed with a trade value (a bet on his recovery, "½ of healthy") and ≥ minGamesBack games from
 * the week that value assumes (current + 4, or the IR minimum if later). Out for the season never. An IR slot is not
 * a reason on its own. The waiver-level check uses the value trades use for him (tradeValue for an unconfirmed return).
 */
export function ineligibleReason(p: ValuedPlayer, S: LeagueSettings): string {
  if (p.pos === "K" || p.pos === "DEF") return "K / DEF are streamed, not traded";
  if (seasonEnding(p)) return "out for the season";
  if (marketOf(p) < V3.minPieceValue && tradeValueOf(p) < V3.minPieceValue) return "waiver-level value";
  const r = p.ret;
  if (r?.absent) {
    if (r.week !== null) {
      const n = gamesFrom(p, S, r.week);
      return n >= V3.minGamesBack ? "" : `back ~wk ${r.week}: only ${n} game${n === 1 ? "" : "s"} left`;
    }
    if (!(r.tradeValue && r.tradeValue > 0)) return "return unconfirmed, no trade value";
    const from = Math.max(S.currentWeek + RETURNS.unknownOffset, r.earliestWeek ?? 0);
    const n = gamesFrom(p, S, from);
    return n >= V3.minGamesBack ? "" : `return unconfirmed: under ${V3.minGamesBack} games left after wk ${from}`;
  }
  if (!usable(p)) return "no games left";
  return "";
}

/** Market QB rank for the QB rule's need-by-rank test: market position rank when market values exist (99 = outside the list). */
export function qbRank(p: ValuedPlayer): number {
  if (p.market !== undefined) return p.marketPosRank ?? 99;
  return p.posRank;
}

export function bestQbRank(roster: ValuedPlayer[]): number {
  let best = 99;
  for (const p of roster) if (p.pos === "QB" && usable(p)) best = Math.min(best, qbRank(p));
  return best;
}

/** A team's best usable QB by our projection (effPpg, the lineup's number), or null when it has none. */
export function bestQb(roster: ValuedPlayer[]): ValuedPlayer | null {
  let best: ValuedPlayer | null = null;
  for (const p of roster) if (p.pos === "QB" && usable(p) && (!best || effPpg(p) > effPpg(best))) best = p;
  return best;
}

/**
 * A team's second QB (the one it does not start: lower projected ppg) when its top two QBs both project
 * (our posRank, not the market) ≤ qbDepthRank — the only QB it may trade. A backup who is merely a bench body is no spare.
 */
export function spareQb(roster: ValuedPlayer[]): ValuedPlayer | null {
  const qbs = roster.filter((p) => p.pos === "QB" && usable(p)).sort((a, b) => effPpg(b) - effPpg(a) || a.posRank - b.posRank);
  return qbs.length >= 2 && qbs[0].posRank <= V3.qbDepthRank && qbs[1].posRank <= V3.qbDepthRank ? qbs[1] : null;
}

/**
 * Does `to` need this QB? Yes when he projects ≥ qbUpgradeMin pts/g above its best usable QB (our projections), or
 * its best QB's market rank is worse than qbNeedRank (old rule). A name-brand QB having a weak season blocks nothing.
 */
export function qbNeeded(qb: ValuedPlayer, toRoster: ValuedPlayer[]): boolean {
  const best = bestQb(toRoster);
  return !best || effPpg(qb) - effPpg(best) >= V3.qbUpgradeMin - 1e-9 || bestQbRank(toRoster) > V3.qbNeedRank;
}

/** QB rule: `from` may send its spare QB (spareQb) to `to` only when `to` needs it (qbNeeded). */
export function qbTradeable(fromRoster: ValuedPlayer[], toRoster: ValuedPlayer[]): ValuedPlayer | null {
  const spare = spareQb(fromRoster);
  return spare && qbNeeded(spare, toRoster) ? spare : null;
}

/** One "QB rule" bullet value: why this QB may (or may not) move from `fromRoster` to `toRoster`. */
export function qbRuleText(q: ValuedPlayer, fromRoster: ValuedPlayer[], toRoster: ValuedPlayer[]): string {
  if (spareQb(fromRoster)?.id !== q.id) return `${q.name} NOT allowed: not a spare (both QBs must project top-${V3.qbDepthRank})`;
  const best = bestQb(toRoster);
  if (!best) return `${q.name} allowed: the receiver has no QB`;
  const d = effPpg(q) - effPpg(best);
  const vs = `QB${q.posRank} vs QB${best.posRank}, our projections`;
  if (d >= V3.qbUpgradeMin - 1e-9) return `${q.name} allowed: ${fmtSigned(d)} pts/g over their QB (${vs})`;
  if (bestQbRank(toRoster) > V3.qbNeedRank) return `${q.name} allowed: their best QB is QB${bestQbRank(toRoster)} by market`;
  return `${q.name} NOT allowed: only ${fmtSigned(d)} pts/g over their QB (${vs})`;
}

// ---------------------------------------------------------------- team profile / complementarity

const GROUPS = ["QB", "RB", "WR", "TE", "FLEX"] as const;
type Group = (typeof GROUPS)[number];
const groupOfSlot = (s: SlotKind): Group | null => (FLEX_SLOTS.includes(s) ? "FLEX" : (GROUPS as readonly string[]).includes(s) ? (s as Group) : null);
const fitsGroup = (g: Group, pos: Position) => (g === "FLEX" ? eligible("FLEX", pos) : g === pos);

interface Weakest {
  group: Group;
  /** Fraction below league average (0.2 = 20% below). */
  deficit: number;
  /** Slot label of the weakest starter in that group, e.g. "RB2". */
  slot: string;
  player: ValuedPlayer | null;
}

/** A team's roster, lineup and roster score (IR-slotted players add no lineup or depth points; value total keeps them). */
export interface TeamBase {
  team: Team;
  roster: ValuedPlayer[];
  base: LineupResult;
  parts: ScoreParts;
  irIds: Set<string>;
  total: number;
}

export function teamBase(ctx: TradeContext, teamId: string): TeamBase {
  const s = teamState(ctx, teamId);
  const irIds = irSet(s.team);
  return { ...s, parts: rosterParts(ctx.league.settings, activeRoster(s.roster, irIds), ctx.replacement).parts, irIds, total: s.roster.reduce((a, p) => a + p.value, 0) };
}

export interface TeamV3 extends TeamBase {
  analysis?: TeamAnalysis;
  pieces: ValuedPlayer[];
  deficit: Record<Group, number>;
  weakest: Weakest | null;
  /** Bench vorp at each skill position among eligible pieces (surplus). */
  surplus: Record<"RB" | "WR" | "TE", number>;
  surplusNames: Record<"RB" | "WR" | "TE", string[]>;
  topMarketId: string | null;
  starters: Set<string>;
  /** Starters + top-3 bench by lineup ppg (for same-NFL-team overlap). */
  core: ValuedPlayer[];
  starterList: ValuedPlayer[];
  bad: boolean;
  /** Playoff lineup strength (teamStrength total, pts/week). */
  strength: number;
  /** The rest-of-season lineup total Yahoo's evaluator would show (perceived values). */
  perceived: number;
}

export function teamV3(ctx: TradeContext, teamId: string): TeamV3 {
  const S = ctx.league.settings;
  const s = teamBase(ctx, teamId);
  const analysis = ctx.teams.find((t) => t.team.id === teamId);
  const pieces = s.roster.filter((p) => p.pos !== "QB" && !ineligibleReason(p, S));
  const deficit = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0 } as Record<Group, number>;
  for (const g of GROUPS) {
    const gr = analysis?.groups[g];
    if (gr && gr.leagueAvg > 0) deficit[g] = Math.max(0, 1 - gr.ppg / gr.leagueAvg);
  }
  const labels = slotLabels(s.base.lineup);
  let weakest: Weakest | null = null;
  for (const g of GROUPS) {
    const gr = analysis?.groups[g];
    if (!gr || gr.leagueAvg <= 0) continue;
    const ratio = gr.ppg / gr.leagueAvg;
    if (weakest && ratio >= 1 - weakest.deficit) continue;
    let slot = g as string;
    let player: ValuedPlayer | null = null;
    let low = Infinity;
    s.base.lineup.forEach((l, i) => {
      if (groupOfSlot(l.slot) !== g) return;
      const v = effPpg(l.player);
      if (v < low) {
        low = v;
        slot = labels[i];
        player = l.player;
      }
    });
    weakest = { group: g, deficit: 1 - ratio, slot, player };
  }
  const starters = new Set(s.base.lineup.map((l) => l.player?.id).filter(Boolean) as string[]);
  const surplus = { RB: 0, WR: 0, TE: 0 };
  const surplusNames = { RB: [] as string[], WR: [] as string[], TE: [] as string[] };
  for (const p of pieces) {
    if (starters.has(p.id) || !(p.pos === "RB" || p.pos === "WR" || p.pos === "TE")) continue;
    const v = Math.max(0, effPpg(p) - (ctx.replacement?.[p.pos] ?? 0));
    if (v <= 0) continue;
    surplus[p.pos] += v;
    surplusNames[p.pos].push(p.name);
  }
  const top = [...s.roster].filter((p) => p.pos !== "K" && p.pos !== "DEF").sort((a, b) => marketOf(b) - marketOf(a))[0];
  const rec = s.team.record;
  const games = rec ? rec.wins + rec.losses + rec.ties : 0;
  const bad = !!rec && games >= 2 && rec.wins / games <= 1 / 3 + 1e-9;
  const starterList = s.base.lineup.map((l) => l.player).filter((p): p is ValuedPlayer => !!p);
  const core = [...starterList, ...[...s.base.bench].sort((a, b) => effPpg(b) - effPpg(a)).slice(0, 3)];
  const strength = teamStrength(S, s.roster, s.irIds).total;
  const perceived = perceivedLineupTotal(S, s.roster, s.irIds);
  return { ...s, analysis, pieces, deficit, weakest, surplus, surplusNames, topMarketId: top?.id ?? null, starters, core, starterList, bad, strength, perceived };
}

const deficitFor = (t: TeamV3, pos: "RB" | "WR" | "TE") => Math.max(t.deficit[pos], 0.5 * t.deficit.FLEX);
const surplusScore = (v: number) => Math.min(1, v / 6);

/** Complementarity: their weak groups × my surplus, plus my weak groups × their surplus (0..~100). */
export function complementarity(me: TeamV3, them: TeamV3): number {
  let c = 0;
  for (const pos of ["RB", "WR", "TE"] as const) {
    c += deficitFor(them, pos) * surplusScore(me.surplus[pos]);
    c += deficitFor(me, pos) * surplusScore(them.surplus[pos]);
  }
  // A spare starting QB for a team without one.
  if (qbTradeable(me.roster, them.roster)) c += them.deficit.QB;
  if (qbTradeable(them.roster, me.roster)) c += me.deficit.QB;
  return r1(c * 100);
}

const GROUP_NAME: Record<Group, string> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", FLEX: "FLEX" };

/** Best-fit partner row: a ≤ 255-char summary (their need, then what either side has spare) + one item per fact. */
export function partnerCard(me: TeamV3, them: TeamV3, fit: number): { summary: string; details: DetailItem[] } {
  const { items, add } = detailBuilder();
  const spare = (t: TeamV3) => (["RB", "WR", "TE"] as const).filter((p) => t.surplus[p] > 0.5).sort((a, b) => t.surplus[b] - t.surplus[a]);
  const mySpare = spare(me);
  const theirSpare = spare(them);
  const need = them.weakest && them.weakest.deficit > 0.02 ? them.weakest : null;
  const mine = me.weakest && me.weakest.deficit > 0.02 ? me.weakest : null;
  if (need) add("Their weakest spot", `${need.slot}: ${GROUP_NAME[need.group]} ${Math.round(need.deficit * 100)}% below league average`);
  if (mySpare.length) add("Your spare depth", `${mySpare[0]}: ${me.surplusNames[mySpare[0]].slice(0, 2).join(", ")}`);
  if (theirSpare.length) add("Their spare depth", `${theirSpare[0]}: ${them.surplusNames[theirSpare[0]].slice(0, 2).join(", ")}`);
  if (mine) add("Your weakest spot", mine.slot);
  add("Fit score", `${fit.toFixed(1)} (their needs × your surplus, and the reverse)`);
  const lead = need ? `Needs help at ${need.slot} (${Math.round(need.deficit * 100)}% below average).` : "No clear weak spot.";
  const offer = [mySpare.length ? `you have spare ${mySpare[0]}` : "", theirSpare.length ? `they have spare ${theirSpare[0]}` : ""].filter(Boolean).join(", ");
  const action = offer ? `${offer[0].toUpperCase()}${offer.slice(1)}.` : "Little overlap between your needs and theirs.";
  return { summary: makeSummary(lead, action), details: items };
}

// ---------------------------------------------------------------- judging one package

export interface Judged3 {
  give: ValuedPlayer[];
  get: ValuedPlayer[];
  myParts: ScoreParts;
  theirParts: ScoreParts;
  myDrops: ValuedPlayer[];
  theirDrops: ValuedPlayer[];
  /** My mode-weighted roster-score delta. */
  myDelta: number;
  /** Partner's rest-of-season weekly lineup delta (our projections). */
  theirLineup: number;
  /** My playoff-lineup strength change (teamStrength total, pts/week); 0 when not computed (my side fails early). */
  strengthDelta: number;
  /** What Yahoo's evaluator would show over the rest of the season (perceived values): me / them, total points. */
  myPerceived: number;
  theirPerceived: number;
  /** "yahoo" when every player in the deal carries a captured Yahoo projection, else "estimate". */
  perceivedSource: "yahoo" | "estimate";
  /** Their perceived lineup total falls (rounded to 0.1): capped acceptance, never on the main list. */
  perceivedLoss: boolean;
  /** Σ perception gaps of what I get − of what I give (pts/game; + = they underrate what I get / overrate what I give). */
  gapFavor: number;
  /** Players they give right after a spike game (≥ 1.5× their perceived rate). */
  spikes: ValuedPlayer[];
  /** Bye / playoff cover I lose (details bullets; empty = none). */
  coverItems: DetailItem[];
  marketGive: number;
  marketGet: number;
  trueGive: number;
  trueGet: number;
  /** Partner: perceived received (net of drop cost) / perceived given. */
  fairness: number;
  theirMarketChange: number;
  myTrueChange: number;
  bestToMe: boolean;
  premiumOk: boolean;
  myOk: boolean;
  partnerOk: boolean;
  acceptance: number;
  fixesWorst: boolean;
  losesTheirTop: boolean;
  score: number;
  edgeSum: number;
  /** v3.1 tags (overlap, stack, slot downgrade, thin, riser) and their details items. */
  tags31: string[];
  items31: DetailItem[];
  /** Slot-loss penalty subtracted from myDelta (≥ 0). */
  slotPenalty: number;
  /** A received player shares NFL team + group with one of my players (kept out of the main list). */
  overlap: boolean;
  /** Why my side fails (empty when myOk). */
  myFail: string;
  /** Why the partner would refuse (empty when partnerOk). */
  theirFail: string;
}

/**
 * `lazy` (the finder's search only): skip the team-strength simulation for a candidate no list can take (classify ⇒
 * null); its strengthDelta / score are then NaN and it is discarded. Evaluate and bench upgrades always compute it.
 */
export function judge3(ctx: TradeContext, my: TeamV3, their: TeamV3, mode: TradeMode, opts: { lazy?: boolean } = {}) {
  const S = ctx.league.settings;
  const repl = ctx.replacement;
  return (give: ValuedPlayer[], get: ValuedPlayer[]): Judged3 => {
    const tags31: string[] = [];
    const items31: DetailItem[] = [];
    let overlap = false;
    // A: same-NFL-team overlap / stacks, judged against each receiver's remaining core.
    const myCore = my.core.filter((p) => !give.includes(p));
    const myStart = my.starterList.filter((p) => !give.includes(p));
    const theirCore = their.core.filter((p) => !get.includes(p));
    const theirStart = their.starterList.filter((p) => !get.includes(p));
    const myAfter: ValuedPlayer[] = [];
    for (const p of my.roster) if (!give.includes(p)) myAfter.push(p);
    for (const p of get) {
      const o = overlapFactor(p, myCore, myStart);
      if (o.tag) tags31.push(o.f < 1 ? `${p.name} ${o.tag}` : `stack: ${p.name} + ${o.tag.replace(/^stack with /, "")}`);
      if (o.f < 1) overlap = true;
      myAfter.push(scaledPlayer(p, o.f));
    }
    const theirAfter: ValuedPlayer[] = [];
    for (const p of their.roster) if (!get.includes(p)) theirAfter.push(p);
    for (const p of give) theirAfter.push(scaledPlayer(p, overlapFactor(p, theirCore, theirStart).f));
    // Roster spots each side must free (IR slots counted: rosterExcess, owner 2026-10-26).
    const myCuts = rosterExcess(S.slots, my.irIds, give, get, their.irIds);
    const theirCuts = rosterExcess(S.slots, their.irIds, get, give, my.irIds);
    const me = rosterParts(S, activeRoster(myAfter, my.irIds), repl, myCuts > 0 ? { count: myCuts, keep: (p) => my.irIds.has(p.id) || get.some((g) => g.id === p.id) } : undefined);
    const th = rosterParts(S, activeRoster(theirAfter, their.irIds), repl, theirCuts > 0 ? { count: theirCuts, keep: (p) => their.irIds.has(p.id) || give.includes(p) } : undefined);
    const myParts = partsDelta(me.parts, my.parts);
    const theirParts = partsDelta(th.parts, their.parts);
    // B: slot loss aversion — a starting slot that drops ≥ 3 ppg counts ×1.5.
    let slotPenalty = 0;
    if (give.length) {
      const after = optimalLineup(S.slots, myAfter.filter((p) => !me.drops.includes(p)), { irIds: my.irIds });
      const labels = slotLabels(my.base.lineup);
      my.base.lineup.forEach((l, i) => {
        if (l.slot === "K" || l.slot === "DEF") return;
        const b = effPpg(l.player);
        const a = effPpg(after.lineup[i]?.player ?? null);
        const loss = b - a;
        if (loss < V3.slotLossMin) return;
        slotPenalty += V3.slotLossExtra * loss;
        const label = FLEX_SLOTS.includes(l.slot) ? labels[i] : l.slot;
        tags31.push(`downgrades ${label} by ${loss.toFixed(1)}`);
        const pos = l.player?.pos;
        if (pos) {
          const left = myAfter.filter((p) => p.pos === pos && !me.drops.includes(p)).length;
          if (left < 2 && get.some((g) => g.pos === pos && g.injury)) {
            slotPenalty += V3.thinPenalty;
            tags31.push(`thin at ${pos}`);
          }
        }
      });
      if (slotPenalty > 0) {
        items31.push({ label: "Slot loss", value: `−${slotPenalty.toFixed(1)}: a starter losing ≥ ${V3.slotLossMin} ppg counts ×1.5`, tone: "neg" });
        if (tags31.some((t) => t.startsWith("thin"))) items31.push({ label: "Thin", value: `−${V3.thinPenalty.toFixed(1)}: thin at the spot, with an injured replacement`, tone: "neg" });
      }
    }
    const myDelta = combine(myParts, MODE_WEIGHTS[mode]) - slotPenalty;
    const theirLineup = theirParts.season;

    // D: selling a riser means selling upside: his value counts ×1.15 on the giving side.
    const riserUp = (v: (p: ValuedPlayer) => number) => (p: ValuedPlayer) => v(p) * (p.riser ? V3.riserPremium : 1);
    for (const p of give) if (p.riser) items31.push({ label: "Riser you give", value: `${p.name}: counts ×${V3.riserPremium} (you sell upside)` });
    for (const p of get) if (p.riser) items31.push({ label: "Riser you get", value: `${p.name}: they value him ×${V3.riserPremium}` });
    const marketGive = packageValue(give.map(marketOf));
    const marketGet = packageValue(get.map(riserUp(marketOf)));
    const trueGive = packageValue(give.map(riserUp(trueOf)));
    const trueGet = packageValue(get.map(trueOf));
    const theirDropP = dropCost(th.drops.map(marketOf));
    const myDropT = dropCost(me.drops.map(trueOf));
    const theirRecvNet = marketGive - theirDropP;
    const fairness = theirRecvNet / Math.max(1, marketGet);
    const theirMarketChange = theirRecvNet - marketGet;
    const myTrueChange = trueGet - myDropT - trueGive;
    const trueTotal = trueGive + trueGet;

    // Single best player in the deal (market, then true value).
    const all = [...give, ...get].sort((a, b) => marketOf(b) - marketOf(a) || trueOf(b) - trueOf(a));
    const bestToMe = get.includes(all[0]);
    // Consolidation premium (the "2-for-1 tax"): only in an UNEVEN deal (2-for-1, 1-for-2, 3-for-2…), where one side
    // gets fewer, better players and frees a roster spot, whoever receives the single best player must give ≥ 110% of
    // the other side's package, net of drop cost. Even swaps (1-for-1, 2-for-2) consolidate no roster spot and are
    // judged by the acceptance model and the other gates only. Their side is judged on what they see (market); mine on
    // our true values — the market is never my bar (Model v4).
    let premiumOk = true;
    let premiumMine = false;
    if (give.length !== get.length) {
      if (bestToMe) premiumOk = theirRecvNet >= V3.consolidationPremium * marketGet;
      const bestTrue = [...give, ...get].sort((a, b) => trueOf(b) - trueOf(a) || marketOf(b) - marketOf(a))[0];
      if (give.includes(bestTrue) && trueGet - myDropT < V3.consolidationPremium * trueGive) {
        premiumOk = false;
        premiumMine = true;
      }
    }

    let myFail = "";
    if (premiumMine && !premiumOk) myFail = `you move the best player for a package worth less than ${pct(V3.consolidationPremium)} of him`;
    else if (myDelta < V3.minMyDelta) myFail = `your team ${fmtSigned(myDelta)} (needs +${V3.minMyDelta.toFixed(1)})${slotPenalty > 0 ? ` after −${slotPenalty.toFixed(1)} slot-loss aversion` : ""}`;
    else if (myTrueChange < V3.minMyTrueGain[mode] * trueTotal) myFail = trueBarFail(myTrueChange, trueTotal, mode);

    // THEIR view (release (d)): the lineup totals Yahoo's evaluator would show, on perceived values (unscaled rosters:
    // the partner does not apply our target-overlap discount).
    const giveIds = new Set(give.map((p) => p.id));
    const getIds = new Set(get.map((p) => p.id));
    const myRosterAfter = my.roster.filter((p) => !giveIds.has(p.id)).concat(get);
    const theirRosterAfter = their.roster.filter((p) => !getIds.has(p.id)).concat(give);
    const myPerceived = perceivedLineupTotal(S, myRosterAfter, my.irIds) - my.perceived;
    const theirPerceived = perceivedLineupTotal(S, theirRosterAfter, their.irIds) - their.perceived;
    const nWeeks = Math.max(1, S.finalWeek - S.currentWeek + 1);
    const perceivedLoss = r1(theirPerceived) < 0;
    const perceivedSource = [...give, ...get].every((p) => perceptionOf(p, S).source === "yahoo") ? "yahoo" : "estimate";
    const gapFavor = get.reduce((a, p) => a + perceptionOf(p, S).gap, 0) - give.reduce((a, p) => a + perceptionOf(p, S).gap, 0);
    const spikes = get.filter((p) => isSpike(perceptionOf(p, S)));

    let theirFail = "";
    if (!premiumMine && !premiumOk) theirFail = `consolidation premium: they give the best player, so your package must be worth ≥ ${pct(V3.consolidationPremium)} of theirs (it is ${pct(fairness)})`;
    else if (perceivedLoss) theirFail = `${perceivedSource === "yahoo" ? "Yahoo shows" : "Yahoo would likely show"} them ${fmtSigned(theirPerceived)} pts rest of season`;

    const losesTheirTop = get.some((p) => p.id === their.topMarketId);
    const w = their.weakest;
    const fixesWorst = !!w && theirPerceived > 0 && give.some((p) => fitsGroup(w.group, p.pos) && effPpg(p) > effPpg(w.player));
    const acceptance = acceptanceV4({
      perceivedPerWeek: theirPerceived / nWeeks,
      perceivedLoss,
      marketEdgePct: (fairness - 1) * 100,
      spikes: spikes.length,
      extraGiven: Math.max(0, theirCuts),
      losesTheirTop,
      fixesWorst,
    });
    // My playoff-lineup gain (team strength, release (b)): always the real number — evaluate shows it and marginal near
    // misses (my side fails) are ranked on it.
    const listable = classifiable({ myOk: !myFail, partnerOk: !theirFail, fairness, myDelta, myTrueChange, trueGive, trueGet });
    const strengthDelta = opts.lazy && !listable ? NaN : teamStrength(S, myAfter.filter((p) => !me.drops.includes(p)), my.irIds).total - my.strength;
    // Gem: the mode's gain (modeGain) × acceptance, plus a bonus when the perception gaps favour me.
    const score = acceptance * ((mode === "playoffs" ? strengthDelta : myDelta) + V3.gapBonus * Math.min(V3.gapCap, Math.max(0, gapFavor)));
    const edgeSum = get.reduce((a, p) => a + edgeOf(p), 0) - give.reduce((a, p) => a + edgeOf(p), 0);
    const coverItems = give.length ? coverLost(S, my, give, get) : [];
    return {
      give, get, myParts, theirParts, myDrops: me.drops, theirDrops: th.drops, myDelta, theirLineup, strengthDelta: r1(strengthDelta),
      myPerceived: r1(myPerceived), theirPerceived: r1(theirPerceived), perceivedSource, perceivedLoss, gapFavor: r1(gapFavor), spikes, coverItems,
      marketGive, marketGet, trueGive, trueGet, fairness, theirMarketChange, myTrueChange, bestToMe, premiumOk,
      myOk: !myFail, partnerOk: !theirFail, acceptance, fixesWorst, losesTheirTop, score, edgeSum, myFail, theirFail, tags31, items31, slotPenalty, overlap,
    };
  };
}

// ---------------------------------------------------------------- building Trade objects

function sideOf(teamId: string, gives: ValuedPlayer[], before: LineupResult, after: { lineup: LineupResult; drops: ValuedPlayer[] }, parts: ScoreParts, scoreDelta: number, valueGiven: number): TradeSide {
  return {
    teamId,
    gives,
    valueGiven: r1(valueGiven),
    lineupDelta: Math.round((after.lineup.starterPpg - before.starterPpg) * 100) / 100,
    lineupChanges: lineupChanges(before, after.lineup).concat(after.drops.map((p) => `Drop: ${p.name} (value ${p.value.toFixed(1)})`)),
    drops: after.drops,
    scoreDelta: r1(scoreDelta),
    nowDelta: r1(parts.now),
    seasonDelta: r1(parts.season),
    playoffDelta: r1(parts.playoffs),
    depthDelta: r1(parts.depth),
  };
}

/**
 * Label tags (labels.ts, one definition app-wide): buy-low / sell-high from luck (what I get under-produces his usage /
 * what I give over-produces it on touchdowns), and the market gap (|edge| ≥ 8). Never "sell" a rising player.
 */
function edgeTags(j: Judged3): string[] {
  const tags: string[] = [];
  for (const p of j.get) if (p.label === "buy-low") tags.push(`buy-low: ${p.name} (due ${fmtSigned(p.luck ?? 0)} pts/g)`);
  for (const p of j.give) if (!p.riser && p.label === "sell-high") tags.push(`sell-high: ${p.name} (TD luck ${fmtSigned(p.luck ?? 0)} pts/g)`);
  for (const p of j.get) if (marketTag(edgeOf(p)) === "market undervalues") tags.push(`market undervalues: ${p.name} (+${edgeOf(p).toFixed(1)})`);
  for (const p of j.give) if (!p.riser && marketTag(edgeOf(p)) === "market overvalues") tags.push(`market overvalues: ${p.name} (${fmtSigned(edgeOf(p))})`);
  // Buying a touchdown-luck spike: his points run ahead of his usage, so expect them to come down.
  for (const p of j.get) if (p.label === "sell-high") tags.push(`TD luck: ${p.name} (${fmtSigned(p.luck ?? 0)} pts/g vs usage)`);
  return tags;
}

/** Bye-overlap and playoff-week bye facts, one item each. */
function byeItems(S: LeagueSettings, j: Judged3, myAfter: LineupResult): DetailItem[] {
  const out: DetailItem[] = [];
  const starters = myAfter.lineup.map((l) => l.player).filter((p): p is ValuedPlayer => !!p && p.pos !== "K" && p.pos !== "DEF");
  for (const p of j.get) {
    if (p.bye === undefined || p.bye < S.currentWeek) continue;
    const same = starters.filter((s) => s.id !== p.id && s.bye === p.bye);
    if (same.length >= 2) out.push({ label: "Bye overlap", value: `${p.name} (week ${p.bye}) with ${same.map((s) => s.name).join(", ")}`, tone: "warn" });
  }
  const po0 = S.regularSeasonEnd + 1;
  const inPO = (p: ValuedPlayer) => p.bye !== undefined && p.bye >= po0 && p.bye <= S.finalWeek;
  const poGet = j.get.filter(inPO);
  const poGive = j.give.filter(inPO);
  for (const p of poGet) out.push({ label: "Playoff bye", value: `${p.name}: week ${p.bye}`, tone: "warn" });
  for (const p of poGive) out.push({ label: "Playoff bye you move", value: `${p.name}: week ${p.bye}`, tone: "pos" });
  if (!poGet.length && !poGive.length) out.push({ label: "Playoff byes", value: `None in weeks ${po0}–${S.finalWeek}` });
  return out;
}

/** Expected points of player p in week w (projection v4 weekly, an unconfirmed return's p × back; 0 = no game / out). */
const ptsIn = (S: LeagueSettings, p: ValuedPlayer, w: number) => expectedWeeklyPoints(p, S)[w - S.currentWeek] ?? 0;

/**
 * Bye / playoff cover I lose by giving `give` (one bullet each):
 *  - a starter's bye in the weeks ahead (current week → final week) at a position where the player I give is my best
 *    bench option that week, and nothing I keep or get covers it as well;
 *  - my only backup QB / TE (the playoff cover when the starter is hurt).
 * A same-position player starting at a FLEX-type slot counts as a backup; for a bye he moves over and the FLEX is
 * refilled from the bench (any player eligible for that slot), as is a FLEX starter's own bye.
 */
export function coverLost(S: LeagueSettings, my: TeamV3, give: ValuedPlayer[], get: ValuedPlayer[]): DetailItem[] {
  const out: DetailItem[] = [];
  const giveIds = new Set(give.map((p) => p.id));
  const starters = my.starterList.filter((p) => p.pos !== "K" && p.pos !== "DEF" && !giveIds.has(p.id));
  // A same-position starter in a FLEX-type slot covers a starter in his own slot (owner 2026-10-27: a TE at W/R/T
  // moves to TE when the TE is out). For a bye that opens the FLEX instead, so the cover is the best bench player
  // eligible for that FLEX slot; a FLEX starter's own bye is covered the same way; otherwise the best bench player at
  // the position. Giving the FLEX mate himself loses the cover when no same-position player as good is left.
  const flexSlot = new Map(my.base.lineup.filter((l) => l.player && FLEX_SLOTS.includes(l.slot)).map((l) => [l.player!.id, l.slot] as const));
  const bench = my.roster.filter((p) => !my.starters.has(p.id) && !my.irIds.has(p.id));
  const flex = my.roster.filter((p) => flexSlot.has(p.id) && !my.irIds.has(p.id));
  const benchAfter = bench.filter((p) => !giveIds.has(p.id)).concat(get);
  const flexAfter = flex.filter((p) => !giveIds.has(p.id));
  const best = (pool: ValuedPlayer[], ok: (p: ValuedPlayer) => boolean, w: number) =>
    pool.filter((p) => ok(p) && p.bye !== w).reduce<{ p: ValuedPlayer | null; v: number }>((b, p) => (ptsIn(S, p, w) > b.v ? { p, v: ptsIn(S, p, w) } : b), { p: null, v: 0 });
  const byeCover = (s: ValuedPlayer, w: number, benchPool: ValuedPlayer[], flexPool: ValuedPlayer[]) => {
    const mate = flexSlot.has(s.id) ? undefined : flexPool.find((p) => p.pos === s.pos && p.id !== s.id && p.bye !== w);
    const open = flexSlot.get(s.id) ?? (mate ? flexSlot.get(mate.id) : undefined);
    const elig = open ? SLOT_ELIGIBILITY[open] : [s.pos];
    return best(benchPool, (p) => elig.includes(p.pos), w);
  };
  const seen = new Set<string>();
  for (const s of starters) {
    const w = s.bye;
    if (w === undefined || w < S.currentWeek || w > S.finalWeek) continue;
    let before = byeCover(s, w, bench, flex);
    let lost = !!before.p && giveIds.has(before.p.id) && byeCover(s, w, benchAfter, flexAfter).v < before.v - 0.5;
    // The FLEX mate himself given away: compare the position's cover — him before, the best same-position player
    // left after (another FLEX mate, a bench player or one I get).
    const mate = flexSlot.has(s.id) ? undefined : flex.find((p) => p.pos === s.pos && p.id !== s.id && p.bye !== w);
    if (!lost && mate && giveIds.has(mate.id)) {
      const v = ptsIn(S, mate, w);
      if (best(benchAfter.concat(flexAfter), (p) => p.pos === s.pos && p.id !== s.id, w).v < v - 0.5) {
        before = { p: mate, v };
        lost = true;
      }
    }
    if (!lost || !before.p) continue;
    const key = `${before.p.id}:${w}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: "Bye cover lost", value: `${before.p.name} covers ${s.name}'s week ${w} bye (${before.v.toFixed(1)} pts)`, tone: "warn" });
  }
  for (const pos of ["QB", "TE"] as const) {
    const startersAt = my.base.lineup.filter((l) => l.player?.pos === pos && !FLEX_SLOTS.includes(l.slot)).length;
    if (!startersAt) continue;
    const backups = bench.concat(flex).filter((p) => p.pos === pos && usable(p));
    const gone = backups.filter((p) => giveIds.has(p.id));
    if (!gone.length || backups.length > gone.length || get.some((p) => p.pos === pos)) continue;
    out.push({ label: "Playoff cover lost", value: `${gone[0].name} is your only ${pos} backup`, tone: "warn" });
  }
  return out;
}

/**
 * A backup I give (projects below their starter at his position) who plays in a week ahead when that starter — one
 * they keep — is on bye.
 */
function theirByeCover(S: LeagueSettings, their: TeamV3, give: ValuedPlayer[], get: ValuedPlayer[]): { player: ValuedPlayer; starter: ValuedPlayer; week: number } | null {
  const getIds = new Set(get.map((p) => p.id));
  for (const p of give) {
    for (const s of their.starterList) {
      const w = s.bye;
      if (getIds.has(s.id) || w === undefined || w < S.currentWeek || w > S.finalWeek || s.pos !== p.pos || p.bye === w || ptsIn(S, p, w) <= 0) continue;
      if (effPpg(p) >= effPpg(s)) continue; // he would start anyway: not a bye-cover argument
      return { player: p, starter: s, week: w };
    }
  }
  return null;
}

/**
 * Pitch: reasons that matter to THEM — the slot it fills, the bye it covers, what their lineup gains in the numbers
 * they see (Yahoo projections), recent production of what they get. Never a market-value claim.
 */
function tradePitch(S: LeagueSettings, j: Judged3, their: TeamV3): string {
  const deal = `my ${names(j.give)} for your ${names(j.get)}`;
  const Deal = `${deal[0].toUpperCase()}${deal.slice(1)}`;
  const reasons: string[] = [];
  // A player whose return is unconfirmed has a placeholder value: say what the bet is.
  const unsure = [...j.give, ...j.get].filter(returnUnconfirmed);
  if (unsure.length) reasons.push(`${names(unsure)}${unsure.length > 1 ? " have unconfirmed returns, so this is a bet on their recovery" : "'s return is unconfirmed, so this is a bet on his recovery"}`);
  const w = their.weakest;
  if (w && j.fixesWorst) reasons.push(`it fills your ${w.slot}, your weakest spot`);
  const cover = theirByeCover(S, their, j.give, j.get);
  if (cover) reasons.push(`${cover.player.name} covers ${cover.starter.name}'s week ${cover.week} bye`);
  if (j.theirPerceived > 0) reasons.push(`${j.perceivedSource === "yahoo" ? "Yahoo projects" : "the projections put"} your lineup ${fmtSigned(j.theirPerceived)} pts over the rest of the season`);
  const hot = j.give
    .map((p) => ({ p, pc: perceptionOf(p, S) }))
    .filter(({ pc }) => pc.lastGamePts !== undefined && pc.lastGamePts >= Math.max(10, pc.rate))
    .sort((a, b) => b.pc.lastGamePts! - a.pc.lastGamePts!)[0];
  if (hot) reasons.push(`${hot.p.name} scored ${hot.pc.lastGamePts!.toFixed(1)} last game`);
  if (!reasons.length) reasons.push("it keeps your starting lineup level");
  return `${Deal}: ${reasons.slice(0, 3).join("; ")}.`;
}

/** "QB rule" items when a QB moves (null when none does); used for trade and bench-upgrade cards. */
export function qbItems(my: TeamV3, their: TeamV3, give: ValuedPlayer[], get: ValuedPlayer[]): DetailItem[] | null {
  const qbs = [...give, ...get].filter((p) => p.pos === "QB");
  if (!qbs.length) return null;
  return qbs.map((q) => {
    const [from, to] = give.includes(q) ? [my, their] : [their, my];
    const ok = qbTradeable(from.roster, to.roster)?.id === q.id;
    return { label: "QB rule", value: qbRuleText(q, from.roster, to.roster), ...(ok ? {} : { tone: "warn" as const }) };
  });
}

export function buildTrade3(ctx: TradeContext, j: Judged3, my: TeamV3, their: TeamV3, mode: TradeMode): Trade {
  const S = ctx.league.settings;
  const { give, get } = j;
  const meAfter = applyTrade(S.slots, my.roster, give, get, my.irIds, their.irIds);
  const themAfter = applyTrade(S.slots, their.roster, get, give, their.irIds, my.irIds);
  const me = sideOf(my.team.id, give, my.base, meAfter, j.myParts, j.myDelta, j.marketGive);
  const them = sideOf(their.team.id, get, their.base, themAfter, j.theirParts, combine(j.theirParts, MODE_WEIGHTS.balanced), j.marketGet);
  const key = `${their.team.id}:${give.map((p) => p.id).sort().join(",")}>${get.map((p) => p.id).sort().join(",")}`;
  const p100 = Math.round(j.acceptance * 100);
  const tags: string[] = [...edgeTags(j), ...j.tags31];
  for (const p of [...give, ...get]) if (p.riser) tags.push(`riser: ${p.name}`);
  for (const p of get) {
    if (p.consistency !== undefined && p.consistency >= FLOOR.highFloor && p.ppg >= FLOOR.highFloorPpg) tags.push(`high floor: ${p.name}`);
    else if (p.consistency !== undefined && p.consistency <= FLOOR.volatile) tags.push(`volatile: ${p.name}`);
  }
  if (j.fixesWorst && their.weakest) tags.push(`fixes their ${their.weakest.slot}`);
  if (give.length > get.length) tags.push("consolidation for them");
  if (meAfter.drops.length) tags.push("adds depth (you drop a bench player)");
  if (give.some((p) => p.pos === "QB") || get.some((p) => p.pos === "QB")) tags.push("spare starting QB");
  if (j.losesTheirTop) tags.push("asks for their best player");
  if (j.theirPerceived > 0 && j.myParts.season > 0) tags.push("helps both");
  if (j.coverItems.length) tags.push("loses bye cover");
  for (const p of j.spikes) tags.push(`just spiked: ${p.name}`);
  const yahoo = yahooViewOf(j);
  // One playoff engine (fix 2026-10-27): the playoff lineup is rosterParts' playoffs part (= teamStrength's lineup on the
  // same roster); strengthDelta is the team-strength total (lineup + DEPTH_WEIGHT × bench cover) the finder ranks on.
  const poLineup = r1(j.myParts.playoffs);
  const lineup = lineupLabel(poLineup, j.myParts.season, j.theirLineup);
  const market = marketLabel(j.fairness);
  const summary = makeSummary(
    `${markedNames(give)} for ${markedNames(get)}: playoff lineup ${fmtSigned(poLineup)}/wk, your team ${fmtSigned(j.myDelta)}.`,
    `${j.perceivedSource === "yahoo" ? "Yahoo shows" : "Yahoo likely shows"} them ${fmtSigned(j.theirPerceived)} pts, ~${p100}% accept.`,
  );
  const nWeeks = Math.max(1, S.finalWeek - S.currentWeek + 1);
  const { items: details, add } = detailBuilder();
  add("Playoff lineup", `${fmtSigned(poLineup)} pts/wk in weeks ${S.regularSeasonEnd + 1}–${S.finalWeek}`, toneOf(poLineup));
  add("Playoff strength", `${fmtSigned(j.strengthDelta)} pts/wk (lineup + ${DEPTH_WEIGHT} × bench cover)`, toneOf(j.strengthDelta));
  add("Your team score", `${fmtSigned(j.myDelta)} (${mode} mode)`, toneOf(j.myDelta));
  add("Now", `${fmtSigned(j.myParts.now)} pts this week`, toneOf(j.myParts.now));
  add("Season", `${fmtSigned(j.myParts.season)} pts/wk rest of season`, toneOf(j.myParts.season));
  add("Depth", `${fmtSigned(j.myParts.depth)} (bench above replacement)`, toneOf(j.myParts.depth));
  for (const d of j.items31) add(d.label, d.value, d.tone);
  for (const d of j.coverItems) add(d.label, d.value, d.tone);
  add(j.perceivedSource === "yahoo" ? "What Yahoo shows" : "Yahoo view (estimate)", `you ${fmtSigned(j.myPerceived)}, them ${fmtSigned(j.theirPerceived)} pts rest of season`, toneOf(j.theirPerceived));
  if (j.perceivedSource !== "yahoo") add("Their view from", "FantasyPros ROS rank + last 3 games: Yahoo projections not captured yet", "warn");
  add("Their weekly lineup", `${fmtSigned(j.theirLineup)} pts (our projections)`, toneOf(j.theirLineup));
  for (const p of j.spikes) {
    const pc = perceptionOf(p, S);
    add("Just spiked", `${p.name}: ${pc.lastGamePts!.toFixed(1)} pts last game vs ${pc.rate.toFixed(1)} usual: × ${V3.spikeMult}`, "warn");
  }
  if (Math.abs(j.gapFavor) >= 0.5) add("Perception gap", `${fmtSigned(j.gapFavor)} pts/g ${j.gapFavor > 0 ? "in your favour" : "against you"} (our rate − their view)`, toneOf(j.gapFavor));
  add("Market: you give", j.marketGive.toFixed(1));
  add("Market: you get", j.marketGet.toFixed(1));
  if (them.drops?.length) add("They must cut", them.drops.map((p) => p.name).join(", "));
  if (me.drops?.length) add("You cut", me.drops.map((p) => p.name).join(", "));
  add("True value (ours)", `give ${j.trueGive.toFixed(1)}, get ${j.trueGet.toFixed(1)} (${fmtSigned(j.myTrueChange)})`, toneOf(j.myTrueChange));
  add("Acceptance", `${p100}%: their lineup ${fmtSigned(j.theirPerceived / nWeeks)}/wk (80%), market ${pctSigned((j.fairness - 1) * 100)} (20%)`);
  if (j.perceivedLoss) add("Their view", `a loss for them: acceptance capped at ${pct(V3.perceivedLossCap)}`, "neg");
  if (j.theirDrops.length) add("Extra players", `× ${V3.extraPlayerMult} per roster spot they must free`);
  if (j.losesTheirTop) add("Their best player", `× ${V3.loseTopMult}: you ask for their most valued player`);
  if (j.fixesWorst) add("Fixes their weakest slot", `× ${V3.fixesWorstMult}`);
  for (const d of byeItems(S, j, meAfter.lineup)) add(d.label, d.value, d.tone);
  for (const d of qbItems(my, their, give, get) ?? []) add(d.label, d.value, d.tone);
  for (const d of injuredItems(give, get)) add(d.label, d.value, d.tone);
  add("Rank score", `${j.score.toFixed(2)} = (${mode === "playoffs" ? "playoff strength" : "team score"} + gap bonus) × acceptance`);
  return {
    key,
    me,
    them,
    fairness: r3(j.fairness),
    acceptance: r3(j.acceptance),
    score: r3(j.score),
    summary,
    details,
    tags,
    mode,
    lineupLabel: lineup,
    marketLabel: market,
    yahooView: yahoo,
    pitch: tradePitch(S, j, their),
    packages: { marketGive: r1(j.marketGive), marketGet: r1(j.marketGet), trueGive: r1(j.trueGive), trueGet: r1(j.trueGet), myTrueChange: r1(j.myTrueChange), theirMarketChange: r1(j.theirMarketChange) },
  };
}

/** "What Yahoo shows them: you +12.0, them −13.4 pts" (or the estimate wording when projections are not captured). */
export function yahooViewOf(j: Pick<Judged3, "myPerceived" | "theirPerceived" | "perceivedSource">): NonNullable<Trade["yahooView"]> {
  const nums = `you ${fmtSigned(j.myPerceived)}, them ${fmtSigned(j.theirPerceived)} pts`;
  return {
    you: j.myPerceived,
    them: j.theirPerceived,
    source: j.perceivedSource,
    label: j.perceivedSource === "yahoo" ? `What Yahoo shows them: ${nums}` : `What Yahoo likely shows them: ${nums} (estimate)`,
  };
}

// ---------------------------------------------------------------- search

export interface TradeOptionsV3 {
  mode?: TradeMode;
  partnerId?: string;
  wantPos?: string;
  maxGive?: number;
  maxGet?: number;
  valueSource?: ValueSource;
  limit?: number;
}

type Cls = "clear" | "edge" | "refuse" | "marginal" | "unlikely";
interface Cand {
  j: Judged3;
  their: TeamV3;
  cls: Cls;
}

/** Can any list take this candidate (classify ≠ null)? Uses no team-strength number (judge3 skips that when not). */
function classifiable(j: Pick<Judged3, "myOk" | "partnerOk" | "fairness" | "myDelta" | "myTrueChange" | "trueGive" | "trueGet">): boolean {
  if (j.myOk) return j.partnerOk || j.fairness >= 0.85;
  return j.partnerOk && j.myDelta > 0 && j.myTrueChange >= -0.05 * (j.trueGive + j.trueGet);
}

function classify(j: Judged3): Cls | null {
  if (!classifiable(j)) return null;
  if (j.myOk && j.partnerOk) {
    if (j.acceptance < V3.minAcceptance) return "unlikely";
    const headliner = Math.max(...j.give.map(marketOf), ...j.get.map(marketOf));
    return j.myDelta >= V3.clearDelta && headliner >= V3.minHeadliner && !j.overlap ? "clear" : "edge";
  }
  return j.myOk ? "refuse" : "marginal";
}

function reasonOf(c: Cand): string {
  if (c.cls === "refuse") return `They'd likely refuse: ${c.j.theirFail}.`;
  if (c.cls === "unlikely") return `Partner unlikely to accept (${pct(c.j.acceptance)}).`;
  return `Marginal: ${c.j.myFail}.`;
}

/** Diversity: ≤ perPartner per partner, ≤ perGive per player I give, one per (partner, my best piece, their best piece). */
function diversify(sorted: Cand[], limit: number, seenKeys = new Set<string>(), perPartner: number = V3.perPartner): Cand[] {
  const byPartner = new Map<string, number>();
  const byGive = new Map<string, number>();
  const out: Cand[] = [];
  const top = (ps: ValuedPlayer[]) => [...ps].sort((a, b) => marketOf(b) - marketOf(a))[0]?.id ?? "";
  for (const c of sorted) {
    const k = `${c.their.team.id}:${top(c.j.give)}>${top(c.j.get)}`;
    if (seenKeys.has(k)) continue;
    if ((byPartner.get(c.their.team.id) ?? 0) >= perPartner) continue;
    if (c.j.give.some((p) => (byGive.get(p.id) ?? 0) >= V3.perGive)) continue;
    seenKeys.add(k);
    byPartner.set(c.their.team.id, (byPartner.get(c.their.team.id) ?? 0) + 1);
    for (const p of c.j.give) byGive.set(p.id, (byGive.get(p.id) ?? 0) + 1);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

export interface TradeFinderResultV3 extends TradeFinderResult {
  simulated: number;
}

/** Candidate (give, get) packages for one partner, closest-to-fair first, capped. */
function packagesFor(my: TeamV3, their: TeamV3, opts: { maxGive: number; maxGet: number; wantPos?: string }): [ValuedPlayer[], ValuedPlayer[]][] {
  const pool = (t: TeamV3, qb: ValuedPlayer | null) => {
    const ps = [...t.pieces];
    if (qb && !ps.includes(qb)) ps.push(qb);
    return ps.sort((a, b) => Math.max(marketOf(b), trueOf(b)) - Math.max(marketOf(a), trueOf(a))).slice(0, V3.poolSize);
  };
  const myPool = pool(my, qbTradeable(my.roster, their.roster));
  const theirPool = pool(their, qbTradeable(their.roster, my.roster));
  // 3-for-1 only when I give quantity to a struggling (0-3 / 1-2) team.
  const give3 = opts.maxGive >= 2 && their.bad;
  const myPk = [...combos(myPool, give3 ? 3 : Math.min(2, opts.maxGive))];
  const theirPk = [...combos(theirPool, Math.min(2, opts.maxGet))].filter((pk) => !opts.wantPos || pk.some((p) => p.pos === opts.wantPos));
  const mv = (pk: ValuedPlayer[]) => packageValue(pk.map(marketOf));
  const tv = (pk: ValuedPlayer[]) => packageValue(pk.map(trueOf));
  const myV = myPk.map((pk) => [mv(pk), tv(pk)]);
  const thV = theirPk.map((pk) => [mv(pk), tv(pk)]);
  const pairs: { m: number; g: number; prio: number }[] = [];
  for (let gi = 0; gi < theirPk.length; gi++) {
    for (let mi = 0; mi < myPk.length; mi++) {
      const lm = myPk[mi].length;
      const lg = theirPk[gi].length;
      if (lm === 3 && lg !== 1) continue;
      const raw = myV[mi][0] / Math.max(1, thV[gi][0]);
      if (raw < V3.preFairLo || raw > V3.preFairHi) continue;
      // Loose true-value prune (the exact rule nets drop costs): keep near misses in reach.
      const trueTotal = myV[mi][1] + thV[gi][1];
      if (thV[gi][1] - myV[mi][1] < -0.08 * trueTotal) continue;
      pairs.push({ m: mi, g: gi, prio: Math.abs(Math.log(Math.max(1e-6, raw))) + 0.03 * (lm + lg - 2) });
    }
  }
  pairs.sort((a, b) => a.prio - b.prio);
  return pairs.slice(0, V3.comboCap).map((p) => [myPk[p.m], theirPk[p.g]]);
}

export function findTradesV3(ctx: TradeContext, myTeamId: string, opts: TradeOptionsV3 = {}): TradeFinderResultV3 {
  const mode = opts.mode ?? "balanced";
  const valueSource = opts.valueSource ?? "model";
  const S = ctx.league.settings;
  if (tradeDeadlinePassed(ctx.league)) {
    return { trades: [], smallerEdges: [], nearMisses: [], mode, valueSource, partners: [], summary: `The trade deadline (week ${S.tradeDeadlineWeek}) has passed: no trades to suggest.`, summaryDetails: [], simulated: 0 };
  }
  const maxGive = Math.max(1, Math.min(3, opts.maxGive ?? 2));
  const maxGet = Math.max(1, Math.min(2, opts.maxGet ?? 2));
  const wantPos = opts.wantPos?.toUpperCase();
  const my = teamV3(ctx, myTeamId);
  const others = ctx.league.teams.filter((t) => t.id !== myTeamId && (!opts.partnerId || t.id === opts.partnerId)).map((t) => teamV3(ctx, t.id));
  const ranked = others
    .map((their) => ({ their, c: complementarity(my, their) }))
    .sort((a, b) => b.c - a.c || a.their.team.id.localeCompare(b.their.team.id));
  const partners = ranked.map((r) => ({ teamId: r.their.team.id, complementarity: r.c, ...partnerCard(my, r.their, r.c) }));

  const cands: Cand[] = [];
  let simulated = 0;
  const search = (list: typeof ranked) => {
    for (const { their } of list) {
      const J = judge3(ctx, my, their, mode, { lazy: true });
      for (const [give, get] of packagesFor(my, their, { maxGive, maxGet, wantPos })) {
        const j = J(give, get);
        simulated++;
        // Never sell a player whose role is rising, and never suggest a noise-level gain in the chosen mode (owner,
        // Model v4; mode-aware since 2026-10-27: listsInMode); a "marginal" near miss only needs a real gain (> 0).
        if (give.some((p) => p.riser)) continue;
        const cls = classify(j);
        if (cls && listsInMode(j, mode, cls === "marginal")) cands.push({ j, their, cls });
      }
    }
  };
  // Every partner is searched: the old early stop (top 8 by complementarity, the rest only while < 6 clear deals) hid a
  // real league's best trade (a 10th-ranked partner) once injured pieces filled the first eight (owner 2026-10-26).
  search(ranked);

  const byScore = (a: Cand, b: Cand) => b.j.score - a.j.score || b.j.edgeSum - a.j.edgeSum || b.j.acceptance - a.j.acceptance;
  const limit = opts.limit ?? V3.limit;
  const seen = new Set<string>();
  const tradesC = diversify(cands.filter((c) => c.cls === "clear").sort(byScore), limit, seen);
  const edgesC = diversify(cands.filter((c) => c.cls === "edge" || c.cls === "clear").sort(byScore), limit, seen);
  const nmC = diversify(
    cands.filter((c) => c.cls === "refuse" || c.cls === "marginal" || c.cls === "unlikely").sort((a, b) => b.j.myDelta * Math.max(0.2, b.j.acceptance) - a.j.myDelta * Math.max(0.2, a.j.acceptance)),
    V3.nearMissLimit,
    seen,
  );
  const build = (c: Cand) => buildTrade3(ctx, c.j, my, c.their, mode);
  const trades = tradesC.map(build);
  const smallerEdges = edgesC.map(build);
  const nearMisses = nmC.map((c) => {
    const t = build(c);
    const reason = makeSummary(reasonOf(c));
    return { ...t, reason, details: [{ label: "Why not on the list", value: c.cls === "marginal" ? "Marginal for you" : c.cls === "unlikely" ? "Unlikely to accept" : "They'd likely refuse" }, ...(t.details ?? [])], tags: [...t.tags, c.cls === "marginal" ? "marginal" : "they'd likely refuse"] };
  });
  const coverage = yahooCoverage([my, ...others].flatMap((t) => t.roster));
  const { summary, details: summaryDetails } = summarize(my, ranked, trades, smallerEdges, valueSource, mode, coverage);
  return { trades, smallerEdges, nearMisses, mode, valueSource, partners, summary, summaryDetails, simulated };
}

/** Finder headline: one short line (≤ 255) + the reasons as items (shown on tap). */
function summarize(
  my: TeamV3,
  ranked: { their: TeamV3; c: number }[],
  trades: Trade[],
  edges: Trade[],
  source: ValueSource,
  mode: TradeMode,
  coverage: { captured: number; total: number },
): { summary: string; details: DetailItem[] } {
  const { items, add } = detailBuilder();
  const n = trades.length;
  const best = ranked.slice(0, 3).map((r) => r.their);
  const weak = my.weakest && my.weakest.deficit > 0.02 ? my.weakest : null;
  add("Mode", MODE_LABEL[mode]);
  if (weak) add("Your weakest spot", weak.slot);
  const groups = my.analysis?.groups ?? {};
  const top3 = (["QB", "RB", "WR", "TE"] as const).filter((g) => groups[g] && groups[g].rank <= 3);
  if (top3.length) add("Your top-3 groups", top3.join(", "));
  if (best.length) add("Best fits", best.map((t) => t.team.name).join(", "));
  const edgesTxt = edges.length ? ` (+${edges.length} smaller edge${edges.length > 1 ? "s" : ""})` : "";
  let summary: string;
  if (n) summary = `${n} trade${n > 1 ? "s" : ""} another manager would plausibly accept${edgesTxt}.`;
  else {
    summary = `No ${mode === "balanced" ? "balanced" : MODE_LABEL[mode].toLowerCase()} trade clears both sides' bars right now${edgesTxt}.`;
    if (!weak) add("Why none", "Your starters are at or above average at every slot");
    const topC = ranked[0]?.c ?? 0;
    if (topC < 5) add("Why none", "Nobody's surplus matches your needs, or needs your spare players");
    else add("Why none", `No fair package with ${ranked[0].their.team.name} raises both lineups`);
    add("Next step", "Check best-fit partners and near misses for a plausible ask");
  }
  add(
    "Their view",
    coverage.captured
      ? `Yahoo projections: ${coverage.captured} of ${coverage.total} rostered players captured`
      : "Estimate (FantasyPros ROS rank + last 3 games): Yahoo projections not captured yet",
    coverage.captured ? undefined : "warn",
  );
  add("Market values", source === "fantasycalc" ? "FantasyCalc (a minor part of acceptance)" : "Unavailable: our values used, no market edges");
  return { summary: makeSummary(summary), details: items };
}

const MODE_LABEL: Record<TradeMode, string> = { now: "Win now", balanced: "Balanced", playoffs: "Playoffs" };

// ---------------------------------------------------------------- evaluate

export function evaluateTradeV3(
  ctx: TradeContext,
  myTeamId: string,
  partnerId: string,
  giveIds: string[],
  getIds: string[],
  mode: TradeMode = "balanced",
): Trade & { verdict: string } {
  const my = teamV3(ctx, myTeamId);
  const their = teamV3(ctx, partnerId);
  const S = ctx.league.settings;
  const pick = (ids: string[], roster: ValuedPlayer[], who: string) =>
    [...new Set(ids)].map((id) => {
      const p = roster.find((r) => r.id === id);
      if (!p) throw Object.assign(new Error(`Player ${id} is not on ${who}'s roster`), { status: 400 });
      return p;
    });
  const give = pick(giveIds, my.roster, my.team.name);
  const get = pick(getIds, their.roster, their.team.name);
  if (!give.length && !get.length) throw Object.assign(new Error("Trade must include at least one player"), { status: 400 });
  const j = judge3(ctx, my, their, mode)(give, get);
  const trade = buildTrade3(ctx, j, my, their, mode);
  const { items: pre, add } = detailBuilder();
  const qbOk = (p: ValuedPlayer, from: TeamV3, to: TeamV3) => p.pos !== "QB" || qbTradeable(from.roster, to.roster)?.id === p.id;
  const QB_RULE = `QB rule (only a spare QB, to a team he upgrades by ${V3.qbUpgradeMin.toFixed(1)}+ pts/g or whose best is outside top ${V3.qbNeedRank})`;
  const flagged = [
    ...give.map((p) => [p, ineligibleReason(p, S) || (qbOk(p, my, their) ? "" : QB_RULE)] as const),
    ...get.map((p) => [p, ineligibleReason(p, S) || (qbOk(p, their, my) ? "" : QB_RULE)] as const),
  ].filter(([, r]) => r);
  let verdict: string;
  if (j.myOk && j.partnerOk) verdict = j.acceptance >= 0.5 ? "Accept" : "Accept if they will";
  else if (j.myOk) verdict = `They won't accept (${j.theirFail})`;
  else if (j.myDelta >= 0 && j.partnerOk) verdict = "Fair, lean decline";
  else verdict = "Decline";
  // The QB rule applies to hand-built trades too: a starting QB for a non-needy team is not a trade chip.
  if (flagged.some(([p, r]) => p.pos === "QB" && r.startsWith("QB rule"))) verdict = "Decline — QB rule";
  add("Verdict", verdict.replace(/ \(.*\)$/, ""), /^accept/i.test(verdict) ? "pos" : /decline/i.test(verdict) ? "neg" : "warn");
  if (!j.myOk) add("For you", j.myFail, "neg");
  if (!j.partnerOk) add("For them", j.theirFail, "neg");
  // The mode bar is one of several bars (both sides, acceptance): green only when the whole verdict is Accept.
  add(`${MODE_LABEL[mode]} bar`, modeBarText(j, mode), listsInMode(j, mode) && /^Accept/.test(verdict) ? "pos" : undefined);
  for (const [p, r] of flagged) add("Outside the rules", `${p.name}: ${r.startsWith("QB rule") ? "QB rule" : r}`, "warn");
  if (tradeDeadlinePassed(ctx.league)) add("Deadline", "The trade deadline has passed", "warn");
  return { ...trade, details: [...pre, ...(trade.details ?? [])], verdict };
}

// ---------------------------------------------------------------- bench-upgrade rule (benchUpgrades.ts)

/**
 * v3 bench-upgrade filter: both players pass the finder's eligibility (no K/DEF, not out for the season / without
 * enough games after his return, QB rule) and are real assets — market ≥ 3 AND our trade value ≥ 3 — the player I receive has market ≥ 8 or
 * value ≥ 5, and my rest-of-season weekly lineup rises ≥ 0.8.
 */
export const BENCH_MIN_SEASON = 0.8;
export const BENCH_GET_MARKET = 8;
export const BENCH_GET_VALUE = 5;
export function benchUpgradeOk(mine: ValuedPlayer, theirs: ValuedPlayer, mySeasonDelta: number): boolean {
  const worth = (p: ValuedPlayer) => marketOf(p) >= V3.minPieceValue && tradeValueOf(p) >= V3.minPieceValue;
  const asset = marketOf(theirs) >= BENCH_GET_MARKET || tradeValueOf(theirs) >= BENCH_GET_VALUE;
  return worth(mine) && worth(theirs) && asset && mySeasonDelta >= BENCH_MIN_SEASON;
}

/** Full bench-upgrade acceptance for findBenchUpgrades: eligibility + QB rule + benchUpgradeOk. */
export function benchUpgradeFilter(ctx: TradeContext, myTeamId: string) {
  const S = ctx.league.settings;
  const my = teamV3(ctx, myTeamId);
  const teams = new Map<string, TeamV3>();
  return (mine: ValuedPlayer, theirs: ValuedPlayer, mySeasonDelta: number, partnerId: string): boolean => {
    let their = teams.get(partnerId);
    if (!their) teams.set(partnerId, (their = teamV3(ctx, partnerId)));
    if (ineligibleReason(mine, S) || ineligibleReason(theirs, S)) return false;
    if (mine.pos === "QB" && qbTradeable(my.roster, their.roster)?.id !== mine.id) return false;
    if (theirs.pos === "QB" && qbTradeable(their.roster, my.roster)?.id !== theirs.id) return false;
    return benchUpgradeOk(mine, theirs, mySeasonDelta);
  };
}

/** Row-summary marker for an injured piece: " (injured, back ~wk 10)" / " (injured, return unconfirmed)"; "" otherwise. */
export function injuryMarker(p: ValuedPlayer): string {
  if (!p.ret?.absent) return "";
  return p.ret.week !== null ? ` (injured, back ~wk ${p.ret.week})` : " (injured, return unconfirmed)";
}

/** "A + B (injured, back ~wk 10)": names with the injury marker, the one wording every trade row summary uses. */
export const markedNames = (ps: ValuedPlayer[]): string => ps.map((p) => `${p.name}${injuryMarker(p)}`).join(" + ") || "nothing";

/** Release (c): an out player in the deal is valued on his return estimate, not 0 — say so on the card. */
export function injuredItems(give: ValuedPlayer[], get: ValuedPlayer[]): DetailItem[] {
  const out: DetailItem[] = [];
  const line = (p: ValuedPlayer) =>
    p.ret!.week !== null
      ? `${p.name}: ${returnText(p.ret!.week, p.ret!.confidence)}, valued from his return (${p.value.toFixed(1)})`
      : p.ret!.tradeValue
        ? `${p.name}: return unconfirmed, a bet on his recovery (valued ${p.ret!.tradeValue.toFixed(1)}, ½ of healthy)`
        : `${p.name}: return unconfirmed, no healthy role on record: value 0`;
  for (const p of give) if (p.ret?.absent) out.push({ label: "Injured, you give", value: line(p), tone: "warn" });
  for (const p of get) if (p.ret?.absent) out.push({ label: "Injured, you get", value: line(p), tone: "warn" });
  return out;
}
