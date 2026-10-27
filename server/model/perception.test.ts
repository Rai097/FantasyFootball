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
