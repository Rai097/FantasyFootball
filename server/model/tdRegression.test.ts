import { test } from "node:test";
import assert from "node:assert/strict";
import { positionTdBaselines, regressTds, type TdInput } from "./tdRegression.js";
import type { PlayerSignals } from "./signals/types.js";

const PTS = { pass: 4, rush: 6, rec: 6 };
const K = { pass: 0, rush: 0, rec: 0 };
const base = (over: Partial<TdInput>): TdInput => ({ xTd: { ...K }, opp: { ...K }, n: 7, k: 8, prior: null, position: undefined, minGames: 4, points: PTS, ...over });

test("role growth: last season's TDs per target are scaled to this year's targets, so a grown role is not dragged down", () => {
  // Last season 6 targets and 0.5 receiving TDs a game (1/12 per target); this year 10 targets, 0.85 expected TDs.
  const r = regressTds(base({ xTd: { ...K, rec: 0.85 }, opp: { ...K, rec: 10 }, prior: { tds: { ...K, rec: 0.5 }, opps: { ...K, rec: 6 } } }))!;
  const b = (0.5 / 6) * 10;
  assert.ok(Math.abs(r.base - b) < 1e-9, `baseline at his volume ${r.base}`);
  assert.ok(Math.abs(r.regressed - (7 * 0.85 + 8 * b) / 15) < 1e-9);
  // Per game (opportunities unknown) the same player would regress to 0.67 TDs: −1.1 pts/g instead of −0.0.
  const perGame = regressTds(base({ xTd: { ...K, rec: 0.85 }, opp: { ...K, rec: 10 }, prior: { tds: { ...K, rec: 0.5 }, opps: null } }))!;
  assert.ok(perGame.ptsDelta - r.ptsDelta > 0.9, `per-opportunity ${r.ptsDelta.toFixed(2)} vs per-game ${perGame.ptsDelta.toFixed(2)}`);
});

test("each kind regresses on its own opportunity; points per kind come from the league (passing TDs at 4)", () => {
  const r = regressTds(base({ xTd: { pass: 2.5, rush: 0.3, rec: 0 }, opp: { pass: 35, rush: 4, rec: 0 }, prior: { tds: { pass: 1.5, rush: 0.1, rec: 0 }, opps: { pass: 30, rush: 4, rec: 0 } } }))!;
  const bp = (1.5 / 30) * 35;
  const br = 0.1;
  const rp = (7 * 2.5 + 8 * bp) / 15;
  const rr = (7 * 0.3 + 8 * br) / 15;
  assert.ok(Math.abs(r.ptsDelta - (4 * (2.5 - rp) + 6 * (0.3 - rr))) < 1e-9);
});

test("no prior and fewer than minGames sample games: not regressed; no sample: not regressed", () => {
  const pos = { perOpp: { pass: 0.045, rush: 0.03, rec: 0.05 }, perGame: { pass: 1.4, rush: 0.2, rec: 0.3 } };
  assert.equal(regressTds(base({ n: 1, xTd: { ...K, pass: 0.1 }, opp: { ...K, pass: 12 }, position: pos })), null);
  assert.equal(regressTds(base({ n: 0, prior: { tds: { ...K }, opps: null } })), null);
  // With minGames games and no prior: the position's rate per opportunity × his volume.
  const r = regressTds(base({ n: 4, xTd: { ...K, rush: 0.9 }, opp: { ...K, rush: 15 }, position: pos }))!;
  assert.equal(r.source, "position");
  assert.ok(Math.abs(r.base - 0.03 * 15) < 1e-9);
});

test("priorExcluded (a real last season not usable as the baseline): position baseline under minGames sample games", () => {
  const pos = { perOpp: { pass: 0.045, rush: 0.03, rec: 0.05 }, perGame: { pass: 1.4, rush: 0.2, rec: 0.3 } };
  const r = regressTds(base({ n: 2, xTd: { ...K, rush: 0.9 }, opp: { ...K, rush: 15 }, position: pos, priorExcluded: true }))!;
  assert.equal(r.source, "position");
  assert.ok(Math.abs(r.regressed - (2 * 0.9 + 8 * 0.03 * 15) / 10) < 1e-9);
  // Still needs a position baseline and a sample.
  assert.equal(regressTds(base({ n: 2, xTd: { ...K, rush: 0.9 }, opp: { ...K, rush: 15 }, priorExcluded: true })), null);
  assert.equal(regressTds(base({ n: 0, position: pos, priorExcluded: true })), null);
});

const sig = (n: number, w: Partial<Record<"passAtt" | "carries" | "targets" | "actPassTd" | "actRushTd" | "actRecTd", number>>) =>
  ({ weeks: Array.from({ length: n }, () => ({ passAtt: 0, carries: 0, targets: 0, actPassTd: 0, actRushTd: 0, actRecTd: 0, ...w })) }) as unknown as PlayerSignals;

test("position baseline: actual TDs per opportunity, players under minGames left out, the player's own games left out", () => {
  const me = sig(6, { carries: 20, actRushTd: 2 });
  const b = positionTdBaselines([{ pos: "RB", sig: sig(6, { carries: 10, actRushTd: 0.5 }) }, { pos: "RB", sig: sig(2, { carries: 10, actRushTd: 5 }) }, { pos: "RB", sig: me }], 4);
  assert.equal(b.of("RB", me)!.perOpp.rush, 0.05);
  assert.equal(b.of("RB", null)!.perOpp.rush, (6 * 0.5 + 6 * 2) / (6 * 10 + 6 * 20));
  assert.equal(b.of("RB", me)!.perOpp.pass, null, "no pass attempts: per game");
  assert.equal(b.of("WR", null), undefined);
});
