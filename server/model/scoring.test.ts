import { test } from "node:test";
import assert from "node:assert/strict";
import { HALF_PPR, recFormat, score } from "./scoring.js";
import { line } from "./testkit.js";

test("half-PPR receiving line", () => {
  // 6 rec, 80 yds, 1 TD = 3 + 8 + 6
  assert.equal(score(HALF_PPR, line({ rec: 6, recYd: 80, recTd: 1 }), "WR"), 17);
});

test("QB passing + rushing line", () => {
  // 300 yds (12) + 2 TD (8) - 1 INT + 40 rush yds (4) + 1 rush TD (6) + 2pt (2) - fumble (2)
  const pts = score(HALF_PPR, line({ passYd: 300, passTd: 2, passInt: 1, rushYd: 40, rushTd: 1, twoPt: 1, fumLost: 1 }), "QB");
  assert.ok(Math.abs(pts - 29) < 1e-9, `got ${pts}`);
});

test("TE premium only applies to tight ends", () => {
  const s = { ...HALF_PPR, teRec: 0.5 };
  const l = line({ rec: 4, recYd: 40 });
  assert.equal(score(s, l, "TE"), 8); // 4*(0.5+0.5) + 4
  assert.equal(score(s, l, "WR"), 6);
});

test("empty line scores zero and format buckets", () => {
  assert.equal(score(HALF_PPR, line()), 0);
  assert.equal(recFormat(HALF_PPR), "half");
  assert.equal(recFormat({ ...HALF_PPR, rec: 1 }), "ppr");
  assert.equal(recFormat({ ...HALF_PPR, rec: 0 }), "std");
});
