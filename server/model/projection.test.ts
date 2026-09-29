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

test("ppg blends ECR 65 / current 22 (scaled by games/5) / prior 13 and renormalises", () => {
  // x: 1 game at 20, prior (5 games) at 10, ECR RB5 → curve value at rank 5 = 26.
  const x = steadyRb("x", 20, 1, 0, { ecrPos: 5, prior: { games: 5, line: line({ rushYd: 10 * 10 * 5 }) } });
  const v = valuePlayers(L, [...field, x]);
  const px = v.players.get("x")!;
  assert.deepEqual(WEIGHTS, { ecr: 0.65, current: 0.22, prior: 0.13 });
  const wCur = (WEIGHTS.current * 1) / 5;
  const expected = (0.65 * 26 + wCur * 20 + 0.13 * 10) / (0.65 + wCur + 0.13);
  assert.ok(Math.abs(px.ppg - expected) < 0.01, `ppg ${px.ppg} vs ${expected}`);
  assert.match(px.why, /ECR RB5/);
  assert.match(px.why, /2026 exp 20\.0 \/ act 20\.0 in 1 g/);
  assert.doesNotMatch(px.why, /ECR ranks are PPR/); // shown once via analysis notes instead
});

test("current-season weight reaches full strength at 5 games", () => {
  const mk = (id: string, g: number) => steadyRb(id, 20, g, 0, { ecrPos: 5 });
  const v = valuePlayers(L, [...field, mk("g3", 3), mk("g5", 5), mk("g7", 7)]);
  // ECR RB5 → 26, current 20: more games → more current weight → lower ppg, flat after 5.
  const ppg = (id: string) => v.players.get(id)!.ppg;
  const exp = (g: number) => (0.65 * 26 + 0.22 * (Math.min(g, 5) / 5) * 20) / (0.65 + 0.22 * (Math.min(g, 5) / 5));
  assert.ok(Math.abs(ppg("g3") - exp(3)) < 0.01);
  assert.ok(Math.abs(ppg("g5") - exp(5)) < 0.01);
  assert.equal(ppg("g5"), ppg("g7"));
});

test("rank curve: current season needs 3+ games and is capped at 1.15x the prior curve", () => {
  // 2025: everyone 10 ppg. 2026: rb hot scoring 30 in 3 games, cold ones 10; a 2-game player at 50 is ignored.
  const flat = Array.from({ length: 10 }, (_, i) => steadyRb(`f${i}`, 10, 3, 17));
  const hot = steadyRb("hot", 30, 3, 0);
  const tiny = steadyRb("tiny", 50, 2, 0);
  const probe = rawPlayer("probe", "RB", { ecrPos: 1 });
  const v = valuePlayers(L, [...flat, hot, tiny, probe]);
  // Rank 1: current curve min(30, 1.15·10)=11.5 blended 50/50 with prior 10 → 10.75, smoothed with rank 2 (10) → 10.375.
  assert.ok(Math.abs(v.players.get("probe")!.ppg - 10.375) < 0.01, `probe ${v.players.get("probe")!.ppg}`);
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

test("Yahoo NA is long-term; return designations cost 4 games", () => {
  assert.equal(injuryKind({ status: "Out", detail: "NA", week: 3 }), "long");
  assert.equal(injuryKind({ status: "Out", detail: "NA (not with team)", week: 3 }), "long");
  assert.equal(injuryKind({ status: "NA", week: 3 }), "long");
  assert.equal(injuryKind({ status: "Out", detail: "return designation", week: 3 }), "return");
  assert.equal(injuryKind({ status: "IR-R", week: 3 }), "return");
  assert.equal(injuryKind({ status: "Out", detail: "IR (return designation)", week: 3 }), "long");
  assert.equal(injuryKind({ status: "Out", detail: "Hamstring", week: 3 }), "out");
  const na = steadyRb("na", 25, 3, 17, { injury: { status: "Out", detail: "NA", week: 3 } });
  const ret = steadyRb("ret", 25, 3, 17, { injury: { status: "Out", detail: "return designation", week: 3 } });
  const v = valuePlayers(L, [...field, na, ret]);
  assert.equal(v.players.get("na")!.remainingGames, 0);
  assert.equal(v.players.get("ret")!.remainingGames, 10);
});

test("effPpg = ppg × remainingGames / weeksLeft (bye excluded), explained in why", () => {
  const out = steadyRb("out", 25, 3, 17, { injury: { status: "Out", detail: "Hamstring", week: 3 }, bye: 9 });
  const healthy = steadyRb("ok", 25, 3, 17, { bye: 9 });
  const v = valuePlayers(L, [...field, out, healthy]);
  const o = v.players.get("out")!;
  const h = v.players.get("ok")!;
  assert.equal(h.effPpg, h.ppg);
  assert.equal(o.remainingGames, 11);
  assert.ok(Math.abs(o.effPpg! - (o.ppg * 11) / 13) < 0.01, `${o.effPpg} vs ${o.ppg}`);
  assert.equal(o.ppg, h.ppg, "ppg itself stays a healthy rate");
  assert.match(o.why, /× 11\/13 games/);
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
