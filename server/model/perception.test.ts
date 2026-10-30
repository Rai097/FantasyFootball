import { test } from "node:test";
import assert from "node:assert/strict";
import { PERCEPTION, attachPerception, evaluatorWeeks, isSpike, perceive, perceivedLineupTotal, perceptionOf, scheduleCheck, yahooCoverage } from "./perception.js";
import { league, line, vp } from "./testkit.js";
import type { WeekLine } from "./types.js";

// Week 8 of a 17-week season: weeks 8..17 = 10 remaining weeks; playoffs 15–17.
const S = league([], undefined, { currentWeek: 8 }).settings;
const flat = (v: number, n = 10) => Array.from({ length: n }, () => v);
const wk = (week: number, recYd: number, recTd = 0, rec = 0): WeekLine => ({ season: S.season, week, team: "KC", actual: line({ recYd, recTd, rec }), expected: line() });

test("captured: Yahoo's total minus this week's number, spread over his games next week through NFL week 18, is their base", () => {
  // Yahoo's total covers weeks 8..18. This week 15 → 117 left over weeks 9..18 minus the week-10 bye = 9 games → 13.0.
  const p = vp("y", "WR", 10, 20, { bye: 10, weekly: flat(10).map((v, i) => (i === 2 ? 0 : v)), weeklyFrom: 8, yahooProj: 132, yahooProjWeekly: 15 });
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
  // Totals cover weeks 16, 17, 18 (3 games); the evaluator sums week 17 only (week 16 = this week, "even").
  const a = vp("a", "WR", 10, 20, { yahooProj: 45 });
  const b = vp("b", "WR", 12, 20, { yahooProj: 30 });
  const q = vp("q", "QB", 18, 30, { yahooProj: 60 });
  attachPerception([a, b, q], S2);
  assert.equal(perceptionOf(a, S2).rate, 15);
  // Week 17 lineup: QB 20 + best WR 15 → 35.
  assert.equal(perceivedLineupTotal(S2, [a, b, q]), 35);
  assert.equal(perceivedLineupTotal(S2, [a, b, q], new Set(["a"])), 30, "IR-slot players never start");
  assert.deepEqual(yahooCoverage([a, b, vp("c", "RB", 5, 1), vp("k", "K", 8, 1)]), { captured: 2, total: 3 });
});

// ---------------------------------------------------------------- fix round 1 (release (d))

const ret = { week: 10, confidence: "medium" as const, reasons: [], absent: true, practiceUp: false };
const hot = [wk(5, 120, 1), wk(6, 100, 1), wk(7, 90, 1)];

test("captured: Yahoo's number is used as is for a player our model has out (it already prices the injury); the estimate follows our availability", () => {
  // Out weeks 8–9 by our model, back week 10. Yahoo projects 44 over weeks 8..18 (no bye: 11 games) → 4 per game.
  const p = vp("o", "WR", 5, 10, { weekly: [0, 0, 5, 5, 5, 5, 5, 5, 5, 5], weeklyFrom: 8, yahooProj: 44, ret });
  const pc = perceive(p, S);
  assert.equal(pc.base, 4);
  assert.deepEqual(pc.weekly.slice(0, 3), [4, 4, 4]);
  // The estimate (no Yahoo number) shows the weeks out as 0.
  const est = perceive(vp("e", "WR", 5, 10, { weekly: [0, 0, 5, 5, 5, 5, 5, 5, 5, 5], weeklyFrom: 8, ecrPts: 5, ret }), S);
  assert.deepEqual(est.weekly.slice(0, 3), [0, 0, 5]);
});

test("captured: Yahoo projecting 0 stays 0 even when our model has him healthy and he was hot (no recency resurrection)", () => {
  const pc = perceive(vp("z", "WR", 12, 20, { weekly: flat(12), weeklyFrom: 8, yahooProj: 0, weeks: hot }), S);
  assert.equal(pc.rate, 0);
  assert.equal(pc.total, 0);
});

test("captured last week: Yahoo's total also covered the game since played, so the per-game base divides by it", () => {
  // Captured in week 7, now week 8, bye week 10: games 7..18 minus the bye = 11 → 143 / 11 = 13; weeks 8..17 show 9 games.
  const pc = perceive(vp("c", "WR", 10, 20, { bye: 10, yahooProj: 143, yahooProjWeek: 7 }), S);
  assert.equal(pc.base, 13);
  assert.equal(pc.total, 13 * 9);
  // Captured this week without this week's number: the whole total over weeks 8..18 minus the bye (10 games).
  assert.equal(perceive(vp("d", "WR", 10, 20, { bye: 10, yahooProj: 130, yahooProjWeek: 8 }), S).base, 13);
  // A this-week number captured LAST week is stale: the whole total spreads (no subtraction).
  assert.equal(perceive(vp("e", "WR", 10, 20, { bye: 10, yahooProj: 143, yahooProjWeek: 7, yahooProjWeekly: 30 }), S).base, 13);
});

test("coverage counts a this-week-only capture too (the headline never says 'not captured' while Yahoo numbers are used)", () => {
  const wkOnly = vp("w", "WR", 10, 20, { yahooProjWeekly: 14 });
  assert.deepEqual(yahooCoverage([wkOnly, vp("n", "RB", 8, 10)]), { captured: 1, total: 2 });
});

// Injured trade pieces fix round 2 (owner 2026-10-26): the partner's view takes the same scenario mix as ours.
const UNC = { week: null, confidence: "unknown" as const, reasons: [], absent: true, practiceUp: false, healthyRate: 20, tradeValue: 25, backWeekly: [0, 0, 0, 0, 20, 20, 20, 20, 20, 20] };
test("return unconfirmed: perceived weekly is his 'not back' scenario (0) on both sources; out for the season 0", () => {
  const est = perceive(vp("u1", "WR", 0, 0, { remainingGames: 0, ecrPts: 6, weekly: flat(0), weeklyFrom: 8, ret: UNC }), S);
  const yah = perceive(vp("u2", "WR", 0, 0, { remainingGames: 0, yahooProj: 0, weekly: flat(0), weeklyFrom: 8, ret: UNC }), S);
  assert.deepEqual(est.weekly, flat(0));
  assert.deepEqual(yah.weekly, est.weekly);
  const over = perceive(vp("u3", "WR", 0, 0, { remainingGames: 0, ecrPts: 6, weekly: flat(0), weeklyFrom: 8, ret: { ...UNC, seasonOver: true as const } }), S);
  assert.equal(over.total, 0, "out for the season: 0");
});

test("perceived lineup: an estimate-sourced unconfirmed return is ½ × lineup with him back + ½ × without; a Yahoo-sourced one counts at Yahoo's number", () => {
  const S2 = league([], ["QB", "WR", "BN", "IR"], { currentWeek: 8 }).settings;
  const qb = vp("qb", "QB", 18, 20, { weekly: flat(18), weeklyFrom: 8 });
  const wr = vp("wr", "WR", 9.6, 5, { weekly: flat(9.6), weeklyFrom: 8, ecrPts: 9.6 });
  const ret = { ...UNC, backWeekly: [0, 0, 0, 0, 12, 12, 12, 12, 12, 12] };
  const est = vp("ue", "WR", 0, 0, { remainingGames: 0, ecrPts: 6, weekly: flat(0), weeklyFrom: 8, ret });
  const yah = vp("uy", "WR", 0, 0, { remainingGames: 0, yahooProj: 0, weekly: flat(0), weeklyFrom: 8, ret });
  const before = perceivedLineupTotal(S2, [qb, wr]);
  // Weeks 12-17: back (12) beats wr (9.6) → ½ × 2.4 × 6 weeks = 7.2; a ½-rate player (6) would add 0.
  assert.ok(Math.abs(perceivedLineupTotal(S2, [qb, wr, est]) - before - 7.2) < 0.051);
  assert.ok(Math.abs(perceivedLineupTotal(S2, [qb, wr, est], new Set([est.id])) - before - 7.2) < 0.051, "in the IR slot");
  // Yahoo shows him at 0 for the rest of the season: Yahoo's evaluator adds nothing.
  assert.equal(perceivedLineupTotal(S2, [qb, wr, yah]), before);
  assert.equal(perceivedLineupTotal(S2, [qb, wr, { ...est, ret: { ...ret, seasonOver: true as const } }]), before, "out for the season: nothing");
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

// ---------------------------------------------------------------- Yahoo evaluator emulation (2026-10-30)

test("evaluator: this week is excluded (a trade processes next week), so a player who only scores this week adds nothing", () => {
  const S2 = league([], ["QB", "WR", "BN", "BN"], { currentWeek: 8 }).settings;
  const qb = vp("qb", "QB", 18, 20, { yahooProj: 220, yahooProjWeekly: 20 });
  const wr = vp("wr", "WR", 8, 5, { yahooProj: 88, yahooProjWeekly: 8 });
  // All of his 40 points are this week's: nothing left for weeks 9..18.
  const now = vp("now", "WR", 30, 5, { yahooProj: 40, yahooProjWeekly: 40 });
  assert.equal(perceptionOf(now, S2).weekly[0], 40, "this week's number is still his week-index-0 point");
  assert.equal(perceivedLineupTotal(S2, [qb, wr, now]), perceivedLineupTotal(S2, [qb, wr]));
  // Weeks 9..17 = 9 weeks; qb (220 − 20) / 10 games = 20, wr (88 − 8) / 10 = 8 → 28 × 9.
  assert.equal(evaluatorWeeks(S2), 9);
  assert.equal(perceivedLineupTotal(S2, [qb, wr]), 28 * 9);
});

test("evaluator: per-week optimal lineup, byes 0 — a backup starts in the starter's bye week", () => {
  const S2 = league([], ["QB", "WR", "BN", "BN"], { currentWeek: 8 }).settings;
  const qb = vp("qb", "QB", 18, 20, { bye: 7, yahooProj: 220, yahooProjWeekly: 20 }); // 20 / game, weeks 9..18
  const star = vp("star", "WR", 15, 30, { bye: 12, yahooProj: 150, yahooProjWeekly: 15 }); // 135 / 9 games = 15
  const back = vp("back", "WR", 6, 5, { bye: 7, yahooProj: 66, yahooProjWeekly: 6 }); // 60 / 10 games = 6
  assert.equal(perceptionOf(star, S2).weekly[12 - 8], 0, "bye");
  // Weeks 9..17: QB 20 × 9 + star 15 × 8 + the backup 6 in week 12.
  assert.equal(perceivedLineupTotal(S2, [qb, star]), 20 * 9 + 15 * 8);
  assert.equal(perceivedLineupTotal(S2, [qb, star, back]), 20 * 9 + 15 * 8 + 6);
});

test("evaluator spread: the schedule's last week (NFL week 18) bounds Yahoo's total, not the league's final week", () => {
  // KC plays every week 8..18 except a week-10 bye: 10 games; captured this week: (120 − 12) over weeks 9..18 = 9 games.
  const sched = new Map([["KC", new Map([8, 9, 11, 12, 13, 14, 15, 16, 17, 18].map((w) => [w, {}]))]]);
  const pc = perceive(vp("s", "WR", 10, 20, { yahooProj: 120, yahooProjWeekly: 12 }), S, scheduleCheck(sched));
  assert.equal(pc.base, 12);
  // Weeks 9..17 shown: 8 games × 12 (week 18 is outside the league's season).
  assert.equal(pc.weekly.slice(1).reduce((a, v) => a + v, 0), 96);
  // Without a schedule the bye-only check runs to week 18 as well.
  assert.equal(perceive(vp("b", "WR", 10, 20, { bye: 10, yahooProj: 120, yahooProjWeekly: 12 }), S).base, 12);
});
