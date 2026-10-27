import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlayerSignals } from "./index.js";
import { luckOf } from "./luck.js";
import { ASOF, fixtureInputs, IDS, PPR } from "../../data/fixtures/signals2026.js";

const ctx = { season: 2026, scoring: PPR, asOf: ASOF };

test("TD-spike WR (Tre Tucker, real 2026 weeks 1-7): luck negative and TD-driven", () => {
  const s = computePlayerSignals(fixtureInputs().get(IDS.tucker)!, ctx);
  const l = s.luck!;
  assert.ok(l.tdsOverExpected > 1.5, `TDs over expected ${l.tdsOverExpected}`);
  assert.ok(l.points < -2, `luck ${l.points}`);
  assert.equal(l.driver, "td");
  assert.ok(l.tdPart < 0 && Math.abs(l.tdPart) > Math.abs(l.yardagePart));
  assert.ok(Math.abs(l.tdPart + l.yardagePart - l.points) < 1e-9);
});

test("no games → no luck", () => {
  assert.equal(luckOf([], PPR), null);
});
