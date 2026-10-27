import { test } from "node:test";
import assert from "node:assert/strict";
import { LUCK_LABEL, luckLabel, luckText, marketTag } from "./labels.js";

test("buy-low at luck ≥ +2.0 pts/g (any driver); sell-high only at ≤ −2.0 with TDs dominant", () => {
  assert.equal(luckLabel({ points: 2.0, driver: "yardage" }, 5), "buy-low");
  assert.equal(luckLabel({ points: 3.1, driver: "td" }, 5), "buy-low");
  assert.equal(luckLabel({ points: 1.9, driver: "yardage" }, 5), null);
  assert.equal(luckLabel({ points: -2.5, driver: "td" }, 5), "sell-high");
  assert.equal(luckLabel({ points: -2.5, driver: "yardage" }, 5), null, "over-producing on yardage is skill, not a sell-high");
  assert.equal(luckLabel({ points: -1.5, driver: "td" }, 5), null);
});

test("no label with too few games or unknown luck", () => {
  assert.equal(luckLabel({ points: 5, driver: "td" }, LUCK_LABEL.minGames - 0.5), null);
  assert.equal(luckLabel(null, 8), null);
  assert.equal(luckLabel({ points: NaN, driver: "td" }, 8), null);
});

test("market tags at |edge| ≥ 8; text stays one short idea", () => {
  assert.equal(marketTag(8), "market undervalues");
  assert.equal(marketTag(-9.5), "market overvalues");
  assert.equal(marketTag(7.9), null);
  assert.equal(marketTag(undefined), null);
  for (const s of [luckText(2.4, "buy-low"), luckText(-3.1, "sell-high"), luckText(0.4, null), luckText(-0.4, null)]) assert.ok(s.length <= 90 && !s.includes(";"), s);
  assert.match(luckText(2.4, "buy-low"), /^\+2\.4 pts\/g/);
});
