import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordGame } from "../../../server/model/matchup";
import { callMark, incompleteLabel, notRecorded, orientGame, pair, pairOrDash, recordPair, recordIncompleteLabel, winPcts } from "./matchupView";

test("record (fix round 1): orientGame swaps every pair; an incomplete week is not 'not recorded'; n starters not projected", () => {
  const g: RecordGame = { teams: ["2", "1"], mine: true, ours: [null, 120], yahoo: [null, 110], yahooPage: [91, 111], oursMissing: [3, 0], yahooMissing: [4, 0], points: [95, 130], oursCall: null, yahooCall: null };
  const o = orientGame(g, "1");
  assert.deepEqual([o.yahooPage, o.oursMissing, o.yahooMissing], [[111, 91], [0, 3], [0, 4]]);
  assert.equal(notRecorded({ ours: [null, null], oursMissing: [9, 9] }), false, "captured week, starters missing");
  assert.equal(notRecorded({ ours: [null, null], oursMissing: [0, 0] }), true, "week never captured");
  assert.equal(recordIncompleteLabel(g), "4 starters not projected");
  assert.equal(recordIncompleteLabel({ oursMissing: [0, 0], yahooMissing: [0, 0] }), null);
});

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
  const g: RecordGame = { teams: ["2", "1"], mine: true, ours: [100, 120], yahoo: [90, 110], yahooPage: [90, 110], oursMissing: [0, 0], yahooMissing: [0, 0], points: [95, 130], oursCall: true, yahooCall: false };
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

test("recordPair: complete pair, 'n not projected' when starters are missing, a single dash otherwise", () => {
  assert.equal(recordPair([128.44, 121], [0, 0]), "128.4 – 121.0");
  assert.equal(recordPair([null, 121], [2, 0]), "2 not projected");
  assert.equal(recordPair([null, null], [0, 3]), "3 not projected");
  assert.equal(recordPair([null, 121], [0, 0]), "–");
});

test("pairOrDash collapses any unknown side to one dash", () => {
  assert.equal(pairOrDash(null, 121), "–");
  assert.equal(pairOrDash(110, undefined), "–");
  assert.equal(pairOrDash(110.04, 121), "110.0 – 121.0");
});
