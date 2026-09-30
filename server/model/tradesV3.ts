// Trade Finder v3: market-value packages that another manager would actually send or accept.
// Perceived value = FantasyCalc market (fallback: our value); true value = our model. See docs/DESIGN.md "Trade finder v3".
import type { FairnessBand, LeagueSettings, Position, SlotKind, TeamAnalysis, Trade, TradeFinderResult, TradeSide, ValuedPlayer } from "./types.js";
import { FLEX_SLOTS, effPpg, eligible, slotLabels, usable, type LineupResult } from "./lineup.js";
import { applyTrade, combos, fmtSigned, lineupChanges, names, tradeDeadlinePassed, type TradeContext } from "./trades.js";
import { state2, type State2 } from "./tradesV2.js";
import { MODE_WEIGHTS, combine, partsDelta, riskAdjusted, rosterParts, type ScoreParts, type TradeMode } from "./rosterScore.js";
import { injuryKind } from "./projection.js";
import { edgeOf, marketOf, trueOf, type ValueSource } from "./market.js";

/** Config for Trade Finder v3 (architect's design after user feedback on v2). */
export const V3 = {
  /** Eligibility: a piece needs market or true value ≥ this (waiver level below). */
  minPieceValue: 3,
  /** Players out this many weeks or more (or on IR) are not traded. */
  outWeeks: 4,
  /** QB rule: a QB moves only from a team with two QBs ranked ≤ qbDepthRank to a team whose best QB ranks > qbNeedRank. */
  qbNeedRank: 18,
  qbDepthRank: 14,
  /** Package value = best + 0.85·second + 0.70·third. */
  pkgWeights: [1, 0.85, 0.7],
  /** Drop cost per player the receiving side must cut: that player's value, at least this. */
  minDropCost: 3,
  /** The side receiving the single best player in an uneven deal must give ≥ 110% of the other package. */
  consolidationPremium: 1.1,
  /** Fairness bands (partner's perceived edge). */
  fairBand: 0.05,
  slightBand: 0.12,
  /** Need model. */
  minMyDelta: 0.5,
  minMyTrueGain: 0.03,
  maxPartnerLoss: 0.03,
  partnerLineupFloor: -0.3,
  partnerFloorFairness: 1.05,
  bestPlayerLoss: 0.05,
  /** Partner targeting. */
  topPartners: 8,
  minTrades: 6,
  /** Edge tags. */
  edgeTag: 8,
  /** Acceptance: logistic(k · edgePct), +5% → 0.65. */
  accK: Math.log(0.65 / 0.35) / 5,
  extraPlayerMult: 0.85,
  loseTopMult: 0.8,
  fixesWorstMult: 1.1,
  accCap: 0.95,
  /** Ranking: min(myGain, partnerGain + margin) × P. */
  margin: 2,
  /** Score ÷ (1 + 2 × market overpay beyond +12%): the same gain at a fairer price ranks first. */
  overpayPenalty: 2,
  perPartner: 2,
  perGive: 2,
  limit: 10,
  clearDelta: 1.0,
  /** Main list only: the deal's best player must have market value ≥ this (else it is a smaller edge, not a headline trade). */
  minHeadliner: 8,
  minAcceptance: 0.4,
  nearMissLimit: 10,
  /** Search bounds. */
  poolSize: 14,
  comboCap: 4000,
  preFairLo: 0.75,
  preFairHi: 1.45,
} as const;

const r1 = (x: number) => Math.round(x * 10) / 10;
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

/** Partner-perspective fairness band: ratio = perceived received / perceived given by the partner. */
export function fairnessBand(ratio: number): { band: FairnessBand; label: string; pct: number } {
  const p = (ratio - 1) * 100;
  const a = Math.abs(ratio - 1);
  const signed = `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(0)}%`;
  if (a <= V3.fairBand + 1e-9) return { band: "fair", label: `Fair (${signed} to them)`, pct: r1(p) };
  const them = ratio > 1;
  if (a <= V3.slightBand + 1e-9) return { band: them ? "slightly-favors-them" : "slightly-favors-you", label: `Slightly favors ${them ? "them" : "you"} (${signed} to them)`, pct: r1(p) };
  return { band: them ? "favors-them" : "favors-you", label: `Favors ${them ? "them" : "you"} (${signed} to them)`, pct: r1(p) };
}

/** P(accept) before multipliers: logistic in the partner's perceived edge (percent). */
export function acceptCurve(edgePct: number): number {
  return 1 / (1 + Math.exp(-V3.accK * edgePct));
}

export interface AcceptFactors {
  /** Players I give beyond what I get (roster spots the partner must free). */
  extraGiven: number;
  losesTheirTop: boolean;
  fixesWorst: boolean;
}
export function acceptanceV3(edgePct: number, f: AcceptFactors): number {
  let p = acceptCurve(edgePct);
  p *= Math.pow(V3.extraPlayerMult, Math.max(0, f.extraGiven));
  if (f.losesTheirTop) p *= V3.loseTopMult;
  if (f.fixesWorst) p *= V3.fixesWorstMult;
  return Math.min(V3.accCap, p);
}

// ---------------------------------------------------------------- eligibility

/** Weeks from now to the final week in which the player has a game (bye excluded). */
function weeksLeft(p: ValuedPlayer, S: LeagueSettings): number {
  let n = 0;
  for (let w = S.currentWeek; w <= S.finalWeek; w++) if (p.bye !== w) n++;
  return n;
}

/** Why a player cannot be a trade piece (empty string when he can), QB rule aside. */
export function ineligibleReason(p: ValuedPlayer, S: LeagueSettings, irIds: Set<string> = new Set()): string {
  if (p.pos === "K" || p.pos === "DEF") return "K / DEF are streamed, not traded";
  if (marketOf(p) < V3.minPieceValue && p.value < V3.minPieceValue) return "waiver-level value";
  const k = injuryKind(p.injury);
  if (irIds.has(p.id) || k === "long") return "on IR / out long-term";
  if (!usable(p) || weeksLeft(p, S) - p.remainingGames >= V3.outWeeks - 1e-9 || k === "return") return `out ${V3.outWeeks}+ weeks`;
  return "";
}

/** QB rank for the QB rule: market position rank when market values exist (99 = outside the list). */
export function qbRank(p: ValuedPlayer): number {
  if (p.market !== undefined) return p.marketPosRank ?? 99;
  return p.posRank;
}

export function bestQbRank(roster: ValuedPlayer[]): number {
  let best = 99;
  for (const p of roster) if (p.pos === "QB" && usable(p)) best = Math.min(best, qbRank(p));
  return best;
}

/**
 * A team's second QB (the one it does not start: lower projected ppg) when its top two QBs both
 * rank ≤ qbDepthRank — the only QB it may trade.
 */
export function spareQb(roster: ValuedPlayer[]): ValuedPlayer | null {
  const qbs = roster.filter((p) => p.pos === "QB" && usable(p)).sort((a, b) => effPpg(b) - effPpg(a) || qbRank(a) - qbRank(b));
  return qbs.length >= 2 && qbRank(qbs[0]) <= V3.qbDepthRank && qbRank(qbs[1]) <= V3.qbDepthRank ? qbs[1] : null;
}

/** QB rule: `from` may send its spare QB to `to` only when `to`'s best QB ranks worse than qbNeedRank. */
export function qbTradeable(fromRoster: ValuedPlayer[], toRoster: ValuedPlayer[]): ValuedPlayer | null {
  if (bestQbRank(toRoster) <= V3.qbNeedRank) return null;
  return spareQb(fromRoster);
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

export interface TeamV3 extends State2 {
  analysis?: TeamAnalysis;
  pieces: ValuedPlayer[];
  deficit: Record<Group, number>;
  weakest: Weakest | null;
  /** Bench vorp at each skill position among eligible pieces (surplus). */
  surplus: Record<"RB" | "WR" | "TE", number>;
  surplusNames: Record<"RB" | "WR" | "TE", string[]>;
  topMarketId: string | null;
  starters: Set<string>;
  bad: boolean;
}

export function teamV3(ctx: TradeContext, teamId: string): TeamV3 {
  const S = ctx.league.settings;
  const s = state2(ctx, teamId);
  const analysis = ctx.teams.find((t) => t.team.id === teamId);
  const pieces = s.roster.filter((p) => p.pos !== "QB" && !ineligibleReason(p, S, s.irIds));
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
  return { ...s, analysis, pieces, deficit, weakest, surplus, surplusNames, topMarketId: top?.id ?? null, starters, bad };
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

export function partnerPitch(me: TeamV3, them: TeamV3): string {
  const bits: string[] = [];
  if (them.weakest && them.weakest.deficit > 0.02) bits.push(`${them.team.name}'s weakest spot is ${them.weakest.slot} (${GROUP_NAME[them.weakest.group]} ${Math.round(them.weakest.deficit * 100)}% below league average)`);
  const mySpare = (["RB", "WR", "TE"] as const).filter((p) => me.surplus[p] > 0.5).sort((a, b) => me.surplus[b] - me.surplus[a]);
  const theirSpare = (["RB", "WR", "TE"] as const).filter((p) => them.surplus[p] > 0.5).sort((a, b) => them.surplus[b] - them.surplus[a]);
  if (mySpare.length) bits.push(`you have spare ${mySpare[0]} depth (${me.surplusNames[mySpare[0]].slice(0, 2).join(", ")})`);
  if (theirSpare.length) bits.push(`they have spare ${theirSpare[0]} depth (${them.surplusNames[theirSpare[0]].slice(0, 2).join(", ")})`);
  if (me.weakest && me.weakest.deficit > 0.02) bits.push(`your weakest spot is ${me.weakest.slot}`);
  if (!bits.length) return `Little overlap between your needs and ${them.team.name}'s.`;
  const t = bits.join("; ");
  return `${t[0].toUpperCase()}${t.slice(1)}.`;
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
  /** Why my side fails (empty when myOk). */
  myFail: string;
  /** Why the partner would refuse (empty when partnerOk). */
  theirFail: string;
}

export function judge3(ctx: TradeContext, my: TeamV3, their: TeamV3, mode: TradeMode) {
  const S = ctx.league.settings;
  const repl = ctx.replacement;
  return (give: ValuedPlayer[], get: ValuedPlayer[]): Judged3 => {
    const myAfter: ValuedPlayer[] = [];
    for (const p of my.roster) if (!give.includes(p)) myAfter.push(p);
    for (const p of get) myAfter.push(riskAdjusted(p));
    const theirAfter: ValuedPlayer[] = [];
    for (const p of their.roster) if (!get.includes(p)) theirAfter.push(p);
    for (const p of give) theirAfter.push(p);
    const me = rosterParts(S, myAfter, repl, get.length > give.length ? { count: get.length - give.length, keep: (p) => my.irIds.has(p.id) || get.some((g) => g.id === p.id) } : undefined);
    const th = rosterParts(S, theirAfter, repl, give.length > get.length ? { count: give.length - get.length, keep: (p) => their.irIds.has(p.id) || give.includes(p) } : undefined);
    const myParts = partsDelta(me.parts, my.parts);
    const theirParts = partsDelta(th.parts, their.parts);
    const myDelta = combine(myParts, MODE_WEIGHTS[mode]);
    const theirLineup = theirParts.season;

    const marketGive = packageValue(give.map(marketOf));
    const marketGet = packageValue(get.map(marketOf));
    const trueGive = packageValue(give.map(trueOf));
    const trueGet = packageValue(get.map(trueOf));
    const theirDropP = give.length > get.length ? dropCost(th.drops.map(marketOf)) : 0;
    const myDropP = get.length > give.length ? dropCost(me.drops.map(marketOf)) : 0;
    const myDropT = get.length > give.length ? dropCost(me.drops.map(trueOf)) : 0;
    const theirRecvNet = marketGive - theirDropP;
    const fairness = theirRecvNet / Math.max(1, marketGet);
    const theirMarketChange = theirRecvNet - marketGet;
    const myTrueChange = trueGet - myDropT - trueGive;
    const marketTotal = marketGive + marketGet;
    const trueTotal = trueGive + trueGet;

    // Single best player in the deal (market, then true value).
    const all = [...give, ...get].sort((a, b) => marketOf(b) - marketOf(a) || trueOf(b) - trueOf(a));
    const bestToMe = get.includes(all[0]);
    // Consolidation premium: in any deal that is not 1-for-1, whoever receives the single best player
    // must give ≥ 110% of the other side's package (perceived, net of drop cost).
    let premiumOk = true;
    let premiumMine = false;
    if (give.length > 1 || get.length > 1) {
      if (bestToMe) premiumOk = theirRecvNet >= V3.consolidationPremium * marketGet;
      else {
        premiumOk = marketGet - myDropP >= V3.consolidationPremium * marketGive;
        premiumMine = true;
      }
    }

    let myFail = "";
    if (myDelta < V3.minMyDelta) myFail = `your team ${fmtSigned(myDelta)} (needs +${V3.minMyDelta.toFixed(1)})`;
    else if (premiumMine && !premiumOk) myFail = `you move the best player for a package worth less than ${pct(V3.consolidationPremium)} of him`;
    else if (myTrueChange < V3.minMyTrueGain * trueTotal) myFail = `you pay market price: true value ${fmtSigned(myTrueChange)} (needs +${(V3.minMyTrueGain * trueTotal).toFixed(1)}, 3% of the deal)`;

    let theirFail = "";
    if (!premiumMine && !premiumOk) theirFail = `consolidation premium: they give the best player, so your package must be worth ≥ ${pct(V3.consolidationPremium)} of theirs (it is ${pct(fairness)})`;
    else if (theirMarketChange < -V3.maxPartnerLoss * marketTotal) theirFail = `they lose ${Math.abs(theirMarketChange).toFixed(1)} market value (${pct(fairness)} of what they give)`;
    else if (bestToMe && theirMarketChange < -V3.bestPlayerLoss * marketGet) theirFail = `they give the best player and lose ${pct(-theirMarketChange / Math.max(1, marketGet))} market value`;
    else if (!(theirLineup > 0 || (theirLineup >= V3.partnerLineupFloor && fairness >= V3.partnerFloorFairness)))
      theirFail = `their weekly lineup ${fmtSigned(theirLineup)} pts${fairness >= V3.partnerFloorFairness ? "" : " without a value premium"}`;

    const losesTheirTop = get.some((p) => p.id === their.topMarketId);
    const w = their.weakest;
    const fixesWorst = !!w && theirLineup > 0 && give.some((p) => fitsGroup(w.group, p.pos) && effPpg(p) > effPpg(w.player));
    const acceptance = acceptanceV3((fairness - 1) * 100, { extraGiven: give.length - get.length, losesTheirTop, fixesWorst });
    // Ranking: min(my gain, their gain + margin) × P, discounted when I overpay by market beyond the "slightly" band.
    const overpay = Math.max(0, fairness - 1 - V3.slightBand);
    const score = (Math.min(myDelta, theirLineup + V3.margin) * acceptance) / (1 + V3.overpayPenalty * overpay);
    const edgeSum = get.reduce((a, p) => a + edgeOf(p), 0) - give.reduce((a, p) => a + edgeOf(p), 0);
    return {
      give, get, myParts, theirParts, myDrops: me.drops, theirDrops: th.drops, myDelta, theirLineup,
      marketGive, marketGet, trueGive, trueGet, fairness, theirMarketChange, myTrueChange, bestToMe, premiumOk,
      myOk: !myFail, partnerOk: !theirFail, acceptance, fixesWorst, losesTheirTop, score, edgeSum, myFail, theirFail,
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

function edgeTags(j: Judged3): string[] {
  const tags: string[] = [];
  for (const p of j.get) if (edgeOf(p) >= V3.edgeTag) tags.push(`buy-low: ${p.name} (+${edgeOf(p).toFixed(1)})`);
  for (const p of j.give) if (edgeOf(p) <= -V3.edgeTag) tags.push(`sell-high: ${p.name} (${fmtSigned(edgeOf(p))})`);
  return tags;
}

function byeNotes(S: LeagueSettings, j: Judged3, myAfter: LineupResult): string[] {
  const notes: string[] = [];
  const starters = myAfter.lineup.map((l) => l.player).filter((p): p is ValuedPlayer => !!p && p.pos !== "K" && p.pos !== "DEF");
  for (const p of j.get) {
    if (p.bye === undefined || p.bye < S.currentWeek) continue;
    const same = starters.filter((s) => s.id !== p.id && s.bye === p.bye);
    if (same.length >= 2) notes.push(`Bye overlap: ${p.name}'s week ${p.bye} bye lines up with ${same.map((s) => s.name).join(", ")}.`);
  }
  const po0 = S.regularSeasonEnd + 1;
  const inPO = (p: ValuedPlayer) => p.bye !== undefined && p.bye >= po0 && p.bye <= S.finalWeek;
  const poGet = j.get.filter(inPO);
  const poGive = j.give.filter(inPO);
  if (poGet.length) notes.push(`Playoffs: ${poGet.map((p) => `${p.name} is on bye in week ${p.bye}`).join("; ")}.`);
  if (poGive.length) notes.push(`Playoffs: you move ${poGive.map((p) => `${p.name}'s week ${p.bye} bye`).join(", ")}.`);
  if (!poGet.length && !poGive.length) notes.push(`No playoff-week (${po0}–${S.finalWeek}) byes involved; your playoff lineup ${fmtSigned(j.myParts.playoffs)} pts/week.`);
  return notes;
}

function tradePitch(j: Judged3, their: TeamV3): string {
  const w = their.weakest;
  const deal = `my ${names(j.give)} for your ${names(j.get)}`;
  const Deal = `${deal[0].toUpperCase()}${deal.slice(1)}`;
  const theirs = r1(j.theirLineup);
  const mine = r1(j.myParts.season);
  const gains = theirs > 0 ? `you gain ${fmtSigned(theirs)} pts/week in your lineup, I gain ${fmtSigned(mine)}` : `your lineup holds steady and I gain ${fmtSigned(mine)} pts/week`;
  if (w && j.fixesWorst) return `Your ${w.slot} slot is your weakest; ${deal} — ${gains}.`;
  if (j.fairness >= 1 + V3.fairBand) return `${Deal} — you win on value (+${Math.round((j.fairness - 1) * 100)}% by market) and ${gains}.`;
  return `${Deal} — fair by market value; ${gains}.`;
}

function buildTrade3(ctx: TradeContext, j: Judged3, my: TeamV3, their: TeamV3, mode: TradeMode): Trade {
  const S = ctx.league.settings;
  const { give, get } = j;
  const meAfter = applyTrade(S.slots, my.roster, give, get.map(riskAdjusted), my.irIds);
  const themAfter = applyTrade(S.slots, their.roster, get, give, their.irIds);
  const me = sideOf(my.team.id, give, my.base, meAfter, j.myParts, j.myDelta, j.marketGive);
  const them = sideOf(their.team.id, get, their.base, themAfter, j.theirParts, combine(j.theirParts, MODE_WEIGHTS.balanced), j.marketGet);
  const band = fairnessBand(j.fairness);
  const key = `${their.team.id}:${give.map((p) => p.id).sort().join(",")}>${get.map((p) => p.id).sort().join(",")}`;
  const p100 = Math.round(j.acceptance * 100);
  const tags: string[] = [...edgeTags(j)];
  if (j.fixesWorst && their.weakest) tags.push(`fixes their ${their.weakest.slot}`);
  if (give.length > get.length) tags.push("consolidation for them");
  if (get.length > give.length) tags.push("adds depth (you drop a bench player)");
  if (give.some((p) => p.pos === "QB") || get.some((p) => p.pos === "QB")) tags.push("spare starting QB");
  if (j.losesTheirTop) tags.push("asks for their best player");
  if (j.theirLineup > 0 && j.myParts.season > 0) tags.push("helps both");
  const summary = `Give ${names(give)} to ${their.team.name} for ${names(get)}: your team ${fmtSigned(j.myDelta)} (${mode}), their lineup ${fmtSigned(j.theirLineup)} pts/week; ${band.label}; ~${p100}% accept.`;
  const why =
    `Market package values (best + 0.85·2nd + 0.70·3rd): you give ${j.marketGive.toFixed(1)}, get ${j.marketGet.toFixed(1)}` +
    (them.drops?.length ? `; they must cut ${them.drops.map((p) => p.name).join(", ")} (drop cost counted)` : "") +
    (me.drops?.length ? `; you cut ${me.drops.map((p) => p.name).join(", ")}` : "") +
    `. Fairness to them ${j.fairness.toFixed(2)} (${band.label}). True value (our model): you give ${j.trueGive.toFixed(1)}, get ${j.trueGet.toFixed(1)} → ${fmtSigned(j.myTrueChange)}.` +
    ` Your roster score ${fmtSigned(j.myDelta)} (${mode}: now ${fmtSigned(j.myParts.now)}, season ${fmtSigned(j.myParts.season)}, playoffs ${fmtSigned(j.myParts.playoffs)}, depth ${fmtSigned(j.myParts.depth)}).` +
    (me.lineupChanges.length ? ` Your lineup: ${me.lineupChanges.join("; ")}.` : "") +
    ` ${their.team.name}: weekly lineup ${fmtSigned(j.theirLineup)} pts (our projections)` +
    (them.lineupChanges.length ? `; ${them.lineupChanges.join("; ")}` : "") +
    `. Acceptance ${p100}% = logistic(${((j.fairness - 1) * 100).toFixed(1)}% edge)` +
    (give.length > get.length ? ` × ${V3.extraPlayerMult}^${give.length - get.length} (extra players)` : "") +
    (j.losesTheirTop ? ` × ${V3.loseTopMult} (their best player)` : "") +
    (j.fixesWorst ? ` × ${V3.fixesWorstMult} (fixes their weakest slot)` : "") +
    `; score = min(your gain, their gain + ${V3.margin}) × acceptance${j.fairness > 1 + V3.slightBand ? " ÷ overpay penalty" : ""} = ${j.score.toFixed(2)}.`;
  return {
    key,
    me,
    them,
    fairness: r3(j.fairness),
    acceptance: r3(j.acceptance),
    score: r3(j.score),
    summary,
    tags,
    why,
    mode,
    band: band.band,
    bandLabel: band.label,
    fairnessPct: band.pct,
    pitch: tradePitch(j, their),
    notes: byeNotes(S, j, meAfter.lineup),
    packages: { marketGive: r1(j.marketGive), marketGet: r1(j.marketGet), trueGive: r1(j.trueGive), trueGet: r1(j.trueGet), myTrueChange: r1(j.myTrueChange), theirMarketChange: r1(j.theirMarketChange) },
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

function classify(j: Judged3): Cls | null {
  if (j.myOk && j.partnerOk) {
    if (j.acceptance < V3.minAcceptance) return "unlikely";
    const headliner = Math.max(...j.give.map(marketOf), ...j.get.map(marketOf));
    return j.myDelta >= V3.clearDelta && headliner >= V3.minHeadliner ? "clear" : "edge";
  }
  if (j.myOk && !j.partnerOk && j.fairness >= 0.85 && j.theirLineup >= -2) return "refuse";
  if (!j.myOk && j.partnerOk && j.myDelta > 0 && j.myTrueChange >= -0.05 * (j.trueGive + j.trueGet)) return "marginal";
  return null;
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
    return { trades: [], smallerEdges: [], nearMisses: [], mode, valueSource, partners: [], summary: `The trade deadline (week ${S.tradeDeadlineWeek}) has passed, so there are no trades to suggest.`, simulated: 0 };
  }
  const maxGive = Math.max(1, Math.min(3, opts.maxGive ?? 2));
  const maxGet = Math.max(1, Math.min(2, opts.maxGet ?? 2));
  const wantPos = opts.wantPos?.toUpperCase();
  const my = teamV3(ctx, myTeamId);
  const others = ctx.league.teams.filter((t) => t.id !== myTeamId && (!opts.partnerId || t.id === opts.partnerId)).map((t) => teamV3(ctx, t.id));
  const ranked = others
    .map((their) => ({ their, c: complementarity(my, their) }))
    .sort((a, b) => b.c - a.c || a.their.team.id.localeCompare(b.their.team.id));
  const partners = ranked.map((r) => ({ teamId: r.their.team.id, complementarity: r.c, pitch: partnerPitch(my, r.their) }));

  const cands: Cand[] = [];
  let simulated = 0;
  const search = (list: typeof ranked) => {
    for (const { their } of list) {
      const J = judge3(ctx, my, their, mode);
      for (const [give, get] of packagesFor(my, their, { maxGive, maxGet, wantPos })) {
        const j = J(give, get);
        simulated++;
        const cls = classify(j);
        if (cls) cands.push({ j, their, cls });
      }
    }
  };
  const first = opts.partnerId ? ranked : ranked.slice(0, V3.topPartners);
  search(first);
  const clearCount = () => new Set(cands.filter((c) => c.cls === "clear").map((c) => c.their.team.id + c.j.give.map((p) => p.id).join())).size;
  if (!opts.partnerId && clearCount() < V3.minTrades) search(ranked.slice(V3.topPartners));

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
    return { ...t, reason: reasonOf(c), tags: [...t.tags, c.cls === "marginal" ? "marginal" : "they'd likely refuse"] };
  });
  const summary = summarize(my, ranked.slice(0, 3).map((r) => r.their), trades, smallerEdges, valueSource, mode);
  return { trades, smallerEdges, nearMisses, mode, valueSource, partners, summary, simulated };
}

function summarize(my: TeamV3, best: TeamV3[], trades: Trade[], edges: Trade[], source: ValueSource, mode: TradeMode): string {
  const src = source === "fantasycalc" ? "Perceived values are FantasyCalc market values" : "Market values are unavailable, so perceived values fall back to our model (edges are not shown)";
  const n = trades.length;
  const first = n
    ? `${n} trade${n > 1 ? "s" : ""} another manager would plausibly accept in ${mode} mode${edges.length ? ` (+${edges.length} smaller edge${edges.length > 1 ? "s" : ""})` : ""}.`
    : `No ${mode} trade clears both sides' bars right now${edges.length ? ` (${edges.length} smaller edge${edges.length > 1 ? "s" : ""} below)` : ""}.`;
  const weak = my.weakest && my.weakest.deficit > 0.02 ? ` Your weakest spot: ${my.weakest.slot}.` : "";
  const fits = best.length ? ` Best fits: ${best.map((t) => t.team.name).join(", ")}.` : "";
  return `${first}${weak}${fits} ${src}.`;
}

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
  const notes: string[] = [];
  const qbOk = (p: ValuedPlayer, from: TeamV3, to: TeamV3) => p.pos !== "QB" || qbTradeable(from.roster, to.roster)?.id === p.id;
  const flagged = [
    ...give.map((p) => [p, ineligibleReason(p, S, my.irIds) || (qbOk(p, my, their) ? "" : "QB rule (only a spare top-14 QB, to a team whose best QB ranks worse than 18)")] as const),
    ...get.map((p) => [p, ineligibleReason(p, S, their.irIds) || (qbOk(p, their, my) ? "" : "QB rule (only a spare top-14 QB, to a team whose best QB ranks worse than 18)")] as const),
  ].filter(([, r]) => r);
  if (flagged.length) notes.push(`Outside the finder's rules: ${flagged.map(([p, r]) => `${p.name} (${r})`).join("; ")}.`);
  let verdict: string;
  if (j.myOk && j.partnerOk) verdict = j.acceptance >= 0.5 ? "Accept" : "Accept if they will";
  else if (j.myOk) verdict = `They won't accept (${j.theirFail})`;
  else if (j.myDelta >= 0 && j.partnerOk) verdict = "Fair, lean decline";
  else verdict = "Decline";
  notes.unshift(
    `Verdict "${verdict}": ${trade.bandLabel}, ~${Math.round(j.acceptance * 100)}% accept. You: ${j.myOk ? `team ${fmtSigned(j.myDelta)}, true value ${fmtSigned(j.myTrueChange)}` : j.myFail}.`,
  );
  if (tradeDeadlinePassed(ctx.league)) notes.push("The trade deadline has passed.");
  return { ...trade, why: `${notes.join(" ")} ${trade.why}`, verdict };
}

// ---------------------------------------------------------------- bench upgrade filter

/** v3 bench-upgrade rule: both players worth ≥ 3 (market or true) and my season lineup +0.8 pts/week. */
export const BENCH_MIN_SEASON = 0.8;
export function benchUpgradeOk(mine: ValuedPlayer, theirs: ValuedPlayer, mySeasonDelta: number): boolean {
  const worth = (p: ValuedPlayer) => marketOf(p) >= V3.minPieceValue || p.value >= V3.minPieceValue;
  return worth(mine) && worth(theirs) && mySeasonDelta >= BENCH_MIN_SEASON;
}

