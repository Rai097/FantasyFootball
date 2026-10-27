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
