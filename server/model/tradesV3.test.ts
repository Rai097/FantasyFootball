import { test } from "node:test";
import assert from "node:assert/strict";
import {
  V3,
  acceptCurve,
  acceptanceV3,
  benchUpgradeFilter,
  benchUpgradeOk,
  qbRuleNote,
  bestQbRank,
  dropCost,
  evaluateTradeV3,
  fairnessBand,
  findTradesV3,
  ineligibleReason,
  judge3,
  packageValue,
  qbTradeable,
  spareQb,
  teamV3,
} from "./tradesV3.js";
import type { TradeContext } from "./trades.js";
import { analyzeTeams } from "./analysis.js";
import { attachMarket } from "./market.js";
import { league, team, vp } from "./testkit.js";
import type { League, ValuedPlayer } from "./types.js";

const G = { remainingGames: 14 };
const REPL = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
const S = league([]).settings;

// ---------------------------------------------------------------- package math

test("package value: best + 0.85·second + 0.70·third (order-free, 4th adds nothing)", () => {
  assert.equal(packageValue([30]), 30);
  assert.ok(Math.abs(packageValue([10, 30]) - (30 + 0.85 * 10)) < 1e-9);
  assert.ok(Math.abs(packageValue([5, 20, 10]) - (20 + 8.5 + 3.5)) < 1e-9);
  assert.ok(Math.abs(packageValue([5, 20, 10, 9]) - packageValue([20, 10, 9])) < 1e-9);
  assert.equal(packageValue([]), 0);
});

test("drop cost: each cut player's value, at least 3", () => {
  assert.equal(dropCost([]), 0);
  assert.equal(dropCost([0.4]), 3);
  assert.equal(dropCost([7.5]), 7.5);
  assert.equal(dropCost([1, 5]), 8);
});

test("fairness bands: fair ±5%, slightly 5–12%, favors > 12%", () => {
  assert.equal(fairnessBand(1).band, "fair");
  assert.equal(fairnessBand(1.05).band, "fair");
  assert.equal(fairnessBand(0.95).band, "fair");
  assert.equal(fairnessBand(1.08).band, "slightly-favors-them");
  assert.equal(fairnessBand(0.9).band, "slightly-favors-you");
  assert.equal(fairnessBand(1.12).band, "slightly-favors-them");
  assert.equal(fairnessBand(1.13).band, "favors-them");
  assert.equal(fairnessBand(0.8).band, "favors-you");
  assert.match(fairnessBand(1.08).label, /^Slightly favors them \(\+8% to them\)$/);
  assert.equal(fairnessBand(1.08).pct, 8);
});

test("acceptance curve: +5% → 0.65, −5% → 0.35, 0 → 0.5; multipliers and cap", () => {
  assert.ok(Math.abs(acceptCurve(5) - 0.65) < 1e-9);
  assert.ok(Math.abs(acceptCurve(-5) - 0.35) < 1e-9);
  assert.equal(acceptCurve(0), 0.5);
  const none = { extraGiven: 0, losesTheirTop: false, fixesWorst: false };
  assert.ok(Math.abs(acceptanceV3(5, { ...none, extraGiven: 1 }) - 0.65 * 0.85) < 1e-9);
  assert.ok(Math.abs(acceptanceV3(5, { ...none, extraGiven: 2 }) - 0.65 * 0.85 * 0.85) < 1e-9);
  assert.ok(Math.abs(acceptanceV3(5, { ...none, losesTheirTop: true }) - 0.65 * 0.8) < 1e-9);
  assert.ok(Math.abs(acceptanceV3(0, { ...none, fixesWorst: true }) - 0.55) < 1e-9);
  assert.equal(acceptanceV3(60, { ...none, fixesWorst: true }), V3.accCap);
  // Negative "extra" (I receive more than I give) is not a bonus.
  assert.equal(acceptanceV3(0, { ...none, extraGiven: -1 }), 0.5);
});

// ---------------------------------------------------------------- eligibility

test("eligibility: K/DEF, waiver level, IR / long-term, out 4+ weeks", () => {
  const ok = vp("ok", "WR", 12, 10, G);
  assert.equal(ineligibleReason(ok, S), "");
  assert.match(ineligibleReason(vp("k", "K", 8, 5, G), S), /K \/ DEF/);
  assert.match(ineligibleReason(vp("d", "DEF", 8, 5, G), S), /K \/ DEF/);
  assert.match(ineligibleReason(vp("w", "WR", 6, 1, G), S), /waiver/);
  // Market ≥ 3 keeps a low-true-value player eligible, and vice versa.
  assert.equal(ineligibleReason(vp("m", "WR", 6, 1, { ...G, market: 4 }), S), "");
  assert.equal(ineligibleReason(vp("t", "WR", 6, 4, { ...G, market: 1 }), S), "");
  assert.match(ineligibleReason(vp("mw", "WR", 6, 1, { ...G, market: 2 }), S), /waiver/);
  assert.match(ineligibleReason(ok, S, new Set(["ok"])), /IR/);
  assert.match(ineligibleReason(vp("ir", "WR", 12, 10, { ...G, injury: { status: "IR", week: 4 } }), S), /IR/);
  // 14 weeks left (4..17, no bye); 10 remaining games = out 4 weeks.
  assert.match(ineligibleReason(vp("o4", "WR", 12, 10, { remainingGames: 10 }), S), /out 4\+ weeks/);
  assert.equal(ineligibleReason(vp("o2", "WR", 12, 10, { remainingGames: 12 }), S), "");
  assert.match(ineligibleReason(vp("r", "WR", 12, 10, { ...G, injury: { status: "Out", detail: "IR-R designation to return", week: 4 } }), S), /out 4\+ weeks|IR/);
});

test("QB rule: only a spare top-14 QB, only to a team whose best QB ranks worse than 18", () => {
  const qb = (id: string, rank: number, ppg: number) => vp(id, "QB", ppg, 10, { ...G, posRank: rank });
  const two = [qb("a", 5, 22), qb("b", 12, 18)];
  const needy = [qb("x", 22, 14)];
  const fine = [qb("y", 10, 19)];
  assert.equal(spareQb(two)?.id, "b", "the second (non-starting) QB");
  assert.equal(spareQb([qb("a", 5, 22), qb("c", 16, 17)]), null, "second QB outside top 14");
  assert.equal(spareQb([qb("a", 5, 22)]), null);
  assert.equal(bestQbRank(needy), 22);
  assert.equal(qbTradeable(two, needy)?.id, "b");
  assert.equal(qbTradeable(two, fine), null, "partner already has a top-18 QB");
  assert.equal(qbTradeable(needy, two), null);
  assert.equal(bestQbRank([]), 99);
  // Market position rank wins when market values exist.
  const m = [vp("m1", "QB", 22, 10, { ...G, posRank: 3, market: 20, marketPosRank: 4 }), vp("m2", "QB", 18, 5, { ...G, posRank: 9, market: 3, marketPosRank: 20 })];
  assert.equal(spareQb(m), null, "second QB is QB20 by market");
});

// ---------------------------------------------------------------- judged packages

// Me: RB-rich (a stud), WR-poor. Partner: WR-rich, RB-poor, weak QB. Values double as market values.
const mine = [
  vp("mQB", "QB", 22, 12, { ...G, posRank: 4 }), vp("mQB2", "QB", 18, 4, { ...G, posRank: 11 }),
  vp("mRB1", "RB", 20, 60, G), vp("mRB2", "RB", 15, 30, G), vp("mRB3", "RB", 13.5, 22, G), vp("mRB4", "RB", 12, 14, G),
  vp("mWR1", "WR", 10, 8, G), vp("mWR2", "WR", 9, 5, G), vp("mTE", "TE", 8, 5, G), vp("mBN", "WR", 5, 0.5, G),
  vp("mK", "K", 8, 1, G), vp("mDEF", "DEF", 7, 1, G),
];
const theirs = [
  vp("tQB", "QB", 13, 2, { ...G, posRank: 24 }),
  vp("tRB1", "RB", 9, 4, G), vp("tRB2", "RB", 7, 3.5, G), vp("tWR1", "WR", 19, 55, G), vp("tWR2", "WR", 15, 28, G), vp("tWR3", "WR", 14, 22, G),
  vp("tWR4", "WR", 12.5, 14, G), vp("tWR5", "WR", 11, 9, G), vp("tTE", "TE", 8, 5, G), vp("tBN", "TE", 4, 0.4, G),
  vp("tK", "K", 8, 1, G), vp("tDEF", "DEF", 7, 1, G),
];
function ctxFor(l: League, ps: ValuedPlayer[]): TradeContext {
  const players = new Map(ps.map((p) => [p.id, p]));
  return { league: l, players, teams: analyzeTeams(l, players, REPL), replacement: REPL };
}
const ctx = ctxFor(league([team("me", mine), team("them", theirs)]), [...mine, ...theirs]);
const P = (id: string) => ctx.players.get(id)!;
const J = () => judge3(ctx, teamV3(ctx, "me"), teamV3(ctx, "them"), "balanced");

test("consolidation premium: whoever receives the best player in a non-1-for-1 deal gives ≥ 110%", () => {
  // I get their best WR (55) for two RBs: they must receive ≥ 1.10 × 55 net of their drop cost.
  const low = J()([P("mRB2"), P("mRB3")], [P("tWR1")]); // 30 + 0.85·22 = 48.7 − drop ≥ 3 → < 60.5
  assert.equal(low.bestToMe, true);
  assert.equal(low.premiumOk, false);
  assert.match(low.theirFail, /consolidation premium/);
  assert.equal(low.partnerOk, false);
  const high = J()([P("mRB1"), P("mRB4")], [P("tWR1")]); // mRB1 (60) is the best player: he goes to them
  assert.equal(high.bestToMe, false);
  // I give the best player for less than 110% of him back: my side fails.
  const sellStud = J()([P("mRB1")], [P("tWR2"), P("tWR3")]); // 28 + 0.85·22 = 46.7 − my drop < 66
  assert.equal(sellStud.bestToMe, false);
  assert.equal(sellStud.premiumOk, false);
  assert.match(sellStud.myFail, /best player/);
  // 1-for-1 deals carry no premium.
  assert.equal(J()([P("mRB2")], [P("tWR2")]).premiumOk, true);
});

test("drop cost: the side receiving more players nets the player it must cut (≥ 3)", () => {
  const j = J()([P("mRB3"), P("mRB4")], [P("tWR3")]);
  assert.equal(j.theirDrops.length, 1);
  const expected = packageValue([22, 14]) - dropCost(j.theirDrops.map((p) => p.value));
  assert.ok(Math.abs(j.fairness - expected / 22) < 1e-9, `${j.fairness} vs ${expected / 22}`);
  assert.ok(Math.abs(j.theirMarketChange - (expected - 22)) < 1e-9);
});

test("finder: no K/DEF/backup QBs/waiver-level pieces; pitch, band and value source on every trade", () => {
  const r = findTradesV3(ctx, "me", { valueSource: "model", limit: 50 });
  const all = [...r.trades, ...r.smallerEdges, ...r.nearMisses];
  assert.ok(all.length > 0, "finds something");
  assert.equal(r.valueSource, "model");
  assert.equal(r.partners?.length, 1);
  assert.equal(r.partners?.[0].teamId, "them");
  for (const t of all) {
    for (const p of [...t.me.gives, ...t.them.gives]) {
      assert.ok(p.pos !== "K" && p.pos !== "DEF", t.key);
      assert.ok(p.id !== "mBN" && p.id !== "tBN", `${t.key}: waiver-level piece`);
      // Their QB24 needs a QB, and my QB2 is QB11: only mQB2 may move.
      if (p.pos === "QB") assert.equal(p.id, "mQB2", t.key);
    }
    assert.ok(t.pitch && t.pitch.length > 20, t.key);
    assert.ok(t.band && t.bandLabel, t.key);
    assert.ok(t.notes && t.notes.length > 0, t.key);
  }
  for (const t of r.trades) {
    assert.ok((t.me.scoreDelta ?? 0) >= V3.clearDelta - 0.05, t.key);
    assert.ok(t.acceptance >= V3.minAcceptance, t.key);
    assert.ok((t.packages?.myTrueChange ?? 0) >= 0, t.key);
    assert.ok((t.them.seasonDelta ?? 0) >= V3.partnerLineupFloor - 0.05, t.key);
  }
  for (const t of r.nearMisses) assert.match(t.reason!, /^(They'd likely refuse|Partner unlikely|Marginal)/);
  // ≤ 2 per partner, ≤ 2 per player I give.
  assert.ok(r.trades.length <= V3.perPartner);
  const giveCount = new Map<string, number>();
  for (const t of r.trades) for (const p of t.me.gives) giveCount.set(p.id, (giveCount.get(p.id) ?? 0) + 1);
  for (const [id, n] of giveCount) assert.ok(n <= V3.perGive, id);
});

test("evaluate: v3 verdict, band and acceptance; flags pieces outside the rules", () => {
  const ev = evaluateTradeV3(ctx, "me", "them", ["mRB3"], ["tWR3"]);
  assert.ok(ev.band);
  assert.ok(ev.acceptance > 0 && ev.acceptance <= V3.accCap);
  assert.equal(typeof ev.verdict, "string");
  const k = evaluateTradeV3(ctx, "me", "them", ["mK"], ["tWR5"]);
  assert.match(k.why, /Outside the finder's rules: mK/);
  const qb = evaluateTradeV3(ctx, "me", "them", ["mQB"], ["tWR3"]);
  assert.match(qb.why, /QB rule/);
  assert.equal(qb.verdict, "Decline — QB rule");
});

test("market attachment: quantile-mapped true value, edge, missing-but-ranked players", () => {
  const ps = [vp("a", "RB", 20, 100, G), vp("b", "WR", 18, 40, G), vp("c", "WR", 10, 10, G), vp("d", "TE", 8, 2, G), vp("k", "K", 8, 5, G)];
  const players = new Map(ps.map((p) => [p.id, p]));
  const mk = (value: number, rank: number) => ({ value, raw: value, overallRank: rank, posRank: rank, trend30: 0 });
  attachMarket(players, new Map([["a", mk(100, 1)], ["c", mk(60, 2)], ["d", mk(5, 3)]]));
  const g = (id: string) => players.get(id)!;
  assert.equal(g("a").trueMarket, 100);
  assert.equal(g("b").marketEstimated, true, "b is ranked inside the list but missing from it");
  assert.equal(g("b").market, g("b").trueMarket);
  assert.equal(g("b").edge, 0);
  assert.equal(g("c").market, 60);
  assert.ok((g("c").edge ?? 0) < 0, "we rank c below the market");
  assert.equal(g("k").market, undefined);
  attachMarket(players, null);
  assert.equal(g("a").market, undefined);
  assert.equal(g("a").edge, undefined);
});

test("bench-upgrade rule: both players market ≥ 3 AND value ≥ 3, received player a real asset, my season +0.8", () => {
  const a = vp("a", "WR", 9, 4, { ...G, market: 5 });
  const b = vp("b", "WR", 10, 6, { ...G, market: 6 });
  assert.equal(benchUpgradeOk(a, b, 1), true);
  assert.equal(benchUpgradeOk(a, b, 0.5), false);
  assert.equal(benchUpgradeOk(vp("z", "RB", 5, 0, { ...G, market: 12 }), b, 2), false, "our value 0 (the Kamara case)");
  assert.equal(benchUpgradeOk(a, vp("q", "QB", 15, 0.2, { ...G, market: 12 }), 2), false, "our value 0.2");
  assert.equal(benchUpgradeOk(a, vp("s", "WR", 8, 4, { ...G, market: 4 }), 2), false, "received player not a real asset");
  assert.equal(benchUpgradeOk(a, vp("s", "WR", 8, 4, { ...G, market: 9 }), 2), true);
});

test("bench-upgrade filter applies eligibility and the QB rule", () => {
  const ok = benchUpgradeFilter(ctx, "me");
  // Their QB24 is not a spare (one QB); my QB2 may only go to them because they need a QB.
  assert.equal(ok(P("mRB4"), P("tQB"), 2, "them"), false);
  assert.equal(ok(P("mK"), P("tWR4"), 2, "them"), false);
  assert.equal(ok(P("mRB4"), P("tWR4"), 2, "them"), true);
  assert.equal(ok(P("mQB"), P("tWR4"), 2, "them"), false, "my starting QB never moves");
  const notes = qbRuleNote(ctx, "me", "them", [P("mQB2")], [P("tWR5")]);
  assert.match(notes!.join(" "), /QB rule: mQB2 .* allowed/);
});
