import { test } from "node:test";
import assert from "node:assert/strict";
import { contextFlags, isFlagged, usualStarter, usualStarters } from "./context.js";
import { fixtureInputs, IDS } from "../../data/fixtures/signals2026.js";
import type { PlayerGame } from "./types.js";

test("CHI: usual starter missed weeks 3-5 (backups in games.csv) → qbOut true exactly those weeks for the TE", () => {
  const lv = fixtureInputs().get(IDS.loveland)!;
  const f = contextFlags(lv.games, "TE");
  assert.deepEqual(f.map((x) => x.qbOut), [false, false, true, true, true, false, false]);
  // blowouts (|margin| ≥ 21): week 1 won by 22, week 5 lost by 24
  assert.deepEqual(f.map((x) => x.blowout), [true, false, false, false, true, false, false]);
  assert.deepEqual(f.map(isFlagged), [true, false, true, true, true, false, false]);
});

test("a QB's own starts are never flagged qbOut", () => {
  const lv = fixtureInputs().get(IDS.loveland)!;
  assert.ok(contextFlags(lv.games, "QB").every((x) => !x.qbOut));
});

const g = (week: number, snapShare?: number): PlayerGame => ({
  week, gameId: `g${week}`, team: "X", targets: 0, carries: 0, airYards: 0, passAttempts: 0,
  actual: { passYd: 0, passTd: 0, passInt: 0, rushYd: 0, rushTd: 0, rec: 0, recYd: 0, recTd: 0, twoPt: 0, fumLost: 0 },
  expected: { passYd: 0, passTd: 0, passInt: 0, rushYd: 0, rushTd: 0, rec: 0, recYd: 0, recTd: 0, twoPt: 0, fumLost: 0 },
  snapShare,
});

test("leftEarly: < 15% snaps after a ≥ 50% average before; not for part-timers, the first game or unknown snaps", () => {
  assert.deepEqual(contextFlags([g(1, 0.7), g(2, 0.6), g(3, 0.1)], "WR").map((x) => x.leftEarly), [false, false, true]);
  assert.deepEqual(contextFlags([g(1, 0.3), g(2, 0.4), g(3, 0.1)], "WR").map((x) => x.leftEarly), [false, false, false]);
  assert.deepEqual(contextFlags([g(1, 0.1)], "WR").map((x) => x.leftEarly), [false]);
  assert.deepEqual(contextFlags([g(1, 0.7), g(2, undefined)], "WR").map((x) => x.leftEarly), [false, false]);
});

test("usual starter: most starts; a tie goes to the earlier starter", () => {
  assert.equal(usualStarter([{ week: 1, qbId: "a" }, { week: 2, qbId: "b" }, { week: 3, qbId: "b" }]), "b");
  assert.equal(usualStarter([{ week: 2, qbId: "b" }, { week: 1, qbId: "a" }, { week: 3, qbId: "b" }, { week: 4, qbId: "a" }]), "a");
  assert.equal(usualStarter([]), undefined);
});

const starts = (ids: string) => [...ids].map((qbId, i) => ({ week: i + 1, qbId }));

test("usual starters: most frequent ∪ ≥ 3 of the last 4 ∪ opener-and-latest (returning starter)", () => {
  // SEA 2026 shape: A, then five B starts, then A returns → both usual, nothing flagged.
  assert.deepEqual(usualStarters(starts("ABBBBBA")), ["A", "B"]);
  // CHI 2026 shape: A A B B C A A → only A; B and C starts (weeks 3-5) stay qbOut.
  assert.deepEqual(usualStarters(starts("AABBCAA")), ["A"]);
  // A change of starter: A A A A B B B → A (most) and B (3 of the last 4).
  assert.deepEqual(usualStarters(starts("AAAABBB")), ["A", "B"]);
  // A one-week fill-in mid-season is still flagged.
  assert.deepEqual(usualStarters(starts("AAABAAA")), ["A"]);
  assert.deepEqual(usualStarters([]), []);
  // Platoon: a QB with ≥ 40% of the team's starts is usual.
  assert.deepEqual(usualStarters(starts("ABABABAB")), ["A", "B"]);
  assert.deepEqual(usualStarters(starts("AABABAAB")), ["A"], "3 of 8 = 37.5% is below the platoon share");
  assert.deepEqual(usualStarters(starts("ABAABBAAAB")), ["A", "B"], "4 of 10 = 40% is a platoon");
});

test("SEA-shaped games: a returning starter's weeks 1 and 7 are not qbOut for a WR", () => {
  const seq = "ABBBBBA";
  const usualQbIds = usualStarters(starts(seq));
  const games = [...seq].map((qb, i) => ({ ...g(i + 1, 0.8), starterQbId: qb, usualQbIds }));
  assert.ok(contextFlags(games, "WR").every((f) => !f.qbOut));
  const chi = [..."AABBCAA"].map((qb, i) => ({ ...g(i + 1, 0.8), starterQbId: qb, usualQbIds: usualStarters(starts("AABBCAA")) }));
  assert.deepEqual(contextFlags(chi, "TE").map((f) => f.qbOut), [false, false, true, true, true, false, false]);
});
