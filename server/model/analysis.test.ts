import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeTeams } from "./analysis.js";
import { league, team, vp } from "./testkit.js";

const REPL = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
const core = (p: string) => [
  vp(`${p}QB`, "QB", 18, 10), vp(`${p}RB1`, "RB", 14, 30), vp(`${p}RB2`, "RB", 13, 26), vp(`${p}WR1`, "WR", 12, 20),
  vp(`${p}WR2`, "WR", 11, 15), vp(`${p}TE`, "TE", 8, 5), vp(`${p}FX`, "RB", 10, 6),
];

test("K and DEF are needs only when the slot is empty", () => {
  // Team a: worst K and DEF in the league, both below replacement → still not a need.
  const a = [...core("a"), vp("aK", "K", 5, 0), vp("aD", "DEF", 4, 0)];
  const b = [...core("b"), vp("bK", "K", 9, 2), vp("bD", "DEF", 8, 2)];
  // Team c: no kicker at all → K need.
  const c = [...core("c"), vp("cD", "DEF", 8, 2)];
  const L = league([team("a", a), team("b", b), team("c", c)]);
  const players = new Map([...a, ...b, ...c].map((p) => [p.id, p]));
  const teams = analyzeTeams(L, players, REPL);
  const needs = (id: string) => teams.find((t) => t.team.id === id)!.needs;
  assert.ok(!needs("a").includes("K") && !needs("a").includes("DEF"), needs("a").join(","));
  assert.ok(needs("c").includes("K"), needs("c").join(","));
  assert.ok(!needs("c").includes("DEF"));
});

test("IR slot: a healthy IR-slotted player never starts, is not bench depth or surplus, but stays on the bench list", () => {
  const star = vp("aStar", "WR", 25, 40, { vorp: 17 }); // no injury status, parked in IR
  const a = [...core("a"), vp("aK", "K", 8, 1), vp("aD", "DEF", 7, 1), star];
  const b = [...core("b"), vp("bK", "K", 8, 1), vp("bD", "DEF", 7, 1)];
  const players = new Map([...a, ...b].map((p) => [p.id, p]));
  const free = analyzeTeams(league([team("a", a), team("b", b)]), players, REPL).find((t) => t.team.id === "a")!;
  assert.ok(free.lineup.some((l) => l.player?.id === "aStar"), "fixture: he starts when not on IR");
  const t = analyzeTeams(league([team("a", a, { irPlayerIds: ["aStar"] }), team("b", b)]), players, REPL).find((x) => x.team.id === "a")!;
  assert.ok(!t.lineup.some((l) => l.player?.id === "aStar"));
  assert.ok(t.bench.some((p) => p.id === "aStar"), "listed on the bench (shown as IR)");
  assert.ok(t.starterPpg < free.starterPpg);
  assert.equal(t.benchStrength, 0, "IR is not bench depth");
  assert.ok(!t.surplus.includes("WR"), "IR is not surplus");
});
