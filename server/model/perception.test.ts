import { test } from "node:test";
import assert from "node:assert/strict";
import { PERCEPTION, attachPerception, isSpike, perceive, perceivedLineupTotal, perceptionOf, scheduleCheck, yahooCoverage } from "./perception.js";
import { league, line, vp } from "./testkit.js";
import type { WeekLine } from "./types.js";

// Week 8 of a 17-week season: weeks 8..17 = 10 remaining weeks; playoffs 15–17.
const S = league([], undefined, { currentWeek: 8 }).settings;
const flat = (v: number, n = 10) => Array.from({ length: n }, () => v);
const wk = (week: number, recYd: number, recTd = 0, rec = 0): WeekLine => ({ season: S.season, week, team: "KC", actual: line({ recYd, recTd, rec }), expected: line() });

test("captured: Yahoo's rest-of-season total ÷ his remaining games is their base; this week's Yahoo number replaces week 1", () => {
  // Bye in week 10 → 9 games left; 117 projected points → 13.0 per game.
  const p = vp("y", "WR", 10, 20, { bye: 10, weekly: flat(10).map((v, i) => (i === 2 ? 0 : v)), weeklyFrom: 8, yahooProj: 117, yahooProjWeekly: 15 });
  const pc = perceive(p, S);
  assert.equal(pc.source, "yahoo");
  assert.equal(pc.base, 13);
  assert.equal(pc.rate, 13, "no recent games: no recency term");
  assert.equal(pc.weekly[0], 15, "Yahoo's weekly projection for this week");
  assert.equal(pc.weekly[2], 0, "bye");
  assert.equal(pc.weekly[3], 13);
  assert.equal(pc.ourRate, 10);
  assert.equal(pc.gap, -3, "they rate him higher than we do");
});

test("estimate: without a Yahoo projection the FantasyPros rank (ecrPts) is their base, then our rate; the estimate follows our availability", () => {
  const ir = vp("ir", "RB", 0, 0, { ecrPts: 12, weekly: flat(0), weeklyFrom: 8 });
  const pc = perceive(ir, S);
  assert.equal(pc.source, "ecr");
  assert.equal(pc.base, 12);
  assert.equal(pc.total, 0, "an out player is not shown starting for them on the estimate");
  // Only this week's Yahoo number captured (rest-of-season view not found): it still replaces week 1.
  const wkOnly = perceive(vp("w", "WR", 10, 20, { ecrPts: 11, weekly: flat(10), weeklyFrom: 8, yahooProjWeekly: 16.5 }), S);
  assert.equal(wkOnly.source, "ecr");
  assert.equal(wkOnly.weekly[0], 16.5);
  assert.equal(wkOnly.weekly[1], 11);
  const noRank = perceive(vp("m", "RB", 9, 10, { effPpg: 9 }), S);
  assert.equal(noRank.source, "model");
  assert.equal(noRank.base, 9);
  assert.equal(noRank.gap, 0);
});

test("recency bias: last 3 games (inside 4 weeks) weigh 0.3 of the perceived rate; older games do not count", () => {
  // Half PPR: 100 yd + 2 TD = 10 + 12 = 22 pts; 50 yd = 5 pts.
  const p = vp("r", "WR", 10, 20, { ecrPts: 10, weekly: flat(10), weeklyFrom: 8, weeks: [wk(2, 200), wk(5, 50), wk(6, 50), wk(7, 100, 2)] });
  const pc = perceive(p, S);
  const recent = (5 + 5 + 22) / 3;
  assert.equal(pc.recentGames, 3);
  assert.equal(pc.recent, Math.round(recent * 100) / 100);
  assert.ok(Math.abs(pc.rate - ((1 - PERCEPTION.recencyWeight) * 10 + PERCEPTION.recencyWeight * recent)) < 0.01, String(pc.rate));
  assert.equal(pc.lastGamePts, 22);
  assert.equal(pc.lastGameWeek, 7);
  assert.ok(isSpike(pc), "a 2-TD game ≥ 1.5× his perceived rate is a spike");
  const stale = perceive(vp("s", "WR", 10, 20, { ecrPts: 10, weeks: [wk(2, 300)] }), S);
  assert.equal(stale.recentGames, 0, "week 2 is outside the 4-week window");
  assert.equal(stale.rate, 10);
  assert.ok(!isSpike(stale));
});

test("schedule check: an unplayed-games map decides game weeks (bye-only without it)", () => {
  const sched = new Map([["KC", new Map([[8, {}], [9, {}]])]]);
  const p = vp("a", "WR", 10, 20, { yahooProj: 20 });
  const pc = perceive(p, S, scheduleCheck(sched));
  assert.equal(pc.base, 10, "20 points over his 2 scheduled games");
  assert.deepEqual(pc.weekly.slice(0, 3), [10, 10, 0]);
});

test("perceived lineup total: Yahoo-style optimal lineup per week on perceived points; attach caches per player", () => {
  const S2 = league([], ["QB", "WR", "BN", "BN"], { currentWeek: 16 }).settings; // weeks 16, 17
  const a = vp("a", "WR", 10, 20, { yahooProj: 30 });
  const b = vp("b", "WR", 12, 20, { yahooProj: 20 });
  const q = vp("q", "QB", 18, 30, { yahooProj: 40 });
  attachPerception([a, b, q], S2);
  assert.equal(perceptionOf(a, S2).rate, 15);
  // Week lineup: QB 20 + best WR 15 → 35 × 2 weeks.
  assert.equal(perceivedLineupTotal(S2, [a, b, q]), 70);
  assert.equal(perceivedLineupTotal(S2, [a, b, q], new Set(["a"])), 60, "IR-slot players never start");
  assert.deepEqual(yahooCoverage([a, b, vp("c", "RB", 5, 1), vp("k", "K", 8, 1)]), { captured: 2, total: 3 });
});

// ---------------------------------------------------------------- fix round 1 (release (d))

const ret = { week: 10, confidence: "medium" as const, reasons: [], absent: true, practiceUp: false };
const hot = [wk(5, 120, 1), wk(6, 100, 1), wk(7, 90, 1)];

test("captured: weeks our model has an injured player out are 0 on Yahoo's view too, and Yahoo's total spreads over his games back", () => {
  // Out weeks 8–9, back from week 10 (no bye in 8..17): 8 games back, Yahoo projects 40 → 5 per game.
  const p = vp("o", "WR", 5, 10, { weekly: [0, 0, 5, 5, 5, 5, 5, 5, 5, 5], weeklyFrom: 8, yahooProj: 40, ret });
  const pc = perceive(p, S);
  assert.equal(pc.base, 5);
  assert.deepEqual(pc.weekly.slice(0, 3), [0, 0, 5]);
  assert.equal(pc.total, 40);
  // The estimate shows the same weeks out.
  const est = perceive(vp("e", "WR", 5, 10, { weekly: [0, 0, 5, 5, 5, 5, 5, 5, 5, 5], weeklyFrom: 8, ecrPts: 5, ret }), S);
  assert.deepEqual(est.weekly.map((v) => v > 0), pc.weekly.map((v) => v > 0));
});

test("captured: Yahoo projecting 0 stays 0 even when our model has him healthy and he was hot (no recency resurrection)", () => {
  const pc = perceive(vp("z", "WR", 12, 20, { weekly: flat(12), weeklyFrom: 8, yahooProj: 0, weeks: hot }), S);
  assert.equal(pc.rate, 0);
  assert.equal(pc.total, 0);
});

test("captured last week: Yahoo's total also covered the game since played, so the per-game base divides by it", () => {
  // Captured in week 7, now week 8, bye week 10: games 8..17 minus the bye = 9, plus week 7 = 10 → 130 / 10 = 13.
  const pc = perceive(vp("c", "WR", 10, 20, { bye: 10, yahooProj: 130, yahooProjWeek: 7 }), S);
  assert.equal(pc.base, 13);
  assert.equal(pc.total, 13 * 9);
  // Captured this week: unchanged rule (9 games → 130 / 9).
  assert.equal(perceive(vp("d", "WR", 10, 20, { bye: 10, yahooProj: 117, yahooProjWeek: 8 }), S).base, 13);
});

test("coverage counts a this-week-only capture too (the headline never says 'not captured' while Yahoo numbers are used)", () => {
  const wkOnly = vp("w", "WR", 10, 20, { yahooProjWeekly: 14 });
  assert.deepEqual(yahooCoverage([wkOnly, vp("n", "RB", 8, 10)]), { captured: 1, total: 2 });
});

// Injured trade pieces fix round 1 (owner 2026-10-26).
const UNC = { week: null, confidence: "unknown" as const, reasons: [], absent: true, practiceUp: false, healthyRate: 20, tradeValue: 25, expWeekly: [0, 0, 0, 0, 10, 10, 10, 10, 10, 10] };
test("return unconfirmed: the partner sees our expected points (½ × healthy from week + 4) on both sources — estimate and captured Yahoo agree", () => {
  const est = perceive(vp("u1", "WR", 0, 0, { remainingGames: 0, ecrPts: 6, weekly: flat(0), weeklyFrom: 8, ret: UNC }), S);
  const yah = perceive(vp("u2", "WR", 0, 0, { remainingGames: 0, yahooProj: 0, weekly: flat(0), weeklyFrom: 8, ret: UNC }), S);
  assert.deepEqual(est.weekly, UNC.expWeekly);
  assert.deepEqual(yah.weekly, est.weekly, "Yahoo's ~0 for an IR player does not erase the bet on his recovery");
  const over = perceive(vp("u3", "WR", 0, 0, { remainingGames: 0, ecrPts: 6, weekly: flat(0), weeklyFrom: 8, ret: { ...UNC, seasonOver: true as const } }), S);
  assert.equal(over.total, 0, "out for the season: 0");
});

test("perceived lineup: an IR-slot player counts from his return week, never this week; without a return estimate never", () => {
  const S2 = league([], ["QB", "WR", "BN", "IR"], { currentWeek: 8 }).settings;
  const qb = vp("qb", "QB", 18, 20, { weekly: flat(18), weeklyFrom: 8 });
  const wr = vp("wr", "WR", 8, 5, { weekly: flat(8), weeklyFrom: 8 });
  const star = vp("star", "WR", 20, 40, { weekly: [0, 0, 0, 0, 20, 20, 20, 20, 20, 20], weeklyFrom: 8, yahooProjWeekly: 5, ret: { week: 12, confidence: "medium", reasons: [], absent: true, practiceUp: false } });
  const ir = new Set(["star"]);
  const before = perceivedLineupTotal(S2, [qb, wr], ir);
  // Weeks 12-17 (6 weeks): star 20 replaces wr 8 → +72; week 8's Yahoo number (5) never starts an IR player.
  assert.equal(perceivedLineupTotal(S2, [qb, wr, star], ir) - before, 72);
  const { ret: _r, ...noRet } = star;
  assert.equal(perceivedLineupTotal(S2, [qb, wr, noRet], ir), before);
});
