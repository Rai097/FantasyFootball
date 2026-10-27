// Bench upgrades: 1-for-1 swaps of one of my bench players (or my weakest skill starter) for a partner's bench player,
// judged by the Trade Finder engine (judge3: roster score, acceptance from the partner's perceived view). DESIGN "Release (d)".
import type { DetailItem, Trade, ValuedPlayer } from "./types.js";
import { effPpg, eligible } from "./lineup.js";
import { fmtSigned, tradeDeadlinePassed, tradeable, type TradeContext } from "./tradeKit.js";
import { benchUpgradeFilter, buildTrade3, judge3, qbItems, teamV3, type Judged3, type TeamV3 } from "./tradesV3.js";
import type { TradeMode } from "./rosterScore.js";
import { detailBuilder, makeSummary, toneOf } from "./details.js";

export const BENCH = {
  limit: 15,
  /** Perceived (market) fairness to the partner. */
  minFairness: 0.9,
  /** My #1/#2 most valuable players (value ≥ 20) are never offered as bench swaps. */
  starCount: 2,
  starMinValue: 20,
  /** Each of my players appears at most this often; each target once. */
  perMine: 2,
} as const;

const inPlayoffs = (ctx: TradeContext, p: ValuedPlayer) => {
  const S = ctx.league.settings;
  return p.bye !== undefined && p.bye > S.regularSeasonEnd && p.bye <= S.finalWeek;
};

/** Bench-upgrade reasons and numbers, one short item each (shown on tap). */
function upgradeItems(ctx: TradeContext, j: Judged3, my: TeamV3, mine: ValuedPlayer, theirs: ValuedPlayer): DetailItem[] {
  const d = j.myParts;
  const { items, add } = detailBuilder();
  if (theirs.ppg > mine.ppg + 0.2) add("Projection", `${theirs.ppg.toFixed(1)} vs ${mine.ppg.toFixed(1)} ppg rest of season`, "pos");
  if (theirs.riser) add("Usage", `${theirs.name}: opportunity rising 3 straight games`, "pos");
  else if (theirs.trend >= 1) add("Usage", `${theirs.name} trending up (${fmtSigned(theirs.trend)} expected pts/g)`, "pos");
  if (theirs.label === "buy-low") add("Buy-low", `${theirs.name} due ${fmtSigned(theirs.luck ?? 0)} pts/g by his usage`, "pos");
  if (mine.label === "sell-high") add("Sell-high", `${mine.name}: TD luck ${fmtSigned(mine.luck ?? 0)} pts/g`, "pos");
  if (mine.trend <= -1) add("Usage", `${mine.name} fading (${fmtSigned(mine.trend)} expected pts/g)`, "neg");
  if (inPlayoffs(ctx, mine) && !inPlayoffs(ctx, theirs)) add("Playoff bye", `${mine.name}: week ${mine.bye}`);
  if (d.season > 0.05) {
    const byes = new Map<number, ValuedPlayer[]>();
    for (const l of my.base.lineup) {
      const p = l.player;
      if (!p || p.bye === undefined || p.bye < ctx.league.settings.currentWeek) continue;
      byes.set(p.bye, [...(byes.get(p.bye) ?? []), p]);
    }
    const covered = [...byes]
      .filter(([w, ps]) => theirs.bye !== w && ps.some((p) => (eligible("FLEX", p.pos) ? eligible("FLEX", theirs.pos) : p.pos === theirs.pos)))
      .map(([w]) => w)
      .sort((x, y) => x - y);
    if (covered.length) add("Bye cover", `Starts in week${covered.length > 1 ? "s" : ""} ${covered.join(", ")} when your starters are off`);
  }
  if (mine.injury && !theirs.injury) add("Injury", `${mine.name} is ${mine.injury.status}`, "warn");
  add("Season", `${fmtSigned(d.season)} pts/wk rest of season`, toneOf(d.season));
  add("Playoffs", `${fmtSigned(d.playoffs)} pts/wk`, toneOf(d.playoffs));
  add("Depth", fmtSigned(d.depth), toneOf(d.depth));
  add("Your team score", fmtSigned(j.myDelta), toneOf(j.myDelta));
  add(j.perceivedSource === "yahoo" ? "What Yahoo shows" : "Yahoo view (estimate)", `you ${fmtSigned(j.myPerceived)}, them ${fmtSigned(j.theirPerceived)} pts rest of season`, toneOf(j.theirPerceived));
  add("Market value", `they get ${fmtSigned((j.fairness - 1) * 100)}% (FantasyCalc)`);
  add("Acceptance", `${Math.round(j.acceptance * 100)}%`);
  return items;
}

/** Up to BENCH.limit bench swaps that raise my season lineup, best first (my team-score delta, then acceptance). */
export function findBenchUpgrades(ctx: TradeContext, myTeamId: string, opts: { mode?: TradeMode; limit?: number; partnerId?: string } = {}): Trade[] {
  if (tradeDeadlinePassed(ctx.league)) return [];
  const mode = opts.mode ?? "balanced";
  const my = teamV3(ctx, myTeamId);
  const ok = benchUpgradeFilter(ctx, myTeamId);
  const stars = new Set(
    [...my.roster]
      .sort((a, b) => b.value - a.value)
      .slice(0, BENCH.starCount)
      .filter((p) => p.value >= BENCH.starMinValue)
      .map((p) => p.id),
  );
  const lowStarter = my.starterList.filter(tradeable).sort((a, b) => effPpg(a) - effPpg(b))[0];
  const mine = my.roster.filter((p) => tradeable(p) && !stars.has(p.id) && (!my.starters.has(p.id) || p.id === lowStarter?.id));
  const scored: { j: Judged3; their: TeamV3; m: ValuedPlayer; g: ValuedPlayer }[] = [];
  for (const partner of ctx.league.teams) {
    if (partner.id === myTeamId || (opts.partnerId && partner.id !== opts.partnerId)) continue;
    const their = teamV3(ctx, partner.id);
    const theirBench = their.roster.filter((p) => tradeable(p) && !their.starters.has(p.id) && p.ppg > 0);
    const J = judge3(ctx, my, their, mode);
    for (const g of theirBench) {
      for (const m of mine) {
        if (m.riser) continue; // never sell a player whose role is rising (Model v4)
        if (!ok(m, g, Infinity, partner.id)) continue; // eligibility / QB rule / real assets before simulating
        const j = J([m], [g]);
        if (j.fairness < BENCH.minFairness || j.myDelta <= 0.05) continue;
        if (!ok(m, g, j.myParts.season, partner.id)) continue;
        scored.push({ j, their, m, g });
      }
    }
  }
  scored.sort((a, b) => b.j.myDelta - a.j.myDelta || b.j.acceptance - a.j.acceptance);
  const gotSeen = new Set<string>();
  const gaveSeen = new Map<string, number>();
  const picked: Trade[] = [];
  for (const { j, their, m, g } of scored) {
    if (gotSeen.has(g.id) || (gaveSeen.get(m.id) ?? 0) >= BENCH.perMine) continue;
    gotSeen.add(g.id);
    gaveSeen.set(m.id, (gaveSeen.get(m.id) ?? 0) + 1);
    const t = buildTrade3(ctx, j, my, their, mode);
    t.summary = makeSummary(`${m.name} for ${g.name}: your season lineup ${fmtSigned(j.myParts.season)} pts/wk.`, `${j.perceivedSource === "yahoo" ? "Yahoo shows" : "Yahoo likely shows"} them ${fmtSigned(j.theirPerceived)} pts, ~${Math.round(j.acceptance * 100)}% accept.`);
    t.details = [...upgradeItems(ctx, j, my, m, g), ...(qbItems(my, their, [m], [g]) ?? [])];
    if (j.myParts.depth > 0.05 && !t.tags.includes("depth upgrade")) t.tags.unshift("depth upgrade");
    picked.push(t);
    if (picked.length >= (opts.limit ?? BENCH.limit)) break;
  }
  return picked;
}
