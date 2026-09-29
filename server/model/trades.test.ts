import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptanceOf, evaluateTrade, fairnessOf, findTrades, partnerWouldConsider, type TradeContext } from "./trades.js";
import { analyzeTeams } from "./analysis.js";
import { league, team, vp } from "./testkit.js";
import type { League, ValuedPlayer } from "./types.js";

// Me: RB-rich, WR-poor, and a hugely valuable kicker (must never be offered).
const mine = [
  vp("mQB", "QB", 18, 10), vp("mRB1", "RB", 14, 30), vp("mRB2", "RB", 13, 26), vp("mRB3", "RB", 12, 22), vp("mRB4", "RB", 11, 18),
  vp("mWR1", "WR", 6, 1), vp("mWR2", "WR", 5, 0.5), vp("mTE", "TE", 8, 5), vp("mK", "K", 9, 90), vp("mDEF", "DEF", 7, 3),
  vp("mBN", "WR", 2, 0),
];
// Partner: stud WR + WR depth, no RBs.
const theirs = [
  vp("tQB", "QB", 18, 10), vp("tRB1", "RB", 5, 0.5), vp("tRB2", "RB", 4, 0.2), vp("tWR1", "WR", 20, 45), vp("tWR2", "WR", 15, 20),
  vp("tWR3", "WR", 14, 16), vp("tWR4", "WR", 10, 6), vp("tTE", "TE", 8, 5), vp("tK", "K", 8, 1), vp("tDEF", "DEF", 7, 3),
  vp("tBN", "TE", 1, 0),
];

function ctxFor(l: League, ps: ValuedPlayer[]): TradeContext {
  const players = new Map(ps.map((p) => [p.id, p]));
  return { league: l, players, teams: analyzeTeams(l, players, { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 }) };
}
const L = league([team("me", mine), team("them", theirs)]);
const ctx = ctxFor(L, [...mine, ...theirs]);

test("fairness has a +5 cushion and acceptance is clamped", () => {
  assert.equal(fairnessOf(0, 0), 1);
  assert.equal(fairnessOf(15, 5), 2);
  assert.ok(acceptanceOf(3, 10) <= 1 && acceptanceOf(0, -10) >= 0);
  assert.ok(Math.abs(acceptanceOf(1, 0) - 0.5) < 1e-9);
  assert.equal(partnerWouldConsider(0.9, 0), true);
  assert.equal(partnerWouldConsider(0.8, 5), false);
  assert.equal(partnerWouldConsider(1.2, -0.9), true);
  assert.equal(partnerWouldConsider(1.2, -1.5), false);
});

test("finds a 2-for-1 consolidation that helps both teams", () => {
  const trades = findTrades(ctx, "me", { limit: 1000 });
  assert.ok(trades.length > 0);
  const t = trades.find((x) => x.me.gives.length === 2 && x.them.gives.length === 1 && x.them.gives[0].id === "tWR1");
  assert.ok(t, `no 2-for-1 for tWR1 in ${trades.map((x) => x.key).join(" ")}`);
  assert.ok(t.me.lineupDelta >= 0.75);
  assert.ok(t.them.lineupDelta > 0, "partner also improves");
  assert.ok(t.tags.includes("2-for-1 consolidation"));
  assert.ok(t.me.lineupChanges.some((c) => c.includes("tWR1")));
  assert.equal(t.them.drops?.length, 1, "partner drops its lowest-value bench player");
  assert.match(t.why, /fairness/);
  for (let i = 1; i < trades.length; i++) assert.ok(trades[i - 1].score >= trades[i].score);
});

test("K and DEF are never traded", () => {
  for (const t of findTrades(ctx, "me", { maxGive: 2, maxGet: 2 })) {
    for (const p of [...t.me.gives, ...t.them.gives]) assert.ok(p.pos !== "K" && p.pos !== "DEF", `${p.id} offered`);
  }
});

test("a lopsided trade is rejected by the finder and declined by the evaluator", () => {
  // Scrub for their stud: great for me, terrible for them.
  const all = findTrades(ctx, "me", { maxGive: 1, maxGet: 1 });
  assert.ok(!all.some((t) => t.me.gives[0].id === "mWR2" && t.them.gives[0].id === "tWR1"));
  const ev = evaluateTrade(ctx, "me", "them", ["mWR2"], ["tWR1"]);
  assert.ok(ev.fairness < 0.85);
  assert.match(ev.why, /unlikely to accept/);
  // My stud RB for their scrub RB: bad for me.
  const bad = evaluateTrade(ctx, "me", "them", ["mRB1"], ["tRB2"]);
  assert.equal(bad.verdict, "Decline");
  assert.ok(bad.me.lineupDelta < 0);
});

test("partner and wantPos filters, and nothing after the trade deadline", () => {
  const onlyWr = findTrades(ctx, "me", { wantPos: "WR" });
  assert.ok(onlyWr.every((t) => t.them.gives.some((p) => p.pos === "WR")));
  const late = ctxFor(league([team("me", mine), team("them", theirs)], undefined, { currentWeek: 14, tradeDeadlineWeek: 13 }), [...mine, ...theirs]);
  assert.deepEqual(findTrades(late, "me"), []);
});

test("evaluator agrees with the finder on a suggested trade", () => {
  const t = findTrades(ctx, "me")[0];
  const ev = evaluateTrade(ctx, "me", "them", t.me.gives.map((p) => p.id), t.them.gives.map((p) => p.id));
  assert.equal(ev.verdict, "Accept", ev.why);
  assert.equal(ev.me.lineupDelta, t.me.lineupDelta);
});
