// Adversarial tests for perceived value (Model v4 release (d), perception.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { perceive } from "./perception.js";
import { acceptanceV4, type AcceptFactors } from "./tradesV3.js";
import { league, line, vp } from "./testkit.js";
import type { WeekLine } from "./types.js";

// Week 8 of a 17-week season: weeks 8..17 = 10 remaining weeks.
const S = league([], undefined, { currentWeek: 8 }).settings;
const flat = (v: number, n = 10) => Array.from({ length: n }, () => v);
const wk = (week: number, recYd: number, recTd = 0): WeekLine => ({ season: S.season, week, team: "KC", actual: line({ recYd, recTd }), expected: line() });
const hotWeeks = [wk(5, 120, 1), wk(6, 100, 1), wk(7, 90, 1)];

test("captured Yahoo source: a player Yahoo projects 0 for the rest of the season (season-ending IR) is not shown scoring for them", () => {
  // Yahoo's rest-of-season total is 0 (he is done); he scored ~16 pts/g in his last 3 games before the injury.
  const ir = vp("ir", "WR", 0, 0, { weekly: flat(0), weeklyFrom: 8, yahooProj: 0, weeks: hotWeeks });
  const pc = perceive(ir, S);
  assert.equal(pc.source, "yahoo");
  // Yahoo's evaluator shows 0 for him in every week; the recency term must not resurrect him (bug: 4.9 pts every week,
  // 49 pts rest of season, which inflates "what Yahoo shows them" for any deal that sends him).
  assert.equal(pc.total, 0, `perceived weekly ${pc.weekly.join(",")}`);
});

test("captured Yahoo source and estimate agree on a player who is out: neither shows him starting", () => {
  const yahoo = perceive(vp("a", "WR", 0, 0, { weekly: flat(0), weeklyFrom: 8, yahooProj: 0, weeks: hotWeeks }), S);
  const est = perceive(vp("b", "WR", 0, 0, { weekly: flat(0), weeklyFrom: 8, ecrPts: 12, weeks: hotWeeks }), S);
  assert.equal(est.total, 0);
  assert.equal(yahoo.total, est.total, "the captured view must not be rosier than the estimate for an out player");
});

test("unknown never becomes 0: a player with neither a Yahoo projection nor a FantasyPros rank keeps our rate", () => {
  const p = vp("m", "WR", 9, 10, { effPpg: 9, weekly: flat(9), weeklyFrom: 8 });
  const pc = perceive(p, S);
  assert.equal(pc.source, "model");
  assert.ok(pc.rate > 0 && pc.total > 0, JSON.stringify(pc));
});

test("K / DEF without any projection or rank get a positive perceived rate (lineup totals stay comparable)", () => {
  for (const pos of ["K", "DEF"] as const) {
    const pc = perceive(vp(pos, pos, 8, 5, { effPpg: 8, weekly: flat(8), weeklyFrom: 8 }), S);
    assert.ok(pc.total > 0, `${pos}: ${JSON.stringify(pc)}`);
  }
});

test("acceptance v4 is monotone: a better perceived lineup or market edge for them never lowers acceptance", () => {
  const base: AcceptFactors = { perceivedPerWeek: 0, perceivedLoss: false, marketEdgePct: 0, spikes: 0, extraGiven: 0, losesTheirTop: false, fixesWorst: false };
  let prev = -1;
  for (let x = -3; x <= 3; x += 0.05) {
    const total = x * 10;
    const a = acceptanceV4({ ...base, perceivedPerWeek: x, perceivedLoss: Math.round(total * 10) / 10 < 0 });
    assert.ok(a >= prev - 1e-12, `perceived ${x.toFixed(2)}/wk: ${a} < ${prev}`);
    prev = a;
  }
  prev = -1;
  for (let m = -50; m <= 50; m += 1) {
    const a = acceptanceV4({ ...base, marketEdgePct: m });
    assert.ok(a >= prev - 1e-12, `market ${m}%`);
    prev = a;
  }
  // A perceived loss is capped at 0.25 whatever the market says.
  assert.ok(acceptanceV4({ ...base, perceivedPerWeek: -0.01, perceivedLoss: true, marketEdgePct: 500, fixesWorst: true }) <= 0.25);
});
