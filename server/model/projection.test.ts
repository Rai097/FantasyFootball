import { test } from "node:test";
import assert from "node:assert/strict";
import { curveAt, injuryKind, replacementRanks, smooth, valuePlayers, WEIGHTS } from "./projection.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import type { Player, WeekLine } from "./types.js";

/** RB whose every game (2026 and 2025) scores exactly `pts` half-PPR points via rush yards. */
function steadyRb(id: string, pts: number, games26: number, games25: number, extra: Partial<Player> = {}): Player {
  const l = line({ rushYd: pts * 10 });
  const weeks: WeekLine[] = Array.from({ length: games26 }, (_, i) => ({ season: 2026, week: i + 1, team: "KC", actual: l, expected: l }));
  return rawPlayer(id, "RB", {
    weeks,
    prior: games25 ? { games: games25, line: line({ rushYd: pts * 10 * games25 }) } : null,
    ...extra,
  });
}

// 30 RBs scoring 30, 29, ..., 1 ppg in both seasons (linear curve, so smoothing is exact inside).
const field = Array.from({ length: 30 }, (_, i) => steadyRb(`rb${i + 1}`, 30 - i, 3, 17));
const L = league([team("1", [])]);

test("smooth / curveAt helpers", () => {
  assert.deepEqual(smooth([3, 2, 1]), [2.5, 2, 1.5]);
  assert.equal(curveAt([10, 8, 6], 1.5), 9);
  assert.equal(curveAt([10, 8, 6], 99), 6);
});

test("ppg blends ECR 50 / current 35 (scaled by games) / prior 15 and renormalises", () => {
  // x: 1 game at 20, prior (5 games) at 10, ECR RB5 → curve value at rank 5 = 26.
  const x = steadyRb("x", 20, 1, 0, { ecrPos: 5, prior: { games: 5, line: line({ rushYd: 10 * 10 * 5 }) } });
  const v = valuePlayers(L, [...field, x]);
  const px = v.players.get("x")!;
  const wCur = (WEIGHTS.current * 1) / 3;
  const expected = (0.5 * 26 + wCur * 20 + 0.15 * 10) / (0.5 + wCur + 0.15);
  assert.ok(Math.abs(px.ppg - expected) < 0.01, `ppg ${px.ppg} vs ${expected}`);
  assert.match(px.why, /ECR RB5/);
  assert.match(px.why, /2026 exp 20\.0 \/ act 20\.0 in 1 g/);
});

test("player with no ECR, no games and no prior projects to 0", () => {
  const v = valuePlayers(L, [...field, rawPlayer("nobody", "WR")]);
  assert.equal(v.players.get("nobody")!.ppg, 0);
  assert.equal(v.players.get("nobody")!.value, 0);
});

test("replacement ranks per position (12 teams, 1 QB, 2 RB, 2 WR, TE, FLEX)", () => {
  const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "IR"] as const;
  const r = replacementRanks([...slots], 12);
  assert.deepEqual(r, { QB: 14, RB: 35, WR: 35, TE: 16, K: 12, DEF: 12 });
});

test("replacement ppg, vorp and value scale (top = 100, convex)", () => {
  // single-team league: RB repl rank = 2 + 0.45 + 0.5 → 3 → the 3rd best RB (28 ppg)
  const v = valuePlayers(L, field);
  assert.equal(v.replacement.RB, 28);
  const top = v.players.get("rb1")!;
  const second = v.players.get("rb2")!;
  assert.equal(top.value, 100);
  assert.equal(top.vorp, 2);
  assert.ok(second.value < 50, "half the vorp is worth less than half the value");
  assert.equal(v.players.get("rb10")!.value, 0);
  assert.equal(top.posRank, 1);
  assert.equal(top.remainingGames, 14); // weeks 4..17, no bye
});

test("injuries and byes reduce remaining games", () => {
  const out = steadyRb("out", 25, 3, 17, { injury: { status: "Out", detail: "Hamstring", week: 3 } });
  const doubt = steadyRb("dbt", 25, 3, 17, { injury: { status: "Doubtful", week: 3 } });
  const acl = steadyRb("acl", 25, 3, 17, { injury: { status: "Out", detail: "ACL", week: 3 } });
  const ir = steadyRb("ir", 25, 3, 17, { injury: { status: "IR", week: 3 } });
  const bye = steadyRb("bye", 25, 3, 17, { bye: 9 });
  const v = valuePlayers(L, [...field, out, doubt, acl, ir, bye]);
  assert.equal(v.players.get("out")!.remainingGames, 12);
  assert.equal(v.players.get("dbt")!.remainingGames, 13.3);
  assert.equal(v.players.get("acl")!.remainingGames, 0);
  assert.equal(v.players.get("acl")!.value, 0);
  assert.match(v.players.get("acl")!.why, /ECR weight halved/);
  assert.equal(v.players.get("ir")!.remainingGames, 0);
  assert.equal(v.players.get("bye")!.remainingGames, 13);
  assert.equal(injuryKind({ status: "Questionable", detail: "ACL", week: 3 }), null);
});

test("K and DEF use the ECR rank line", () => {
  const k = rawPlayer("k", "K", { ecrPos: 11 });
  const d = rawPlayer("d", "DEF", { ecrPos: 1 });
  const v = valuePlayers(L, [...field, k, d]);
  assert.equal(v.players.get("k")!.ppg, 8);
  assert.equal(v.players.get("d")!.ppg, 8.5);
});

test("valueOf re-values a copy with fresher injury status", () => {
  const p = steadyRb("p", 25, 3, 17);
  const v = valuePlayers(L, [...field, p]);
  assert.equal(v.valueOf(p), v.players.get("p"));
  const copy = { ...p, injury: { status: "IR", week: 3 } };
  assert.equal(v.valueOf(copy).remainingGames, 0);
});

test("deterministic", () => {
  const a = valuePlayers(L, field).players.get("rb2");
  const b = valuePlayers(L, field).players.get("rb2");
  assert.deepEqual(a, b);
});
