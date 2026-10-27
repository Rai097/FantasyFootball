import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlayerSignals } from "./index.js";
import { slope, trendOf } from "./trend.js";
import { ASOF, fixtureInputs, IDS, PPR } from "../../data/fixtures/signals2026.js";

test("rising-trend WR (KC Concepcion, target share up over real weeks 5-7) → rising", () => {
  const s = computePlayerSignals(fixtureInputs().get(IDS.concepcion)!, { season: 2026, scoring: PPR, asOf: ASOF });
  const last3 = s.weeks.slice(-3);
  assert.ok(last3[0].targetShare! < last3[1].targetShare! && last3[1].targetShare! < last3[2].targetShare!);
  assert.deepEqual(s.trend!.weeks, [5, 6, 7]);
  assert.equal(s.trend!.metric, "wopr");
  assert.ok(s.trend!.slope >= 0.03);
  assert.equal(s.trend!.rising, true);
});

test("slope = OLS; 3 points → (last − first)/2", () => {
  assert.equal(slope([1, 5, 3]), 1);
  assert.equal(slope([0.2, 0.2, 0.2]), 0);
});

test("trend uses the last 3 UNFLAGGED games; < 3 → null; QBs → null", () => {
  const w = (week: number, wopr: number, flagged = false) => ({ week, flagged, wopr, weightedOpp: 0 });
  const t = trendOf([w(1, 0.1), w(2, 0.2), w(3, 0.3), w(4, 0.0, true)], "WR")!;
  assert.deepEqual(t.weeks, [1, 2, 3]);
  assert.ok(Math.abs(t.slope - 0.1) < 1e-12 && t.rising);
  assert.equal(trendOf([w(1, 0.1), w(2, 0.4, true), w(3, 0.5)], "WR"), null);
  assert.equal(trendOf([w(1, 0.1), w(2, 0.2), w(3, 0.3)], "QB"), null);
});

test("RB trend on weighted opportunity: rising at ≥ +1.5 per game", () => {
  const w = (week: number, weightedOpp: number) => ({ week, flagged: false, weightedOpp });
  assert.equal(trendOf([w(1, 10), w(2, 11), w(3, 13)], "RB")!.rising, true);
  assert.equal(trendOf([w(1, 10), w(2, 11), w(3, 12.9)], "RB")!.rising, false);
});
