import { test } from "node:test";
import assert from "node:assert/strict";
import { DEPTH_WEIGHT, teamStrength } from "./teamStrength.js";
import { league, vp } from "./testkit.js";
import type { SlotKind, ValuedPlayer } from "./types.js";

// Week 8 of a season whose playoffs run 15-17; weekly points start at week 8.
const SLOTS: SlotKind[] = ["QB", "RB", "WR", "FLEX", "BN", "BN", "IR"];
const S = league([], SLOTS, { currentWeek: 8 }).settings;
/** A player scoring `pts` every week 8..17 except the listed weeks (0). */
const P = (id: string, pos: ValuedPlayer["pos"], pts: number, zero: number[] = []) =>
  vp(id, pos, pts, 10, { weeklyFrom: 8, weekly: Array.from({ length: 10 }, (_, i) => (zero.includes(8 + i) ? 0 : pts)) });

test("lineup = mean optimal playoff-week lineup; a playoff bye costs that week", () => {
  const roster = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("wr2", "WR", 10)];
  const t = teamStrength(S, roster);
  assert.deepEqual(t.weeks, [15, 16, 17]);
  assert.equal(t.lineup, 59);
  const bye = teamStrength(S, [P("qb", "QB", 20), P("rb", "RB", 15, [16]), P("wr", "WR", 14), P("wr2", "WR", 10)]);
  assert.equal(bye.lineup, 59 - 15 / 3);
});

test("depth: bench points recovered when one random starter is out; total = lineup + 0.25 × depth", () => {
  const thin = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("wr2", "WR", 10)];
  // No bench: losing any starter recovers nothing.
  assert.equal(teamStrength(S, thin).depth, 0);
  const deep = [...thin, P("rb2", "RB", 9)];
  const t = teamStrength(S, deep);
  // Starters QB 20, RB 15, WR 14, FLEX WR2 10 (rb2 9 on the bench). Out QB: nobody covers (0). Out RB: rb2 → +9.
  // Out WR: wr2 moves to WR, rb2 FLEX → +9. Out FLEX wr2: rb2 → +9. Mean = 27 / 4 = 6.75.
  assert.equal(t.depth, 6.8);
  assert.equal(t.total, Math.round((59 + DEPTH_WEIGHT * 6.75) * 10) / 10);
});

test("IR-slot players never count; after the season everything is 0", () => {
  const roster = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("star", "WR", 30)];
  const withIr = teamStrength(S, roster, new Set(["star"]));
  assert.equal(withIr.lineup, 49);
  assert.equal(teamStrength(S, roster).lineup, 79);
  const late = league([], SLOTS, { currentWeek: 18 }).settings;
  assert.deepEqual(teamStrength(late, roster), { lineup: 0, depth: 0, total: 0, weeks: [] });
});

// Injured trade pieces fix round 1 (owner 2026-10-26): a returner counts at his expected availability in the playoffs.
const back = (id: string, pts: number, week: number) =>
  P(id, "WR", pts, Array.from({ length: week - 8 }, (_, i) => 8 + i));
test("IR slot: a player back ~wk 12 counts in the playoff lineup from his return (he leaves the IR slot); out for the season or no return estimate never", () => {
  const base = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("wr2", "WR", 10)];
  const star = back("star", 30, 12);
  star.ret = { week: 12, confidence: "medium", reasons: [], absent: true, practiceUp: false };
  const ir = new Set(["star"]);
  // Playoff lineup: QB 20 + RB 15 + WR star 30 + FLEX wr 14 = 79 (wr2 to the bench).
  assert.equal(teamStrength(S, [...base, star], ir).lineup, 79);
  const done = { ...star, ret: { ...star.ret, seasonOver: true as const } };
  assert.equal(teamStrength(S, [...base, done], ir).lineup, 59, "out for the season: never");
  const { ret: _r, ...noRet } = star;
  assert.equal(teamStrength(S, [...base, noRet], ir).lineup, 59, "no return estimate: never");
});

test("return unconfirmed: ½ × healthy rate from week current + 4 (ret.expWeekly), in or out of the IR slot", () => {
  const base = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("wr2", "WR", 10)];
  const unk = vp("unk", "WR", 0, 0, {
    remainingGames: 0, weeklyFrom: 8, weekly: Array(10).fill(0),
    ret: { week: null, confidence: "unknown", reasons: [], absent: true, practiceUp: false, healthyRate: 28, tradeValue: 30, expWeekly: [0, 0, 0, 0, 14, 14, 14, 14, 14, 14] },
  });
  // Playoffs: unk 14 beats wr2 10 at FLEX → +4 per week.
  assert.equal(teamStrength(S, [...base, unk]).lineup, 63);
  assert.equal(teamStrength(S, [...base, unk], new Set(["unk"])).lineup, 63);
  // Fixture without expWeekly: the same convention from the healthy rate (byes 0).
  const { expWeekly: _e, ...ret } = unk.ret!;
  assert.equal(teamStrength(S, [...base, { ...unk, ret }]).lineup, 63);
  assert.equal(teamStrength(S, [...base, { ...unk, ret: { ...ret, seasonOver: true as const } }]).lineup, 59);
});
