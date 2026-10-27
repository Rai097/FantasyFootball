// ADVERSARIAL tests (tester, not developer) for Model v4 release (b) consumers: the injury double haircut in lineups /
// trades, team strength, power score v2 tie-breaks, labels, and the deleted v1/v2 trade paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { riskAdjusted } from "./injuryRisk.js";
import { optimalLineup } from "./lineup.js";
import { analyzeTeams, actualPpg, powerScore } from "./analysis.js";
import { teamStrength } from "./teamStrength.js";
import { luckLabel, marketTag } from "./labels.js";
import { league, team, vp } from "./testkit.js";
import type { Position, SlotKind, ValuedPlayer } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SLOTS: SlotKind[] = ["QB", "RB", "WR", "FLEX", "BN", "BN", "IR"];
const CW = 8;
const N = 17 - CW + 1;
/** A ValuedPlayer as projection v4 emits it: weekly from week 8, effPpg = mean over his games, injury optional. */
function v4p(id: string, pos: Position, weekly: number[], extra: Partial<ValuedPlayer> = {}): ValuedPlayer {
  const games = weekly.filter((x) => x > 0).length || 1;
  const eff = weekly.reduce((a, b) => a + b, 0) / games;
  return vp(id, pos, Math.max(...weekly), 20, { weekly, weeklyFrom: CW, effPpg: Math.round(eff * 100) / 100, remainingGames: weekly.filter((x) => x > 0).length, ...extra });
}
const flat = (pts: number) => Array.from({ length: N }, () => pts);
/** v4 output for a Questionable player: ×0.85 next game only. */
const qWeekly = (pts: number) => [0.85 * pts, ...flat(pts).slice(1)];
/** v4 output for an Out player: 0 next game, full after. */
const oWeekly = (pts: number) => [0, ...flat(pts).slice(1)];
const S = league([], SLOTS, { currentWeek: CW }).settings;

test("double haircut: riskAdjusted must not scale a Questionable player's weeks 9–17 (v4 already shaded his next game)", () => {
  const q = v4p("q", "WR", qWeekly(10), { injury: { status: "Q", week: CW } });
  const adj = riskAdjusted(q);
  assert.deepEqual(adj.weekly!.slice(1), q.weekly!.slice(1), `weeks 9-17 ${adj.weekly!.slice(1).map((x) => x.toFixed(2))} (×0.85 again)`);
});

test("double haircut: an Out player (0 next game in v4) keeps his weeks 9–17 in trade / lineup math", () => {
  const o = v4p("o", "RB", oWeekly(12), { injury: { status: "O", week: CW } });
  const adj = riskAdjusted(o);
  const lost = 1 - adj.weekly!.reduce((a, b) => a + b, 0) / o.weekly!.reduce((a, b) => a + b, 0);
  assert.ok(lost < 0.01, `rest-of-season points cut by ${(lost * 100).toFixed(0)}% on top of v4's next-game 0`);
});

test("double haircut: lineup starterPpg for a Questionable starter equals his v4 effPpg (no second ×0.85)", () => {
  const q = v4p("q", "WR", qWeekly(10), { injury: { status: "Q", week: CW } });
  const roster = [v4p("qb", "QB", flat(18)), v4p("rb", "RB", flat(12)), q, v4p("fx", "RB", flat(8))];
  const plain = optimalLineup(SLOTS, roster).starterPpg;
  const risk = optimalLineup(SLOTS, roster, { injuryRisk: true }).starterPpg;
  assert.ok(Math.abs(risk - plain) < 0.05, `starterPpg ${risk} with injuryRisk vs ${plain}: Q starter discounted twice (${q.effPpg} → ${(q.effPpg! * 0.85).toFixed(2)})`);
});

test("double haircut: an Out WR worth 12/wk from week 9 is not benched for a healthy 7/wk WR in the team lineup", () => {
  const o = v4p("o", "WR", oWeekly(12), { injury: { status: "O", week: CW } });
  const roster = [v4p("qb", "QB", flat(18)), v4p("rb", "RB", flat(12)), o, v4p("w7", "WR", flat(7)), v4p("rb7", "RB", flat(7))];
  const lg = league([team("a", roster)], SLOTS, { currentWeek: CW });
  const t = analyzeTeams(lg, new Map(roster.map((p) => [p.id, p])), { QB: 10, RB: 5, WR: 5, TE: 4, K: 5, DEF: 5 })[0];
  const starters = t.lineup.map((l) => l.player?.id);
  assert.ok(starters.includes("o"), `starters ${starters.join(",")}: Out player's effPpg ${o.effPpg} × 0.55 = ${(o.effPpg! * 0.55).toFixed(2)} < 7`);
});

test("team strength ignores injury tags beyond v4's weekly (weeks 15–17 only) and the IR slot", () => {
  const q = v4p("q", "WR", qWeekly(10), { injury: { status: "Q", week: CW } });
  const healthy = v4p("q", "WR", flat(10));
  const rest = [v4p("qb", "QB", flat(18)), v4p("rb", "RB", flat(12)), v4p("fx", "RB", flat(8))];
  assert.deepEqual(teamStrength(S, [...rest, q]), teamStrength(S, [...rest, healthy]), "Q tag must not move playoff strength");
  // Huge regular-season weeks don't count; only 15-17.
  const regOnly = v4p("big", "WR", flat(40).map((x, i) => (CW + i >= 15 ? 0 : x)));
  const ts = teamStrength(S, [...rest, healthy, regOnly]);
  assert.deepEqual(ts.weeks, [15, 16, 17]);
  assert.deepEqual(ts, teamStrength(S, [...rest, healthy]), "weeks 8-14 points leak into playoff strength");
  // IR slot: the best player parked there counts for nothing (lineup or depth).
  const star = v4p("star", "WR", flat(30));
  assert.deepEqual(teamStrength(S, [...rest, healthy, star], new Set(["star"])), teamStrength(S, [...rest, healthy]));
});

test("team strength depth term is bounded: 0 ≤ depth ≤ the best bench player's playoff points; total = lineup + 0.25 × depth", () => {
  const roster = [v4p("qb", "QB", flat(18)), v4p("rb", "RB", flat(12)), v4p("wr", "WR", flat(10)), v4p("fx", "RB", flat(8)), v4p("b1", "WR", flat(6)), v4p("b2", "RB", flat(5)), v4p("b3", "QB", flat(14))];
  const ts = teamStrength(S, roster);
  assert.ok(ts.depth >= 0 && ts.depth <= 14, `depth ${ts.depth}`);
  assert.ok(Math.abs(ts.total - (ts.lineup + 0.25 * ts.depth)) <= 0.1);
  // Empty bench → depth 0; empty roster / season over → zeros.
  assert.equal(teamStrength(S, roster.slice(0, 4)).depth, 0);
  assert.deepEqual(teamStrength(league([], SLOTS, { currentWeek: 18 }).settings, roster), { lineup: 0, depth: 0, total: 0, weeks: [] });
  for (const x of [ts.lineup, ts.depth, ts.total]) assert.ok(Number.isFinite(x));
});

test("power score v2: 0.7 × starters + 0.3 × actual; unknown results fall back to starters; pointsFor 0 over 6 games is unknown", () => {
  assert.equal(powerScore(100, null), 100);
  assert.ok(Math.abs(powerScore(100, 120) - 106) < 1e-9);
  assert.equal(actualPpg(undefined), null);
  assert.equal(actualPpg({ wins: 0, losses: 0, ties: 0, pointsFor: 0 }), null);
  assert.equal(actualPpg({ wins: 3, losses: 3, ties: 0, pointsFor: 600 }), 100);
  // A standings capture without points (0) is not a real 0 pts/game team.
  assert.equal(actualPpg({ wins: 3, losses: 3, ties: 0, pointsFor: 0 }), null, "pointsFor 0 after 6 games treated as a real 0 (−30% power)");
});

test("power rank tie-breaks: score, then bench strength, then wins, then team id; IR not bench strength", () => {
  const starters = (t: string) => [v4p(`${t}qb`, "QB", flat(18)), v4p(`${t}rb`, "RB", flat(12)), v4p(`${t}wr`, "WR", flat(10)), v4p(`${t}fx`, "RB", flat(8))];
  const bench = (t: string, ppg: number) => [vp(`${t}bn`, "WR", ppg, 5, { weekly: flat(ppg), weeklyFrom: CW, effPpg: ppg })];
  const rec = (wins: number) => ({ wins, losses: 6 - wins, ties: 0, pointsFor: 600 });
  const rosters: Record<string, ValuedPlayer[]> = {
    b: [...starters("b"), ...bench("b", 4)],
    a: [...starters("a"), ...bench("a", 6)],
    d: [...starters("d"), ...bench("d", 4)],
    c: [...starters("c"), ...bench("c", 4)],
    e: [...starters("e"), ...bench("e", 4), vp("eir", "WR", 25, 50, { weekly: flat(25), weeklyFrom: CW, effPpg: 25 })],
  };
  const teams = [
    team("b", rosters.b, { record: rec(4) }),
    team("a", rosters.a, { record: rec(1) }),
    team("d", rosters.d, { record: rec(2) }),
    team("c", rosters.c, { record: rec(2) }),
    team("e", rosters.e, { record: rec(2), irPlayerIds: ["eir"] }),
  ];
  const players = new Map(Object.values(rosters).flat().map((p) => [p.id, p]));
  const out = analyzeTeams(league(teams, SLOTS, { currentWeek: CW }), players, { QB: 10, RB: 5, WR: 5, TE: 4, K: 5, DEF: 5 });
  const order = [...out].sort((x, y) => x.powerRank - y.powerRank).map((t) => t.team.id);
  assert.equal(new Set(out.map((t) => t.powerScore)).size, 1, `scores ${out.map((t) => t.powerScore)}`);
  assert.deepEqual(order, ["a", "b", "c", "d", "e"], `order ${order}; e's IR player must not count as bench strength`);
});

test("labels: exact thresholds ±2.0, TD-dominant sell-high, ≥ 3 sample games; market tags at |edge| ≥ 8", () => {
  assert.equal(luckLabel({ points: 2.0, driver: "yardage" }, 3), "buy-low");
  assert.equal(luckLabel({ points: 1.999, driver: "td" }, 10), null);
  assert.equal(luckLabel({ points: -2.0, driver: "td" }, 3), "sell-high");
  assert.equal(luckLabel({ points: -2.0, driver: "yardage" }, 10), null, "yardage-driven over-performance is not sell-high");
  assert.equal(luckLabel({ points: -9, driver: "td" }, 2.99), null);
  assert.equal(luckLabel({ points: NaN, driver: "td" }, 9), null);
  assert.equal(luckLabel({ points: Infinity, driver: "td" }, 9), null);
  assert.equal(luckLabel(null, 9), null);
  assert.equal(marketTag(8), "market undervalues");
  assert.equal(marketTag(7.99), null);
  assert.equal(marketTag(-8), "market overvalues");
  assert.equal(marketTag(NaN), null);
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("deleted paths: trades.ts / tradesV2.ts gone, nothing imports them, the web app and mock never call /trades (v1)", () => {
  for (const f of ["server/model/trades.ts", "server/model/tradesV2.ts", "server/model/trades.test.ts", "server/model/tradesV2.test.ts"]) assert.equal(fs.existsSync(path.join(ROOT, f)), false, f);
  const files = [...walk(path.join(ROOT, "server")), ...walk(path.join(ROOT, "web/src"))].filter((f) => !f.endsWith(".adversarial.test.ts"));
  const bad: string[] = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    if (/from\s+["'][./]*(?:model\/)?trades(?:V2)?\.js["']/.test(src)) bad.push(`${path.relative(ROOT, f)} imports trades/tradesV2`);
    if (/["'`]\/api\/league\/[^"'`]*\/trades["'`?]|\/trades\b(?!2)[^/]*["'`]\s*\)/.test(src) && !f.endsWith(".test.ts")) bad.push(`${path.relative(ROOT, f)} references /trades`);
    if (/\btrades(?:V2|v2)\b|findTrades\b|findTradesV2\b/.test(src)) bad.push(`${path.relative(ROOT, f)} mentions tradesV2 / findTrades`);
  }
  const mock = fs.readFileSync(path.join(ROOT, "web/src/mock.ts"), "utf8");
  if (/\(analysis\|trades\|/.test(mock)) bad.push("web/src/mock.ts route regex still matches the deleted /trades");
  assert.deepEqual(bad, []);
});
