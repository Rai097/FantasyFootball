import { test } from "node:test";
import assert from "node:assert/strict";
import { BENCH, findBenchUpgrades } from "./benchUpgrades.js";
import { teamBase, teamV3 } from "./tradesV3.js";
import type { TradeContext } from "./tradeKit.js";
import { analyzeTeams } from "./analysis.js";
import { rosterParts } from "./rosterScore.js";
import { detailProblems, league, summaryProblems, team, vp } from "./testkit.js";
import type { League, ValuedPlayer } from "./types.js";

const G = { remainingGames: 14 };
const REPL = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
// Me: deep at RB (bench RBs worth something), thin at WR. Partner: WR depth on the bench, weak RBs.
const mine = [
  vp("mQB", "QB", 20, 12, G), vp("mRB1", "RB", 20, 60, G), vp("mRB2", "RB", 15, 30, G), vp("mRB3", "RB", 12, 12, G), vp("mRB4", "RB", 11, 9, G),
  vp("mWR1", "WR", 12, 14, G), vp("mWR2", "WR", 7, 4, G), vp("mTE", "TE", 8, 5, G), vp("mWR3", "WR", 5, 3, G),
  vp("mK", "K", 8, 1, G), vp("mDEF", "DEF", 7, 1, G),
];
const theirs = [
  vp("tQB", "QB", 20, 12, G), vp("tRB1", "RB", 10, 8, G), vp("tRB2", "RB", 8, 4, G), vp("tWR1", "WR", 19, 55, G), vp("tWR2", "WR", 15, 28, G),
  vp("tWR3", "WR", 13, 12, G), vp("tWR4", "WR", 12, 10, G), vp("tTE", "TE", 8, 5, G), vp("tWR5", "WR", 11, 8, G),
  vp("tK", "K", 8, 1, G), vp("tDEF", "DEF", 7, 1, G),
];
const NFL = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE"];
[...mine, ...theirs].forEach((p, i) => (p.team = NFL[i % NFL.length]));
function ctxFor(l: League, ps: ValuedPlayer[]): TradeContext {
  const players = new Map(ps.map((p) => [p.id, p]));
  return { league: l, players, teams: analyzeTeams(l, players, REPL), replacement: REPL };
}
const ctx = ctxFor(league([team("me", mine), team("them", theirs)]), [...mine, ...theirs]);

test("bench upgrades (v3 engine): 1-for-1, their bench player for my bench (or weakest starter), my season up", () => {
  const ups = findBenchUpgrades(ctx, "me");
  const my = teamV3(ctx, "me");
  const their = teamV3(ctx, "them");
  const lowest = my.starterList.filter((p) => p.pos !== "K" && p.pos !== "DEF").sort((a, b) => a.ppg - b.ppg)[0];
  assert.ok(ups.length > 0, "found at least one swap");
  assert.ok(ups.length <= BENCH.limit);
  const seen = new Set<string>();
  for (const t of ups) {
    assert.equal(t.me.gives.length, 1);
    assert.equal(t.them.gives.length, 1);
    const [m, g] = [t.me.gives[0], t.them.gives[0]];
    assert.ok(!their.starters.has(g.id), `${t.key}: their starter`);
    assert.ok(!my.starters.has(m.id) || m.id === lowest.id, `${t.key}: my starter`);
    assert.ok(!["mRB1", "mRB2"].includes(m.id), `${t.key}: my top-2 (value ≥ 20) never offered`);
    assert.ok(t.fairness >= BENCH.minFairness, `${t.key}: fairness ${t.fairness}`);
    assert.ok((t.me.seasonDelta ?? 0) >= 0.75, `${t.key}: season ${t.me.seasonDelta}`);
    assert.ok(!seen.has(g.id), "each target once");
    seen.add(g.id);
    assert.deepEqual(summaryProblems(t.summary), [], t.summary);
    assert.ok((t.details ?? []).length >= 4, t.key);
    assert.deepEqual(detailProblems(t.details ?? []), [], t.key);
  }
  for (let i = 1; i < ups.length; i++) assert.ok((ups[i - 1].me.scoreDelta ?? 0) >= (ups[i].me.scoreDelta ?? 0) - 0.05);
});

test("bench upgrades: nothing after the trade deadline; one partner filter", () => {
  const late = ctxFor(league([team("me", mine), team("them", theirs)], undefined, { currentWeek: 14, tradeDeadlineWeek: 13 }), [...mine, ...theirs]);
  assert.deepEqual(findBenchUpgrades(late, "me"), []);
  assert.ok(findBenchUpgrades(ctx, "me", { partnerId: "them" }).every((t) => t.them.teamId === "them"));
});

test("IR slot: teamBase scores lineup and depth without the team's IR-slotted player; value total keeps him", () => {
  const me0 = teamBase(ctx, "me");
  const star = me0.base.lineup.map((l) => l.player!).filter((p) => p.pos !== "K" && p.pos !== "DEF").sort((a, b) => b.ppg - a.ppg)[0];
  const l = ctx.league;
  const irLeague = { ...l, teams: l.teams.map((t) => (t.id === "me" ? { ...t, irPlayerIds: [star.id] } : t)) };
  const c = ctxFor(irLeague, [...ctx.players.values()]);
  const me = teamBase(c, "me");
  assert.ok(!me.base.lineup.some((x) => x.player?.id === star.id));
  assert.ok(me.parts.now < me0.parts.now, `now ${me.parts.now} vs ${me0.parts.now}`);
  const without = rosterParts(l.settings, me0.roster.filter((p) => p.id !== star.id), c.replacement).parts;
  assert.equal(me.parts.now, without.now);
  assert.equal(me.parts.depth, without.depth);
  assert.equal(me.total, me0.total);
});

test("bench upgrades (owner 2026-10-26): an injured piece back in 2 weeks can be the target; the row carries the marker and the card the return line", () => {
  // Their other bench WRs at waiver-level value (still depth, so he stays on their bench), so my one tradeable bench
  // piece (≤ 2 offers) is not used up on healthier targets.
  const t = theirs.map((p) => (p.id === "tWR4" || p.id === "tWR5" ? { ...p, value: 2 } : p)).map((p) => (p.id === "tWR3" ? { ...p, ppg: 10, value: 9, remainingGames: 12, injury: { status: "Out", week: 4 }, ret: { week: 6, confidence: "medium" as const, reasons: [], absent: true, practiceUp: false } } : { ...p }));
  // tWR3 (10 ppg, out 2 weeks) sits on their bench, not in their IR slot (an IR-slot target would cost them a cut for
  // the active player they get back: market fairness < 0.9 here).
  const c = ctxFor(league([team("me", mine.map((p) => ({ ...p }))), team("them", t)]), [...mine, ...t]);
  const ups = findBenchUpgrades(c, "me");
  const hit = ups.find((u) => u.them.gives[0].id === "tWR3");
  assert.ok(hit, `targets: ${ups.map((u) => u.key).join(", ")}`);
  assert.match(hit.summary, /for tWR3 \(injured, back ~wk 6\): /);
  assert.ok(hit.details!.some((d) => d.label === "Injured, you get" && /^tWR3: back ~wk 6/.test(d.value)), JSON.stringify(hit.details));
  assert.deepEqual(summaryProblems(hit.summary), []);
  assert.deepEqual(detailProblems(hit.details ?? []), []);
});
