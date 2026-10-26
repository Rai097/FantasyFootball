import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeTeams, POWER_WEIGHTS } from "./analysis.js";
import { buildLeagueView, comparisonSummary, standingsRanks } from "./league.js";
import { league, summaryProblems, team, vp } from "./testkit.js";
import type { ValuedPlayer } from "./types.js";

const REPL = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
/** A roster whose starters scale with `k`, plus a bench of `bench` vorp-bearing players. */
const roster = (p: string, k: { qb: number; rb: number; wr: number; te: number }, bench: number[]): ValuedPlayer[] => [
  vp(`${p}QB`, "QB", k.qb, 10),
  vp(`${p}RB1`, "RB", k.rb, 30),
  vp(`${p}RB2`, "RB", k.rb - 1, 26),
  vp(`${p}WR1`, "WR", k.wr, 20),
  vp(`${p}WR2`, "WR", k.wr - 1, 15),
  vp(`${p}TE`, "TE", k.te, 5),
  vp(`${p}FX`, "RB", 9, 6),
  vp(`${p}K`, "K", 8, 1),
  vp(`${p}D`, "DEF", 7, 1),
  ...bench.map((v, i) => vp(`${p}BN${i}`, "QB", 5 + v, 3, { vorp: v })),
];

function setup(records = true) {
  const rosters = {
    a: roster("a", { qb: 24, rb: 18, wr: 16, te: 6 }, [3, 2, 1]), // strong RB / WR, weak TE
    b: roster("b", { qb: 18, rb: 12, wr: 12, te: 11 }, [8, 8, 8]), // deep bench
    m: roster("m", { qb: 19, rb: 13, wr: 13, te: 12 }, [1, 1, 0]), // me
    c: roster("c", { qb: 16, rb: 10, wr: 10, te: 5 }, [1, 0, 0]),
  };
  const rec = (wins: number, losses: number, pointsFor?: number) => (records ? { record: { wins, losses, ties: 0, pointsFor } } : {});
  const L = league([
    team("a", rosters.a, rec(2, 5, 700)),
    team("b", rosters.b, rec(5, 2, 800)),
    team("m", rosters.m, rec(5, 2, 820)),
    team("c", rosters.c, rec(4, 3)),
  ]);
  L.myTeamId = "m";
  const players = new Map(Object.values(rosters).flat().map((p) => [p.id, p]));
  return analyzeTeams(L, players, REPL);
}

test("power score splits into 0.7 × starter ppg + 0.3 × bench strength; gaps add up", () => {
  const teams = setup();
  const v = buildLeagueView(teams, "m");
  for (const r of v.teams) assert.ok(Math.abs(r.starterPart + r.benchPart - r.powerScore) <= 0.02, `${r.id}: parts ${r.starterPart}+${r.benchPart} vs ${r.powerScore}`);
  for (const c of [...v.above, ...v.below]) {
    assert.ok(Math.abs(c.starterPartGap + c.benchPartGap - c.powerGap) <= 0.02, `${c.teamId}: power gap`);
    assert.ok(Math.abs(POWER_WEIGHTS.starter * c.starterGap + POWER_WEIGHTS.bench * c.benchGap - c.powerGap) <= 0.02);
    const groupSum = c.groups.reduce((a, g) => a + g.gap, 0);
    assert.ok(Math.abs(groupSum - c.starterGap) <= 0.05, `${c.teamId}: Σ group gaps ${groupSum} vs starter gap ${c.starterGap}`);
    for (const g of c.groups) assert.ok(Math.abs(g.theirs - g.mine - g.gap) <= 0.01);
  }
});

test("above = every better power rank, mine excluded; ordered best first; below the rest", () => {
  const teams = setup();
  const v = buildLeagueView(teams, "m");
  const me = v.teams.find((t) => t.mine)!;
  assert.equal(me.id, "m");
  assert.equal(v.teams.filter((t) => t.mine).length, 1);
  assert.deepEqual(v.above.map((c) => c.teamId), v.teams.filter((t) => t.powerRank < me.powerRank).map((t) => t.id));
  assert.ok(v.above.length >= 1, "fixture has a team above me");
  assert.ok(![...v.above, ...v.below].some((c) => c.teamId === "m"));
  assert.equal(v.above.length + v.below.length, teams.length - 1);
  for (let i = 1; i < v.teams.length; i++) assert.ok(v.teams[i - 1].powerRank < v.teams[i].powerRank);
  for (const c of v.above) assert.ok(c.powerGap >= 0, `${c.teamId} above with gap ${c.powerGap}`);
});

test("groups stay in chart order; key players are their top 2 starters at the biggest leads", () => {
  const v = buildLeagueView(setup(), "m");
  const a = [...v.above, ...v.below].find((c) => c.teamId === "a")!;
  assert.deepEqual(a.groups.map((g) => g.group), ["QB", "RB", "WR", "TE", "FLEX", "K", "DEF"]);
  assert.deepEqual(a.keyPlayers.map((k) => k.group), ["RB", "WR"], "biggest positive gaps first");
  assert.ok(a.keyPlayers[0].gap >= a.keyPlayers[1].gap);
  assert.deepEqual(a.keyPlayers[0].players.map((p) => p.id), ["aRB1", "aRB2"]);
  assert.ok(a.keyPlayers.every((k) => k.players.length <= 2));
  assert.ok(!("weeks" in a.keyPlayers[0].players[0]), "names + ids only, no full player objects");
});

test("summaries: one line ≤ 255 chars, explain the starter vs bench split", () => {
  const v = buildLeagueView(setup(), "m");
  for (const c of [...v.above, ...v.below]) assert.deepEqual(summaryProblems(c.summary), [], c.summary);
  assert.deepEqual(summaryProblems(v.summary), [], v.summary);
  const a = [...v.above, ...v.below].find((c) => c.teamId === "a")!;
  assert.match(a.summary, /^\+\d+\.\d starter pts\/wk: stronger RB \(\+\d+\.\d\) and WR/);
  assert.match(a.summary, /you're better at TE/);
  const b = [...v.above, ...v.below].find((c) => c.teamId === "b")!;
  assert.ok(v.above.some((c) => c.teamId === "b"), "deep bench lifts b above me");
  assert.match(b.summary, /^Deeper bench \(\+\d+\.\d bench strength\) outweighs your \+\d+\.\d starter pts\/wk/);
  const c = v.below.find((x) => x.teamId === "c")!;
  assert.match(c.summary, /^-\d+\.\d starter pts\/wk vs you: weaker/);
  const gs = [{ group: "WR", theirs: 30, mine: 25, gap: 5 }];
  assert.equal(comparisonSummary({ starterGap: 4.9, benchGap: -9.1, groups: gs }, true), "+4.9 starter pts/wk, partly offset by your deeper bench (+9.1): stronger WR (+5.0).");
  // Worst case length: every group named.
  const long = comparisonSummary(
    { starterGap: 99.9, benchGap: -99.9, groups: ["QB", "RB", "WR", "TE", "FLEX", "K", "DEF"].map((g, i) => ({ group: g, theirs: 0, mine: 0, gap: i < 4 ? 50 : -50 })) },
    true,
  );
  assert.deepEqual(summaryProblems(long), []);
});

test("standings: rank by win% then PF; unknown records stay '—' / null, never 0", () => {
  const v = buildLeagueView(setup(), "m");
  const by = (id: string) => v.teams.find((t) => t.id === id)!;
  assert.equal(by("m").standingsRank, 1, "5-2 with more PF than b");
  assert.equal(by("b").standingsRank, 2);
  assert.equal(by("c").standingsRank, 3);
  assert.equal(by("a").standingsRank, 4);
  assert.equal(by("m").record, "5-2");
  assert.equal(by("c").pointsFor, null, "PF unknown stays null");
  assert.equal(by("m").pointsAgainst, null);
  assert.match(v.summary, /1st in the standings/);

  const u = buildLeagueView(setup(false), "m");
  assert.equal(u.standingsKnown, false);
  for (const t of u.teams) {
    assert.equal(t.record, "—");
    assert.equal(t.standingsRank, null);
    assert.equal(t.pointsFor, null);
  }
  for (const c of [...u.above, ...u.below]) assert.equal(c.record, "—");
  assert.match(u.summary, /standings unknown/);
});

test("standings use the source's own ranks when every recorded team has one", () => {
  const teams = setup();
  teams.forEach((t, i) => (t.team = { ...t.team, record: { ...t.team.record!, rank: teams.length - i } }));
  const r = standingsRanks(teams);
  assert.deepEqual(teams.map((t) => r.get(t.team.id)), [4, 3, 2, 1]);
});

test("unknown team throws", () => {
  assert.throws(() => buildLeagueView(setup(), "zz"));
});
