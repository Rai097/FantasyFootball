// Role check (DESIGN "Fix: vacated role, spikes, depth and roster need (2026-10-28)"). Synthetic players only.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_ENV, futureStarterBlock, healthyShare, isBack, roleCheck, roleItems, shareBar, teamOffense, teamUsage, vacPlayerOf } from "./roleCheck.js";
import { line, vp } from "./testkit.js";
import { HALF_PPR } from "./scoring.js";
import { detailProblems } from "./testkit.js";
import type { RoleCheck, ValuedPlayer, WeekLine } from "./types.js";

const wk = (week: number, team: string, targets: number, carries = 0, recYd = targets * 8): WeekLine => ({
  season: 2026, week, team, actual: line({ rec: targets * 0.6, recYd }), expected: line({ rec: targets * 0.6, recYd }), opp: { targets, carries, airYards: 0 },
});
const player = (id: string, pos: "WR" | "TE" | "RB", team: string, targets: (number | null)[], extra: Partial<ValuedPlayer> = {}): ValuedPlayer =>
  vp(id, pos, 5, 1, { team, weeks: targets.flatMap((t, i) => (t === null ? [] : [wk(i + 1, team, t)])), ...extra });

describe("team offense and usage", () => {
  test("offense ranks teams on skill players' fantasy pts per team game; < 3 team weeks = unknown", () => {
    const ps = [player("a1", "WR", "AAA", [10, 10, 10]), player("b1", "WR", "BBB", [3, 3, 3]), player("c1", "WR", "CCC", [9, 9])];
    const off = teamOffense(ps, HALF_PPR);
    assert.equal(off.get("AAA")!.rank, 1);
    assert.equal(off.get("BBB")!.rank, 2);
    assert.equal(off.get("AAA")!.of, 2);
    assert.equal(off.has("CCC"), false, "two team weeks: unknown");
  });
  test("healthy share leaves out borrowed-role weeks; fewer than minShareGames games = unknown", () => {
    const me = player("me", "TE", "AAA", [2, 2, 2, 8]);
    const mate = player("wr", "WR", "AAA", [8, 8, 8, null]);
    const usage = teamUsage([me, mate]);
    assert.ok(Math.abs(healthyShare(me, usage, new Set([4]))! - 0.2) < 1e-9, "2 of 10 targets in weeks 1–3");
    assert.equal(healthyShare(me, usage, new Set([2, 3, 4])), undefined, "one game is not a share");
    assert.equal(ROLE_ENV.minShareGames, 2);
  });
  test("vacPlayerOf adds snap-only weeks (he played, 0 usage)", () => {
    const p = player("p", "WR", "AAA", [4], { snapShare: { 1: 0.5, 2: 0.3 } });
    assert.deepEqual(vacPlayerOf(p).games.map((g) => g.week), [1, 2]);
  });
});

describe("isBack: the teammate plays again or has a return week", () => {
  test("healthy → back; absent with a week → due back; absent unknown / no games left / other team → not", () => {
    assert.equal(isBack(vp("t", "WR", 9, 9, { team: "AAA" }), "AAA"), true);
    assert.equal(isBack(vp("t", "WR", 9, 9, { team: "AAA", ret: { week: 10, confidence: "medium", reasons: [], absent: true, practiceUp: false } }), "AAA"), true);
    assert.equal(isBack(vp("t", "WR", 9, 9, { team: "AAA", ret: { week: null, confidence: "unknown", reasons: [], absent: true, practiceUp: false } }), "AAA"), false);
    assert.equal(isBack(vp("t", "WR", 9, 9, { team: "AAA", remainingGames: 0 }), "AAA"), false);
    assert.equal(isBack(vp("t", "WR", 9, 9, { team: "BBB" }), "AAA"), false);
    assert.equal(isBack(undefined, "AAA"), false);
  });
});

describe("roleCheck + futureStarterBlock", () => {
  const players = new Map<string, ValuedPlayer>();
  const base = (over: Partial<Parameters<typeof roleCheck>[0]> = {}) => {
    const p = player("me", "TE", "AAA", [1, 1, 1, 1, 6]);
    return roleCheck({ p, weeks: [1, 2, 3, 4, 5], expPpg: [1.5, 1.5, 1.5, 1.5, 9], players, usage: new Map(), offense: new Map(), ...over });
  };
  test("a single jump is a spike → blocked as 'one strong game'", () => {
    const r = base();
    assert.equal(r.spike, true);
    assert.equal(futureStarterBlock(r, "TE")?.short, "one strong game, not a role yet");
  });
  test("a borrowed role whose starter is back → blocked as borrowed, naming him", () => {
    players.set("wr", vp("wr", "WR", 12, 20, { team: "AAA", name: "Lead WR" }));
    const r = base({ weeks: [1, 2, 3, 4, 5], expPpg: [1.5, 1.5, 1.5, 9, 9], vacated: new Map([[4, [{ id: "wr", name: "Lead WR", pos: "WR" }]], [5, [{ id: "wr", name: "Lead WR", pos: "WR" }]]]) });
    assert.equal(r.vacated?.back, true);
    assert.equal(r.sustained, false, "two borrowed games × 0.4 < 2");
    assert.match(futureStarterBlock(r, "TE")!.short, /usage rose while Lead WR was out/);
  });
  test("the depth chart: TE2 is below starter level unless the TE ahead is out (the chart moved him up)", () => {
    const sustained = { weeks: [1, 2, 3, 4, 5], expPpg: [1.5, 1.5, 1.5, 9, 9] };
    players.set("te1", vp("te1", "TE", 10, 10, { team: "AAA" }));
    const r = base({ ...sustained, chart: ["te1", "me"] });
    assert.equal(r.chartRank, 2);
    assert.equal(r.belowStarter, true);
    assert.match(futureStarterBlock(r, "TE")!.rule, /Below starter level on the depth chart \(TE2\)/);
    players.set("te1", vp("te1", "TE", 10, 10, { team: "AAA", injury: { status: "IR", week: 5 } }));
    const up = base({ ...sustained, chart: ["te1", "me"] });
    assert.equal(up.chartEffective, 1);
    assert.equal(up.belowStarter, false);
    assert.equal(futureStarterBlock(up, "TE"), null);
    const unknown = base({ ...sustained });
    assert.equal(unknown.chartRank, undefined, "no chart: unknown, never a block");
    assert.equal(futureStarterBlock(unknown, "TE"), null);
  });
  test("share once healthy below the bar blocks; a bottom offense raises the bar", () => {
    const r: RoleCheck = { sustained: true, spike: false, healthyShare: 0.13 };
    assert.equal(futureStarterBlock(r, "WR")?.rule.startsWith("Target share with starters healthy 13.0% < 15%"), true);
    const ok: RoleCheck = { sustained: true, spike: false, healthyShare: 0.17 };
    assert.equal(futureStarterBlock(ok, "WR"), null);
    const low: RoleCheck = { ...ok, offense: { ppg: 60, rank: 30, of: 32 } };
    assert.ok(Math.abs(shareBar(low, "WR")! - 0.15 * ROLE_ENV.lowOffenseMult) < 1e-9);
    assert.match(futureStarterBlock(low, "WR")!.short, /on a low-scoring offense/);
    assert.equal(futureStarterBlock({ sustained: true, spike: false }, "WR"), null, "share unknown: no block");
  });
  test("role detail items are one short idea each; unknowns say so", () => {
    const items = roleItems({ sustained: false, spike: true, vacated: { weeks: [7], by: ["Lead WR"], back: true } }, "TE");
    assert.deepEqual(detailProblems(items), []);
    assert.equal(items.find((d) => d.label === "Depth chart rank")?.value, "Unknown: not on the depth chart we have");
    assert.equal(items.find((d) => d.label === "Offense")?.value, "Unknown");
    assert.ok(items.some((d) => d.label === "Borrowed role" && /wk 7 while Lead WR was out/.test(d.value)));
    const known = roleItems({ sustained: true, spike: false, chartRank: 3, chartEffective: 2, healthyShare: 0.21, offense: { ppg: 66, rank: 30, of: 32 } }, "WR");
    assert.equal(known.find((d) => d.label === "Offense")?.value, "30th of 32 in fantasy pts/game (66.0)");
    assert.equal(known.find((d) => d.label === "Depth chart rank")?.value, "WR3 (WR2 with the injured ahead out)");
  });
});

describe("fix round 1: one spike definition, a riser's share, a borrowed role that is his", () => {
  test("the projection (signals) and the role check call a spike on the same games (one definition)", async () => {
    const { computeAllSignals } = await import("./signals/index.js");
    const { PPR } = await import("../data/fixtures/signals2026.js");
    const series: { t: number[]; snap: number }[] = [
      { t: [2, 2, 2, 2, 2, 2, 9], snap: 0.3 },
      { t: [2, 2, 2, 2, 3, 5, 12], snap: 0.3 },
      { t: [8, 9, 8, 9, 8, 16, 8], snap: 0.9 },
      { t: [1, 2, 4, 3, 5, 0, 15], snap: 0.35 },
      { t: [4, 4, 4, 4], snap: 0.5 },
    ];
    for (const { t, snap } of series) {
      const p = player("x", "WR", "AAA", t, { snapShare: Object.fromEntries(t.map((_, i) => [i + 1, snap])) });
      const games = p.weeks.map((w) => ({ week: w.week, gameId: `g${w.week}`, team: "AAA", targets: w.opp!.targets, carries: 0, airYards: 0, passAttempts: 0, actual: w.actual, expected: w.expected, snapShare: snap }));
      const sig = computeAllSignals([{ id: "x", name: "x", pos: "WR", team: "AAA", games, status: [] }], { season: 2026, scoring: PPR, asOf: new Date("2026-10-26T00:00:00Z") }).get("x")!;
      const exp = sig.weeks.map((w) => w.expPts);
      const r = roleCheck({ p, weeks: p.weeks.map((w) => w.week), expPpg: exp, players: new Map(), usage: new Map(), offense: new Map() });
      assert.equal(r.spike, !!sig.spike, `targets ${t.join(",")}`);
    }
  });
  test("rising usage: the share follows his last 2 games (shown as such); flat usage: the last 4", () => {
    const usage = new Map([1, 2, 3, 4].map((w) => [`AAA|${w}`, { targets: 36, touches: 60 }]));
    const riser = roleCheck({ p: player("r", "WR", "AAA", [2, 3, 7, 8]), weeks: [1, 2, 3, 4], expPpg: [2.2, 3.3, 7.7, 8.8], players: new Map(), usage, offense: new Map() });
    assert.equal(riser.shareGames, 2);
    assert.ok(Math.abs(riser.healthyShare! - 15 / 72) < 1e-3);
    assert.ok(roleItems(riser, "WR").some((d) => /last 2 games/.test(d.value)));
    const flat = roleCheck({ p: player("f", "WR", "AAA", [4, 4, 4, 4]), weeks: [1, 2, 3, 4], expPpg: [4, 4, 4, 4], players: new Map(), usage, offense: new Map() });
    assert.equal(flat.shareGames, 4);
  });
  test("borrowed role whose teammate has no return week: his share counts those games, the detail says the role is his", () => {
    const me = player("me", "TE", "AAA", [2, 2, 8, 8]);
    const mate = player("wr", "WR", "AAA", [8, 8, null, null], { ret: { week: null, confidence: "unknown", reasons: [], absent: true, practiceUp: false } });
    const usage = teamUsage([me, mate]);
    const by = [{ id: "wr", name: "Lead WR", pos: "WR" }];
    const r = roleCheck({ p: me, weeks: [1, 2, 3, 4], expPpg: [1.5, 1.5, 9, 9], vacated: new Map([[3, by], [4, by]]), players: new Map([["wr", mate]]), usage, offense: new Map() });
    assert.equal(r.vacated?.back, false);
    assert.equal(r.healthyShare, 1, "weeks 3–4 count: he had all 16 team targets");
    assert.ok(roleItems(r, "TE").some((d) => d.label === "Borrowed role" && /the role is his/.test(d.value)));
  });
});
