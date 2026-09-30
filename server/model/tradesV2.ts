// Trade Finder v2: trades scored on the whole roster (this week, rest of season, playoffs,
// bench depth), near misses, a summary line, and bench upgrades. See docs/DESIGN.md "Trade finder v2".
import type { Team, TeamAnalysis, Trade, TradeFinderResult, TradeSide, ValuedPlayer } from "./types.js";
import { effPpg, eligible, type LineupResult } from "./lineup.js";
import {
  MAX_MY_VALUE_DROP,
  MAX_REPEAT,
  MIN_MY_DELTA,
  MIN_PIECE_VALUE,
  MIN_SCORE_DELTA,
  acceptanceOf,
  applyTrade,
  combos,
  corePlayers,
  fairnessOf,
  fmtSigned,
  lineupChanges,
  names,
  partnerRefusalReason,
  teamState,
  tradeDeadlinePassed,
  tradeable,
  verdictFor,
  type TradeContext,
  type TradeOptions,
} from "./trades.js";
import { INJURY_RISK, MODE_WEIGHTS, combine, partsDelta, riskAdjusted, riskStatus, rosterParts, type ScoreParts, type TradeMode } from "./rosterScore.js";

export interface TradeOptionsV2 extends TradeOptions {
  mode?: TradeMode;
  /** Max simulated (give, get) pairs per partner; closest-to-fair value packages first. */
  comboCap?: number;
  nearMissLimit?: number;
}

/** Config for the v2 finder (architect's Trade Finder v2 design + user-feedback rules A–F). */
export const V2 = {
  comboCap: 6000,
  /** Cheap value prune: raw fairness to them must reach this (near misses need < 0.85). */
  minRawFairness: 0.7,
  /** "They'd likely refuse" near misses must be this close to acceptable. */
  nearMissFairness: 0.7,
  nearMissThemDelta: -3,
  nearMissLimit: 10,
  nearMissPerClass: 5,
  /** Partner bench players below this value are not offered to me. */
  partnerBenchMinValue: 1,
  benchUpgradeLimit: 15,
  benchUpgradeFairness: 0.9,
  /** A: giving my #1/#2 most valuable player needs this team-score gain (nowDelta in "now" mode). */
  starMinDelta: 2.0,
  starCount: 2,
  /** A top-2 player only counts as a "star" at this value or more (a weak roster's #2 at 15 is not). */
  starMinValue: 20,
  /** A: receiving more players than I give (a roster spot plus a drop) raises my bar by this. */
  rosterSpotExtra: 0.5,
  /** B: a throw-in (value < MIN_PIECE_VALUE) must add this much to its receiver's score by himself. */
  throwInMinGain: 1.0,
  /** F: a received low-value player adds at most this much to the partner's team delta. */
  throwInCap: 1.0,
  /** D / E: minimum acceptance for the main list; "clear win" needs this team-score gain. */
  minAcceptance: 0.45,
  clearWinDelta: 1.0,
  /** F: asking for the partner's #1/#2 player needs this fairness and a non-negative team delta; acceptance × 0.8. */
  theirStarFairness: 1.05,
  theirStarAcceptance: 0.8,
} as const;

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const sum = (ps: ValuedPlayer[]) => ps.reduce((a, p) => a + p.value, 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;

export interface State2 {
  team: Team;
  roster: ValuedPlayer[];
  base: LineupResult;
  parts: ScoreParts;
  irIds: Set<string>;
  /** Ids of the team's #1 and #2 most valuable players. */
  stars: Set<string>;
  total: number;
}

export function state2(ctx: TradeContext, teamId: string): State2 {
  const s = teamState(ctx, teamId);
  const stars = new Set(
    [...s.roster]
      .sort((a, b) => b.value - a.value)
      .slice(0, V2.starCount)
      .filter((p) => p.value >= V2.starMinValue)
      .map((p) => p.id),
  );
  return { ...s, parts: rosterParts(ctx.league.settings, s.roster, ctx.replacement).parts, irIds: new Set(s.team.irPlayerIds ?? []), stars, total: sum(s.roster) };
}

interface FastSim {
  myParts: ScoreParts;
  theirParts: ScoreParts;
  myDelta: number;
  themDeltaRaw: number;
  myDrops: ValuedPlayer[];
  theirDrops: ValuedPlayer[];
  fairness: number;
  myFairness: number;
  myTotalAfter: number;
}

/** Everything the finder decides about one (give, get) package. */
export interface Judged {
  give: ValuedPlayer[];
  get: ValuedPlayer[];
  sim: FastSim;
  myDelta: number;
  /** Partner's balanced team delta, with low-value pieces capped (rule F). */
  themDelta: number;
  acceptance: number;
  star: boolean;
  theirStar: boolean;
  keep: boolean;
  /** My bar for this package (base or star, + roster-spot extra). */
  bar: number;
  partnerOk: boolean;
  refusal: string;
  valueOk: boolean;
  throwInOk: boolean;
  throwInTags: string[];
  clear: boolean;
}

/** Memoised fast simulator + rule checks for one (me, partner) pair. Exported for tests. */
export function judge(ctx: TradeContext, my: State2, their: State2, mode: TradeMode) {
  const S = ctx.league.settings;
  const repl = ctx.replacement;
  const memo = new Map<string, FastSim>();
  const sim = (give: ValuedPlayer[], get: ValuedPlayer[]): FastSim => {
    const key = `${give.map((p) => p.id).join(",")}>${get.map((p) => p.id).join(",")}`;
    const hit = memo.get(key);
    if (hit) return hit;
    // I see received players risk-adjusted (rule C); the partner sees healthy projections.
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
    const giveV = sum(give);
    const getV = sum(get);
    const iReceiveNet = getV - sum(me.drops);
    const out: FastSim = {
      myParts,
      theirParts,
      myDelta: combine(myParts, MODE_WEIGHTS[mode]),
      // The partner manager cares about his whole team: always judged in balanced mode.
      themDeltaRaw: combine(theirParts, MODE_WEIGHTS.balanced),
      myDrops: me.drops,
      theirDrops: th.drops,
      fairness: fairnessOf(giveV - sum(th.drops), getV),
      // Rule A: the bench player I must drop counts against what I receive.
      myFairness: fairnessOf(iReceiveNet, giveV),
      myTotalAfter: my.total - giveV + iReceiveNet,
    };
    memo.set(key, out);
    return out;
  };

  return (give: ValuedPlayer[], get: ValuedPlayer[]): Judged => {
    const s = sim(give, get);
    // Rules B + F: throw-ins must matter on their own; filler adds ≤ throwInCap to the partner's delta.
    let themDelta = s.themDeltaRaw;
    let throwInOk = true;
    const throwInTags: string[] = [];
    for (const p of give) {
      if (p.value >= MIN_PIECE_VALUE) continue;
      const without = sim(give.filter((x) => x !== p), get).themDeltaRaw;
      if (give.length >= 2) {
        if (s.themDeltaRaw - without < V2.throwInMinGain) throwInOk = false;
        else throwInTags.push(`throw-in: fills their ${p.pos} slot`);
      }
      themDelta = Math.min(themDelta, without + V2.throwInCap);
    }
    if (get.length >= 2) {
      for (const p of get) {
        if (p.value >= MIN_PIECE_VALUE) continue;
        const without = sim(give, get.filter((x) => x !== p)).myDelta;
        if (s.myDelta - without < V2.throwInMinGain) throwInOk = false;
        else throwInTags.push(`throw-in: fills your ${p.pos} slot`);
      }
    }
    const star = give.some((p) => my.stars.has(p.id));
    const extra = get.length > give.length ? V2.rosterSpotExtra : 0;
    const bar = (star ? V2.starMinDelta : MIN_SCORE_DELTA) + extra;
    const keep = star ? (mode === "now" ? s.myParts.now : s.myDelta) >= bar : s.myDelta >= bar || s.myParts.now >= MIN_MY_DELTA + extra;
    const theirStar = get.some((p) => their.stars.has(p.id));
    let refusal = partnerRefusalReason(s.fairness, themDelta, "team");
    if (!refusal && theirStar && !(s.fairness >= V2.theirStarFairness && themDelta >= 0)) {
      refusal = `you ask for their star, so they must win on value (fairness ${s.fairness.toFixed(2)}, needs ≥ ${V2.theirStarFairness}) and not lose ground (team ${fmtSigned(themDelta)})`;
    }
    const partnerOk = !refusal;
    const acceptance = acceptanceOf(s.fairness, themDelta) * (theirStar ? V2.theirStarAcceptance : 1);
    const valueOk = s.myTotalAfter >= (1 - MAX_MY_VALUE_DROP) * my.total;
    const clear = acceptance >= V2.minAcceptance && (s.myDelta >= V2.clearWinDelta || (mode === "now" && s.myParts.now >= V2.clearWinDelta));
    return { give, get, sim: s, myDelta: s.myDelta, themDelta, acceptance, star, theirStar, keep, bar, partnerOk, refusal, valueOk, throwInOk, throwInTags, clear };
  };
}

export type NearMissClass = "refuse" | "unlikely" | "marginal" | null;

/** Classify a package that did not make the main list (exported for tests). */
export function nearMissClass(
  j: Pick<Judged, "keep" | "valueOk" | "throwInOk" | "partnerOk" | "acceptance" | "myDelta" | "themDelta" | "star"> & { fairness: number; myFairness: number },
): NearMissClass {
  if (!j.valueOk || !j.throwInOk) return null;
  if (j.keep && !j.partnerOk && j.fairness >= V2.nearMissFairness && j.themDelta >= V2.nearMissThemDelta) return "refuse";
  if (j.keep && j.partnerOk && j.acceptance < V2.minAcceptance) return "unlikely";
  if (!j.keep && j.partnerOk && j.acceptance >= V2.minAcceptance && j.myDelta > 0 && (j.myFairness >= 1 || j.star)) return "marginal";
  return null;
}

const COMPONENT_LABEL: Record<keyof ScoreParts, string> = {
  now: "this week's lineup",
  season: "your weekly lineup over the rest of the season (byes and injuries included)",
  playoffs: "your playoff-week lineup",
  depth: "bench depth (top bench players above replacement)",
};

/** Weighted component that contributes most to my score delta. */
function driver(parts: ScoreParts, mode: TradeMode): keyof ScoreParts {
  const w = MODE_WEIGHTS[mode];
  const contrib: [keyof ScoreParts, number][] = [
    ["now", w.now * parts.now],
    ["season", w.season * parts.season],
    ["playoffs", w.playoffs * parts.playoffs],
    ["depth", w.depth * parts.depth],
  ];
  return contrib.sort((a, b) => b[1] - a[1])[0][0];
}

const deltasLine = (s: TradeSide) =>
  `Now ${fmtSigned(s.nowDelta ?? 0)}, Season ${fmtSigned(s.seasonDelta ?? 0)}, Playoffs ${fmtSigned(s.playoffDelta ?? 0)}, Depth ${fmtSigned(s.depthDelta ?? 0)}`;

function starterByes(ctx: TradeContext, lineup: LineupResult): Map<number, ValuedPlayer[]> {
  const S = ctx.league.settings;
  const out = new Map<number, ValuedPlayer[]>();
  for (const l of lineup.lineup) {
    const p = l.player;
    if (!p || p.bye === undefined || p.bye < S.currentWeek || p.bye > S.finalWeek || p.pos === "K" || p.pos === "DEF") continue;
    out.set(p.bye, [...(out.get(p.bye) ?? []), p]);
  }
  return out;
}

function tagsFor(ctx: TradeContext, j: Judged, myAnalysis: TeamAnalysis | undefined, myBase: LineupResult): string[] {
  const { give, get } = j;
  const d = j.sim.myParts;
  const tags: string[] = [];
  if (j.star) tags.push("moving a star");
  if (j.theirStar) tags.push("asks for their star");
  if (d.depth >= 1 && d.now < 0.75) tags.push("depth upgrade");
  if (d.playoffs >= 0.75 && d.playoffs > d.now + 0.25) tags.push("playoff cover");
  // Weekly lineups gain more than the average-rate lineup: the new player plays when a starter is off.
  const byeWeeks = [...starterByes(ctx, myBase).keys()];
  if (d.season >= 0.3 && d.season > d.now + 0.2 && get.some((p) => byeWeeks.some((w) => p.bye !== w))) tags.push("bye cover");
  if (give.length > get.length) tags.push("consolidation");
  const surplus = new Set(myAnalysis?.surplus ?? []);
  if (give.some((p) => surplus.has(p.pos))) tags.push("sells surplus");
  if (get.some((p) => p.games >= 2 && p.ppgExp26 - p.ppg26 >= 3)) tags.push("buy-low");
  const needs = new Set(myAnalysis?.needs ?? []);
  const needTags = new Set<string>();
  for (const p of get) {
    if (needs.has(p.pos)) needTags.add(`fills ${p.pos} need`);
    else if (needs.has("FLEX") && eligible("FLEX", p.pos)) needTags.add("fills FLEX need");
  }
  tags.push(...needTags);
  if (get.some((p) => riskStatus(p))) tags.push("injury risk");
  tags.push(...j.throwInTags);
  if (j.themDelta >= MIN_SCORE_DELTA) tags.push("helps both");
  return tags;
}

function side(teamId: string, gives: ValuedPlayer[], before: LineupResult, after: { lineup: LineupResult; drops: ValuedPlayer[] }, parts: ScoreParts, scoreDelta: number): TradeSide {
  return {
    teamId,
    gives,
    valueGiven: r1(sum(gives)),
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

function riskNote(get: ValuedPlayer[]): string {
  const adj = get.filter((p) => riskStatus(p));
  if (!adj.length) return "";
  return ` Risk-adjusted for ${adj.map((p) => `${p.injury!.status} (${p.name} ×${INJURY_RISK[riskStatus(p)!]})`).join(", ")}: your deltas use the haircut; the ppg shown is the healthy rate.`;
}

/** Turn a judged package into a Trade (exact lineups for the displayed lineup changes). */
function buildTrade2(ctx: TradeContext, j: Judged, my: State2, their: State2, myAnalysis: TeamAnalysis | undefined, mode: TradeMode): Trade {
  const S = ctx.league.settings;
  const { give, get, sim } = j;
  const meAfter = applyTrade(S.slots, my.roster, give, get.map(riskAdjusted), my.irIds);
  const themAfter = applyTrade(S.slots, their.roster, get, give, their.irIds);
  const me = side(my.team.id, give, my.base, meAfter, sim.myParts, j.myDelta);
  const them = side(their.team.id, get, their.base, themAfter, sim.theirParts, j.themDelta);
  const partner = their.team;
  const score = j.myDelta * j.acceptance;
  const key = `${partner.id}:${give.map((p) => p.id).sort().join(",")}>${get.map((p) => p.id).sort().join(",")}`;
  const p100 = Math.round(j.acceptance * 100);
  const drv = driver(sim.myParts, mode);
  const summary = `Give ${names(give)} to ${partner.name} for ${names(get)}: your team ${fmtSigned(j.myDelta)} (${mode}), theirs ${fmtSigned(j.themDelta)} (~${p100}% accept).`;
  const lead = `Driven by ${COMPONENT_LABEL[drv]} ${fmtSigned(sim.myParts[drv])} ppg (${deltasLine(me)}).`;
  const capped = j.themDelta < sim.themDeltaRaw - 0.05 ? ` (capped from ${fmtSigned(sim.themDeltaRaw)}: filler adds at most +${V2.throwInCap.toFixed(1)})` : "";
  const why =
    lead +
    (j.star ? ` Moves one of your top-${V2.starCount} players, so it must add ≥ ${j.bar.toFixed(1)}.` : "") +
    riskNote(get) +
    (me.lineupChanges.length ? ` Your lineup now: ${me.lineupChanges.join("; ")}.` : "") +
    ` ${partner.name}: team ${fmtSigned(j.themDelta)}${capped} in balanced terms (${deltasLine(them)})` +
    (them.lineupChanges.length ? `; ${them.lineupChanges.join("; ")}` : "") +
    `. They receive ${sum(give).toFixed(1)} value${them.drops?.length ? " (net of drops)" : ""} for ${sum(get).toFixed(1)} → fairness ${sim.fairness.toFixed(2)}.` +
    ` Acceptance ${p100}%${j.theirStar ? ` (×${V2.theirStarAcceptance} for asking for their star)` : ""}; score = your team Δ × acceptance = ${score.toFixed(2)}.`;
  return { key, me, them, fairness: r3(sim.fairness), acceptance: r3(j.acceptance), score: r3(score), summary, tags: tagsFor(ctx, j, myAnalysis, my.base), why, mode };
}

function coreKey(t: Trade) {
  return `${t.them.teamId}:${corePlayers(t.me.gives).map((p) => p.id).sort().join(",")}>${corePlayers(t.them.gives).map((p) => p.id).sort().join(",")}`;
}

/** Diversity: unique core keys; each core player ≤ maxRepeat times per side. */
function diversify(sorted: Trade[], limit: number, exclude = new Set<string>(), maxRepeat: number = MAX_REPEAT): Trade[] {
  const giveSeen = new Map<string, number>();
  const getSeen = new Map<string, number>();
  const picked: Trade[] = [];
  const seen = new Set(exclude);
  for (const t of sorted) {
    const ck = coreKey(t);
    if (seen.has(ck)) continue;
    const cg = corePlayers(t.me.gives);
    const ct = corePlayers(t.them.gives);
    if (cg.some((p) => (giveSeen.get(p.id) ?? 0) >= maxRepeat) || ct.some((p) => (getSeen.get(p.id) ?? 0) >= maxRepeat)) continue;
    seen.add(ck);
    for (const p of cg) giveSeen.set(p.id, (giveSeen.get(p.id) ?? 0) + 1);
    for (const p of ct) getSeen.set(p.id, (getSeen.get(p.id) ?? 0) + 1);
    picked.push(t);
    if (picked.length >= limit) break;
  }
  return picked;
}

export function nearMissReason(cls: Exclude<NearMissClass, null>, j: Judged): string {
  if (cls === "refuse") return `They'd likely refuse: ${j.refusal}.`;
  if (cls === "unlikely") return `Partner unlikely to accept (${pct(j.acceptance)}).`;
  if (j.star) return `Marginal: moves one of your top-${V2.starCount} players for only ${fmtSigned(j.myDelta)} (needs ${fmtSigned(j.bar)}).`;
  return `Marginal: your team ${fmtSigned(j.myDelta)} (bar is ${fmtSigned(j.bar)}, or +${MIN_MY_DELTA} this week), but you gain value (${j.sim.myFairness.toFixed(2)} in your favour).`;
}

interface Cand {
  j: Judged;
  their: State2;
  cls: "clear" | "edge" | Exclude<NearMissClass, null>;
}

export interface TradeFinderResultV2 extends TradeFinderResult {
  /** Packages simulated (performance reporting). */
  simulated: number;
}

/** Search every partner (or one) for trades that raise my roster score in `mode`. */
export function findTradesV2(ctx: TradeContext, myTeamId: string, opts: TradeOptionsV2 = {}): TradeFinderResultV2 {
  const mode = opts.mode ?? "balanced";
  const S = ctx.league.settings;
  if (tradeDeadlinePassed(ctx.league)) {
    return { trades: [], smallerEdges: [], nearMisses: [], mode, summary: `The trade deadline (week ${S.tradeDeadlineWeek}) has passed, so there are no trades to suggest.`, simulated: 0 };
  }
  const maxGive = Math.max(1, Math.min(3, opts.maxGive ?? 2));
  const maxGet = Math.max(1, Math.min(3, opts.maxGet ?? 2));
  // 3-for-1 / 1-for-3 only outside "now" mode, and only when the caller allows packages.
  const giveMax = mode !== "now" && maxGive >= 2 ? 3 : Math.min(2, maxGive);
  const getMax = mode !== "now" && maxGet >= 2 ? 3 : Math.min(2, maxGet);
  const poolSize = opts.poolSize ?? 14;
  const limit = opts.limit ?? 40;
  const cap = opts.comboCap ?? V2.comboCap;
  const wantPos = opts.wantPos?.toUpperCase();
  const my = state2(ctx, myTeamId);
  const myAnalysis = ctx.teams.find((t) => t.team.id === myTeamId);

  const pool = (s: State2, benchMin: number) => {
    const starters = new Set(s.base.lineup.map((l) => l.player?.id));
    const sorted = s.roster.filter(tradeable).sort((a, b) => b.value - a.value || b.ppg - a.ppg);
    const top = sorted.slice(0, poolSize);
    const ids = new Set(top.map((p) => p.id));
    for (const p of sorted) if (!ids.has(p.id) && !starters.has(p.id) && p.value >= benchMin) top.push(p);
    return top;
  };
  const withValue = (pk: ValuedPlayer[]) => ({ pk, v: sum(pk) });
  const myPkgs = [...combos(pool(my, -Infinity), giveMax)].map(withValue);

  const cands: Cand[] = [];
  let simulated = 0;
  for (const partner of ctx.league.teams) {
    if (partner.id === myTeamId) continue;
    if (opts.partnerId && partner.id !== opts.partnerId) continue;
    const their = state2(ctx, partner.id);
    const theirPkgs = [...combos(pool(their, V2.partnerBenchMinValue), getMax)].filter((pk) => !wantPos || pk.some((p) => p.pos === wantPos)).map(withValue);
    // Candidate pairs as (my package, their package) indexes + priority (closest to fair first).
    const pm: number[] = [];
    const pg: number[] = [];
    const prio: number[] = [];
    const minGive = (1 - MAX_MY_VALUE_DROP) * my.total - my.total;
    for (let gi = 0; gi < theirPkgs.length; gi++) {
      const g = theirPkgs[gi];
      const lenG = g.pk.length;
      for (let mi = 0; mi < myPkgs.length; mi++) {
        const m = myPkgs[mi];
        const lenM = m.pk.length;
        // 3-player packages only against a single player.
        if ((lenM === 3 && lenG !== 1) || (lenG === 3 && lenM !== 1)) continue;
        const raw = fairnessOf(m.v, g.v);
        if (raw < V2.minRawFairness || g.v - m.v < minGive) continue;
        pm.push(mi);
        pg.push(gi);
        prio.push(Math.abs(Math.log(raw)) + 0.05 * (lenM + lenG - 2));
      }
    }
    let order = Array.from(pm.keys());
    if (order.length > cap) {
      const pr = Float64Array.from(prio);
      order = order.sort((a, b) => pr[a] - pr[b]).slice(0, cap);
    }
    const J = judge(ctx, my, their, mode);
    for (const k of order) {
      const give = myPkgs[pm[k]].pk;
      const get = theirPkgs[pg[k]].pk;
      const j = J(give, get);
      simulated++;
      if (j.keep && j.valueOk && j.throwInOk && j.partnerOk && j.acceptance >= V2.minAcceptance) {
        cands.push({ j, their, cls: j.clear ? "clear" : "edge" });
        continue;
      }
      const cls = nearMissClass({ ...j, fairness: j.sim.fairness, myFairness: j.sim.myFairness });
      if (cls) cands.push({ j, their, cls });
    }
  }

  const build = (c: Cand) => buildTrade2(ctx, c.j, my, c.their, myAnalysis, mode);
  // Only the best few hundred per list are turned into Trade objects.
  const BUILD_MAX = 300;
  const scoreOf = (c: Cand) => c.j.myDelta * c.j.acceptance;
  const listOf = (cls: Cand["cls"]) =>
    cands
      .filter((c) => c.cls === cls)
      .sort((a, b) => scoreOf(b) - scoreOf(a))
      .slice(0, BUILD_MAX)
      .map(build)
      .sort((a, b) => b.score - a.score || b.acceptance - a.acceptance || a.key.localeCompare(b.key));
  const trades = diversify(listOf("clear"), limit);
  const smallerEdges = diversify(listOf("edge"), limit, new Set(trades.map(coreKey)));

  // Near misses: best for me first, ≤ nearMissPerClass per class, not duplicating a listed trade.
  const nmLimit = opts.nearMissLimit ?? V2.nearMissLimit;
  const nmTop = (cls: Cand["cls"]) =>
    cands
      .filter((c) => c.cls === cls)
      .sort((a, b) => b.j.myDelta - a.j.myDelta || scoreOf(b) - scoreOf(a))
      .slice(0, BUILD_MAX / 3);
  const tagOf: Record<string, string> = { refuse: "they'd likely refuse", unlikely: "they'd likely refuse", marginal: "marginal" };
  const nmSorted = [...nmTop("refuse"), ...nmTop("unlikely"), ...nmTop("marginal")]
    .sort((a, b) => b.j.myDelta - a.j.myDelta || scoreOf(b) - scoreOf(a))
    .map((c) => {
      const t = build(c);
      return { ...t, reason: nearMissReason(c.cls as Exclude<NearMissClass, null>, c.j), tags: [...t.tags, tagOf[c.cls]] };
    });
  const perClass = new Map<string, number>();
  const listed = new Set([...trades, ...smallerEdges].map(coreKey));
  const nearMisses = diversify(nmSorted, 1000, listed, 2)
    .filter((t) => {
      const k = t.reason!.split(" ")[0];
      const n = perClass.get(k) ?? 0;
      if (n >= V2.nearMissPerClass) return false;
      perClass.set(k, n + 1);
      return true;
    })
    .slice(0, nmLimit);

  return { trades, smallerEdges, nearMisses, mode, summary: summarize(ctx, my, myAnalysis, trades, smallerEdges, nearMisses, mode), simulated };
}

const MODE_NAME: Record<TradeMode, string> = { now: "Win-now", balanced: "Balanced", playoffs: "Playoffs" };

function summarize(ctx: TradeContext, my: State2, a: TeamAnalysis | undefined, trades: Trade[], edges: Trade[], nearMisses: Trade[], mode: TradeMode): string {
  const S = ctx.league.settings;
  const n = S.numTeams || ctx.league.teams.length;
  const strong = a ? ["QB", "RB", "WR", "TE"].filter((g) => a.groups[g] && a.groups[g].rank <= 3) : [];
  const weak = a ? ["QB", "RB", "WR", "TE", "FLEX"].filter((g) => a.groups[g] && a.groups[g].rank > n - Math.floor(n / 3)) : [];
  const basis = trades.length ? trades : edges.length ? edges : nearMisses;
  const drivers = new Map<keyof ScoreParts, number>();
  for (const t of basis) {
    const k = driver({ now: t.me.nowDelta ?? 0, season: t.me.seasonDelta ?? 0, playoffs: t.me.playoffDelta ?? 0, depth: t.me.depthDelta ?? 0 }, mode);
    drivers.set(k, (drivers.get(k) ?? 0) + 1);
  }
  const top = [...drivers].sort((x, y) => y[1] - x[1])[0]?.[0];
  const DRV: Record<keyof ScoreParts, string> = { now: "this week's lineup", season: "weekly cover for byes and injuries", playoffs: "playoff-week cover", depth: "bench depth" };
  const byes = [...starterByes(ctx, my.base)].sort((x, y) => y[1].length - x[1].length || x[0] - y[0]);
  const playoffByes = byes.filter(([w]) => w > S.regularSeasonEnd);
  const top3 = strong.length ? `your starters rank top-3 at ${strong.join("/")}` : "";
  const edgeNote = edges.length ? ` (+${edges.length} smaller edge${edges.length > 1 ? "s" : ""})` : "";
  const first = !trades.length
    ? `${top3 ? top3[0].toUpperCase() + top3.slice(1) + ", so no" : "No"} ${MODE_NAME[mode].toLowerCase()} trade is a clear win (+${V2.clearWinDelta.toFixed(1)} team score at ≥ ${pct(V2.minAcceptance)} acceptance)${edgeNote}.`
    : trades.length < 5
      ? `Only ${trades.length} clear win${trades.length > 1 ? "s" : ""} in ${MODE_NAME[mode]} mode${edgeNote}${top3 ? ` — ${top3}` : ""}.`
      : `${trades.length} clear wins in ${MODE_NAME[mode]} mode${edgeNote}${top3 ? `; ${top3}` : ""}.`;
  const hints: string[] = [];
  if (top) hints.push(`the best gains come from ${DRV[top]}`);
  if (weak.length) hints.push(`weakest spots: ${weak.join("/")}`);
  if (playoffByes.length) hints.push(`playoff cover needed for ${playoffByes.map(([w, ps]) => `${ps.map((p) => p.name).join(", ")}'s week ${w} bye`).join("; ")}`);
  else if (byes.length && byes[0][1].length >= 2) hints.push(`worst bye: week ${byes[0][0]} (${byes[0][1].map((p) => p.name).join(", ")})`);
  if (!trades.length && nearMisses.length) hints.push("see the near misses below");
  const second = hints.join("; ");
  return second ? `${first} ${second[0].toUpperCase()}${second.slice(1)}.` : first;
}

// ---------------------------------------------------------------- bench upgrades

function upgradeWhy(ctx: TradeContext, j: Judged, mine: ValuedPlayer, theirs: ValuedPlayer, myBase: LineupResult): string {
  const S = ctx.league.settings;
  const d = j.sim.myParts;
  const bits: string[] = [];
  if (theirs.ppg > mine.ppg + 0.2) bits.push(`${theirs.name} projects ${theirs.ppg.toFixed(1)} ppg rest of season vs ${mine.ppg.toFixed(1)} for ${mine.name}`);
  if (theirs.trend >= 1) bits.push(`${theirs.name}'s usage is trending up (${fmtSigned(theirs.trend)} expected pts/game over the last 2 weeks)`);
  if (theirs.games >= 2 && theirs.ppgExp26 - theirs.ppg26 >= 2) bits.push(`expected ${theirs.ppgExp26.toFixed(1)} > actual ${theirs.ppg26.toFixed(1)} ppg, due to bounce back`);
  if (mine.trend <= -1) bits.push(`${mine.name}'s usage is fading (${fmtSigned(mine.trend)})`);
  const inPO = (p: ValuedPlayer) => p.bye !== undefined && p.bye > S.regularSeasonEnd && p.bye <= S.finalWeek;
  if (inPO(mine) && !inPO(theirs)) bits.push(`${mine.name} has a playoff bye (week ${mine.bye})`);
  if (d.season > 0.05) {
    const covered = [...starterByes(ctx, myBase)]
      .filter(([w, ps]) => theirs.bye !== w && ps.some((p) => (eligible("FLEX", p.pos) ? eligible("FLEX", theirs.pos) : p.pos === theirs.pos)))
      .map(([w]) => w)
      .sort((x, y) => x - y);
    if (covered.length) bits.push(`can start in week${covered.length > 1 ? "s" : ""} ${covered.join(", ")} when your starters are on bye`);
  }
  if (mine.injury && !theirs.injury) bits.push(`${mine.name} is ${mine.injury.status}`);
  const nums = `Season ${fmtSigned(d.season)}, Playoffs ${fmtSigned(d.playoffs)}, Depth ${fmtSigned(d.depth)}; fairness to them ${j.sim.fairness.toFixed(2)}`;
  const text = bits.length ? bits.join("; ") : "a small depth gain";
  return `${text[0].toUpperCase()}${text.slice(1)} (${nums}).`;
}

/**
 * Bench upgrades: 1-for-1 swaps of one of my bench players (or my lowest skill
 * starter) for a partner's bench player where my season or playoff score rises.
 */
export function findBenchUpgrades(
  ctx: TradeContext,
  myTeamId: string,
  opts: { mode?: TradeMode; limit?: number; partnerId?: string; accept?: (mine: ValuedPlayer, theirs: ValuedPlayer, j: Judged, partnerId: string) => boolean } = {},
): Trade[] {
  const mode = opts.mode ?? "balanced";
  if (tradeDeadlinePassed(ctx.league)) return [];
  const my = state2(ctx, myTeamId);
  const myAnalysis = ctx.teams.find((t) => t.team.id === myTeamId);
  const startersOf = (s: State2) => new Set(s.base.lineup.map((l) => l.player?.id).filter(Boolean) as string[]);
  const myStarters = startersOf(my);
  const lowStarter = my.base.lineup
    .map((l) => l.player)
    .filter((p): p is ValuedPlayer => !!p && tradeable(p))
    .sort((a, b) => effPpg(a) - effPpg(b))[0];
  const mine = my.roster.filter((p) => tradeable(p) && !my.stars.has(p.id) && (!myStarters.has(p.id) || p.id === lowStarter?.id));
  const scored: { j: Judged; their: State2; m: ValuedPlayer; g: ValuedPlayer }[] = [];
  for (const partner of ctx.league.teams) {
    if (partner.id === myTeamId || (opts.partnerId && partner.id !== opts.partnerId)) continue;
    const their = state2(ctx, partner.id);
    const theirStarters = startersOf(their);
    const theirBench = their.roster.filter((p) => tradeable(p) && !theirStarters.has(p.id) && p.ppg > 0);
    const J = judge(ctx, my, their, mode);
    for (const g of theirBench) {
      for (const m of mine) {
        if (fairnessOf(m.value, g.value) < V2.benchUpgradeFairness) continue;
        const j = J([m], [g]);
        if (j.sim.fairness < V2.benchUpgradeFairness || !j.valueOk) continue;
        if (!(j.sim.myParts.season > 0.05 || j.sim.myParts.playoffs > 0.05)) continue;
        if (j.myDelta <= 0.05) continue;
        if (opts.accept && !opts.accept(m, g, j, partner.id)) continue;
        scored.push({ j, their, m, g });
      }
    }
  }
  scored.sort((a, b) => b.j.myDelta - a.j.myDelta || b.j.acceptance - a.j.acceptance);
  // Each target once; each of my players at most twice.
  const gotSeen = new Set<string>();
  const gaveSeen = new Map<string, number>();
  const picked: Trade[] = [];
  for (const { j, their, m, g } of scored) {
    if (gotSeen.has(g.id) || (gaveSeen.get(m.id) ?? 0) >= 2) continue;
    gotSeen.add(g.id);
    gaveSeen.set(m.id, (gaveSeen.get(m.id) ?? 0) + 1);
    const t = buildTrade2(ctx, j, my, their, myAnalysis, mode);
    t.why = `${upgradeWhy(ctx, j, m, g, my.base)} ${t.why}`;
    if (!t.tags.includes("depth upgrade") && j.sim.myParts.depth > 0.05) t.tags.unshift("depth upgrade");
    picked.push(t);
    if (picked.length >= (opts.limit ?? V2.benchUpgradeLimit)) break;
  }
  return picked;
}

// ---------------------------------------------------------------- evaluate

/** Evaluate one proposal with v2 roster scores and rules (verdict counts this-week or roster-score gains). */
export function evaluateTradeV2(ctx: TradeContext, myTeamId: string, partnerId: string, giveIds: string[], getIds: string[], mode: TradeMode = "balanced"): Trade & { verdict: string } {
  const my = state2(ctx, myTeamId);
  const their = state2(ctx, partnerId);
  const pick = (ids: string[], roster: ValuedPlayer[], who: string) =>
    [...new Set(ids)].map((id) => {
      const p = roster.find((r) => r.id === id);
      if (!p) throw Object.assign(new Error(`Player ${id} is not on ${who}'s roster`), { status: 400 });
      return p;
    });
  const give = pick(giveIds, my.roster, my.team.name);
  const get = pick(getIds, their.roster, their.team.name);
  if (!give.length && !get.length) throw Object.assign(new Error("Trade must include at least one player"), { status: 400 });
  const j = judge(ctx, my, their, mode)(give, get);
  const trade = buildTrade2(ctx, j, my, their, ctx.teams.find((t) => t.team.id === myTeamId), mode);
  const valueDrop = my.total > 0 ? 1 - j.sim.myTotalAfter / my.total : 0;
  const refusal = j.refusal || (j.acceptance < V2.minAcceptance ? `partner unlikely to accept (${pct(j.acceptance)})` : "");
  let verdict = verdictFor(trade.me.lineupDelta, j.sim.myFairness, valueDrop, refusal, j.myDelta);
  if (verdict === "Accept" && (!j.keep || !j.throwInOk)) verdict = "Fair, lean accept";
  const notes: string[] = [
    `Verdict "${verdict}": your team ${fmtSigned(j.myDelta)} (${mode}; lineup this week ${fmtSigned(trade.me.lineupDelta)} ppg), value to you ${j.sim.myFairness.toFixed(2)} (what you get net of drops vs give, +5 cushion).`,
  ];
  if (j.star && !j.keep) notes.push(`You give one of your top-${V2.starCount} players: worth it only for ${fmtSigned(j.bar)} or more.`);
  if (!j.throwInOk) notes.push("A low-value piece does not matter to whoever receives him; leave him out.");
  if (valueDrop > MAX_MY_VALUE_DROP) notes.push(`Warning: your total roster value falls ${Math.round(valueDrop * 100)}%.`);
  if (refusal) notes.push(`${their.team.name} is unlikely to accept: ${refusal}.`);
  if (tradeDeadlinePassed(ctx.league)) notes.push("The trade deadline has passed.");
  return { ...trade, why: `${notes.join(" ")} ${trade.why}`, verdict };
}
