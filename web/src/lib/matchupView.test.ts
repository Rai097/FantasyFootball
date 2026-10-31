import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordGame } from "../../../server/model/matchup";
import { callMark, incompleteLabel, notRecorded, orientGame, pair, winPcts } from "./matchupView";

test("incompleteLabel pluralises and hides when complete", () => {
  assert.equal(incompleteLabel(0), null);
  assert.equal(incompleteLabel(1), "1 starter not projected");
  assert.equal(incompleteLabel(3), "3 starters not projected");
});

test("callMark and pair never show a missing number as 0", () => {
  assert.equal(callMark(true), "✓");
  assert.equal(callMark(false), "✗");
  assert.equal(callMark(null), "—");
  assert.equal(pair(128.44, null), "128.4 – —");
});

test("winPcts sums to 100 and is null when unknown", () => {
  assert.deepEqual(winPcts(0.625), ["63%", "37%"]);
  assert.equal(winPcts(null), null);
});

test("orientGame puts the request team first", () => {
  const g: RecordGame = { teams: ["2", "1"], mine: true, ours: [100, 120], yahoo: [90, 110], points: [95, 130], oursCall: true, yahooCall: false };
  const o = orientGame(g, "1");
  assert.deepEqual(o.teams, ["1", "2"]);
  assert.deepEqual(o.ours, [120, 100]);
  assert.deepEqual(o.points, [130, 95]);
  assert.equal(o.oursCall, true);
  assert.deepEqual(orientGame({ ...g, mine: false }, "1").teams, ["2", "1"]);
});

test("notRecorded: ours unknown on both sides", () => {
  assert.equal(notRecorded({ ours: [null, null] }), true);
  assert.equal(notRecorded({ ours: [100, null] }), false);
});
