import { test } from "node:test";
import assert from "node:assert/strict";
import { riskFactor } from "./injuryRisk.js";
import { vp } from "./testkit.js";

test("riskFactor: Q 0.85 / D 0.70 / O 0.55 / healthy 1", () => {
  assert.equal(riskFactor(vp("q", "WR", 10, 10, { injury: { status: "Q", week: 4 } })), 0.85);
  assert.equal(riskFactor(vp("d", "WR", 10, 10, { injury: { status: "Doubtful", week: 4 } })), 0.7);
  assert.equal(riskFactor(vp("o", "WR", 10, 10, { injury: { status: "O", week: 4 } })), 0.55);
  assert.equal(riskFactor(vp("h", "WR", 10, 10)), 1);
});
