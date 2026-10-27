import { test } from "node:test";
import assert from "node:assert/strict";
import { contextFlags, isFlagged, usualStarter } from "./context.js";
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
