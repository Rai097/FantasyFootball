import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOOR, attachFloor, floorFactor, floorOf, overlapFactor, percentile, scaledPlayer } from "./signals.js";
import { rosterScore } from "./rosterScore.js";
import { league, line, vp } from "./testkit.js";
import { HALF_PPR } from "./scoring.js";
import type { WeekLine } from "./types.js";

const G = { remainingGames: 14 };
const S = league([]).settings;

test("C: floor = 25th percentile of weekly points (≥ 6 games), consistency = floor / mean", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.25), 2);
  assert.equal(floorOf([10, 12, 14, 16, 18]), null, "under 6 games: skipped");
  const f = floorOf([10, 10, 10, 10, 10, 10])!;
  assert.equal(f.floor, 10);
  assert.equal(f.consistency, 1);
  const v = floorOf([0, 2, 30, 1, 25, 3])!;
  assert.ok(v.consistency <= FLOOR.volatile, `boom/bust consistency ${v.consistency}`);
  // attachFloor: prior-season weeks + this season, league scoring (half PPR: 5 rec, 50 yds = 7.5).
  const wk = (w: number): WeekLine => ({ season: 2026, week: w, team: "KC", actual: line({ rec: 5, recYd: 50 }), expected: line({ rec: 5, recYd: 50 }) });
  const p = vp("w", "WR", 8, 10, { ...G, weeks: [wk(1), wk(2)] });
  const players = new Map([[p.id, p]]);
  attachFloor(players, new Map([["w", [line({ rec: 5, recYd: 50 }), line({ rec: 5, recYd: 50 }), line({ rec: 5, recYd: 50 }), line({ rec: 5, recYd: 50 })]]]), HALF_PPR);
  assert.equal(p.floor, 7.5);
  assert.equal(p.consistency, 1);
});

test("C: rosterScore uses 0.8·ppg + 0.2·floor for lineup players", () => {
  const plain = vp("a", "WR", 10, 10, G);
  const low = vp("a", "WR", 10, 10, { ...G, floor: 5 });
  assert.equal(floorFactor(plain), 1);
  assert.ok(Math.abs(floorFactor(low) - 0.9) < 1e-9);
  const slots = S.slots;
  const now = (p: typeof plain) => rosterScore({ ...S, slots }, [p]).now;
  assert.ok(Math.abs(now(low) - 0.9 * now(plain)) < 0.01, `${now(low)} vs ${now(plain)}`);
});

test("scaledPlayer scales ppg, effPpg and the v4 weekly points together (cached per factor)", () => {
  const p = vp("w", "WR", 10, 5, { ...G, effPpg: 9, weekly: [10, 0, 8], weeklyFrom: 4 });
  const c = scaledPlayer(p, 0.85);
  assert.deepEqual(c.weekly, [8.5, 0, 6.8]);
  assert.ok(Math.abs(c.effPpg! - 7.65) < 1e-9 && Math.abs(c.ppg - 8.5) < 1e-9);
  assert.equal(scaledPlayer(p, 0.85), c);
  assert.equal(scaledPlayer(p, 1), p);
});

test("A: same NFL team + group ×0.85 (WR/TE are one group), QB–pass-catcher stack ×1.03", () => {
  const wr = vp("wr", "WR", 12, 20, { ...G, team: "CIN" });
  const te = vp("te", "TE", 9, 8, { ...G, team: "CIN" });
  const rb = vp("rb", "RB", 12, 20, { ...G, team: "CIN" });
  const qb = vp("qb", "QB", 20, 20, { ...G, team: "CIN" });
  const other = vp("o", "WR", 12, 20, { ...G, team: "DAL" });
  assert.equal(overlapFactor(te, [wr], [wr]).f, 0.85);
  assert.match(overlapFactor(te, [wr], [wr]).tag!, /shares targets with wr/);
  assert.equal(overlapFactor(rb, [wr], [wr]).f, 1, "RB and WR do not share");
  assert.equal(overlapFactor(other, [wr], [wr]).f, 1);
  assert.equal(overlapFactor(qb, [wr], [wr]).f, 1.03);
  assert.equal(overlapFactor(wr, [qb], [qb]).f, 1.03);
  assert.match(overlapFactor(wr, [qb], [qb]).tag!, /stack/);
  const s = scaledPlayer(te, 0.85);
  assert.ok(Math.abs(s.ppg - 9 * 0.85) < 1e-9);
  assert.equal(scaledPlayer(te, 0.85), s, "cached");
  assert.equal(scaledPlayer(te, 1), te);
});
