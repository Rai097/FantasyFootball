import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOOR, attachFloor, attachRisers, floorFactor, floorOf, overlapFactor, percentile, riserSignal, scaledPlayer } from "./signals.js";
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

const wkExp = (w: number, rec: number, share: number) => ({ w, rec, share });
function riserPlayer(id: string, series: { w: number; rec: number; share: number }[]) {
  const weeks: WeekLine[] = series.map(({ w, rec }) => ({ season: 2026, week: w, team: "KC", actual: line({ rec, recYd: rec * 10 }), expected: line({ rec, recYd: rec * 10 }) }));
  const snapShare = Object.fromEntries(series.map(({ w, share }) => [w, share]));
  return vp(id, "RB", 8, 10, { ...G, weeks, snapShare, effPpg: 8 });
}

test("D: riser = snaps +12 pts and expected +2 (new high, not already full-time, not in-and-out); ppg blends 30%", () => {
  const love = riserPlayer("love", [wkExp(1, 2, 0.43), wkExp(2, 1.5, 0.4), wkExp(3, 4, 0.64)]); // exp 3, 2.25, 6 pts
  const r = riserSignal(love, HALF_PPR);
  assert.equal(r.riser, true, JSON.stringify(r));
  const flat = riserPlayer("flat", [wkExp(1, 3, 0.6), wkExp(2, 3, 0.62), wkExp(3, 3.1, 0.64)]);
  assert.equal(riserSignal(flat, HALF_PPR).riser, false);
  const vet = riserPlayer("vet", [wkExp(1, 2, 0.9), wkExp(2, 1, 0.5), wkExp(3, 4, 0.95)]);
  assert.equal(riserSignal(vet, HALF_PPR).riser, false, "already full-time");
  const hurt = riserPlayer("hurt", [wkExp(1, 2, 0.7), wkExp(2, 0, 0.1), wkExp(3, 4, 0.8)]);
  assert.equal(riserSignal(hurt, HALF_PPR).riser, false, "in-and-out");
  const players = new Map([[love.id, love]]);
  const level = r.oppLevel;
  attachRisers(players, S);
  assert.equal(love.riser, true);
  assert.ok(Math.abs(love.ppg - (0.7 * 8 + 0.3 * level)) < 0.01);
  assert.match(love.why, /Riser/);
  attachRisers(players, S);
  assert.ok(Math.abs(love.ppg - (0.7 * 8 + 0.3 * level)) < 0.01, "idempotent");
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
