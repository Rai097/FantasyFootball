import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTrade, combos, lineupChanges, teamState, tradeDeadlinePassed, type TradeContext } from "./tradeKit.js";
import { analyzeTeams } from "./analysis.js";
import { league, team, vp } from "./testkit.js";
import type { League, ValuedPlayer } from "./types.js";

const mine = [
  vp("mQB", "QB", 18, 10), vp("mRB1", "RB", 14, 30), vp("mRB2", "RB", 13, 26), vp("mRB3", "RB", 12, 22), vp("mRB4", "RB", 11, 18),
  vp("mWR1", "WR", 6, 1), vp("mWR2", "WR", 5, 0.5), vp("mTE", "TE", 8, 5), vp("mK", "K", 9, 90), vp("mDEF", "DEF", 7, 3), vp("mBN", "WR", 2, 0),
];
const theirs = [
  vp("tQB", "QB", 18, 10), vp("tRB1", "RB", 5, 0.5), vp("tRB2", "RB", 4, 0.2), vp("tWR1", "WR", 20, 45), vp("tWR2", "WR", 15, 20),
  vp("tWR3", "WR", 14, 16), vp("tWR4", "WR", 10, 6), vp("tTE", "TE", 8, 5), vp("tK", "K", 8, 1), vp("tDEF", "DEF", 7, 3), vp("tBN", "TE", 1, 0),
];
function ctxFor(l: League, ps: ValuedPlayer[]): TradeContext {
  const players = new Map(ps.map((p) => [p.id, p]));
  return { league: l, players, teams: analyzeTeams(l, players, { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 }) };
}
const L = league([team("me", mine), team("them", theirs)]);
const ctx = ctxFor(L, [...mine, ...theirs]);

test("IR slot: teamState and applyTrade never start a team's IR-slotted player; a receiver can start him", () => {
  const irL = league([team("me", mine, { irPlayerIds: ["mRB1"] }), team("them", theirs)]);
  const c = ctxFor(irL, [...mine, ...theirs]);
  const me = teamState(c, "me");
  assert.ok(!me.base.lineup.some((l) => l.player?.id === "mRB1"));
  assert.ok(me.base.bench.some((p) => p.id === "mRB1"));
  assert.ok(me.base.starterPpg < teamState(ctx, "me").base.starterPpg);
  const rb1 = mine.find((p) => p.id === "mRB1")!;
  const tWr4 = theirs.find((p) => p.id === "tWR4")!;
  const tRb2 = theirs.find((p) => p.id === "tRB2")!;
  const after = applyTrade(irL.settings.slots, me.roster, [], [tWr4, tRb2], new Set(["mRB1"]));
  assert.ok(!after.lineup.lineup.some((l) => l.player?.id === "mRB1"));
  assert.ok(!after.drops.some((p) => p.id === "mRB1"));
  const them = teamState(c, "them");
  const got = applyTrade(irL.settings.slots, them.roster, [tWr4], [rb1], new Set());
  assert.ok(got.lineup.lineup.some((l) => l.player?.id === "mRB1"));
});

test("applyTrade drops the lowest-value bench player when receiving more; lineupChanges names the slot moves", () => {
  const me = teamState(ctx, "me");
  const tWr1 = theirs.find((p) => p.id === "tWR1")!;
  const tWr2 = theirs.find((p) => p.id === "tWR2")!;
  const rb4 = mine.find((p) => p.id === "mRB4")!;
  const after = applyTrade(L.settings.slots, me.roster, [rb4], [tWr1, tWr2], new Set());
  assert.deepEqual(after.drops.map((p) => p.id), ["mBN"]);
  const ch = lineupChanges(me.base, after.lineup);
  assert.ok(ch.some((c) => c.startsWith("WR1: mWR1") && c.includes("tWR1")), ch.join(" | "));
});

test("combos: singles, pairs, triples; deadline check", () => {
  assert.deepEqual([...combos([1, 2, 3], 2)].map((c) => c.join("")), ["1", "12", "13", "2", "23", "3"]);
  assert.equal([...combos([1, 2, 3], 3)].length, 7);
  assert.equal(tradeDeadlinePassed(league([], undefined, { currentWeek: 14, tradeDeadlineWeek: 13 })), true);
  assert.equal(tradeDeadlinePassed(league([], undefined, { currentWeek: 13, tradeDeadlineWeek: 13 })), false);
  assert.equal(tradeDeadlinePassed(league([])), false);
});
