import { test } from "node:test";
import assert from "node:assert/strict";
import { claimThreshold, rankWaivers, snapTrendOf } from "./waivers.js";
import { analyzeTeams } from "./analysis.js";
import { league, team, vp } from "./testkit.js";
import type { TradeContext } from "./trades.js";
import type { ValuedPlayer } from "./types.js";

const REPL = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
// 13 active slots (9 starters + 4 BN) + IRGUY → full roster, so every add needs a drop.
const mine = [
  vp("QB", "QB", 18, 10), vp("RB1", "RB", 14, 30), vp("RB2", "RB", 13, 26), vp("WR1", "WR", 12, 20), vp("WR2", "WR", 3, 0),
  vp("TE", "TE", 8, 5), vp("FLX", "RB", 9, 4), vp("K", "K", 8, 2), vp("DEF", "DEF", 7, 3),
  vp("BN1", "RB", 4, 0.4), vp("BN2", "WR", 2, 0.1), vp("BN3", "TE", 1, 0), vp("BN4", "QB", 1.5, 0), vp("IRGUY", "RB", 0, 0, { remainingGames: 0 }),
];
const other = [vp("oQB", "QB", 17, 8)];

function ctxFor(ps: ValuedPlayer[], irIds: string[] = []): TradeContext {
  const L = league([team("me", mine, { irPlayerIds: irIds }), team("o", other)], undefined, { numTeams: 12 });
  const players = new Map(ps.map((p) => [p.id, p]));
  return { league: L, players, teams: analyzeTeams(L, players, REPL) };
}

test("claim threshold scales with rolling-list priority", () => {
  assert.equal(claimThreshold(1, 12), 2.5);
  assert.equal(claimThreshold(12, 12), 1.0);
  assert.equal(claimThreshold(undefined, 12), 2.0);
});

test("claim for a big lineup gain; wait for a marginal waiver player below the 5th-best FA", () => {
  const ctx = ctxFor([...mine, ...other], ["IRGUY"]);
  const bigWr = vp("FA_WR", "WR", 10, 12);
  const fas = [bigWr, ...[9, 8, 7, 6, 5].map((v, i) => vp(`FA_TE${i}`, "TE", 6 + i * 0.1, v)), vp("FA_TE_low", "TE", 8.3, 1)];
  const r = rankWaivers(ctx, "me", fas.map((p) => ({ player: p, onWaivers: true })), { myPriority: 3 });
  const big = r.freeAgents.find((t) => t.id === "FA_WR")!;
  assert.equal(big.recommendation, "claim");
  assert.equal(big.gain, 7); // replaces the 3-ppg WR2
  assert.equal(big.drop?.id, "BN3"); // lowest value, never the IR player
  assert.match(big.why, /Using your #3 priority drops you to #12/);
  const low = r.freeAgents.find((t) => t.id === "FA_TE_low")!;
  assert.equal(low.recommendation, "wait", low.why);
  assert.match(r.advice, /#3 of 12/);
});

test("pass when not an upgrade; free agents cost no priority", () => {
  const ctx = ctxFor([...mine, ...other]);
  const meh = vp("FA_meh", "WR", 0.5, 0);
  const good = vp("FA_good", "RB", 12, 8);
  const r = rankWaivers(ctx, "me", [{ player: meh, onWaivers: true }, { player: good, onWaivers: false }], { myPriority: 1 });
  assert.equal(r.freeAgents.find((t) => t.id === "FA_meh")!.recommendation, "pass");
  const g = r.freeAgents.find((t) => t.id === "FA_good")!;
  assert.equal(g.recommendation, "claim");
  assert.match(g.why, /add now, no priority cost/);
  assert.ok(r.freeAgents[0].rankScore >= r.freeAgents[1].rankScore);
});

test("never drops the only K / DEF; K streaming swaps the kicker", () => {
  const ctx = ctxFor([...mine, ...other]);
  const k = vp("FA_K", "K", 9.5, 4);
  const r = rankWaivers(ctx, "me", [{ player: k, onWaivers: false }]);
  assert.equal(r.freeAgents[0].drop?.id, "K");
  assert.equal(r.freeAgents[0].gain, 1.5);
  for (const t of rankWaivers(ctx, "me", [{ player: vp("FA_RB", "RB", 3, 0.2), onWaivers: false }]).freeAgents) {
    assert.ok(t.drop?.pos !== "K" && t.drop?.pos !== "DEF");
  }
});

test("snap trend = last week minus earlier average", () => {
  assert.equal(snapTrendOf({ snapShare: { 1: 0.5, 2: 0.6, 3: 0.8 } }), 0.25);
  assert.equal(snapTrendOf({ snapShare: { 1: 0.5 } }), 0);
});

test("claim/optional rows first; value-0 ties broken on vorp, not raw ppg", () => {
  const ctx = { ...ctxFor([...mine, ...other]), replacement: REPL };
  const zeroQb = vp("FA_QB0", "QB", 14, 0); // 14 ppg but QB repl 15 → vorp −1
  const zeroTe = vp("FA_TE0", "TE", 5.5, 0); // repl 6 → vorp −0.5
  const good = vp("FA_RB_ok", "RB", 9.5, 5); // bench upgrade → optional
  const r = rankWaivers(ctx, "me", [zeroQb, zeroTe, good].map((p) => ({ player: p, onWaivers: true })), { myPriority: 6 });
  assert.deepEqual(r.freeAgents.map((t) => t.recommendation), ["optional", "pass", "pass"]);
  assert.deepEqual(r.freeAgents.map((t) => t.id), ["FA_RB_ok", "FA_TE0", "FA_QB0"]);
});

test("wait rule compares ppg when the 5th-best FA has value 0", () => {
  const ctx = ctxFor([...mine, ...other]);
  // Six value-0 WRs that each start over my 3-ppg WR2 (gain 1.0–1.5, below the 1.8 claim threshold).
  const rbs = [4.5, 4.4, 4.3, 4.2, 4.1, 4.0].map((ppg, i) => vp(`R${i}`, "WR", ppg, 0, { vorp: 0 }));
  const r = rankWaivers(ctx, "me", rbs.map((p) => ({ player: p, onWaivers: true })), { myPriority: 6 });
  const rec = (id: string) => r.freeAgents.find((t) => t.id === id)!;
  assert.equal(rec("R5").recommendation, "wait", rec("R5").why);
  assert.match(rec("R5").why, /4\.1 ppg/);
  assert.notEqual(rec("R0").recommendation, "wait");
});

test("K / DEF never consume waiver priority", () => {
  const ctx = ctxFor([...mine, ...other]);
  const bigK = vp("FA_K", "K", 13, 10); // +5 ppg over my kicker: would be a claim for a skill player
  const onW = rankWaivers(ctx, "me", [{ player: bigK, onWaivers: true }], { myPriority: 1 }).freeAgents[0];
  assert.equal(onW.recommendation, "pass", onW.why);
  const free = rankWaivers(ctx, "me", [{ player: bigK, onWaivers: false }], { myPriority: 1 }).freeAgents[0];
  assert.equal(free.recommendation, "optional", free.why);
  const worse = rankWaivers(ctx, "me", [{ player: vp("FA_K2", "K", 7, 0), onWaivers: false }]).freeAgents[0];
  assert.equal(worse.recommendation, "pass");
});
