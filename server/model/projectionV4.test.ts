import { test } from "node:test";
import assert from "node:assert/strict";
import { V4, defaultMode, emptyTables, signalInputFromPlayer, valuePlayers, type ProjectionTables, type ScheduledGame } from "./projectionV4.js";
import { computeAllSignals, computePlayerSignals } from "./signals/index.js";
import { ASOF, fixtureInputs, IDS, PPR } from "../data/fixtures/signals2026.js";
import { detailProblems, league, line, rawPlayer, team } from "./testkit.js";
import type { Player, Position, StatLine, WeekLine } from "./types.js";
import type { StatusWeek } from "./signals/types.js";

const wk = (week: number, actual: Partial<StatLine>, expected: Partial<StatLine>, opp = { targets: 0, carries: 0, airYards: 0 }): WeekLine => ({
  season: 2026, week, team: "KC", actual: line(actual), expected: line(expected), opp,
});
/** n identical games (weeks 1..n). */
const games = (n: number, actual: Partial<StatLine>, expected: Partial<StatLine> = actual, opp?: WeekLine["opp"]) =>
  Array.from({ length: n }, (_, i) => wk(i + 1, actual, expected, opp));

const L = (over: Parameters<typeof league>[2] = {}) => league([team("a", [])], undefined, { currentWeek: 8, numTeams: 12, ...over });
/** A filler pool so the ECR curve and replacement levels exist: 40 per position with descending production. */
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

test("QB-out TE (CHI 2026, backups weeks 3-5): v4 rate above his plain season average", () => {
  const sig = computeAllSignals(fixtureInputs().values(), { season: 2026, scoring: PPR, asOf: ASOF });
  const lv = sig.get(IDS.loveland)!;
  const tables: ProjectionTables = { ...emptyTables(), signals: sig };
  const pl = rawPlayer(IDS.loveland, "TE", { team: "CHI" });
  const v = valuePlayers(L({ scoring: PPR }), [...POOL, pl], tables).players.get(IDS.loveland)!;
  const seasonAvgAct = lv.seasonAvg.actPts!;
  const seasonAvgExp = lv.seasonAvg.expPts!;
  assert.ok(v.ppg > seasonAvgAct && v.ppg > seasonAvgExp, `v4 ${v.ppg} vs season act ${seasonAvgAct.toFixed(2)} / exp ${seasonAvgExp.toFixed(2)}`);
  assert.ok(v.whyItems!.some((d) => d.label === "Odd games" && /backup QB/.test(d.value)), "the down-weighted games are explained");
});

test("TD-spike WR regresses toward his expected points (and is labelled sell-high)", () => {
  // 6 games: usage worth 10 pts/game (PPR), actual 22 thanks to 2 TDs a game.
  const spike = rawPlayer("spike", "WR", { weeks: games(6, { rec: 5, recYd: 50, recTd: 2 }, { rec: 5, recYd: 50, recTd: 0 }, { targets: 7, carries: 0, airYards: 70 }) });
  const v = valuePlayers(L({ scoring: PPR }), [...POOL, spike]).players.get("spike")!;
  assert.equal(v.ppg26, 22);
  assert.equal(v.ppgExp26, 10);
  assert.ok(v.ppg < 14 && v.ppg > 10, `ppg ${v.ppg}: efficiency capped at 1.3 and shrunk`);
  assert.equal(v.label, "sell-high");
  assert.ok(v.luck! <= -10, `luck ${v.luck}`);
  assert.ok(v.whyItems!.some((d) => d.label === "Luck" && /sell-high/.test(d.value)));
});

test("rookie with no history and no games: rate = the ECR anchor at his rank (100% weight)", () => {
  const rookie = rawPlayer("rook", "WR", { ecrPos: 10 });
  const val = valuePlayers(L(), [...POOL, rookie]);
  const r = val.players.get("rook")!;
  const wr10 = val.players.get("WR10")!;
  assert.ok(r.ppg > 0, "not 0");
  assert.ok(Math.abs(r.ppg - wr10.ppg) < 0.25 * wr10.ppg, `rookie ${r.ppg} vs WR10 ${wr10.ppg}`);
  assert.ok(r.whyItems!.some((d) => d.label === "Experts (ECR)" && /100% weight/.test(d.value)), JSON.stringify(r.whyItems));
  const nobody = valuePlayers(L(), [...POOL, rawPlayer("nobody", "WR")]).players.get("nobody")!;
  assert.equal(nobody.ppg, 0);
  assert.equal(nobody.value, 0);
  assert.match(nobody.whyItems![0].value, /no game this season, no expert rank/);
});

test("bye week = 0 (player bye or no game in the schedule); others get rate × matchup", () => {
  const p = rawPlayer("bye", "WR", { ecrPos: 5, bye: 10, weeks: games(6, { rec: 6, recYd: 80 }) });
  const v = valuePlayers(L(), [...POOL, p]).players.get("bye")!;
  assert.equal(v.weeklyFrom, 8);
  assert.equal(v.weekly!.length, 17 - 8 + 1);
  assert.equal(v.weekly![10 - 8], 0);
  assert.ok(v.weekly!.every((x, i) => i === 2 || x > 0));
  // Schedule tables: a missing week is no game (bye, or already played).
  const sched: ProjectionTables = { ...emptyTables(), schedule: new Map([["KC", new Map([8, 9, 11, 12, 13, 14, 15, 16, 17].map((w) => [w, { opp: "DEN", home: true }]))]]) };
  const s = valuePlayers(L(), [...POOL, p], sched).players.get("bye")!;
  assert.equal(s.weekly![10 - 8], 0);
  assert.ok(s.weekly![9 - 8] > 0);
});

test("Out = 0 for his next game only; IR = 0 rest of season (return unconfirmed); designated to return = window estimate; Q / D shade this week", () => {
  const mk = (id: string, status?: string, detail?: string) =>
    rawPlayer(id, "RB", { ecrPos: 8, weeks: games(6, { rushYd: 90, rec: 3, recYd: 20 }), ...(status ? { injury: { status, detail, week: 8 } } : {}) });
  const val = valuePlayers(L(), [...POOL, mk("ok"), mk("out", "Out", "Hamstring"), mk("ir", "IR"), mk("ret", "IR-R"), mk("q", "Questionable"), mk("d", "Doubtful")]);
  const g = (id: string) => val.players.get(id)!;
  const healthy = g("ok").weekly!;
  assert.equal(g("out").weekly![0], 0);
  assert.deepEqual(g("out").weekly!.slice(1), healthy.slice(1));
  assert.ok(g("ir").weekly!.every((x) => x === 0));
  assert.equal(g("ir").value, 0);
  // Designated to return (no practice row): inside the 21-day window, floored by the IR minimum (missed 1 → 3 more).
  const ret = g("ret");
  assert.equal(ret.ret!.week, 8 + 3);
  assert.equal(ret.ret!.confidence, "medium");
  assert.deepEqual(ret.weekly!.slice(0, 3), [0, 0, 0]);
  // Absent with a sample: no ECR anchor (the rank prices the absence), so compare with his own healthy rate, not a twin.
  assert.ok(Math.abs(ret.weekly![3] - ret.ret!.healthyRate! * 0.85) < 0.06, "first game back × 0.85");
  assert.ok(Math.abs(ret.weekly![4] - ret.ret!.healthyRate!) < 0.051, "full after the ramp game");
  assert.equal(g("out").ret!.week, 9, "ruled out once: back the game after");
  assert.equal(g("ir").ret!.week, null);
  assert.ok(g("ir").ret!.returnValue! > 0, "return unconfirmed: a stash value, not 0");
  assert.ok(Math.abs(g("q").weekly![0] - healthy[0] * V4.questionable) < 0.06);
  assert.ok(Math.abs(g("d").weekly![0] - healthy[0] * V4.doubtful) < 0.06);
  assert.deepEqual(g("q").weekly!.slice(1), healthy.slice(1));
  assert.equal(g("ok").ppg, g("out").ppg, "ppg is the healthy rate");
  assert.ok(g("out").effPpg! < g("ok").effPpg!, "lineup pts/game include the missed week");
  assert.ok(g("ir").whyItems!.some((d) => d.label === "Availability" && /return unconfirmed/.test(d.value)));
  // availThisWeek (the My Team "check status" chip) carries v4's factor for this week's game only.
  assert.equal(g("q").availThisWeek, V4.questionable);
  assert.equal(g("d").availThisWeek, V4.doubtful);
  assert.equal(g("out").availThisWeek, 0);
  assert.equal(g("ok").availThisWeek, undefined);
  assert.equal(g("ir").availThisWeek, undefined, "long-term: no weekly chip, the season is 0");
});

test("scoring.rec 1.0 vs 0.5: a 6-catch receiver gains ~3 pts/game", () => {
  const p = rawPlayer("rec", "WR", { weeks: games(6, { rec: 6, recYd: 60 }), ecrPos: 12 });
  const half = valuePlayers(L({ scoring: { ...PPR, rec: 0.5 } }), [...POOL, p]).players.get("rec")!;
  const full = valuePlayers(L({ scoring: PPR }), [...POOL, p]).players.get("rec")!;
  const d = full.ppg - half.ppg;
  assert.ok(d > 2 && d < 4, `full ${full.ppg} − half ${half.ppg} = ${d}`);
});

test("matchup: soft defenses raise a week, tough ones lower it; the next game's Vegas total adds a bonus", () => {
  const p = rawPlayer("m", "WR", { ecrPos: 6, weeks: games(6, { rec: 6, recYd: 80 }) });
  const weeks = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
  const opp = (w: number) => (w === 9 ? "SOFT" : w === 10 ? "HARD" : "AVG");
  const tables: ProjectionTables = {
    ...emptyTables(),
    schedule: new Map<string, Map<number, ScheduledGame>>([
      ["KC", new Map(weeks.map((w): [number, ScheduledGame] => [w, { opp: opp(w), home: true, ...(w === 8 ? { implied: 30 } : {}) }]))],
      ["XX", new Map<number, ScheduledGame>([[8, { opp: "KC", home: false, implied: 20 }]])],
    ]),
    allowed: new Map([
      ["SOFT", { WR: { pts: 60 * 8, games: 8 } }],
      ["HARD", { WR: { pts: 25 * 8, games: 8 } }],
      ["AVG", { WR: { pts: 40 * 8, games: 8 } }],
    ]),
    leagueAllowed: { WR: 40 },
  };
  const v = valuePlayers(L(), [...POOL, p], tables).players.get("m")!;
  const [w8, w9, w10, w11] = v.weekly!;
  assert.ok(w9 > w11 && w11 > w10, `${w9} > ${w11} > ${w10}`);
  // Shrinkage: 8 games of 60 vs 4 pseudo-games of 40 → (480 + 160) / 12 / 40 = 1.33 → clamped 1.2.
  assert.ok(Math.abs(w9 / w11 - V4.matchupClamp[1]) < 0.02, `soft ${w9 / w11}`);
  // Week 8: implied 30 vs average 25 → × (1 + 0.5 × 0.2) = 1.1.
  assert.ok(Math.abs(w8 / w11 - 1.1) < 0.02, `vegas ${w8 / w11}`);
  assert.ok(v.whyItems!.some((d) => d.label === "Next game" && /Vegas 30\.0/.test(d.value)));
});

test("value: playoffs mode weighs weeks 15-17 at 75%, so a playoff-week bye costs more than in balanced mode", () => {
  const twin = (id: string, bye?: number) => rawPlayer(id, "WR", { ecrPos: 3, bye, weeks: games(6, { rec: 7, recYd: 95 }) });
  const pool = [...POOL, twin("reg", 10), twin("po", 16)];
  const bal = valuePlayers(L(), pool, emptyTables(), "balanced").players;
  const po = valuePlayers(L(), pool, emptyTables(), "playoffs").players;
  assert.equal(bal.get("reg")!.value, bal.get("po")!.value, "balanced: a bye is a bye");
  assert.ok(po.get("reg")!.value > po.get("po")!.value, `playoffs: ${po.get("reg")!.value} vs ${po.get("po")!.value}`);
  assert.equal(po.get("po")!.valueMode, "playoffs");
  assert.ok(po.get("po")!.whyItems!.some((d) => d.label === "Value" && /playoff weeks 75%/.test(d.value)));
  // Top player = 100 in both modes; seasonPts + playoffPts = Σ weekly.
  assert.equal(Math.max(...[...po.values()].map((p) => p.value)), 100);
  const r = bal.get("reg")!;
  assert.ok(Math.abs(r.seasonPts! + r.playoffPts! - r.weekly!.reduce((a, b) => a + b, 0)) < 0.6);
});

test("K / DEF keep the ECR line; a bye is 0; no NaN anywhere; bullets are short single ideas", () => {
  const k = rawPlayer("k1", "K", { ecrPos: 1, bye: 12 });
  const d = rawPlayer("d20", "DEF", { ecrPos: 20 });
  const val = valuePlayers(L(), [...POOL, k, d, rawPlayer("empty", "TE")]);
  assert.equal(val.players.get("k1")!.ppg, 9);
  assert.equal(val.players.get("k1")!.weekly![12 - 8], 0);
  assert.ok(Math.abs(val.players.get("d20")!.ppg - (8.5 - 0.15 * 19)) < 1e-9);
  for (const p of val.players.values()) {
    for (const key of ["ppg", "effPpg", "value", "vorp", "remainingGames", "seasonPts", "playoffPts"] as const) assert.ok(Number.isFinite(p[key]), `${p.id}.${key} = ${p[key]}`);
    assert.ok(p.weekly!.every(Number.isFinite), p.id);
    assert.deepEqual(detailProblems(p.whyItems!), [], p.id);
    assert.ok(p.whyItems!.some((x) => x.label === "Value"));
    assert.ok(p.why.length > 0 && p.why.length <= 255);
  }
});

test("rising opportunity sets riser; valueOf re-values a fresher injury copy with the same signals; deterministic", () => {
  const p = rawPlayer("x", "RB", { ecrPos: 4, weeks: games(6, { rushYd: 85, rec: 3, recYd: 25 }) });
  const val = valuePlayers(L(), [...POOL, p]);
  const copy = { ...p, injury: { status: "Out", week: 8 } };
  const c = val.valueOf(copy);
  assert.equal(c.weekly![0], 0);
  assert.equal(c.ppg, val.players.get("x")!.ppg);
  assert.equal(val.valueOf(p), val.players.get("x"), "same object → cached");
  const again = valuePlayers(L(), [...POOL, p]).players.get("x")!;
  assert.deepEqual(again, val.players.get("x"));
});

test("default value mode: playoffs for a team in a playoff spot by standings, else balanced; unknown → balanced", () => {
  const l = league(
    [
      team("1", [], { record: { wins: 6, losses: 1, ties: 0, rank: 1 } }),
      team("2", [], { record: { wins: 3, losses: 4, ties: 0, rank: 7, seed: 7 } }),
      team("3", []),
      team("4", [], { record: { wins: 4, losses: 3, ties: 0, rank: 8, seed: 5 } }),
    ],
    undefined,
    { numTeams: 12 },
  );
  assert.equal(defaultMode(l, "1"), "playoffs");
  assert.equal(defaultMode(l, "2"), "balanced");
  assert.equal(defaultMode(l, "3"), "balanced");
  assert.equal(defaultMode(l, "4"), "playoffs", "seed wins over rank");
  assert.equal(defaultMode(l, undefined), "balanced");
});

test("replacement level, vorp and the convex 0-100 value scale (one-team league: RB replacement = 3rd best)", () => {
  // 30 RBs scoring 30, 29, …, 1 pts every game in both seasons: rate = his points (efficiency 1, no ECR).
  const steady = (i: number) => {
    const pts = 30 - i;
    return rawPlayer(`rb${i + 1}`, "RB", { weeks: games(3, { rushYd: pts * 10 }), prior: { games: 17, line: line({ rushYd: pts * 10 * 17 }) } });
  };
  const v = valuePlayers(league([team("1", [])], undefined, { scoring: PPR }), Array.from({ length: 30 }, (_, i) => steady(i)));
  assert.equal(v.replacement.RB, 28);
  const top = v.players.get("rb1")!;
  assert.equal(top.ppg, 30);
  assert.equal(top.value, 100);
  assert.equal(top.vorp, 2);
  assert.equal(top.posRank, 1);
  assert.equal(top.remainingGames, 14, "weeks 4..17, no bye");
  const second = v.players.get("rb2")!;
  assert.ok(second.value < 50 && second.value > 30, `half the surplus is worth ~39 (convexity 1.35), got ${second.value}`);
  assert.equal(v.players.get("rb10")!.value, 0);
});

test("luck is unknown (absent) without real usage, never a 0", () => {
  // Snap-only games: no expected points at all.
  const idle = rawPlayer("idle", "WR", { ecrPos: 60, weeks: games(4, {}, {}) });
  const v = valuePlayers(L(), [...POOL, idle]).players.get("idle")!;
  assert.equal(v.luck, undefined);
  assert.equal(v.label, undefined);
  assert.ok(!v.whyItems!.some((d) => d.label === "Luck"));
});

test("injury availability applies to his NEXT game, even when the current week is a bye or already played", () => {
  const mk = (id: string, status?: string) => rawPlayer(id, "WR", { ecrPos: 9, weeks: games(6, { rec: 6, recYd: 70 }), ...(status ? { injury: { status, week: 8 } } : {}) });
  // KC has no game in week 8 (already played / bye): the first remaining game is week 9.
  const sched: ProjectionTables = { ...emptyTables(), schedule: new Map([["KC", new Map([9, 10, 11, 12, 13, 14, 15, 16, 17].map((w): [number, ScheduledGame] => [w, { opp: "DEN", home: true }]))]]) };
  const val = valuePlayers(L(), [...POOL, mk("ok"), mk("out", "O"), mk("q", "Q")], sched);
  const g = (id: string) => val.players.get(id)!.weekly!;
  assert.equal(g("ok")[0], 0, "no game in week 8");
  assert.equal(g("out")[1], 0, "Out for the week-9 game");
  assert.equal(g("out")[2], g("ok")[2], "full after");
  assert.ok(Math.abs(g("q")[1] - g("ok")[1] * V4.questionable) < 0.06);
  assert.equal(val.players.get("q")!.availThisWeek, undefined, "no game this week: no 'check status' chip");
});

test("roster RES = 0 from now on even with a game last week (return unconfirmed); designated to return uses the estimate", () => {
  const p = rawPlayer("res", "WR", { ecrPos: 10, weeks: games(7, { rec: 5, recYd: 60 }) });
  const input = signalInputFromPlayer(p)!;
  const tables = (status: string): ProjectionTables => ({
    ...emptyTables(),
    signals: new Map([["res", computePlayerSignals({ ...input, roster: { status } }, { season: 2026, scoring: PPR, asOf: ASOF })]]),
  });
  const res = valuePlayers(L(), [...POOL, p], tables("RES")).players.get("res")!;
  assert.ok(res.weekly!.every((x) => x === 0), `RES weekly ${res.weekly}`);
  assert.equal(res.remainingGames, 0);
  assert.ok(res.whyItems!.some((d) => d.label === "Availability" && /return unconfirmed/.test(d.value)));
  const act = valuePlayers(L(), [...POOL, p], tables("ACT")).players.get("res")!;
  assert.ok(act.weekly![0] > 0);
  const dtr = valuePlayers(L(), [...POOL, { ...p, injury: { status: "IR-R", week: 8 } }], tables("RES")).players.get("res")!;
  // Played through week 7 → the IR minimum (4 games) binds: back in his 5th remaining game.
  assert.equal(dtr.ret!.week, 12);
  assert.deepEqual(dtr.weekly!.slice(0, 4), [0, 0, 0, 0]);
  assert.ok(Math.abs(dtr.weekly![5] - dtr.ret!.healthyRate!) < 0.051, "designated to return: full (his healthy rate) after the ramp game");
});

test("missing expected data (expected 0, actual > 0 over ≥ 2 games): rate from actual points, flagged, noted", () => {
  const ghost = rawPlayer("ghost", "WR", { ecrPos: 20, weeks: games(6, { rec: 6, recYd: 120, recTd: 1 }, {}) });
  const one = rawPlayer("one", "WR", { ecrPos: 20, weeks: [...games(5, { rec: 5, recYd: 60 }), wk(6, { rec: 6, recYd: 120, recTd: 1 }, {})] });
  const val = valuePlayers(L(), [...POOL, ghost, one]);
  const g = val.players.get("ghost")!;
  assert.ok(g.ppg >= 18, `ppg ${g.ppg} for 24 actual pts/game`);
  assert.ok(g.whyItems!.some((d) => d.label === "Usage data" && d.tone === "warn"));
  assert.equal(g.luck, undefined, "luck stays unknown");
  assert.ok(val.notes.some((n) => /Usage data missing for 1 player/.test(n)), val.notes.join(" | "));
  assert.ok(!val.players.get("one")!.whyItems!.some((d) => d.label === "Usage data"), "one odd game does not switch the model");
});

test("no buy-low / sell-high label without games left; season / playoff totals = Σ of the shown weekly numbers", () => {
  const unlucky = (id: string, injury?: { status: string; week: number }) =>
    rawPlayer(id, "RB", { ecrPos: 15, ...(injury ? { injury } : {}), weeks: games(6, { rushYd: 40, rec: 2, recYd: 10 }, { rushYd: 70, rushTd: 0.6, rec: 4, recYd: 30 }) });
  const val = valuePlayers(L(), [...POOL, unlucky("ok"), unlucky("ir", { status: "IR", week: 8 })]);
  assert.equal(val.players.get("ok")!.label, "buy-low", "fixture: healthy twin is buy-low");
  assert.equal(val.players.get("ir")!.label, undefined);
  const S = L().settings;
  for (const p of val.players.values()) {
    const sum = (f: (w: number) => boolean) => Math.round(p.weekly!.reduce((a, x, i) => a + (f(S.currentWeek + i) ? x : 0), 0) * 10) / 10;
    assert.equal(p.playoffPts, sum((w) => w > S.regularSeasonEnd), `${p.id} playoffPts`);
    assert.equal(p.seasonPts, sum((w) => w <= S.regularSeasonEnd), `${p.id} seasonPts`);
  }
});

test("release (c): a reserve-list WR practising fully, IR minimum to week 10 → 0 before, × 0.85 week 10, full after; playoffs count him", () => {
  const p = rawPlayer("back", "WR", { ecrPos: 12, weeks: games(5, { rec: 6, recYd: 80 }) });
  const input = signalInputFromPlayer(p)!;
  const tables = (roster: { status: string; statusCode?: string }, status: StatusWeek[]): ProjectionTables => ({
    ...emptyTables(),
    signals: new Map([["back", computePlayerSignals({ ...input, roster, status }, { season: 2026, scoring: PPR, asOf: ASOF })]]),
  });
  const healthy = valuePlayers(L(), [...POOL, p], tables({ status: "ACT" }, [])).players.get("back")!;
  // Missed weeks 6-7 (2 games) → 2 more under the IR minimum (weeks 8, 9) although he practised fully this week.
  const v = valuePlayers(L(), [...POOL, p], tables({ status: "RES", statusCode: "R01" }, [{ week: 8, practice: "Full Participation in Practice", report: "Questionable" }])).players.get("back")!;
  assert.equal(v.ret!.week, 10);
  assert.equal(v.ret!.confidence, "medium", "the IR minimum pushed it back: not high");
  assert.deepEqual(v.weekly!.slice(0, 2), [0, 0]);
  // Absent with a sample: no ECR anchor (the rank prices the absence), so compare with his own healthy rate, not a twin.
  const hr = v.ret!.healthyRate!;
  assert.ok(Math.abs(v.weekly![2] - 0.85 * hr) < 0.06, `week 10 ${v.weekly![2]} vs 0.85 × ${hr}`);
  for (const x of v.weekly!.slice(3)) assert.ok(Math.abs(x - hr) < 0.051, `full after: ${x} vs ${hr}`);
  assert.ok(Math.abs(v.playoffPts! - 3 * hr) < 0.16, "playoff weeks at full strength");
  assert.ok(Math.abs(hr - healthy.ppg) < 0.15 * healthy.ppg, `healthy rate ${hr} near the healthy twin's anchored ${healthy.ppg}`);
  assert.ok(v.playoffPts! > 0 && v.value > 0, "a returner is not worth 0");
  assert.ok(v.whyItems!.some((d) => d.label === "Availability" && /back ~wk 10 \(medium\)/.test(d.value)), JSON.stringify(v.whyItems));
  assert.equal(v.ret!.returnValue, undefined, "returnValue only when the return is unconfirmed");
  // One playoff number: My Team hold / Stash watch read the same rate and weeks as Values / lineups.
  assert.equal(v.ret!.playoffPts, v.playoffPts, "hold / stash playoff pts = projection playoff pts");
  // Not practising on the reserve list: unconfirmed, 0 every week, but a stash value (× 0.5 from week 12).
  const u = valuePlayers(L(), [...POOL, p], tables({ status: "RES", statusCode: "R01" }, [])).players.get("back")!;
  assert.equal(u.ret!.week, null);
  assert.ok(u.weekly!.every((x) => x === 0));
  assert.equal(u.value, 0, "lineups and value ignore returnValue");
  // Healthy-role rate = his projection rate without the anchor: returnValue = ½ × healthy rate × his games from week 12.
  const fromWk12 = (17 - 12 + 1) * u.ret!.healthyRate!;
  assert.ok(Math.abs(u.ret!.returnValue! - 0.5 * fromWk12) < 0.1, `returnValue ${u.ret!.returnValue} vs ½ × ${fromWk12.toFixed(1)}`);
  assert.ok(u.ret!.tradeValue! > 0 && u.ret!.tradeValue! < healthy.value, `trade value ${u.ret!.tradeValue} (healthy ${healthy.value})`);
  for (const x of [v, u]) assert.ok(Object.values(x.ret!).every((n) => typeof n !== "number" || Number.isFinite(n)));
});

test("release (d): an unconfirmed return is worth ½ of his full healthy surplus in trades — not 0 when half his rate is below replacement", () => {
  const p = rawPlayer("mid", "WR", { ecrPos: 30, weeks: games(5, { rec: 3, recYd: 40 }) });
  const input = signalInputFromPlayer(p)!;
  const tables: ProjectionTables = {
    ...emptyTables(),
    signals: new Map([["mid", computePlayerSignals({ ...input, roster: { status: "RES", statusCode: "R01" }, status: [] }, { season: 2026, scoring: PPR, asOf: ASOF })]]),
  };
  const ctx = valuePlayers(L(), [...POOL, p], tables);
  const u = ctx.players.get("mid")!;
  const repl = ctx.replacement.WR;
  const hr = u.ret!.healthyRate!;
  assert.equal(u.ret!.week, null);
  assert.ok(hr > repl && 0.5 * hr < repl, `fixture: healthy rate ${hr} above replacement ${repl}, half of it below`);
  assert.ok(u.ret!.tradeValue! > 0, `trade value ${u.ret!.tradeValue}`);
});
