// Adversarial: roster need ("trade chip only") and the weak-position line (DESIGN "Fix: vacated role, spikes, depth
// and roster need (2026-10-28)"). Synthetic players only (generic ids).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gapLines, rankWaivers } from "./waivers.js";
import { analyzeTeams } from "./analysis.js";
import { league, team, vp } from "./testkit.js";
import type { TradeContext } from "./tradeKit.js";
import type { ValuedPlayer, WaiverTarget } from "./types.js";

const txt = (t: WaiverTarget) => [t.summary, ...t.details.map((d) => `${d.label}: ${d.value}`)].join("\n");
const REPL = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
const roster = (bn1: Partial<ValuedPlayer>) => [
  vp("QB", "QB", 18, 10), vp("RB1", "RB", 14, 30), vp("RB2", "RB", 13, 26), vp("WR1", "WR", 12, 20), vp("WR2", "WR", 3, 0),
  vp("TE", "TE", 8, 5), vp("FLX", "RB", 9, 4), vp("K", "K", 8, 2), vp("DEF", "DEF", 7, 3),
  vp("BN1", "RB", 6, 0.4, bn1), vp("BN2", "WR", 2, 0.1), vp("BN3", "TE", 1, 0), vp("BN4", "QB", 1.5, 0), vp("IRGUY", "RB", 0, 0, { remainingGames: 0 }),
];
function ctxFor(mine: ValuedPlayer[]): TradeContext {
  const other = [vp("oQB", "QB", 17, 8)];
  const L = league([team("me", mine, { irPlayerIds: ["IRGUY"] }), team("o", other)], undefined, { numTeams: 12 });
  const players = new Map([...mine, ...other].map((p) => [p.id, p]));
  return { league: L, players, teams: analyzeTeams(L, players, REPL) };
}
const cleanRole = { tier: "rising" as const, score: 78, situation: 0.5, oppLevel: 11, thesis: "", role: { sustained: true, spike: false, chartRank: 1, chartEffective: 1, belowStarter: false, healthyShare: 0.25 } };

test("an injured bench player (Out, back wk 12) is not 'cover' today: a future-starter claim is not turned into 'trade chip only'", () => {
  const out = { injury: { status: "O", detail: "Hamstring", week: 8 }, remainingGames: 6, ret: { week: 12, confidence: "medium" as const, reasons: [], absent: true, practiceUp: false } };
  const ctx = ctxFor(roster(out));
  const t = rankWaivers(ctx, "me", [{ player: vp("FA_RB", "RB", 5, 0), onWaivers: true }], { myPriority: 3, breakouts: new Map([["FA_RB", cleanRole]]) }).freeAgents[0];
  assert.notEqual(t.recommendation, "pass", txt(t));
  assert.doesNotMatch(t.summary, /Trade chip only/, txt(t));
  // Control: the same bench player healthy does cover (the design's rule), so only the injury changes the call.
  const healthy = rankWaivers(ctxFor(roster({})), "me", [{ player: vp("FA_RB", "RB", 5, 0), onWaivers: true }], { myPriority: 3, breakouts: new Map([["FA_RB", cleanRole]]) }).freeAgents[0];
  assert.match(healthy.summary, /^Trade chip only/);
});

test("K / DEF never get a roster-need verdict", () => {
  const ctx = ctxFor(roster({}));
  const r = rankWaivers(ctx, "me", [{ player: vp("FA_K", "K", 9.5, 3), onWaivers: false }], { myPriority: 3 }).freeAgents[0];
  assert.doesNotMatch(txt(r), /Trade chip only|Roster need/);
});

test("weak-position line: 'no free agent beats yours' is judged against my weakest starter on the SAME measure it compares", () => {
  // WR-A has the lower season ppg but the higher week projection; WR-B is the weakest starter THIS week (8.0).
  // The best free agent (10.0 this week) beats WR-B, so the line must not claim nobody beats my WRs.
  const lineup = [
    { player: vp("WR-A", "WR", 12, 10, { yahooProjWeekly: 15 }), label: "WR1" },
    { player: vp("WR-B", "WR", 14, 15, { yahooProjWeekly: 8 }), label: "W/R/T1" },
  ];
  const fa = vp("Spare WR", "WR", 7, 0, { name: "Spare WR", yahooProjWeekly: 10 });
  const lines = gapLines(["WR"], lineup, [], [fa]);
  assert.deepEqual(lines, [], `got: ${lines.join(" / ")}`);
});
