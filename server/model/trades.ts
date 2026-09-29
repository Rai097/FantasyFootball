// Trade finder + evaluator. See docs/DESIGN.md "Trade finder" (+ architect amendments).
import type { League, Team, TeamAnalysis, Trade, TradeSide, ValuedPlayer } from "./types.js";
import { eligible, optimalLineup, slotLabels, usable, type LineupResult } from "./lineup.js";
import { rosterOf } from "./analysis.js";

export interface TradeContext {
  league: League;
  players: Map<string, ValuedPlayer>;
  teams: TeamAnalysis[];
}

export interface TradeOptions {
  maxGive?: number;
  maxGet?: number;
  partnerId?: string;
  wantPos?: string;
  /** Candidate pool size per side (top N by value). */
  poolSize?: number;
  limit?: number;
}

export const MIN_MY_DELTA = 0.75;
export const FAIRNESS_CUSHION = 5;
export const MAX_MY_VALUE_DROP = 0.2;
/** Max times one exact outgoing (or incoming) package may appear in the results. */
export const MAX_REPEAT = 3;

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const sum = (ps: ValuedPlayer[]) => ps.reduce((a, p) => a + p.value, 0);
const fmtSigned = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;
const tradeable = (p: ValuedPlayer) => p.pos !== "K" && p.pos !== "DEF" && p.remainingGames > 0;

export function fairnessOf(valueReceived: number, valueGiven: number): number {
  return (valueReceived + FAIRNESS_CUSHION) / (valueGiven + FAIRNESS_CUSHION);
}

export function acceptanceOf(fairness: number, themDelta: number): number {
  return clamp01(0.5 + 0.35 * Math.tanh(2 * (fairness - 1)) + 0.15 * Math.tanh(themDelta / 2));
}

/** Partner-acceptance filter (architect amendment #3). */
export function partnerWouldConsider(fairness: number, themDelta: number): boolean {
  return (themDelta >= -0.25 && fairness >= 0.85) || (fairness >= 1.1 && themDelta >= -1.0);
}

/** Roster after a trade, dropping lowest-value bench players (never incoming or IR) to keep size. */
function applyTrade(slots: League["settings"]["slots"], roster: ValuedPlayer[], gives: ValuedPlayer[], gets: ValuedPlayer[], irIds: Set<string>) {
  const giveIds = new Set(gives.map((p) => p.id));
  let after = roster.filter((p) => !giveIds.has(p.id)).concat(gets);
  let lu = optimalLineup(slots, after);
  const drops: ValuedPlayer[] = [];
  let excess = gets.length - gives.length;
  if (excess > 0) {
    const getIds = new Set(gets.map((p) => p.id));
    const cands = lu.bench
      .filter((p) => !getIds.has(p.id) && !irIds.has(p.id))
      .sort((a, b) => a.value - b.value || a.ppg - b.ppg || (b.ecrOverall ?? 999) - (a.ecrOverall ?? 999));
    while (excess-- > 0 && cands.length) drops.push(cands.shift()!);
    if (drops.length) {
      const dropIds = new Set(drops.map((p) => p.id));
      after = after.filter((p) => !dropIds.has(p.id));
      // Dropping bench players never changes the optimal lineup, but keep bench accurate.
      lu = { ...lu, bench: lu.bench.filter((p) => !dropIds.has(p.id)) };
    }
  }
  return { roster: after, lineup: lu, drops };
}

function lineupChanges(before: LineupResult, after: LineupResult): string[] {
  const labels = slotLabels(before.lineup);
  const out: string[] = [];
  before.lineup.forEach((l, i) => {
    const a = after.lineup[i]?.player ?? null;
    const b = l.player;
    if ((a?.id ?? null) === (b?.id ?? null)) return;
    const fmt = (p: ValuedPlayer | null) => (p ? `${p.name} ${(usable(p) ? p.ppg : 0).toFixed(1)}` : "empty");
    out.push(`${labels[i]}: ${fmt(b)} → ${fmt(a)}`);
  });
  return out;
}

interface Sim {
  me: TradeSide;
  them: TradeSide;
  fairness: number;
  myFairness: number;
  myTotalBefore: number;
  myTotalAfter: number;
}

function simulate(
  ctx: TradeContext,
  my: { team: Team; roster: ValuedPlayer[]; base: LineupResult },
  their: { team: Team; roster: ValuedPlayer[]; base: LineupResult },
  give: ValuedPlayer[],
  get: ValuedPlayer[],
): Sim {
  const slots = ctx.league.settings.slots;
  const meAfter = applyTrade(slots, my.roster, give, get, new Set(my.team.irPlayerIds ?? []));
  const themAfter = applyTrade(slots, their.roster, get, give, new Set(their.team.irPlayerIds ?? []));
  const valueGivenByMe = sum(give);
  const valueGivenByThem = sum(get);
  const theyReceiveNet = valueGivenByMe - sum(themAfter.drops);
  const iReceiveNet = valueGivenByThem - sum(meAfter.drops);
  const myTotalBefore = sum(my.roster);
  return {
    me: {
      teamId: my.team.id,
      gives: give,
      valueGiven: r1(valueGivenByMe),
      lineupDelta: r2(meAfter.lineup.starterPpg - my.base.starterPpg),
      lineupChanges: lineupChanges(my.base, meAfter.lineup).concat(meAfter.drops.map((p) => `Drop: ${p.name} (value ${p.value.toFixed(1)})`)),
      drops: meAfter.drops,
    },
    them: {
      teamId: their.team.id,
      gives: get,
      valueGiven: r1(valueGivenByThem),
      lineupDelta: r2(themAfter.lineup.starterPpg - their.base.starterPpg),
      lineupChanges: lineupChanges(their.base, themAfter.lineup).concat(themAfter.drops.map((p) => `Drop: ${p.name} (value ${p.value.toFixed(1)})`)),
      drops: themAfter.drops,
    },
    fairness: fairnessOf(theyReceiveNet, valueGivenByThem),
    myFairness: fairnessOf(iReceiveNet, valueGivenByMe),
    myTotalBefore,
    myTotalAfter: myTotalBefore - valueGivenByMe + iReceiveNet,
  };
}

const names = (ps: ValuedPlayer[]) => ps.map((p) => p.name).join(" + ") || "nothing";

function buildTrade(ctx: TradeContext, sim: Sim, myAnalysis: TeamAnalysis | undefined, partner: Team): Trade {
  const acceptance = acceptanceOf(sim.fairness, sim.them.lineupDelta);
  const score = sim.me.lineupDelta * acceptance;
  const give = sim.me.gives;
  const get = sim.them.gives;
  const tags: string[] = [];
  if (give.length === 2 && get.length === 1) tags.push("2-for-1 consolidation");
  if (give.length === 1 && get.length === 2) tags.push("1-for-2 depth");
  const needs = new Set(myAnalysis?.needs ?? []);
  const surplus = new Set(myAnalysis?.surplus ?? []);
  const needTags = new Set<string>();
  for (const p of get) {
    if (needs.has(p.pos)) needTags.add(`fills ${p.pos} need`);
    else if (needs.has("FLEX") && eligible("FLEX", p.pos)) needTags.add("fills FLEX need");
  }
  tags.push(...needTags);
  for (const pos of new Set(give.map((p) => p.pos))) if (surplus.has(pos)) tags.push(`sells ${pos} surplus`);
  if (get.some((p) => p.games >= 2 && p.ppgExp26 - p.ppg26 >= 3)) tags.push("buy-low: exp > act by 3+");
  if (get.some((p) => p.injury && /^(Q|D|O|Questionable|Doubtful|Out)$/i.test(p.injury.status))) tags.push("injury-discount");
  if (sim.them.lineupDelta >= MIN_MY_DELTA) tags.push("helps both");

  const key = `${partner.id}:${give.map((p) => p.id).sort().join(",")}>${get.map((p) => p.id).sort().join(",")}`;
  const pct = Math.round(acceptance * 100);
  const summary = `Give ${names(give)} to ${partner.name} for ${names(get)}: your lineup ${fmtSigned(sim.me.lineupDelta)} ppg, theirs ${fmtSigned(sim.them.lineupDelta)} ppg (~${pct}% accept).`;
  const why =
    `Your starters ${fmtSigned(sim.me.lineupDelta)} ppg` +
    (sim.me.lineupChanges.length ? ` (${sim.me.lineupChanges.join("; ")})` : "") +
    `. ${partner.name} starters ${fmtSigned(sim.them.lineupDelta)} ppg` +
    (sim.them.lineupChanges.length ? ` (${sim.them.lineupChanges.join("; ")})` : "") +
    `. They receive ${sum(give).toFixed(1)} value${sim.them.drops?.length ? ` (net of drops)` : ""} for ${sum(get).toFixed(1)} → fairness ${sim.fairness.toFixed(2)} ((recv+5)/(given+5)).` +
    ` Acceptance ${pct}% = 0.5 + 0.35·tanh(2·(fairness−1)) + 0.15·tanh(their Δ/2); score = your Δ × acceptance = ${score.toFixed(2)}.`;
  return {
    key,
    me: sim.me,
    them: sim.them,
    fairness: r3(sim.fairness),
    acceptance: r3(acceptance),
    score: r3(score),
    summary,
    tags,
    why,
  };
}

function* combos<T>(items: T[], maxSize: number): Generator<T[]> {
  const n = items.length;
  for (let i = 0; i < n; i++) {
    yield [items[i]];
    if (maxSize >= 2) for (let j = i + 1; j < n; j++) yield [items[i], items[j]];
  }
  if (maxSize >= 3) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) yield [items[i], items[j], items[k]];
  }
}

function teamState(ctx: TradeContext, teamId: string) {
  const team = ctx.league.teams.find((t) => t.id === teamId);
  if (!team) throw Object.assign(new Error(`Unknown team ${teamId}`), { status: 404 });
  const roster = rosterOf(team, ctx.players);
  const base = optimalLineup(ctx.league.settings.slots, roster);
  return { team, roster, base };
}

export function tradeDeadlinePassed(league: League): boolean {
  const d = league.settings.tradeDeadlineWeek;
  return d !== undefined && league.settings.currentWeek > d;
}

/** Search every partner (or one) for trades that help my starting lineup. */
export function findTrades(ctx: TradeContext, myTeamId: string, opts: TradeOptions = {}): Trade[] {
  if (tradeDeadlinePassed(ctx.league)) return [];
  const maxGive = Math.max(1, Math.min(3, opts.maxGive ?? 2));
  const maxGet = Math.max(1, Math.min(3, opts.maxGet ?? 2));
  const poolSize = opts.poolSize ?? 14;
  const limit = opts.limit ?? 40;
  const wantPos = opts.wantPos?.toUpperCase();
  const my = teamState(ctx, myTeamId);
  const myAnalysis = ctx.teams.find((t) => t.team.id === myTeamId);
  const pool = (r: ValuedPlayer[]) =>
    r
      .filter(tradeable)
      .sort((a, b) => b.value - a.value || b.ppg - a.ppg)
      .slice(0, poolSize);
  const myPool = pool(my.roster);
  const myPackages = [...combos(myPool, maxGive)];
  const myTotal = sum(my.roster);

  const seen = new Set<string>();
  const out: Trade[] = [];
  for (const partner of ctx.league.teams) {
    if (partner.id === myTeamId) continue;
    if (opts.partnerId && partner.id !== opts.partnerId) continue;
    const their = teamState(ctx, partner.id);
    const theirPackages = [...combos(pool(their.roster), maxGet)].filter((pk) => !wantPos || pk.some((p) => p.pos === wantPos));
    for (const get of theirPackages) {
      const getValue = sum(get);
      for (const give of myPackages) {
        const giveValue = sum(give);
        // Cheap prune: even before drops, fairness (+ possible drops lowering it) must reach 0.85.
        if (fairnessOf(giveValue, getValue) < 0.85) continue;
        // My total value may not fall by more than 20% (drops only lower it further).
        if (myTotal - giveValue + getValue < (1 - MAX_MY_VALUE_DROP) * myTotal) continue;
        const sim = simulate(ctx, my, their, give, get);
        if (sim.me.lineupDelta < MIN_MY_DELTA) continue;
        if (sim.myTotalAfter < (1 - MAX_MY_VALUE_DROP) * sim.myTotalBefore) continue;
        if (!partnerWouldConsider(sim.fairness, sim.them.lineupDelta)) continue;
        const trade = buildTrade(ctx, sim, myAnalysis, partner);
        if (seen.has(trade.key)) continue;
        seen.add(trade.key);
        out.push(trade);
      }
    }
  }
  out.sort((a, b) => b.score - a.score || b.acceptance - a.acceptance || a.key.localeCompare(b.key));
  // Diversity: the same outgoing package (or incoming package) appears at most MAX_REPEAT times.
  const giveSeen = new Map<string, number>();
  const getSeen = new Map<string, number>();
  const picked: Trade[] = [];
  for (const t of out) {
    const gk = t.me.gives.map((p) => p.id).sort().join(",");
    const tk = t.them.gives.map((p) => p.id).sort().join(",");
    if ((giveSeen.get(gk) ?? 0) >= MAX_REPEAT || (getSeen.get(tk) ?? 0) >= MAX_REPEAT) continue;
    giveSeen.set(gk, (giveSeen.get(gk) ?? 0) + 1);
    getSeen.set(tk, (getSeen.get(tk) ?? 0) + 1);
    picked.push(t);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * Verdict from my side, based on my lineup delta and value fairness to me
 * ((value I get + 5) / (value I give + 5)). A big lineup gain justifies paying
 * some value (VORP-based value understates players who replace sub-replacement
 * starters), mirroring the finder's rule that my total value may fall ≤ 20%.
 */
export function verdictFor(myDelta: number, myFairness: number, myValueDrop = 0): string {
  if (myValueDrop <= MAX_MY_VALUE_DROP && ((myDelta >= MIN_MY_DELTA && myFairness >= 0.5) || (myDelta >= 0 && myFairness >= 1.15))) return "Accept";
  if ((myDelta >= 0.25 && myFairness >= 0.5) || (myDelta >= -0.25 && myFairness >= 1.0)) return "Fair, lean accept";
  return "Decline";
}

/** Evaluate one specific trade proposal. */
export function evaluateTrade(
  ctx: TradeContext,
  myTeamId: string,
  partnerId: string,
  giveIds: string[],
  getIds: string[],
): Trade & { verdict: string } {
  const my = teamState(ctx, myTeamId);
  const their = teamState(ctx, partnerId);
  const pick = (ids: string[], roster: ValuedPlayer[], who: string) =>
    [...new Set(ids)].map((id) => {
      const p = roster.find((r) => r.id === id);
      if (!p) throw Object.assign(new Error(`Player ${id} is not on ${who}'s roster`), { status: 400 });
      return p;
    });
  const give = pick(giveIds, my.roster, my.team.name);
  const get = pick(getIds, their.roster, their.team.name);
  if (!give.length && !get.length) throw Object.assign(new Error("Trade must include at least one player"), { status: 400 });
  const sim = simulate(ctx, my, their, give, get);
  const trade = buildTrade(ctx, sim, ctx.teams.find((t) => t.team.id === myTeamId), their.team);
  const valueDrop = sim.myTotalBefore > 0 ? 1 - sim.myTotalAfter / sim.myTotalBefore : 0;
  const verdict = verdictFor(sim.me.lineupDelta, sim.myFairness, valueDrop);
  const notes: string[] = [];
  notes.push(`Verdict "${verdict}": your lineup ${fmtSigned(sim.me.lineupDelta)} ppg, value to you ${sim.myFairness.toFixed(2)} (what you get vs give, +5 cushion).`);
  if (valueDrop > MAX_MY_VALUE_DROP) notes.push(`Warning: your total roster value falls ${Math.round(valueDrop * 100)}%.`);
  if (!partnerWouldConsider(sim.fairness, sim.them.lineupDelta)) notes.push(`${their.team.name} is unlikely to accept.`);
  if (tradeDeadlinePassed(ctx.league)) notes.push("The trade deadline has passed.");
  return { ...trade, why: `${notes.join(" ")} ${trade.why}`, verdict };
}
