import { test } from "node:test";
import assert from "node:assert/strict";
import { V2, evaluateTradeV2, findBenchUpgrades, findTradesV2, judge, nearMissClass, state2 } from "./tradesV2.js";
import { acceptanceOf, fairnessOf, type TradeContext } from "./trades.js";
import { analyzeTeams } from "./analysis.js";
import { league, team, vp } from "./testkit.js";
import type { League, ValuedPlayer } from "./types.js";

const G = { remainingGames: 14 };
const REPL = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
// Me: RB-rich (two stars), WR-poor, a backup QB worth ~0.
const mine = [
  vp("mQB", "QB", 18, 10, G), vp("mQB2", "QB", 14, 0.2, G), vp("mRB1", "RB", 20, 70, G), vp("mRB2", "RB", 16, 45, G), vp("mRB3", "RB", 13, 20, G),
  vp("mRB4", "RB", 11, 12, { ...G, bye: 9 }), vp("mWR1", "WR", 10, 8, { ...G, bye: 9 }), vp("mWR2", "WR", 9, 5, G), vp("mTE", "TE", 8, 5, G),
  vp("mK", "K", 8, 1, G), vp("mDEF", "DEF", 7, 1, G),
];
// Partner: WR-rich, no RBs of note; QB optional.
const theirs = (withQb: boolean) => [
  ...(withQb ? [vp("tQB", "QB", 18, 10, G)] : []),
  vp("tRB1", "RB", 9, 4, G), vp("tWR1", "WR", 19, 60, G), vp("tWR2", "WR", 15, 28, G), vp("tWR3", "WR", 14, 22, G),
  vp("tWR4", "WR", 12, 11, G), vp("tWR5", "WR", 11, 9, { ...G, bye: 16 }), vp("tWRok", "WR", 12.5, 12, G),
  vp("tWRout", "WR", 12.5, 12, { ...G, injury: { status: "Out", detail: "Hamstring", week: 4 } }),
  vp("tTE", "TE", 8, 5, G), vp("tK", "K", 8, 1, G), vp("tDEF", "DEF", 7, 1, G),
];

function ctxFor(l: League, ps: ValuedPlayer[]): TradeContext {
  const players = new Map(ps.map((p) => [p.id, p]));
  return { league: l, players, teams: analyzeTeams(l, players, REPL), replacement: REPL };
}
const make = (withQb: boolean) => ctxFor(league([team("me", mine), team("them", theirs(withQb))]), [...mine, ...theirs(withQb)]);
const ctx = make(true);
const ctxNoQb = make(false);
const P = (c: TradeContext, id: string) => c.players.get(id)!;
const J = (c: TradeContext, mode: "now" | "balanced" | "playoffs" = "balanced") => judge(c, state2(c, "me"), state2(c, "them"), mode);

test("A: giving my #1/#2 player needs +2.0 and is tagged; 1-for-2 raises the bar by 0.5 and nets the drop", () => {
  const j = J(ctx)([P(ctx, "mRB1")], [P(ctx, "tWR2")]);
  assert.equal(j.star, true);
  assert.equal(j.bar, V2.starMinDelta);
  assert.equal(j.keep, j.myDelta >= 2);
  const plain = J(ctx)([P(ctx, "mRB3")], [P(ctx, "tWR4")]);
  assert.equal(plain.star, false);
  assert.equal(plain.bar, 0.5);
  const twoForOne = J(ctx)([P(ctx, "mRB3")], [P(ctx, "tWR4"), P(ctx, "tWR5")]);
  assert.equal(twoForOne.bar, 1.0);
  const dropped = twoForOne.sim.myDrops;
  assert.equal(dropped.length, 1);
  assert.ok(Math.abs(twoForOne.sim.myFairness - fairnessOf(11 + 9 - dropped[0].value, 20)) < 1e-9, "my fairness nets the drop");
  // Finder invariants.
  const r = findTradesV2(ctx, "me", { limit: 1000 });
  for (const t of [...r.trades, ...r.smallerEdges]) {
    if (t.me.gives.some((p) => p.id === "mRB1" || p.id === "mRB2")) {
      assert.ok(t.tags.includes("moving a star"), t.key);
      assert.ok((t.me.scoreDelta ?? 0) >= 1.95, `${t.key} star for ${t.me.scoreDelta}`);
    }
    if (t.them.gives.length > t.me.gives.length) assert.ok((t.me.scoreDelta ?? 0) >= 0.95 || (t.me.nowDelta ?? 0) >= 1.2, t.key);
  }
});

test("B: a throw-in must add ≥ 1.0 for his receiver, else the package is dropped; F: his gain to them is capped at +1.0", () => {
  // Partner has a QB: my backup QB is pure filler.
  const filler = J(ctx)([P(ctx, "mRB3"), P(ctx, "mQB2")], [P(ctx, "tWR2")]);
  assert.equal(filler.throwInOk, false);
  // Partner has no QB: the backup fills their empty QB slot.
  const c = ctxNoQb;
  const judged = J(c);
  const fills = judged([P(c, "mRB3"), P(c, "mQB2")], [P(c, "tWR2")]);
  const without = judged([P(c, "mRB3")], [P(c, "tWR2")]);
  assert.equal(fills.throwInOk, true);
  assert.ok(fills.throwInTags.includes("throw-in: fills their QB slot"));
  assert.ok(fills.sim.themDeltaRaw - without.sim.themDeltaRaw > 1, "raw gain is large");
  assert.ok(Math.abs(fills.themDelta - (without.sim.themDeltaRaw + V2.throwInCap)) < 1e-9, "capped at +1.0");
  // Nothing the finder returns carries unjustified filler.
  for (const t of findTradesV2(ctx, "me", { limit: 1000 }).trades) assert.ok(!t.me.gives.some((p) => p.id === "mQB2"), t.key);
});

test("C: received injured players are risk-adjusted for me only", () => {
  const out = J(ctx)([P(ctx, "mRB3")], [P(ctx, "tWRout")]);
  const ok = J(ctx)([P(ctx, "mRB3")], [P(ctx, "tWRok")]);
  assert.ok(out.myDelta < ok.myDelta - 0.5, `${out.myDelta} vs ${ok.myDelta}`);
  assert.ok(Math.abs(out.sim.themDeltaRaw - ok.sim.themDeltaRaw) < 1e-9, "partner sees healthy projections");
  const ev = evaluateTradeV2(ctx, "me", "them", ["mRB3"], ["tWRout"]);
  assert.ok(ev.tags.includes("injury risk"));
  assert.match(ev.why, /Risk-adjusted for Out \(tWRout ×0\.55\)/);
  assert.equal(ev.them.gives[0].ppg, 12.5, "UI keeps the healthy ppg");
});

test("D + E: main list needs ≥ 45% acceptance and +1.0; smaller edges and near misses are separate", () => {
  for (const mode of ["now", "balanced", "playoffs"] as const) {
    const r = findTradesV2(ctx, "me", { mode, limit: 1000 });
    assert.ok(r.trades.length > 0, `${mode}: no trades`);
    for (const t of r.trades) {
      assert.ok(t.acceptance >= V2.minAcceptance, `${t.key} acc ${t.acceptance}`);
      assert.ok(Math.max(t.me.scoreDelta ?? 0, mode === "now" ? t.me.nowDelta ?? 0 : 0) >= 0.95, `${t.key} ${t.me.scoreDelta}`);
    }
    for (const t of r.smallerEdges) assert.ok(t.acceptance >= V2.minAcceptance);
    for (let i = 1; i < r.trades.length; i++) assert.ok(r.trades[i - 1].score >= r.trades[i].score);
    assert.ok(r.nearMisses.length <= V2.nearMissLimit);
    for (const t of r.nearMisses) assert.ok(t.reason && /^(They'd likely refuse|Partner unlikely|Marginal)/.test(t.reason), t.reason);
    assert.equal(typeof r.summary, "string");
    assert.ok(r.summary.length > 20);
    assert.equal(r.mode, mode);
  }
});

test("near-miss classification", () => {
  const base = { keep: true, valueOk: true, throwInOk: true, partnerOk: true, acceptance: 0.6, myDelta: 2, themDelta: 0, star: false, fairness: 1, myFairness: 1 };
  assert.equal(nearMissClass(base), null, "a real trade is not a near miss");
  assert.equal(nearMissClass({ ...base, partnerOk: false, fairness: 0.8 }), "refuse");
  assert.equal(nearMissClass({ ...base, partnerOk: false, fairness: 0.5 }), null, "hopeless for them");
  assert.equal(nearMissClass({ ...base, partnerOk: false, themDelta: -4 }), null);
  assert.equal(nearMissClass({ ...base, acceptance: 0.4 }), "unlikely");
  assert.equal(nearMissClass({ ...base, keep: false, myDelta: 0.3, myFairness: 1.2 }), "marginal");
  assert.equal(nearMissClass({ ...base, keep: false, myDelta: 0.3, myFairness: 0.8 }), null, "marginal needs value in my favour");
  assert.equal(nearMissClass({ ...base, keep: false, myDelta: 1.2, myFairness: 0.8, star: true }), "marginal", "star moved for too little");
  assert.equal(nearMissClass({ ...base, keep: false, myDelta: -0.1, myFairness: 2 }), null);
  assert.equal(nearMissClass({ ...base, throwInOk: false, partnerOk: false }), null);
  assert.equal(nearMissClass({ ...base, valueOk: false, partnerOk: false }), null);
});

test("F: asking for their #1/#2 player needs fairness ≥ 1.05 and their team ≥ 0; acceptance × 0.8", () => {
  const cheap = J(ctx)([P(ctx, "mRB3")], [P(ctx, "tWR1")]);
  assert.equal(cheap.theirStar, true);
  assert.equal(cheap.partnerOk, false);
  const rich = J(ctx)([P(ctx, "mRB2"), P(ctx, "mRB4")], [P(ctx, "tWR1")]);
  assert.equal(rich.theirStar, true);
  assert.ok(Math.abs(rich.acceptance - 0.8 * acceptanceOf(rich.sim.fairness, rich.themDelta)) < 1e-9);
  assert.equal(rich.partnerOk, rich.sim.fairness >= 1.05 && rich.themDelta >= 0 && rich.sim.fairness >= 0.85);
  if (!rich.partnerOk && rich.sim.fairness >= 0.85 && rich.themDelta >= -0.25) assert.match(rich.refusal, /their star/);
  for (const t of findTradesV2(ctx, "me", { limit: 1000 }).trades) {
    if (t.them.gives.some((p) => p.id === "tWR1" || p.id === "tWR2")) {
      assert.ok(t.tags.includes("asks for their star"));
      assert.ok(t.fairness >= 1.05 && (t.them.scoreDelta ?? 0) >= -0.05, t.key);
    }
  }
});

test("bench upgrades: 1-for-1, their bench player for my bench (or lowest starter)", () => {
  const ups = findBenchUpgrades(ctx, "me");
  const st = (id: string) => new Set(state2(ctx, id).base.lineup.map((l) => l.player?.id));
  const mySt = st("me");
  const theirSt = st("them");
  const lowest = state2(ctx, "me").base.lineup.map((l) => l.player!).filter((p) => p.pos !== "K" && p.pos !== "DEF").sort((a, b) => a.ppg - b.ppg)[0];
  assert.ok(ups.length > 0);
  assert.ok(ups.length <= V2.benchUpgradeLimit);
  for (const t of ups) {
    assert.equal(t.me.gives.length, 1);
    assert.equal(t.them.gives.length, 1);
    assert.ok(!theirSt.has(t.them.gives[0].id), `${t.key}: their starter`);
    assert.ok(!mySt.has(t.me.gives[0].id) || t.me.gives[0].id === lowest.id, `${t.key}: my starter`);
    assert.ok(t.fairness >= 0.9);
    assert.ok((t.me.seasonDelta ?? 0) > 0 || (t.me.playoffDelta ?? 0) > 0, t.key);
    assert.ok(t.why.length > 20);
  }
  for (let i = 1; i < ups.length; i++) assert.ok((ups[i - 1].me.scoreDelta ?? 0) >= (ups[i].me.scoreDelta ?? 0));
});

test("nothing after the trade deadline", () => {
  const late = ctxFor(league([team("me", mine), team("them", theirs(true))], undefined, { currentWeek: 14, tradeDeadlineWeek: 13 }), [...mine, ...theirs(true)]);
  const r = findTradesV2(late, "me");
  assert.deepEqual([r.trades, r.smallerEdges, r.nearMisses], [[], [], []]);
  assert.match(r.summary, /deadline/);
  assert.deepEqual(findBenchUpgrades(late, "me"), []);
});
