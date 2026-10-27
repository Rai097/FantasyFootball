// ADVERSARIAL tests (tester, not developer) for Model v4 release (b): projection v4 math, availability, anchors,
// matchup bounds, context flags, memo expiry. Synthetic edge cases plus the real demo league (cached 2026 files).
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { V4, defaultMode, emptyTables, valuePlayers, type ProjectionTables, type ScheduledGame } from "./projectionV4.js";
import { computePlayerSignals } from "./signals/index.js";
import { contextFlags, usualStarters, BLOWOUT_MARGIN, FLAGGED_WEIGHT } from "./signals/context.js";
import { recencyWeights } from "./signals/recency.js";
import { efficiencyOf, EFF_CAPS } from "./signals/efficiency.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import { PPR } from "../data/fixtures/signals2026.js";
import type { League, Player, Position, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import type { PlayerGame, PlayerSignalInput, SkillPos } from "./signals/types.js";
import { staleMemo } from "../data/memo.js";
import { injuryKind } from "./projection.js";

const wk = (week: number, actual: Partial<StatLine>, expected: Partial<StatLine> = actual, teamAbbr = "KC", opp = { targets: 6, carries: 0, airYards: 60 }): WeekLine => ({
  season: 2026, week, team: teamAbbr, actual: line(actual), expected: line(expected), opp,
});
const games = (n: number, actual: Partial<StatLine>, expected: Partial<StatLine> = actual) => Array.from({ length: n }, (_, i) => wk(i + 1, actual, expected));
const L = (over: Parameters<typeof league>[2] = {}) => league([team("a", [])], undefined, { currentWeek: 8, numTeams: 12, scoring: { ...PPR }, ...over });
function filler(pos: Position, n = 40): Player[] {
  return Array.from({ length: n }, (_, i) =>
    rawPlayer(`${pos}${i + 1}`, pos, {
      ecrPos: i + 1,
      weeks: games(6, { recYd: 120 - i * 2.5, rec: 6 - i * 0.1, rushYd: pos === "RB" ? 80 - i : 0, passYd: pos === "QB" ? 280 - i * 3 : 0 }),
      prior: { games: 16, line: line({ recYd: (120 - i * 2.5) * 16, rec: (6 - i * 0.1) * 16, passYd: pos === "QB" ? (280 - i * 3) * 16 : 0 }) },
    }),
  );
}
const POOL = [...filler("QB", 30), ...filler("RB"), ...filler("WR"), ...filler("TE", 30)];
const ASOF = new Date("2026-10-26T00:00:00Z");

/** Every number a ValuedPlayer exposes is finite and ≥ 0 (weekly included). */
function assertSane(p: ValuedPlayer, where: string, S: League["settings"]) {
  const nums: [string, number | undefined][] = [
    ["ppg", p.ppg], ["effPpg", p.effPpg], ["value", p.value], ["vorp", p.vorp], ["seasonPts", p.seasonPts], ["playoffPts", p.playoffPts], ["remainingGames", p.remainingGames],
  ];
  for (const [k, v] of nums) assert.ok(v !== undefined && Number.isFinite(v) && v >= 0, `${where} ${p.name}: ${k} = ${v}`);
  assert.ok(p.value <= 100, `${where} ${p.name}: value ${p.value} > 100`);
  const n = Math.max(0, S.finalWeek - S.currentWeek + 1);
  assert.equal(p.weeklyFrom, S.currentWeek, `${where} ${p.name}: weeklyFrom`);
  assert.equal(p.weekly!.length, n, `${where} ${p.name}: weekly length`);
  for (const x of p.weekly!) assert.ok(Number.isFinite(x) && x >= 0, `${where} ${p.name}: weekly ${p.weekly}`);
  // playoffPts = Σ weeks 15..17; weekly entries and the total are each rounded to 0.1 separately.
  const po = p.weekly!.reduce((a, x, i) => a + (S.currentWeek + i > S.regularSeasonEnd ? x : 0), 0);
  assert.ok(Math.abs(po - p.playoffPts!) <= 0.21, `${where} ${p.name}: playoffPts ${p.playoffPts} vs Σ weekly 15-17 ${po.toFixed(2)}`);
  const se = p.weekly!.reduce((a, x, i) => a + (S.currentWeek + i <= S.regularSeasonEnd ? x : 0), 0);
  assert.ok(Math.abs(se - p.seasonPts!) <= 0.05 * Math.max(0, S.regularSeasonEnd - S.currentWeek + 2) + 0.01, `${where} ${p.name}: seasonPts ${p.seasonPts} vs Σ weekly ${se.toFixed(2)}`);
}

/** Signal input built by hand (for flags the Player shape cannot carry: margins, QB starters, roster status). */
function input(id: string, pos: SkillPos, gs: Partial<PlayerGame>[], extra: Partial<PlayerSignalInput> = {}): PlayerSignalInput {
  return {
    id, name: id, pos, team: "KC", status: [],
    games: gs.map((g, i) => ({
      week: i + 1, gameId: `g${i + 1}`, team: "KC", targets: 7, carries: 0, airYards: 70, passAttempts: 0,
      actual: line({ rec: 5, recYd: 60 }), expected: line({ rec: 5, recYd: 60 }), ...g,
    })),
    ...extra,
  };
}
const sigTables = (...inputs: PlayerSignalInput[]): ProjectionTables => ({
  ...emptyTables(),
  signals: new Map(inputs.map((i) => [i.id, computePlayerSignals(i, { season: 2026, scoring: PPR, asOf: ASOF })])),
});
const weeksOf = (p: Player, n: number, actual: Partial<StatLine> = { rec: 5, recYd: 60 }) => ({ ...p, weeks: games(n, actual) });
const item = (v: ValuedPlayer, label: string) => v.whyItems?.find((d) => d.label === label)?.value ?? "";

describe("projection v4 synthetic edge cases (adversarial)", () => {
  test("0 games / 1 game / rookie no ECR / K and DEF with and without rank / season over: no NaN, no negatives", () => {
    const pool: Player[] = [
      ...POOL,
      rawPlayer("zero", "WR"),
      weeksOf(rawPlayer("one", "WR"), 1),
      rawPlayer("rookieNoEcr", "RB", { prior: null }),
      rawPlayer("k1", "K", { ecrPos: 1 }),
      rawPlayer("kUnranked", "K"),
      rawPlayer("def1", "DEF", { ecrPos: 3, team: "DEN" }),
      rawPlayer("defUnranked", "DEF", { team: "NYJ" }),
    ];
    for (const cw of [1, 8, 14, 15, 17, 18]) {
      const lg = L({ currentWeek: cw });
      const v = valuePlayers(lg, pool);
      for (const p of v.players.values()) assertSane(p, `week ${cw}`, lg.settings);
      if (cw === 18) for (const p of v.players.values()) assert.equal(p.value, 0, `${p.name}: value after the season`);
      if (cw >= 15) for (const p of v.players.values()) assert.equal(p.seasonPts, 0, `${p.name}: no regular season left at week ${cw}`);
    }
  });

  test("unranked K in a pool with ranked K is projected below the worst ranked K", () => {
    const ks = Array.from({ length: 20 }, (_, i) => rawPlayer(`K${i + 1}`, "K", { ecrPos: i + 1 }));
    const v = valuePlayers(L(), [...POOL, ...ks, rawPlayer("kU", "K")]);
    assert.ok(v.players.get("kU")!.ppg <= v.players.get("K20")!.ppg, `unranked ${v.players.get("kU")!.ppg} vs K20 ${v.players.get("K20")!.ppg}`);
  });

  test("all games flagged (blowouts): finite rate, explained, ECR anchor stays 25%", () => {
    const allFlagged = input("flag", "WR", Array.from({ length: 6 }, () => ({ teamMargin: 35 })));
    const v = valuePlayers(L(), [...POOL, rawPlayer("flag", "WR", { ecrPos: 20, weeks: games(6, { rec: 5, recYd: 60 }) })], sigTables(allFlagged)).players.get("flag")!;
    assertSane(v, "all flagged", L().settings);
    assert.ok(v.ppg > 0);
    assert.match(item(v, "Odd games"), /^6 count 25%/);
    assert.match(item(v, "Experts (ECR)"), /25% weight/, "0 unflagged games → 25% anchor");
  });

  test("ECR anchor weight: 3 unflagged games 25%, 4 → 10%, 4 games with one flagged → still 25%", () => {
    const at = (n: number) => valuePlayers(L(), [...POOL, rawPlayer("x", "WR", { ecrPos: 15, weeks: games(n, { rec: 6, recYd: 70 }) })]).players.get("x")!;
    assert.match(item(at(3), "Experts (ECR)"), /25% weight/);
    assert.match(item(at(4), "Experts (ECR)"), /10% weight/);
    const gs = [{}, {}, {}, { teamMargin: -28 }];
    const v = valuePlayers(L(), [...POOL, rawPlayer("y", "WR", { ecrPos: 15, weeks: games(4, { rec: 6, recYd: 70 }) })], sigTables(input("y", "WR", gs))).players.get("y")!;
    assert.match(item(v, "Experts (ECR)"), /25% weight/, "only 3 unflagged games");
  });

  test("player traded mid-season (posteam changes): every game counts, weekly follows his new team's schedule", () => {
    const weeks = [1, 2, 3].map((w) => wk(w, { rec: 6, recYd: 80 }, { rec: 6, recYd: 80 }, "NYJ")).concat([4, 5, 6].map((w) => wk(w, { rec: 6, recYd: 80 }, { rec: 6, recYd: 80 }, "KC")));
    const p = rawPlayer("traded", "WR", { team: "KC", ecrPos: 12, weeks });
    const sched: ProjectionTables = {
      ...emptyTables(),
      schedule: new Map([
        ["KC", new Map([9, 10, 11, 12, 13, 14, 15, 16, 17].map((w) => [w, { opp: "DEN", home: true } as ScheduledGame]))],
        ["NYJ", new Map([8, 9, 10, 11, 12, 13, 14, 15, 16, 17].map((w) => [w, { opp: "MIA", home: true } as ScheduledGame]))],
      ]),
    };
    const v = valuePlayers(L(), [...POOL, p], sched).players.get("traded")!;
    assertSane(v, "traded", L().settings);
    assert.equal(v.games, 6);
    assert.equal(v.weekly![0], 0, "KC has no week-8 game (NYJ does): uses his CURRENT team");
    assert.ok(v.weekly![1] > 0);
  });

  test("bye in the current week: weekly[0] = 0 and a Questionable tag shades week 9, not week 10+", () => {
    const base = rawPlayer("byeq", "WR", { ecrPos: 8, bye: 8, weeks: games(6, { rec: 6, recYd: 80 }) });
    const healthy = valuePlayers(L(), [...POOL, base]).players.get("byeq")!;
    const q = valuePlayers(L(), [...POOL, { ...base, injury: { status: "Q", week: 8 } }]).players.get("byeq")!;
    assert.equal(q.weekly![0], 0);
    assert.ok(Math.abs(q.weekly![1] - V4.questionable * healthy.weekly![1]) <= 0.1, `week 9 ${q.weekly![1]} vs 0.85 × ${healthy.weekly![1]}`);
    assert.deepEqual(q.weekly!.slice(2), healthy.weekly!.slice(2), "weeks 10-17 untouched");
  });

  test("QB with rushing only / player with expected 0 but actual > 0: finite, positive, luck unknown not 0", () => {
    const qb = rawPlayer("rushQb", "QB", { ecrPos: 20, weeks: games(6, { rushYd: 60, rushTd: 1 }, { rushYd: 55, rushTd: 0.6 }) });
    const ghost = rawPlayer("ghost", "WR", { weeks: games(6, { rec: 6, recYd: 120, recTd: 1 }, {}) });
    const v = valuePlayers(L(), [...POOL, qb, ghost]);
    for (const id of ["rushQb", "ghost"]) assertSane(v.players.get(id)!, id, L().settings);
    assert.ok(v.players.get("rushQb")!.ppg > 5, `rushing QB ppg ${v.players.get("rushQb")!.ppg}`);
    const g = v.players.get("ghost")!;
    assert.ok(g.ppg > 0, "a 24-pt/g player with missing expected data is not 0");
    assert.equal(g.luck, undefined, "luck unknown when expected is 0");
  });

  test("expected 0 but actual 24 pts/g (missing expected data): projection keeps at least half his production", () => {
    // ffopportunity can miss a player's expected line; v4 then sees zero usage and projects ~the ECR anchor only.
    const ghost = rawPlayer("ghost", "WR", { weeks: games(6, { rec: 6, recYd: 120, recTd: 1 }, {}) });
    const g = valuePlayers(L(), [...POOL, ghost]).players.get("ghost")!;
    assert.ok(g.ppg >= 12, `ppg ${g.ppg} for actual ${g.ppg26} pts/g with expected ${g.ppgExp26}`);
  });

  test("efficiency caps per position hold for extreme over/under-performance", () => {
    for (const pos of ["QB", "RB", "WR", "TE"] as SkillPos[]) {
      const [lo, hi] = EFF_CAPS[pos];
      const hot = efficiencyOf(Array.from({ length: 30 }, () => ({ expPts: 10, actPts: 40, weight: 1, sample: 1 })), pos)!;
      const cold = efficiencyOf(Array.from({ length: 30 }, () => ({ expPts: 10, actPts: 0, weight: 1, sample: 1 })), pos)!;
      assert.equal(hot.shrunk, hi, `${pos} hot`);
      assert.equal(cold.shrunk, lo, `${pos} cold`);
      assert.equal(efficiencyOf([], pos), null);
    }
    // Through the valuation: a WR with 4 TDs a game never shows Finishing above ×1.30.
    const spike = rawPlayer("spike", "WR", { weeks: games(8, { rec: 5, recYd: 60, recTd: 4 }, { rec: 5, recYd: 60 }) });
    const v = valuePlayers(L(), [...POOL, spike]).players.get("spike")!;
    const m = item(v, "Finishing").match(/×([\d.]+)/);
    assert.ok(m && Number(m[1]) <= 1.3, item(v, "Finishing"));
  });

  test("matchup factor: clamped to 0.8–1.2 without Vegas, total 0.75–1.25 with; no allowed data → 1", () => {
    const p = rawPlayer("m", "WR", { ecrPos: 1, weeks: games(6, { rec: 9, recYd: 130, recTd: 1 }) });
    const sched = (opp: string, implied?: number): ProjectionTables => ({
      ...emptyTables(),
      schedule: new Map([
        ["KC", new Map([[8, { opp, home: true, ...(implied !== undefined ? { implied } : {}) } as ScheduledGame]])],
        ["OTH", new Map([[8, { opp: "X", home: true, implied: implied !== undefined ? 50 - implied : undefined } as ScheduledGame]])],
      ]),
      allowed: new Map([
        ["SOFT", { WR: { pts: 9999, games: 6 } }],
        ["HARD", { WR: { pts: 0, games: 6 } }],
        ["NODATA", { WR: { pts: 0, games: 0 } }],
      ]),
      leagueAllowed: { WR: 35 },
    });
    const w8 = (t: ProjectionTables) => valuePlayers(L(), [...POOL, p], t).players.get("m")!.weekly![0];
    const neutral = w8(sched("NEUTRAL"));
    assert.ok(neutral > 10);
    const r = (x: number) => x / neutral;
    assert.ok(Math.abs(w8(sched("NODATA")) - neutral) <= 0.05, "0 games allowed → factor 1");
    assert.ok(Math.abs(r(w8(sched("SOFT"))) - 1.2) <= 0.01, `soft ${r(w8(sched("SOFT")))}`);
    assert.ok(Math.abs(r(w8(sched("HARD"))) - 0.8) <= 0.01, `hard ${r(w8(sched("HARD")))}`);
    assert.ok(Math.abs(r(w8(sched("SOFT", 45))) - 1.25) <= 0.01, `soft + Vegas ${r(w8(sched("SOFT", 45)))}`);
    assert.ok(Math.abs(r(w8(sched("HARD", 5))) - 0.75) <= 0.01, `hard + Vegas ${r(w8(sched("HARD", 5)))}`);
  });

  test("injuries: Q / D / Out touch only the next game; IR, PUP, NA, SUSP, Suspended → 0 rest of season; -R → window estimate", () => {
    const base = rawPlayer("inj", "WR", { ecrPos: 6, weeks: games(6, { rec: 6, recYd: 80 }) });
    const healthy = valuePlayers(L(), [...POOL, base]).players.get("inj")!;
    const run = (status: string, detail?: string) => valuePlayers(L(), [...POOL, { ...base, injury: { status, week: 8, ...(detail ? { detail } : {}) } }]).players.get("inj")!;
    for (const [st, f] of [["Q", 0.85], ["Questionable", 0.85], ["D", 0.7], ["Doubtful", 0.7], ["O", 0], ["Out", 0]] as const) {
      const v = run(st);
      assert.ok(Math.abs(v.weekly![0] - f * healthy.weekly![0]) <= 0.1, `${st}: week 8 ${v.weekly![0]} vs ${f} × ${healthy.weekly![0]}`);
      assert.deepEqual(v.weekly!.slice(1), healthy.weekly!.slice(1), `${st}: weeks 9-17 untouched`);
    }
    for (const st of ["IR", "PUP-P", "NA", "NFI", "SUSP", "Suspended"]) {
      const v = run(st);
      assert.ok(v.weekly!.every((x) => x === 0), `${st}: ${v.weekly}`);
      assert.equal(v.value, 0, st);
      assert.equal(v.remainingGames, 0, st);
    }
    const ir = run("Out", "Knee - ACL");
    assert.ok(ir.weekly!.every((x) => x === 0), `Out ACL: ${ir.weekly}`);
    // Designated to return (release (c) estimate): missed 1 game → IR minimum leaves 3 → back week 11, × 0.85 that game.
    const ret = run("IR-R");
    assert.equal(ret.ret!.week, 11);
    assert.deepEqual(ret.weekly!.slice(0, 3), [0, 0, 0]);
    // Absent with a sample: no ECR anchor (fix round 2), so the return weeks follow his own healthy rate.
    assert.ok(Math.abs(ret.weekly![3] - 0.85 * ret.ret!.healthyRate!) <= 0.1);
    for (const x of ret.weekly!.slice(4)) assert.ok(Math.abs(x - ret.ret!.healthyRate!) <= 0.051 || x === 0, `${x}`);
  });

  test("nflverse roster RES with a game last week (freshly placed on IR, no Yahoo tag) is not projected at full strength", () => {
    // Real 2026 cache, week 7: Davante Adams (LAR), Romeo Doubs (NE) and others are RES on the roster file with their
    // last game in week 5-6 and no injury tag; v4 values them at full strength because RES only counts after 2 idle weeks.
    const sig = input("res", "WR", Array.from({ length: 7 }, () => ({})), { roster: { status: "RES" } });
    const p = rawPlayer("res", "WR", { ecrPos: 10, weeks: games(7, { rec: 5, recYd: 60 }) });
    const v = valuePlayers(L(), [...POOL, p], sigTables(sig)).players.get("res")!;
    assert.equal(v.weekly![0], 0, `RES player, last game week 7, current week 8: weekly ${v.weekly}`);
  });

  test("a buy-low label is never put on a player projected 0 for the rest of the season", () => {
    const p = rawPlayer("unlucky", "RB", { ecrPos: 15, injury: { status: "IR", week: 8 }, weeks: games(6, { rushYd: 40, rec: 2, recYd: 10 }, { rushYd: 70, rushTd: 0.6, rec: 4, recYd: 30 }) });
    const v = valuePlayers(L(), [...POOL, p]).players.get("unlucky")!;
    assert.equal(v.value, 0);
    assert.notEqual(v.label, "buy-low", `label ${v.label} with luck ${v.luck} on an IR player`);
  });

  test("defaultMode: seed beats rank; boundary seed = numTeams/2 is in; seed 0 / out of range → balanced", () => {
    const mk = (rec: object | undefined) => ({ ...L(), settings: { ...L().settings, numTeams: 12 }, teams: [{ ...team("a", []), record: rec as never }] });
    assert.equal(defaultMode(mk({ wins: 5, losses: 1, ties: 0, seed: 6 }), "a"), "playoffs");
    assert.equal(defaultMode(mk({ wins: 5, losses: 1, ties: 0, seed: 7 }), "a"), "balanced");
    assert.equal(defaultMode(mk({ wins: 5, losses: 1, ties: 0, seed: 8, rank: 2 }), "a"), "balanced");
    assert.equal(defaultMode(mk({ wins: 5, losses: 1, ties: 0, rank: 3 }), "a"), "playoffs");
    assert.equal(defaultMode(mk({ wins: 5, losses: 1, ties: 0, seed: 0 }), "a"), "balanced");
    assert.equal(defaultMode(mk(undefined), "a"), "balanced");
    assert.equal(defaultMode(mk({ wins: 5, losses: 1, ties: 0, seed: 1 }), "nobody"), "balanced");
  });
});

describe("context flags (adversarial)", () => {
  const starts = (seq: string[]) => seq.map((qbId, i) => ({ week: i + 1, qbId }));

  test("returning starter after 3 missed games is usual; his games are never qbOut", () => {
    for (const seq of [
      ["A", "A", "A", "B", "B", "B", "A"],
      ["A", "A", "A", "A", "B", "B", "B", "A"],
      ["A", "A", "B", "B", "B", "A", "A"],
      ["A", "B", "B", "B", "A"],
    ]) {
      assert.ok(usualStarters(starts(seq)).includes("A"), seq.join(""));
    }
  });

  test("mid-season trade of the starter: the new team's starter (≥ 3 starts) and the old team's replacement are usual", () => {
    // QB X: team1 weeks 1-4, traded; team2 weeks 6-8 after its own starter Z weeks 1-5.
    const team1 = starts(["X", "X", "X", "X", "Y", "Y", "Y"]);
    const team2 = starts(["Z", "Z", "Z", "Z", "Z", "X", "X", "X"]);
    assert.ok(usualStarters(team1).includes("X") && usualStarters(team1).includes("Y"), usualStarters(team1).join(","));
    assert.ok(usualStarters(team2).includes("X") && usualStarters(team2).includes("Z"), usualStarters(team2).join(","));
  });

  test("two-QB 50/50 platoon (A,B alternating over 8 games): neither QB's games are qbOut", () => {
    const u = usualStarters(starts(["A", "B", "A", "B", "A", "B", "A", "B"]));
    assert.ok(u.includes("A") && u.includes("B"), `usual = ${u.join(",")}: half the WRs' games are flagged qbOut`);
  });

  test("qbOut is never set on a QB's own games, nor when starter or usual set is unknown", () => {
    const g = (o: Partial<PlayerGame>): PlayerGame => ({ week: 1, gameId: "g", team: "KC", targets: 0, carries: 0, airYards: 0, passAttempts: 30, actual: line(), expected: line(), ...o });
    assert.equal(contextFlags([g({ starterQbId: "B", usualQbIds: ["A"] })], "QB")[0].qbOut, false);
    assert.equal(contextFlags([g({ starterQbId: "B", usualQbIds: ["A"] })], "WR")[0].qbOut, true);
    assert.equal(contextFlags([g({ usualQbIds: ["A"] })], "WR")[0].qbOut, false);
    assert.equal(contextFlags([g({ starterQbId: "B", usualQbIds: [] })], "WR")[0].qbOut, false);
  });

  test("blowout at |margin| ≥ 21 exactly; leftEarly at < 15% after a ≥ 50% average; flagged weight 0.25", () => {
    const g = (o: Partial<PlayerGame>, week = 1): PlayerGame => ({ week, gameId: `g${week}`, team: "KC", targets: 0, carries: 0, airYards: 0, passAttempts: 0, actual: line(), expected: line(), ...o });
    assert.equal(BLOWOUT_MARGIN, 21);
    assert.deepEqual([20, 21, -21, -20].map((m) => contextFlags([g({ teamMargin: m })], "WR")[0].blowout), [false, true, true, false]);
    const le = (before: number, last: number) => contextFlags([g({ snapShare: before }, 1), g({ snapShare: last }, 2)], "RB")[1].leftEarly;
    assert.equal(le(0.5, 0.149), true);
    assert.equal(le(0.5, 0.15), false);
    assert.equal(le(0.499, 0.1), false);
    assert.equal(contextFlags([g({ snapShare: 0.05 })], "RB")[0].leftEarly, false, "first game: no 'before'");
    const w = recencyWeights([false, true]);
    assert.equal(FLAGGED_WEIGHT, 0.25);
    assert.equal(w[1], 0.25);
    assert.equal(recencyWeights([false, false])[1], 1);
  });
});

describe("signal/projection memo expiry (adversarial)", () => {
  test("staleMemo: served within ttl, rebuilt after ttl, bounded, a rejection is evicted", async () => {
    let now = 0;
    const m = staleMemo<number>(1000, 2, () => now);
    let calls = 0;
    const make = () => Promise.resolve(++calls);
    assert.equal(await m.get("a", make), 1);
    now = 1000;
    assert.equal(await m.get("a", make), 1, "at ttl: still cached");
    now = 1001;
    assert.equal(await m.get("a", make), 2, "after ttl: rebuilt (player DB cadence)");
    await m.get("b", make);
    await m.get("c", make);
    assert.equal(m.size(), 2, "bounded");
    await assert.rejects(m.get("d", () => Promise.reject(new Error("x"))));
    await new Promise((r) => setImmediate(r));
    const before = calls;
    assert.equal(await m.get("d", make), before + 1, "rejection not cached");
  });
});

describe("projection v4 on the demo league (adversarial, cached 2026 data)", { timeout: 300_000 }, () => {
  let lg: League;
  let tables: ProjectionTables;
  let pool: Player[];
  let rostered: Set<string>;
  let vals: Map<string, ValuedPlayer>[] = [];
  let valuation: ReturnType<typeof valuePlayers>;
  before(async () => {
    const { getPlayerDb } = await import("../data/players.js");
    const { getNflState } = await import("../data/nfl.js");
    const { buildDemoLeague } = await import("../providers/demo.js");
    const { getProjectionTables } = await import("../data/signalTables.js");
    const db = await getPlayerDb();
    const st = await getNflState();
    lg = buildDemoLeague({ season: db.season, currentWeek: st.currentWeek, players: db.players.values(), builtAt: db.builtAt }, 42);
    tables = await getProjectionTables(db.season, lg.settings.scoring);
    pool = [...db.players.values()];
    rostered = new Set(lg.teams.flatMap((t) => t.playerIds));
    valuation = valuePlayers(lg, pool, tables, "balanced");
    vals = [valuation.players, valuePlayers(lg, pool, tables, "playoffs").players];
  });

  test("every player in both modes: finite, ≥ 0, weekly length = remaining weeks, playoffPts = Σ weeks 15–17", () => {
    for (const m of vals) for (const p of m.values()) assertSane(p, "demo", lg.settings);
  });

  test("every player with games or an ECR rank has his NFL team in the remaining schedule (no silent all-zero team)", () => {
    const teams = new Set(tables.schedule.keys());
    const missing = pool.filter((p) => (p.weeks.length || p.ecrPos !== undefined) && p.team !== "FA" && p.pos !== "DEF" && !teams.has(p.team)).map((p) => `${p.name} ${p.team}`);
    assert.deepEqual(missing.slice(0, 10), []);
    assert.equal(teams.size, 32);
  });

  test("next game is per team: Q / D / Out shade only each player's first remaining game (DAL/PHI week 7, others week 8+)", () => {
    let checked = 0;
    for (const p of pool) {
      if (!p.injury || !rostered.has(p.id)) continue;
      const v = valuation.players.get(p.id)!;
      const healthy = valuation.valueOf({ ...p, injury: undefined });
      const st = p.injury.status.trim().toUpperCase();
      const k = injuryKind(p.injury);
      const f = k === "out" && st !== "SUSP" ? 0 : k === "doubtful" ? 0.7 : k === null && (st === "Q" || st === "QUESTIONABLE") ? 0.85 : null;
      if (f === null) continue;
      const first = healthy.weekly!.findIndex((x) => x > 0);
      if (first < 0) continue;
      checked++;
      assert.ok(Math.abs(v.weekly![first] - f * healthy.weekly![first]) <= 0.1, `${p.name} (${p.team}, ${p.injury.status}): first game wk ${lg.settings.currentWeek + first} ${v.weekly![first]} vs ${f} × ${healthy.weekly![first]}`);
      assert.deepEqual(v.weekly!.slice(first + 1), healthy.weekly!.slice(first + 1), `${p.name}: later weeks untouched`);
      if (!["DAL", "PHI"].includes(p.team) && lg.settings.currentWeek === 7) assert.ok(first >= 1, `${p.name} ${p.team}: week 7 already played`);
    }
    assert.ok(checked >= 5, `checked ${checked} injured rostered players`);
  });

  test("labels follow luck: buy-low ⇒ luck ≥ +2.0; sell-high ⇒ luck ≤ −2.0 with the TD part dominant", () => {
    for (const p of vals[0].values()) {
      if (p.label === "buy-low") assert.ok(p.luck! >= 1.95, `${p.name}: buy-low with luck ${p.luck}`);
      if (p.label === "sell-high") {
        assert.ok(p.luck! <= -1.95, `${p.name}: sell-high with luck ${p.luck}`);
        assert.ok(Math.abs(p.luckTd!) + 0.1 >= Math.abs(p.luck! - p.luckTd!), `${p.name}: sell-high not TD-driven (${p.luckTd} of ${p.luck})`);
      }
      if (p.luck === undefined) assert.equal(p.label, undefined, `${p.name}: label without luck`);
    }
  });

  test("players on nflverse reserve (roster RES) score 0 before their estimated return week (every week when unconfirmed)", () => {
    const bad: string[] = [];
    let estimated = 0;
    for (const p of pool) {
      const s = tables.signals.get(p.id);
      if (s?.rosterStatus !== "RES") continue;
      const v = valuation.players.get(p.id)!;
      assert.ok(v.ret?.absent, `${p.name}: RES without a return estimate`);
      const back = v.ret!.week;
      if (back !== null) estimated++;
      const early = v.weekly!.findIndex((x, i) => x > 0 && (back === null || lg.settings.currentWeek + i < back));
      if (early >= 0) bad.push(`${p.name} ${p.team} (back ${back}, wk ${lg.settings.currentWeek + early} = ${v.weekly![early]})`);
    }
    assert.deepEqual(bad, []);
    assert.ok(estimated > 0, "some reserve players practise (designated to return) and get a week");
  });
});
