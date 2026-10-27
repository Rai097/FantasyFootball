import { test } from "node:test";
import assert from "node:assert/strict";
import { efficiencyOf, SHRINK_K } from "./efficiency.js";

const games = (n: number, exp: number, act: number) => Array.from({ length: n }, () => ({ expPts: exp, actPts: act, weight: 1 }));

test("shrinkage: (n·raw + k)/(n + k) with k = 6 — more games, less shrink", () => {
  const two = efficiencyOf(games(2, 10, 12), "WR")!;
  assert.ok(Math.abs(two.raw - 1.2) < 1e-12);
  assert.ok(Math.abs(two.shrunk - (2 * 1.2 + SHRINK_K) / (2 + SHRINK_K)) < 1e-12);
  const twelve = efficiencyOf(games(12, 10, 12), "WR")!;
  assert.ok(twelve.shrunk > two.shrunk && twelve.shrunk < 1.2);
});

test("per-position caps: RB/TE 0.75-1.35, WR 0.8-1.3, QB 0.85-1.2", () => {
  assert.equal(efficiencyOf(games(60, 10, 30), "QB")!.shrunk, 1.2);
  assert.equal(efficiencyOf(games(60, 10, 30), "WR")!.shrunk, 1.3);
  assert.equal(efficiencyOf(games(60, 10, 30), "TE")!.shrunk, 1.35);
  assert.equal(efficiencyOf(games(60, 10, 0), "RB")!.shrunk, 0.75);
  assert.equal(efficiencyOf(games(60, 10, 0), "WR")!.shrunk, 0.8);
});

test("too little expected volume → null", () => {
  assert.equal(efficiencyOf(games(3, 0.2, 5), "WR"), null);
  assert.equal(efficiencyOf([], "WR"), null);
});
