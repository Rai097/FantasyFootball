import { test } from "node:test";
import assert from "node:assert/strict";
import { ageAt, talentPrior } from "./talent.js";
import { ASOF, fixtureInputs, IDS, PPR } from "../../data/fixtures/signals2026.js";

test("rookie draft capital and age (KC Concepcion: 2026 rookie, pick 24, born 2004-09-24)", () => {
  const p = fixtureInputs().get(IDS.concepcion)!;
  const t = talentPrior("WR", p.prior, p.roster, 2026, ASOF, PPR);
  assert.equal(t.rookie, true);
  assert.equal(t.draftNumber, 24);
  assert.equal(t.age, 22.1);
  assert.equal(t.ageRising, true);
  assert.equal(t.priorGames, 0);
  assert.equal(t.priorExpPpg, null, "no prior season = unknown, not 0");
});

test("last season expected / actual per game under league scoring (Loveland 2025 weeks 1-3)", () => {
  const p = fixtureInputs().get(IDS.loveland)!;
  const t = talentPrior("TE", p.prior, p.roster, 2026, ASOF, PPR);
  assert.equal(t.priorGames, 3);
  assert.ok(t.priorExpPpg! > 0 && t.priorActPpg !== null);
  assert.equal(t.rookie, false);
  assert.equal(t.draftNumber, null);
});

test("unknown birth date → age null", () => {
  assert.equal(ageAt(undefined, ASOF), null);
  assert.equal(ageAt("not a date", ASOF), null);
});
