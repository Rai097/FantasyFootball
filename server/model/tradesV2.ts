// Trade Finder v2: trades scored on the whole roster (this week, rest of season, playoffs,
// bench depth), near misses, a summary line, and bench upgrades. See docs/DESIGN.md "Trade finder v2".
import type { Team, TeamAnalysis, Trade, TradeFinderResult, TradeSide, ValuedPlayer } from "./types.js";
import { effPpg, eligible, type LineupResult } from "./lineup.js";
import {
  MAX_MY_VALUE_DROP,
  MAX_REPEAT,
  MIN_MY_DELTA,
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
  partnerWouldConsider,
  piecesJustified,
  teamState,
  tradeDeadlinePassed,
  tradeable,
  verdictFor,
  type TradeContext,
  type TradeOptions,
} from "./trades.js";
import { MODE_WEIGHTS, combine, partsDelta, rosterScore, type RosterScore, type ScoreParts, type TradeMode } from "./rosterScore.js";

export interface TradeOptionsV2 extends TradeOptions {
  mode?: TradeMode;
  /** Max simulated (give, get) pairs per partner; closest-to-fair value packages first. */
  comboCap?: number;
  nearMissLimit?: number;
}

/** Config for the v2 finder (architect's Trade Finder v2 design). */
export const V2 = {
  comboCap: 6000,
  /** Cheap value prune: raw fairness to them must reach this (near misses need < 0.85). */
  minRawFairness: 0.7,
  /** "They'd likely refuse" near misses must be this close to acceptable. */
  nearMissFairness: 0.7,
  nearMissThemDelta: -3,
  nearMissLimit: 10,
  nearMissPerClass: 7,
  /** Partner bench players below this value are not offered to me. */
  partnerBenchMinValue: 1,
  benchUpgradeLimit: 15,
  benchUpgradeFairness: 0.9,
} as const;

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const sum = (ps: ValuedPlayer[]) => ps.reduce((a, p) => a + p.value, 0);

interface State2 {
  team: Team;
  roster: ValuedPlayer[];
  base: LineupResult;
  score: RosterScore;
  irIds: Set<string>;
}

function state2(ctx: TradeContext, teamId: string): State2 {
  const s = teamState(ctx, teamId);
  return { ...s, score: rosterScore(ctx.league.settings, s.roster, ctx.replacement, s.base), irIds: new Set(s.team.irPlayerIds ?? []) };
}

interface Sim2 {
  give: ValuedPlayer[];
  get: ValuedPlayer[];
  me: TradeSide;
  them: TradeSide;
  myParts: ScoreParts;
  theirParts: ScoreParts;
  myDelta: number;
  themDelta: number;
  fairness: number;
  myFairness: number;
  myTotalBefore: number;
  myTotalAfter: number;
  myLineupAfter: LineupResult;
  theirLineupAfter: LineupResult;
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

function simulate2(ctx: TradeContext, my: State2, their: State2, give: ValuedPlayer[], get: ValuedPlayer[], mode: TradeMode): Sim2 {
  const S = ctx.league.settings;
  const meAfter = applyTrade(S.slots, my.roster, give, get, my.irIds);
  const themAfter = applyTrade(S.slots, their.roster, get, give, their.irIds);
  const myParts = partsDelta(rosterScore(S, meAfter.roster, ctx.replacement, meAfter.lineup), my.score);
  const theirParts = partsDelta(rosterScore(S, themAfter.roster, ctx.replacement, themAfter.lineup), their.score);
  const myDelta = combine(myParts, MODE_WEIGHTS[mode]);
  // The partner manager cares about his whole team: always judged in balanced mode.
  const themDelta = combine(theirParts, MODE_WEIGHTS.balanced);
  const giveV = sum(give);
  const getV = sum(get);
  const myTotalBefore = sum(my.roster);
  const iReceiveNet = getV - sum(meAfter.drops);
  return {
    give,
    get,
    me: side(my.team.id, give, my.base, meAfter, myParts, myDelta),
    them: side(their.team.id, get, their.base, themAfter, theirParts, themDelta),
    myParts,
    theirParts,
    myDelta,
    themDelta,
    fairness: fairnessOf(giveV - sum(themAfter.drops), getV),
    myFairness: fairnessOf(iReceiveNet, giveV),
    myTotalBefore,
    myTotalAfter: myTotalBefore - giveV + iReceiveNet,
    myLineupAfter: meAfter.lineup,
    theirLineupAfter: themAfter.lineup,
  };
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

function tagsFor(ctx: TradeContext, sim: Sim2, myAnalysis: TeamAnalysis | undefined, myBase: LineupResult): string[] {
  const S = ctx.league.settings;
  const { give, get, myParts: d } = sim;
  const tags: string[] = [];
  if (d.depth >= 1 && d.now < 0.75) tags.push("depth upgrade");
  if (d.playoffs >= 0.75 && d.playoffs > d.now + 0.25) tags.push("playoff cover");
  // Weekly lineups gain more than the average-rate lineup: the new player plays when a starter is off.
  if (d.season >= 0.3 && d.season > d.now + 0.2 && get.some((p) => [...starterByes(ctx, myBase).keys()].some((w) => p.bye !== w))) tags.push("bye cover");
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
  if (get.some((p) => p.injury && /^(Q|D|O|Questionable|Doubtful|Out)$/i.test(p.injury.status))) tags.push("injury-discount");
  if (sim.themDelta >= MIN_SCORE_DELTA) tags.push("helps both");
  void S;
  return tags;
}

function buildTrade2(ctx: TradeContext, sim: Sim2, myAnalysis: TeamAnalysis | undefined, myBase: LineupResult, partner: Team, mode: TradeMode): Trade {
  const acceptance = acceptanceOf(sim.fairness, sim.themDelta);
  const score = sim.myDelta * acceptance;
  const { give, get } = sim;
  const key = `${partner.id}:${give.map((p) => p.id).sort().join(",")}>${get.map((p) => p.id).sort().join(",")}`;
  const pct = Math.round(acceptance * 100);
  const drv = driver(sim.myParts, mode);
  const drvDelta = sim.myParts[drv];
  const summary =
    `Give ${names(give)} to ${partner.name} for ${names(get)}: your team ${fmtSigned(sim.myDelta)} (${mode}), ` +
    `theirs ${fmtSigned(sim.themDelta)} (~${pct}% accept).`;
  const lead = `Driven by ${COMPONENT_LABEL[drv]} ${fmtSigned(drvDelta)} ppg (${deltasLine(sim.me)}).`;
  const why =
    `${lead} ` +
    (sim.me.lineupChanges.length ? `Your lineup now: ${sim.me.lineupChanges.join("; ")}. ` : "") +
    `${partner.name}: team ${fmtSigned(sim.themDelta)} in balanced terms (${deltasLine(sim.them)})` +
    (sim.them.lineupChanges.length ? `; ${sim.them.lineupChanges.join("; ")}` : "") +
    `. They receive ${sum(give).toFixed(1)} value${sim.them.drops?.length ? " (net of drops)" : ""} for ${sum(get).toFixed(1)} → fairness ${sim.fairness.toFixed(2)}.` +
    ` Acceptance ${pct}%; score = your team Δ × acceptance = ${score.toFixed(2)}.`;
  return {
    key,
    me: sim.me,
    them: sim.them,
    fairness: r3(sim.fairness),
    acceptance: r3(acceptance),
    score: r3(score),
    summary,
    tags: tagsFor(ctx, sim, myAnalysis, myBase),
    why,
    mode,
  };
}

const myKeep = (s: Sim2) => s.myDelta >= MIN_SCORE_DELTA || s.myParts.now >= MIN_MY_DELTA;
const valueOk = (s: Sim2) => s.myTotalAfter >= (1 - MAX_MY_VALUE_DROP) * s.myTotalBefore;
const piecesOk = (s: Sim2) =>
  (s.give.length === 1 && s.get.length === 1) || (piecesJustified(s.get, s.myLineupAfter) && piecesJustified(s.give, s.theirLineupAfter));

export type NearMissClass = "refuse" | "marginal" | null;

/** Classify a simulated trade that did not make the main list (exported for tests). */
export function nearMissClass(x: { myKeep: boolean; valueOk: boolean; piecesOk: boolean; partnerOk: boolean; myDelta: number; myFairness: number; fairness: number; themDelta: number }): NearMissClass {
  if (!x.valueOk || !x.piecesOk) return null;
  if (x.myKeep && !x.partnerOk && x.fairness >= V2.nearMissFairness && x.themDelta >= V2.nearMissThemDelta) return "refuse";
  if (!x.myKeep && x.partnerOk && x.myDelta > 0 && x.myFairness >= 1) return "marginal";
  return null;
}

interface Cand {
  sim: Sim2;
  partner: Team;
  cls: "trade" | "refuse" | "marginal";
}

function coreKey(t: Trade) {
  return `${t.them.teamId}:${corePlayers(t.me.gives).map((p) => p.id).sort().join(",")}>${corePlayers(t.them.gives).map((p) => p.id).sort().join(",")}`;
}

/** Diversity: unique core keys; each core player ≤ MAX_REPEAT times per side. */
function diversify(sorted: Trade[], limit: number, exclude = new Set<string>(), maxRepeat = MAX_REPEAT): Trade[] {
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

function refuseReason(sim: Sim2): string {
  return `They'd likely refuse: ${partnerRefusalReason(sim.fairness, sim.themDelta, "team")}.`;
}
function marginalReason(sim: Sim2): string {
  return `Marginal: your team ${fmtSigned(sim.myDelta)} (bar is +${MIN_SCORE_DELTA.toFixed(1)}, or +${MIN_MY_DELTA} this week), but you gain value (${sim.myFairness.toFixed(2)} in your favour).`;
}

/** Search every partner (or one) for trades that raise my roster score in `mode`. */
export function findTradesV2(ctx: TradeContext, myTeamId: string, opts: TradeOptionsV2 = {}): TradeFinderResult {
  const mode = opts.mode ?? "balanced";
  const S = ctx.league.settings;
  if (tradeDeadlinePassed(ctx.league)) {
    return { trades: [], nearMisses: [], mode, summary: `The trade deadline (week ${S.tradeDeadlineWeek}) has passed, so there are no trades to suggest.` };
  }
  const maxGive = Math.max(1, Math.min(3, opts.maxGive ?? 2));
  const maxGet = Math.max(1, Math.min(3, opts.maxGet ?? 2));
  // 3-for-1 / 1-for-3 only outside "now" mode, and only when the caller allows packages.
  const giveMax = mode !== "now" && maxGive >= 2 && maxGet >= 1 ? 3 : Math.min(2, maxGive);
  const getMax = mode !== "now" && maxGet >= 2 && maxGive >= 1 ? 3 : Math.min(2, maxGet);
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
  const myPkgs = [...combos(pool(my, -Infinity), Math.max(giveMax, 1))].filter((pk) => pk.length <= maxGive || (pk.length === 3 && giveMax === 3)).map(withValue);
  const myTotal = sum(my.roster);

  const cands: Cand[] = [];
  for (const partner of ctx.league.teams) {
    if (partner.id === myTeamId) continue;
    if (opts.partnerId && partner.id !== opts.partnerId) continue;
    const their = state2(ctx, partner.id);
    const theirPkgs = [...combos(pool(their, V2.partnerBenchMinValue), getMax)]
      .filter((pk) => pk.length <= maxGet || (pk.length === 3 && getMax === 3))
      .filter((pk) => !wantPos || pk.some((p) => p.pos === wantPos))
      .map(withValue);
    const pairs: { give: ValuedPlayer[]; get: ValuedPlayer[]; prio: number }[] = [];
    for (const g of theirPkgs) {
      for (const m of myPkgs) {
        // 3-player packages only against a single player.
        if ((m.pk.length === 3 && g.pk.length !== 1) || (g.pk.length === 3 && m.pk.length !== 1)) continue;
        const raw = fairnessOf(m.v, g.v);
        if (raw < V2.minRawFairness) continue;
        if (myTotal - m.v + g.v < (1 - MAX_MY_VALUE_DROP) * myTotal) continue;
        pairs.push({ give: m.pk, get: g.pk, prio: Math.abs(Math.log(raw)) + 0.05 * (m.pk.length + g.pk.length - 2) });
      }
    }
    if (pairs.length > cap) pairs.sort((a, b) => a.prio - b.prio).length = cap;
    for (const { give, get } of pairs) {
      const sim = simulate2(ctx, my, their, give, get, mode);
      const partnerOk = partnerWouldConsider(sim.fairness, sim.themDelta);
      const keep = myKeep(sim);
      const vOk = valueOk(sim);
      const pOk = piecesOk(sim);
      if (keep && vOk && pOk && partnerOk) {
        cands.push({ sim, partner, cls: "trade" });
        continue;
      }
      const cls = nearMissClass({ myKeep: keep, valueOk: vOk, piecesOk: pOk, partnerOk, myDelta: sim.myDelta, myFairness: sim.myFairness, fairness: sim.fairness, themDelta: sim.themDelta });
      if (cls) cands.push({ sim, partner, cls });
    }
  }

  const build = (c: Cand) => buildTrade2(ctx, c.sim, myAnalysis, my.base, c.partner, mode);
  // Only the best few hundred per list are turned into Trade objects.
  const BUILD_MAX = 400;
  const scoreOf = (c: Cand) => c.sim.myDelta * acceptanceOf(c.sim.fairness, c.sim.themDelta);
  const tradeList = cands
    .filter((c) => c.cls === "trade")
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, BUILD_MAX)
    .map(build)
    .sort((a, b) => b.score - a.score || b.acceptance - a.acceptance || a.key.localeCompare(b.key));
  const trades = diversify(tradeList, limit);

  // Near misses: best for me first, ≤ nearMissPerClass per class, not duplicating a listed trade.
  const nmLimit = opts.nearMissLimit ?? V2.nearMissLimit;
  const nmTop = (cls: Cand["cls"]) =>
    cands
      .filter((c) => c.cls === cls)
      .sort((a, b) => b.sim.myDelta - a.sim.myDelta || scoreOf(b) - scoreOf(a))
      .slice(0, BUILD_MAX / 2);
  const nmSorted = [...nmTop("refuse"), ...nmTop("marginal")]
    .sort((a, b) => b.sim.myDelta - a.sim.myDelta || scoreOf(b) - scoreOf(a))
    .map((c) => {
      const t = build(c);
      return { ...t, reason: c.cls === "refuse" ? refuseReason(c.sim) : marginalReason(c.sim), tags: [...t.tags, c.cls === "refuse" ? "they'd likely refuse" : "marginal"] };
    });
  const perClass = new Map<string, number>();
  const nearMisses = diversify(nmSorted, 1000, new Set(trades.map(coreKey)), 2)
    .filter((t) => {
      const k = t.tags.includes("marginal") ? "marginal" : "refuse";
      const n = perClass.get(k) ?? 0;
      if (n >= V2.nearMissPerClass) return false;
      perClass.set(k, n + 1);
      return true;
    })
    .slice(0, nmLimit);

  return { trades, nearMisses, mode, summary: summarize(ctx, my, myAnalysis, trades, nearMisses, mode) };
}

const MODE_NAME: Record<TradeMode, string> = { now: "Win-now", balanced: "Balanced", playoffs: "Playoffs" };

function summarize(ctx: TradeContext, my: State2, a: TeamAnalysis | undefined, trades: Trade[], nearMisses: Trade[], mode: TradeMode): string {
  const S = ctx.league.settings;
  const n = S.numTeams || ctx.league.teams.length;
  const parts: string[] = [];
  const strong = a ? ["QB", "RB", "WR", "TE"].filter((g) => a.groups[g] && a.groups[g].rank <= 3) : [];
  const weak = a ? ["QB", "RB", "WR", "TE", "FLEX"].filter((g) => a.groups[g] && a.groups[g].rank > n - Math.floor(n / 3)) : [];
  // Where do the gains come from?
  const drivers = new Map<string, number>();
  for (const t of trades.length ? trades : nearMisses) {
    const d = { now: t.me.nowDelta ?? 0, season: t.me.seasonDelta ?? 0, playoffs: t.me.playoffDelta ?? 0, depth: t.me.depthDelta ?? 0 };
    const k = driver(d, mode);
    drivers.set(k, (drivers.get(k) ?? 0) + 1);
  }
  const top = [...drivers].sort((x, y) => y[1] - x[1])[0]?.[0] as keyof ScoreParts | undefined;
  const DRV: Record<keyof ScoreParts, string> = { now: "this week's lineup", season: "weekly cover for byes and injuries", playoffs: "playoff-week cover", depth: "bench depth" };
  // Bye pain among my starters in the remaining weeks (worst week).
  const byes = [...starterByes(ctx, my.base)].sort((x, y) => y[1].length - x[1].length || x[0] - y[0]);
  const byeNote = byes.length ? `week ${byes[0][0]} (${byes[0][1].map((p) => p.name).join(", ")} on bye)` : "";
  const playoffByes = byes.filter(([w]) => w > S.regularSeasonEnd);

  if (trades.length === 0) {
    parts.push(
      strong.length
        ? `Your starters rank top-3 at ${strong.join("/")}, so no ${MODE_NAME[mode].toLowerCase()} trade clears the bar (+${MIN_SCORE_DELTA} team score or +${MIN_MY_DELTA} ppg this week) while staying fair to the other side.`
        : `No ${MODE_NAME[mode].toLowerCase()} trade clears the bar (+${MIN_SCORE_DELTA} team score or +${MIN_MY_DELTA} ppg this week) while staying fair to the other side.`,
    );
  } else if (trades.length < 5) {
    parts.push(`Only ${trades.length} trade${trades.length > 1 ? "s" : ""} clear${trades.length > 1 ? "" : "s"} the bar in ${MODE_NAME[mode]} mode${strong.length ? ` — your starters already rank top-3 at ${strong.join("/")}` : ""}.`);
  } else {
    parts.push(`${trades.length} trades found in ${MODE_NAME[mode]} mode${strong.length ? `; your starters rank top-3 at ${strong.join("/")}` : ""}.`);
  }
  const hints: string[] = [];
  if (top) hints.push(`the best gains come from ${DRV[top]}`);
  if (weak.length) hints.push(`weakest spots: ${weak.join("/")}`);
  if (playoffByes.length) hints.push(`playoff cover needed for ${playoffByes.map(([w, ps]) => `${ps.map((p) => p.name).join(", ")}'s week ${w} bye`).join("; ")}`);
  else if (byeNote && (top === "season" || trades.length < 5)) hints.push(`worst bye: ${byeNote}`);
  if (!trades.length && nearMisses.length) hints.push(`see the ${nearMisses.length} near misses below`);
  if (hints.length) parts.push(hints[0][0].toUpperCase() + hints.join("; ").slice(1) + ".");
  return parts.join(" ");
}

// ---------------------------------------------------------------- bench upgrades

function upgradeWhy(ctx: TradeContext, sim: Sim2, mine: ValuedPlayer, theirs: ValuedPlayer, myBase: LineupResult): string {
  const S = ctx.league.settings;
  const bits: string[] = [];
  if (theirs.ppg > mine.ppg + 0.2) bits.push(`${theirs.name} projects ${theirs.ppg.toFixed(1)} ppg rest of season vs ${mine.ppg.toFixed(1)} for ${mine.name}`);
  if (theirs.trend >= 1) bits.push(`usage trending up (${fmtSigned(theirs.trend)} expected pts/game over the last 2 weeks)`);
  if (theirs.games >= 2 && theirs.ppgExp26 - theirs.ppg26 >= 2) bits.push(`expected ${theirs.ppgExp26.toFixed(1)} > actual ${theirs.ppg26.toFixed(1)} ppg, due to bounce back`);
  if (mine.trend <= -1) bits.push(`${mine.name}'s usage is fading (${fmtSigned(mine.trend)})`);
  const inPO = (p: ValuedPlayer) => p.bye !== undefined && p.bye > S.regularSeasonEnd && p.bye <= S.finalWeek;
  if (inPO(mine) && !inPO(theirs)) bits.push(`${mine.name} has a playoff bye (week ${mine.bye})`);
  const byes = starterByes(ctx, myBase);
  const covered = [...byes].filter(([w, ps]) => theirs.bye !== w && ps.some((p) => eligible("FLEX", p.pos) ? eligible("FLEX", theirs.pos) : p.pos === theirs.pos));
  if (covered.length && (sim.myParts.season > 0.05 || bits.length === 0)) bits.push(`covers week ${covered.map(([w]) => w).join("/")} starter byes`);
  if (mine.injury && !theirs.injury) bits.push(`${mine.name} is ${mine.injury.status}`);
  const d = `Season ${fmtSigned(sim.myParts.season)}, Playoffs ${fmtSigned(sim.myParts.playoffs)}, Depth ${fmtSigned(sim.myParts.depth)}`;
  return `${bits.length ? bits.join("; ") : "small depth gain"} (${d}; fairness to them ${sim.fairness.toFixed(2)}).`;
}

/**
 * Bench upgrades: 1-for-1 swaps of one of my bench players (or my lowest skill
 * starter) for a partner's bench player where my season or playoff score rises.
 */
export function findBenchUpgrades(ctx: TradeContext, myTeamId: string, opts: { mode?: TradeMode; limit?: number; partnerId?: string } = {}): Trade[] {
  const mode = opts.mode ?? "balanced";
  if (tradeDeadlinePassed(ctx.league)) return [];
  const my = state2(ctx, myTeamId);
  const myAnalysis = ctx.teams.find((t) => t.team.id === myTeamId);
  const starters = (s: State2) => new Set(s.base.lineup.map((l) => l.player?.id).filter(Boolean) as string[]);
  const myStarters = starters(my);
  const lowStarter = my.base.lineup
    .map((l) => l.player)
    .filter((p): p is ValuedPlayer => !!p && tradeable(p))
    .sort((a, b) => effPpg(a) - effPpg(b))[0];
  const mine = my.roster.filter((p) => tradeable(p) && (!myStarters.has(p.id) || p.id === lowStarter?.id));
  const out: Trade[] = [];
  for (const partner of ctx.league.teams) {
    if (partner.id === myTeamId || (opts.partnerId && partner.id !== opts.partnerId)) continue;
    const their = state2(ctx, partner.id);
    const theirStarters = starters(their);
    const theirBench = their.roster.filter((p) => tradeable(p) && !theirStarters.has(p.id) && p.ppg > 0);
    for (const g of theirBench) {
      for (const m of mine) {
        if (fairnessOf(m.value, g.value) < V2.benchUpgradeFairness) continue;
        const sim = simulate2(ctx, my, their, [m], [g], mode);
        if (sim.fairness < V2.benchUpgradeFairness) continue;
        if (!(sim.myParts.season > 0.05 || sim.myParts.playoffs > 0.05)) continue;
        if (sim.myDelta <= 0.05 || !valueOk(sim)) continue;
        const t = buildTrade2(ctx, sim, myAnalysis, my.base, partner, mode);
        t.why = `${upgradeWhy(ctx, sim, m, g, my.base)} ${t.why}`;
        if (!t.tags.includes("depth upgrade") && sim.myParts.depth > 0) t.tags.unshift("depth upgrade");
        out.push(t);
      }
    }
  }
  out.sort((a, b) => (b.me.scoreDelta ?? 0) - (a.me.scoreDelta ?? 0) || b.acceptance - a.acceptance || a.key.localeCompare(b.key));
  // Each target once; each of my players at most twice.
  const gotSeen = new Set<string>();
  const gaveSeen = new Map<string, number>();
  const picked: Trade[] = [];
  for (const t of out) {
    const g = t.them.gives[0].id;
    const m = t.me.gives[0].id;
    if (gotSeen.has(g) || (gaveSeen.get(m) ?? 0) >= 2) continue;
    gotSeen.add(g);
    gaveSeen.set(m, (gaveSeen.get(m) ?? 0) + 1);
    picked.push(t);
    if (picked.length >= (opts.limit ?? V2.benchUpgradeLimit)) break;
  }
  return picked;
}

// ---------------------------------------------------------------- evaluate

/** Evaluate one proposal with v2 roster scores (verdict counts this-week or roster-score gains). */
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
  const sim = simulate2(ctx, my, their, give, get, mode);
  const trade = buildTrade2(ctx, sim, ctx.teams.find((t) => t.team.id === myTeamId), my.base, their.team, mode);
  const valueDrop = sim.myTotalBefore > 0 ? 1 - sim.myTotalAfter / sim.myTotalBefore : 0;
  const refusal = partnerRefusalReason(sim.fairness, sim.themDelta, "team");
  const verdict = verdictFor(sim.me.lineupDelta, sim.myFairness, valueDrop, refusal, sim.myDelta);
  const notes: string[] = [];
  notes.push(
    `Verdict "${verdict}": your team ${fmtSigned(sim.myDelta)} (${mode}; lineup this week ${fmtSigned(sim.me.lineupDelta)} ppg), value to you ${sim.myFairness.toFixed(2)} (what you get vs give, +5 cushion).`,
  );
  if (valueDrop > MAX_MY_VALUE_DROP) notes.push(`Warning: your total roster value falls ${Math.round(valueDrop * 100)}%.`);
  if (refusal) notes.push(`${their.team.name} is unlikely to accept: ${refusal}.`);
  if (tradeDeadlinePassed(ctx.league)) notes.push("The trade deadline has passed.");
  return { ...trade, why: `${notes.join(" ")} ${trade.why}`, verdict };
}
