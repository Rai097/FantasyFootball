import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDemoLeague, demoFreeAgents, draftBoard, prng, undraftedPicks, DEMO_SLOTS } from "./demo.js";
import { analyzeLeague } from "../model/analysis.js";
import { rawPlayer } from "../model/testkit.js";
import type { Player, Position } from "../model/types.js";

// Synthetic ECR board: realistic position mix, overall ranks interleaved.
function board(): Player[] {
  const mix: [Position, number][] = [["RB", 100], ["WR", 130], ["TE", 50], ["QB", 40], ["K", 25], ["DEF", 32]];
  const out: Player[] = [];
  let overall = 1;
  const counters: Record<string, number> = {};
  const queue = mix.flatMap(([pos, n]) => Array.from({ length: n }, (_, i) => ({ pos, i })));
  // K/DEF ranked last overall, skill positions interleaved by index.
  queue.sort((a, b) => Number(a.pos === "K" || a.pos === "DEF") - Number(b.pos === "K" || b.pos === "DEF") || a.i - b.i);
  for (const { pos } of queue) {
    counters[pos] = (counters[pos] ?? 0) + 1;
    out.push(rawPlayer(`${pos}${counters[pos]}`, pos, { ecrOverall: overall++, ecrPos: counters[pos] }));
  }
  out.push(rawPlayer("unranked", "WR"));
  return out;
}
const players = board();
const input = { season: 2026, currentWeek: 4, players, builtAt: "2026-09-29T00:00:00Z" };

test("prng is deterministic and in [0,1)", () => {
  const a = prng(42);
  const b = prng(42);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test("12 half-PPR teams, 15 drafted each, legal full lineups, no duplicates", () => {
  const L = buildDemoLeague(input, 42);
  assert.equal(L.teams.length, 12);
  assert.equal(L.myTeamId, "1");
  assert.equal(L.settings.scoring.rec, 0.5);
  assert.deepEqual(L.settings.slots, DEMO_SLOTS);
  assert.equal(L.settings.regularSeasonEnd, 14);
  assert.equal(L.settings.finalWeek, 17);
  const seen = new Set<string>();
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const t of L.teams) {
    assert.equal(t.playerIds.length, 15);
    const pos = t.playerIds.map((id) => byId.get(id)!.pos);
    const n = (p: Position) => pos.filter((x) => x === p).length;
    assert.ok(n("QB") >= 1 && n("RB") >= 2 && n("WR") >= 2 && n("TE") >= 1 && n("K") === 1 && n("DEF") === 1, `${t.id}: ${pos.join(",")}`);
    assert.ok(n("RB") + n("WR") + n("TE") >= 6, "FLEX filled");
    for (const id of t.playerIds) {
      assert.ok(!seen.has(id), `${id} drafted twice`);
      seen.add(id);
    }
    assert.equal((t.record!.wins + t.record!.losses + t.record!.ties), 3);
  }
  const wins = L.teams.reduce((a, t) => a + t.record!.wins, 0);
  const losses = L.teams.reduce((a, t) => a + t.record!.losses, 0);
  assert.equal(wins, losses);
});

test("snake draft follows ECR with slight randomness", () => {
  const L = buildDemoLeague(input, 42);
  // Round 1 picks come from the top of the board; team 12 picks twice at the turn.
  const firstPicks = L.teams.map((t) => byOverall(t.playerIds[0]));
  assert.ok(Math.max(...firstPicks) <= 20, `round 1 overall ranks ${firstPicks}`);
  const avg = (i: number) => L.teams.reduce((a, t) => a + byOverall(t.playerIds[i]), 0) / 12;
  assert.ok(avg(0) < avg(3) && avg(3) < avg(8), "later rounds draft lower-ranked players");
});
const byOverall = (id: string) => players.find((p) => p.id === id)!.ecrOverall!;

test("deterministic per seed, different across seeds", () => {
  const a = buildDemoLeague(input, 42);
  const b = buildDemoLeague(input, 42);
  const c = buildDemoLeague(input, 7);
  assert.deepEqual(a.teams, b.teams);
  assert.notDeepEqual(a.teams.map((t) => t.playerIds), c.teams.map((t) => t.playerIds));
  assert.equal(c.id, "7");
});

test("free agents are ranked players not on a roster; priority from record", () => {
  const L = buildDemoLeague(input, 42);
  const { freeAgents, myPriority } = demoFreeAgents(L, players);
  const rostered = new Set(L.teams.flatMap((t) => t.playerIds));
  assert.equal(freeAgents.length, draftBoard(players).length - rostered.size);
  assert.ok(freeAgents.every((f) => !rostered.has(f.player.id) && f.player.id !== "unranked"));
  assert.ok(myPriority! >= 1 && myPriority! <= 12);
});

test("every demo team gets a full valued lineup", () => {
  const L = buildDemoLeague(input, 42);
  const ctx = analyzeLeague(L, players);
  for (const t of ctx.teams) assert.ok(t.lineup.every((l) => l.player), `team ${t.team.id} has an empty slot`);
});

test("about 10% of the ECR top-150 stays undrafted, deterministic per seed", () => {
  const top = draftBoard(players).slice(0, 150);
  for (const seed of [42, 7]) {
    const L = buildDemoLeague(input, seed);
    const rostered = new Set(L.teams.flatMap((t) => t.playerIds));
    const undrafted = top.filter((p) => !rostered.has(p.id));
    const skipped = undraftedPicks(draftBoard(players), seed);
    assert.equal(skipped.size, 15, `seed ${seed}`);
    const ids = new Set(undrafted.map((p) => p.id));
    for (const id of skipped) {
      assert.ok(ids.has(id), `${id} should be undrafted`);
      const p = top.find((x) => x.id === id)!;
      assert.ok(p.pos !== "K" && p.pos !== "DEF" && p.ecrOverall! > 30);
    }
  }
  assert.notDeepEqual(undraftedPicks(draftBoard(players), 42), undraftedPicks(draftBoard(players), 7));
});
