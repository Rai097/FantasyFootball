import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAllSignals, computePlayerSignals } from "./index.js";
import { flexLevels, FLEX_RANK, slope, stdDev, trendOf } from "./trend.js";
import { ASOF, fixtureInputs, IDS, PPR } from "../../data/fixtures/signals2026.js";

test("rising-trend WR (KC Concepcion, WOPR up over real weeks 5-7, above a flex level) → rising", () => {
  const ctx = { season: 2026, scoring: PPR, asOf: ASOF, flexLevels: { WR: 0.46 } };
  const s = computePlayerSignals(fixtureInputs().get(IDS.concepcion)!, ctx);
  const last3 = s.weeks.slice(-3);
  assert.ok(last3[0].wopr! < last3[1].wopr! && last3[1].wopr! < last3[2].wopr!);
  assert.deepEqual(s.trend!.weeks, [5, 6, 7]);
  assert.equal(s.trend!.metric, "wopr");
  assert.ok(s.trend!.slope >= s.trend!.std, `slope ${s.trend!.slope} vs std ${s.trend!.std}`);
  assert.equal(s.trend!.rising, true);
  // Same player without a flex level (single computation, no batch) → never rising (fail closed).
  assert.equal(computePlayerSignals(fixtureInputs().get(IDS.concepcion)!, { season: 2026, scoring: PPR, asOf: ASOF }).trend!.rising, false);
});

test("slope = OLS; 3 points → (last − first)/2; std-dev is the population std", () => {
  assert.equal(slope([1, 5, 3]), 1);
  assert.equal(slope([0.2, 0.2, 0.2]), 0);
  assert.equal(stdDev([2, 4]), 1);
  assert.equal(stdDev([3]), 0);
});

const w = (week: number, wopr: number, flagged = false) => ({ week, flagged, wopr, weightedOpp: 0 });
const r = (week: number, weightedOpp: number) => ({ week, flagged: false, weightedOpp });

test("trend uses the last 3 UNFLAGGED games; < 3 → null; QBs → null", () => {
  const t = trendOf([w(1, 0.3), w(2, 0.4), w(3, 0.5), w(4, 0.0, true)], "WR", 0.4)!;
  assert.deepEqual(t.weeks, [1, 2, 3]);
  assert.ok(Math.abs(t.slope - 0.1) < 1e-12 && t.rising);
  assert.equal(trendOf([w(1, 0.1), w(2, 0.4, true), w(3, 0.5)], "WR", 0.4), null);
  assert.equal(trendOf([w(1, 0.1), w(2, 0.2), w(3, 0.3)], "QB", 0.1), null);
});

test("rising needs both steps up, slope ≥ 1.0 × his weekly std-dev, and the latest value at flex level", () => {
  // Both steps up, big vs his noise, above flex → rising.
  assert.equal(trendOf([r(1, 12), r(2, 12.5), r(3, 12), r(4, 14), r(5, 17), r(6, 21)], "RB", 15)!.rising, true);
  // Up then down: one step up only.
  assert.equal(trendOf([r(1, 10), r(2, 20), r(3, 19)], "RB", 15)!.rising, false);
  // A volatile player: the same +2/game inside a ±6 weekly swing is noise.
  const noisy = trendOf([r(1, 30), r(2, 12), r(3, 28), r(4, 14), r(5, 16), r(6, 18)], "RB", 15)!;
  assert.ok(noisy.slope < noisy.std);
  assert.equal(noisy.rising, false);
  // Part-timer rising from 3 to 7: below the flex level.
  assert.equal(trendOf([r(1, 3), r(2, 5), r(3, 7)], "RB", 15)!.rising, false);
  // No flex level known → never rising.
  assert.equal(trendOf([r(1, 12), r(2, 16), r(3, 21)], "RB")!.rising, false);
});

test("flex levels: the FLEX_RANK-th highest metric rate among players with ≥ 3 games; too few players → none", () => {
  const wrs = Array.from({ length: FLEX_RANK.WR + 5 }, (_, i) => ({ pos: "WR" as const, rate: 1 - i / 100, games: 4 }));
  const lv = flexLevels([...wrs, { pos: "WR", rate: 5, games: 2 }, { pos: "RB", rate: 20, games: 5 }]);
  assert.ok(Math.abs(lv.WR! - (1 - (FLEX_RANK.WR - 1) / 100)) < 1e-12, "a 2-game player does not count");
  assert.equal(lv.RB, undefined);
});

test("batch sets flex levels from the batch itself (fixture: too few players per position → nobody rising)", () => {
  const all = computeAllSignals(fixtureInputs().values(), { season: 2026, scoring: PPR, asOf: ASOF });
  for (const s of all.values()) if (s.trend) assert.equal(s.trend.rising, false, s.name);
});
