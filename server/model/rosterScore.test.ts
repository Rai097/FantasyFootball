import { test } from "node:test";
import assert from "node:assert/strict";
import { MODE_WEIGHTS, activeRoster, combine, depthCount, parseMode, rosterParts, rosterScore, weeklyPoints } from "./rosterScore.js";
import { league, vp, SMALL_SLOTS } from "./testkit.js";
import type { ValuedPlayer } from "./types.js";

// Week 4 of a season whose regular season ends in week 14 and playoffs run 15–17.
const S = league([]).settings;
const repl = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
// vp() defaults to 13 games left; weeks 4–17 are 14 games, so pass 14 for "healthy".
const H = { remainingGames: 14 };
const base = (o: Record<string, Partial<ValuedPlayer>> = {}) => {
  const over = Object.fromEntries(["QB", "RB1", "RB2", "WR1", "WR2", "TE", "FX", "BN1", "BN2"].map((k) => [k, { ...H, ...o[k] }]));
  return [
  vp("QB", "QB", 20, 20, over.QB), vp("RB1", "RB", 15, 30, over.RB1), vp("RB2", "RB", 13, 20, over.RB2),
  vp("WR1", "WR", 16, 30, over.WR1), vp("WR2", "WR", 12, 15, over.WR2), vp("TE", "TE", 9, 8, over.TE),
  vp("FX", "WR", 10, 8, over.FX), vp("K", "K", 8, 1), vp("DEF", "DEF", 7, 1),
  vp("BN1", "RB", 9, 4, over.BN1), vp("BN2", "WR", 6, 1, over.BN2),
  ].map((p) => (p.pos === "K" || p.pos === "DEF" ? { ...p, ...H } : p));
};

test("rosterScore: healthy roster without byes scores the same every week", () => {
  const r = rosterScore(S, base(), repl);
  assert.equal(r.now, 20 + 15 + 13 + 16 + 12 + 9 + 10 + 8 + 7);
  assert.ok(Math.abs(r.season - r.now) < 1e-9);
  assert.ok(Math.abs(r.playoffs - r.now) < 1e-9);
  // Bench: BN1 9−8=1, BN2 6−8<0 → 0.
  assert.equal(r.depth, 1);
});

test("rosterScore: a starter's bye lowers seasonAvg (bench covers part of it), not now or playoffs", () => {
  const healthy = rosterScore(S, base());
  const bye = rosterScore(S, base({ WR1: { bye: 8 } }));
  assert.equal(bye.now, healthy.now);
  // Week 8: WR1 (16) out, FX moves up and BN1 (9, RB) fills FLEX → −(16 − 9) = −7 over 14 weeks.
  assert.ok(Math.abs(healthy.season - bye.season - 7 / 14) < 1e-9, `${healthy.season} vs ${bye.season}`);
  assert.equal(bye.playoffs, healthy.playoffs);
  // A bye before the current week does not count.
  assert.equal(rosterScore(S, base({ WR1: { bye: 2 } })).season, healthy.season);
});

test("rosterScore: a playoff-week bye lowers starterPlayoffs", () => {
  const healthy = rosterScore(S, base());
  const po = rosterScore(S, base({ RB1: { bye: 16 } }));
  assert.ok(po.playoffs < healthy.playoffs);
  // Week 16 of 15–17: RB1 15 → BN1 9 at RB2/FLEX chain → −6 over 3 playoff weeks.
  assert.ok(Math.abs(healthy.playoffs - po.playoffs - 6 / 3) < 1e-9);
});

test("rosterScore: injured players miss their first weeks; playoffs see the healthy rate", () => {
  const out = vp("X", "RB", 15, 20, { remainingGames: 12, effPpg: 15 * 12 / 14, injury: { status: "Out", week: 4 } });
  const w = weeklyPoints(out, S);
  assert.deepEqual([...w.slice(0, 3)], [0, 0, 15]);
  assert.equal(w[w.length - 1], 15);
  const dbt = vp("Y", "RB", 10, 5, { remainingGames: 13.3, injury: { status: "Doubtful", week: 4 } });
  assert.ok(Math.abs(weeklyPoints(dbt, S)[0] - 3) < 1e-9, "Doubtful plays ~30% of week 1");
  assert.equal(weeklyPoints(vp("Z", "WR", 10, 5, { remainingGames: 0 }), S).every((x) => x === 0), true);
});

test("rosterScore: a deeper bench raises depth only", () => {
  const thin = rosterScore(S, base(), repl);
  const deep = rosterScore(S, base({ BN2: { ppg: 9.5, value: 6 } }), repl);
  assert.equal(deep.now, thin.now);
  assert.equal(deep.season, thin.season);
  assert.ok(deep.depth > thin.depth);
  assert.equal(deep.depth - thin.depth, 9.5 - 8);
  assert.equal(depthCount(SMALL_SLOTS), 4); // 7 skill slots → ceil(3.5)
  assert.equal(depthCount(["QB", "RB", "WR", "BN"]), 3);
});

test("rosterParts drops the lowest-value bench player (never a kept one)", () => {
  const r = rosterParts(S, base(), repl, { count: 1, keep: (p) => p.id === "BN2" });
  // Lowest-value bench player is BN2 (1.0) but he is kept → BN1 (4.0) goes.
  assert.deepEqual(r.drops.map((p) => p.id), ["BN1"]);
  // Without BN1 there is no RB cover, but no bye either: season unchanged, depth loses BN1's +1.
  assert.equal(r.parts.depth, 0);
});

test("mode weights: one config object, parseMode defaults to balanced", () => {
  assert.deepEqual(MODE_WEIGHTS.now, { now: 1, season: 0, playoffs: 0, depth: 0.15 });
  assert.deepEqual(MODE_WEIGHTS.balanced, { now: 0.4, season: 0.4, playoffs: 0.2, depth: 0.25 });
  assert.deepEqual(MODE_WEIGHTS.playoffs, { now: 0.15, season: 0.25, playoffs: 0.6, depth: 0.25 });
  const d = { now: 1, season: 2, playoffs: 4, depth: 8 };
  assert.equal(combine(d, MODE_WEIGHTS.now), 1 + 1.2);
  assert.ok(Math.abs(combine(d, MODE_WEIGHTS.balanced) - (0.4 + 0.8 + 0.8 + 2)) < 1e-9);
  assert.ok(Math.abs(combine(d, MODE_WEIGHTS.playoffs) - (0.15 + 0.5 + 2.4 + 2)) < 1e-9);
  assert.equal(parseMode("PLAYOFFS"), "playoffs");
  assert.equal(parseMode(undefined), "balanced");
  assert.equal(parseMode("bogus"), "balanced");
});

test("injured pieces fix round 1: weeklyPoints adds an unconfirmed return's expected weeks; an IR-slot returner never counts this week, counts from his return", () => {
  // Week 4: 14 weeks 4..17. Unconfirmed, healthy 20: 0 for weeks 4-7, then 10 (byes 0).
  const unk = vp("U", "WR", 0, 0, { remainingGames: 0, bye: 10, ret: { week: null, confidence: "unknown", reasons: [], absent: true, practiceUp: false, healthyRate: 20 } });
  const w = [...weeklyPoints(unk, S)];
  assert.deepEqual(w.slice(0, 4), [0, 0, 0, 0]);
  assert.equal(w[4], 10);
  assert.equal(w[10 - 4], 0, "bye");
  assert.equal(weeklyPoints({ ...unk, ret: { ...unk.ret!, seasonOver: true } }, S).every((x) => x === 0), true, "out for the season: 0");
  // IR slot, back in week 15 at 18/wk: no "now" points, playoff points count.
  const star = vp("STAR", "WR", 18, 40, { weeklyFrom: 4, weekly: Array.from({ length: 14 }, (_, i) => (4 + i >= 15 ? 18 : 0)), ret: { week: 15, confidence: "high", reasons: [], absent: true, practiceUp: false } });
  const roster = [...base(), star];
  const ir = new Set(["STAR"]);
  const withIr = rosterParts(S, activeRoster(roster, ir), repl).parts;
  const without = rosterParts(S, base(), repl).parts;
  assert.equal(withIr.now, without.now, "never starts this week from the IR slot");
  assert.equal(withIr.depth, without.depth, "no bench depth credit while in the IR slot");
  assert.ok(withIr.playoffs > without.playoffs, `playoffs ${withIr.playoffs} vs ${without.playoffs}`);
});
