import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAllSignals, computePlayerSignals } from "./index.js";
import { ASOF, fixtureInputs, IDS, PPR } from "../../data/fixtures/signals2026.js";

const ctx = { season: 2026, scoring: PPR, asOf: ASOF };

test("CHI TE with backup QBs weeks 3-5: recency-weighted rate above his plain season average", () => {
  const s = computePlayerSignals(fixtureInputs().get(IDS.loveland)!, ctx);
  assert.deepEqual(s.weeks.filter((w) => w.flags.qbOut).map((w) => w.week), [3, 4, 5]);
  assert.ok(s.rates.expPts! > s.seasonAvg.expPts!, `${s.rates.expPts} vs ${s.seasonAvg.expPts}`);
  assert.ok(s.rates.targetShare! > s.seasonAvg.targetShare!);
  assert.ok(s.rates.wopr! > s.seasonAvg.wopr!);
});

test("RB with ≥ 50% snaps vs one below (Swift vs Monangai, CHI 2026)", () => {
  const all = computeAllSignals(fixtureInputs().values(), ctx);
  const swift = all.get(IDS.swift)!;
  const mona = all.get(IDS.monangai)!;
  assert.equal(swift.halfSnaps, true);
  assert.equal(mona.halfSnaps, false);
  assert.ok(swift.rates.snapShare! >= 0.5 && mona.rates.snapShare! < 0.5);
  assert.equal(mona.rosterStatus, "INA");
  assert.deepEqual(mona.status.filter((w) => w.report === "Out").map((w) => w.week), [5, 6, 7]);
});

test("batch covers every skill player in the inputs, and unknown snaps give halfSnaps null", () => {
  const inputs = fixtureInputs();
  const all = computeAllSignals(inputs.values(), ctx);
  assert.equal(all.size, inputs.size);
  const p = { ...inputs.get(IDS.tucker)!, games: inputs.get(IDS.tucker)!.games.map((g) => ({ ...g, snapShare: undefined })) };
  assert.equal(computePlayerSignals(p, ctx).halfSnaps, null);
});
