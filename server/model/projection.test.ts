import { test } from "node:test";
import assert from "node:assert/strict";
import { curveAt, ecrCurve, injuryKind, replacementRanks, smooth } from "./projection.js";

test("smooth / curveAt helpers", () => {
  assert.deepEqual(smooth([3, 2, 1]), [2.5, 2, 1.5]);
  assert.equal(curveAt([10, 8, 6], 1.5), 9);
  assert.equal(curveAt([10, 8, 6], 99), 6);
  assert.equal(curveAt([], 3), 0);
});

test("ECR curve: half this season, half last season, current capped at 1.15× prior, smoothed", () => {
  // Linear curves: smoothing is exact inside.
  const cur = [30, 20, 25, 15, 10];
  const prior = [20, 18, 16, 14, 12];
  const c = ecrCurve(cur, prior);
  // Sorted current 30, 25, …; rank 1: 30 capped to 23 → (23 + 20) / 2 = 21.5; rank 2: 25 capped to 20.7 → 19.35.
  assert.ok(Math.abs(c[0] - (21.5 + 19.35) / 2) < 1e-9, String(c[0]));
  assert.equal(c.length, 5);
  assert.deepEqual(ecrCurve([5, 4], []), smooth([5, 4]));
  assert.deepEqual(ecrCurve([], []), []);
});

test("replacement ranks per position (12 teams, 1 QB, 2 RB, 2 WR, TE, FLEX)", () => {
  const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "IR"] as const;
  assert.deepEqual(replacementRanks([...slots], 12), { QB: 14, RB: 35, WR: 35, TE: 16, K: 12, DEF: 12 });
});

test("injury classification: long-term, designated to return, out, doubtful", () => {
  assert.equal(injuryKind({ status: "Out", detail: "NA", week: 3 }), "long");
  assert.equal(injuryKind({ status: "Out", detail: "NA (not with team)", week: 3 }), "long");
  assert.equal(injuryKind({ status: "NA", week: 3 }), "long");
  assert.equal(injuryKind({ status: "IR", week: 3 }), "long");
  assert.equal(injuryKind({ status: "Out", detail: "ACL", week: 3 }), "long");
  assert.equal(injuryKind({ status: "Out", detail: "return designation", week: 3 }), "return");
  assert.equal(injuryKind({ status: "IR-R", week: 3 }), "return");
  assert.equal(injuryKind({ status: "Out", detail: "IR (return designation)", week: 3 }), "long");
  assert.equal(injuryKind({ status: "Out", detail: "Hamstring", week: 3 }), "out");
  assert.equal(injuryKind({ status: "Doubtful", week: 3 }), "doubtful");
  assert.equal(injuryKind({ status: "Questionable", detail: "ACL", week: 3 }), null);
  assert.equal(injuryKind(undefined), null);
});
