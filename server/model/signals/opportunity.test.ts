import { test } from "node:test";
import assert from "node:assert/strict";
import { targetWeight, weekOpportunity, WOPR } from "./opportunity.js";
import { fixtureInputs, IDS, PPR } from "../../data/fixtures/signals2026.js";

const HALF = { ...PPR, rec: 0.5 };

test("WOPR = 1.5·target share + 0.7·air-yards share from team totals (Concepcion, CLE week 7, real rows)", () => {
  const g = fixtureInputs().get(IDS.concepcion)!.games.find((x) => x.week === 7)!;
  const o = weekOpportunity(g, "WR", PPR);
  assert.equal(o.targetShare, g.targets / g.teamTotals!.targets);
  assert.equal(o.airShare, g.airYards / g.teamTotals!.airYards);
  assert.ok(Math.abs(o.wopr! - (WOPR.target * o.targetShare! + WOPR.air * o.airShare!)) < 1e-12);
  assert.ok(o.wopr! > 0.6, `WOPR ${o.wopr}`);
});

test("missing team totals → shares unknown (undefined), never 0", () => {
  const g = { ...fixtureInputs().get(IDS.concepcion)!.games[0], teamTotals: undefined };
  const o = weekOpportunity(g, "WR", PPR);
  assert.equal(o.targetShare, undefined);
  assert.equal(o.wopr, undefined);
});

test("scoring.rec 0.5 vs 1.0 changes RB weighted opportunity and expected points (Swift, real weeks)", () => {
  assert.equal(targetWeight(PPR), 2.8);
  assert.ok(Math.abs(targetWeight(HALF) - 2.1) < 1e-12);
  const swift = fixtureInputs().get(IDS.swift)!;
  const g = swift.games.find((x) => x.targets > 0)!;
  const full = weekOpportunity(g, "RB", PPR);
  const half = weekOpportunity(g, "RB", HALF);
  assert.ok(Math.abs(full.weightedOpp - (g.carries + 2.8 * g.targets)) < 1e-9);
  assert.ok(Math.abs(half.weightedOpp - (g.carries + 2.1 * g.targets)) < 1e-9);
  assert.ok(full.weightedOpp > half.weightedOpp);
  // expected points come from the components under the league's scoring: the gap is 0.5 per expected catch
  assert.ok(Math.abs(full.expPts - half.expPts - 0.5 * g.expected.rec) < 1e-9);
  assert.ok(g.expected.rec > 0);
});
