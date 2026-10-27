import { test } from "node:test";
import assert from "node:assert/strict";
import { plainMean, recencyWeights, weightedRate } from "./recency.js";

test("half-life 2 games: over 7 unflagged games the last 3 carry ~70%", () => {
  const w = recencyWeights(Array(7).fill(false));
  assert.equal(w[6], 1);
  assert.ok(Math.abs(w[4] - 0.5) < 1e-12);
  const share = (w[4] + w[5] + w[6]) / w.reduce((a, b) => a + b, 0);
  assert.ok(share > 0.69 && share < 0.73, `share ${share}`);
});

test("flagged games weigh 0.25 of their recency weight", () => {
  const w = recencyWeights([false, true, false]);
  assert.ok(Math.abs(w[1] - 0.25 * Math.SQRT1_2) < 1e-12);
});

test("weighted rate skips unknown values; no data → null", () => {
  assert.equal(weightedRate([undefined, 4], [1, 1]), 4);
  assert.equal(weightedRate([undefined], [1]), null);
  assert.equal(plainMean([2, 4, undefined]), 3);
});
