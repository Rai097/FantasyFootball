// Season-over injuries (DESIGN "Season-over injuries (2026-10-31)"): ESPN return-date rule, the owner's mark, and what
// "out for the season" does downstream (value, Stash watch, waivers, Targets).
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyTables, signalInputFromPlayer, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computePlayerSignals } from "./signals/index.js";
import { ASOF, PPR } from "../data/fixtures/signals2026.js";
import { detailProblems, league, line, rawPlayer, team, vp } from "./testkit.js";
import { stashWatch } from "./stash.js";
import { autoSeasonOver, dayText, espnSeasonOverWhy } from "./returns.js";
import { rankWaivers } from "./waivers.js";
import { findBreakouts } from "./breakouts.js";
import { analyzeTeams } from "./analysis.js";
import { buildWeekEnds, type GameInfo } from "../data/signalTables.js";
import type { League, Player, Position, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import type { RosterInfo } from "./signals/types.js";

const END = "2026-12-28"; // fixture: the day of the final week's last game (the real 2026 week 17 ends 2027-01-04)

test("ESPN rule: return date strictly after the final week's last game day; non-absent statuses, missing dates and an unknown final week never count", () => {
  const ir = (returnDate?: string, status = "Injured Reserve") => ({ status, ...(returnDate ? { returnDate } : {}) });
  assert.equal(espnSeasonOverWhy(ir("2027-02-15"), END), "ESPN: return Feb 15, 2027, after the final week");
  assert.equal(espnSeasonOverWhy(ir("2026-12-29"), END), "ESPN: return Dec 29, 2026, after the final week");
  assert.equal(espnSeasonOverWhy(ir("2026-12-28"), END), null, "back on the final game day: can still play");
  assert.equal(espnSeasonOverWhy(ir("2026-11-25"), END), null, "back before the playoffs (the hamstring WR)");
  assert.equal(espnSeasonOverWhy(ir(undefined), END), null, "no date: no evidence");
  assert.equal(espnSeasonOverWhy(ir("2027-02-15"), undefined), null, "unknown final week: ESPN never decides");
  assert.equal(espnSeasonOverWhy(ir("Feb 15"), END), null, "unparsable date");
  assert.equal(espnSeasonOverWhy(ir("2027-13-01"), END), null, "not a month");
  for (const s of ["Active", "Questionable", "questionable ", "Probable", "Day-To-Day"]) assert.equal(espnSeasonOverWhy(ir("2027-02-15", s), END), null, s);
  for (const s of ["Out", "Doubtful", "Suspension"]) assert.ok(espnSeasonOverWhy(ir("2027-02-15", s), END), s);
  assert.equal(espnSeasonOverWhy(undefined, END), null);
  assert.equal(dayText("2026-11-25"), "Nov 25, 2026");
  // Order of the automatic sources: report, then Sleeper, then ESPN; none → null.
  const acl = { status: "IR", bodyPart: "Knee - ACL", rosterStatus: "Inactive" };
  assert.equal(autoSeasonOver({ reportSeason: true, sleeper: acl, espn: ir("2027-02-15"), finalWeekEnd: END })?.source, "report");
  assert.equal(autoSeasonOver({ sleeper: acl, espn: ir("2027-02-15"), finalWeekEnd: END })?.source, "sleeper");
  assert.equal(autoSeasonOver({ sleeper: { status: "IR", bodyPart: "Knee" }, espn: ir("2027-02-15"), finalWeekEnd: END })?.source, "espn");
  assert.equal(autoSeasonOver({ sleeper: { status: "IR", bodyPart: "Knee" }, espn: ir("2026-11-25"), finalWeekEnd: END }), null);
});

test("week ends: the latest game day of each week (games.csv gameday); undated games are unknown", () => {
  const g = (id: string, week: number, gameday?: string): GameInfo => ({ gameId: id, week, home: "A", away: "B", ...(gameday ? { gameday } : {}) });
  const games = new Map([g("1", 17, "2026-12-24"), g("2", 17, "2026-12-28"), g("3", 17, "2026-12-27"), g("4", 16), g("5", 15, "2026-12-14")].map((x) => [x.gameId, x]));
  const ends = buildWeekEnds(games);
  assert.equal(ends.get(17), "2026-12-28");
  assert.equal(ends.get(15), "2026-12-14");
  assert.equal(ends.has(16), false);
});

// ---- projection v4 + Stash watch on a small pool (same harness as stash.test.ts)
const wk = (week: number, actual: Partial<StatLine>): WeekLine => ({
  season: 2026, week, team: "KC", actual: line(actual), expected: line(actual), opp: { targets: 0, carries: 0, airYards: 0 },
});
const games = (weeks: number[], actual: Partial<StatLine>) => weeks.map((w) => wk(w, actual));
const L = (marks?: Record<string, boolean>): League => {
  const l = league([team("a", ["owned"])], undefined, { currentWeek: 8, numTeams: 12 });
  if (marks) l.seasonMarks = marks;
  return l;
};
function filler(pos: Position, n = 45): Player[] {
  return Array.from({ length: n }, (_, i) =>
    rawPlayer(`${pos}${i + 1}`, pos, { ecrPos: i + 1, weeks: games([1, 2, 3, 4, 5, 6, 7], { recYd: 110 - i * 2.2, rec: 6 - i * 0.1, rushYd: pos === "RB" ? 70 - i : 0, passYd: pos === "QB" ? 280 - i * 3 : 0 }) }),
  );
}
const POOL = [...filler("QB", 30), ...filler("RB"), ...filler("WR"), ...filler("TE", 30)];
const ROLE = { rec: 8, recYd: 110, recTd: 0.3 };

/** Two IR WRs with the same strong role: "torn" (ESPN back Feb 2027) and "ham" (ESPN back Nov 25), plus "nodate". */
function setup(opts: { marks?: Record<string, boolean>; weekEnds?: Map<number, string> | null; roster?: RosterInfo } = {}) {
  const ir = { status: "IR", detail: "Knee", week: 8 };
  const torn = rawPlayer("torn", "WR", { ecrPos: 70, injury: ir, weeks: games([1, 2, 3, 4, 5, 6], ROLE) });
  torn.sleeperInjury = { status: "IR", bodyPart: "Knee", notes: "Surgery", rosterStatus: "Inactive" };
  torn.espnInjury = { status: "Injured Reserve", returnDate: "2027-02-15", type: "Knee", detail: "Surgery" };
  const ham = rawPlayer("ham", "WR", { ecrPos: 72, injury: { ...ir, detail: "Hamstring" }, weeks: games([1, 2, 3, 4, 5, 6], ROLE) });
  ham.sleeperInjury = { status: "IR", bodyPart: "Hamstring", notes: "Surgery", rosterStatus: "Inactive" };
  ham.espnInjury = { status: "Injured Reserve", returnDate: "2026-11-25", type: "Hamstring", detail: "Surgery" };
  // ESPN lists him, but without a return date: no evidence either way.
  const nodate = rawPlayer("nodate", "WR", { ecrPos: 74, injury: ir, weeks: games([1, 2, 3, 4, 5, 6], ROLE) });
  nodate.espnInjury = { status: "Injured Reserve" };
  // Healthy starter the owner may mark.
  const fine = rawPlayer("fine", "WR", { ecrPos: 20, weeks: games([1, 2, 3, 4, 5, 6, 7], ROLE) });
  const roster = opts.roster ?? { status: "RES", statusCode: "R01" };
  const sig = (p: Player) => [p.id, computePlayerSignals({ ...signalInputFromPlayer(p)!, roster, status: [] }, { season: 2026, scoring: PPR, asOf: ASOF })] as const;
  const weekEnds = opts.weekEnds === null ? undefined : (opts.weekEnds ?? new Map([[17, END]]));
  const tables: ProjectionTables = { ...emptyTables(), signals: new Map([sig(torn), sig(ham), sig(nodate)]), ...(weekEnds ? { weekEnds } : {}) };
  const val = valuePlayers(L(opts.marks), [...POOL, torn, ham, nodate, fine], tables);
  const stash = stashWatch({ players: val.players.values(), rostered: new Set(), availability: new Map([["torn", "fa"], ["ham", "fa"], ["nodate", "fa"]]), flexLevel: val.flexLevel, regularSeasonEnd: 14, finalWeek: 17 });
  return { val, stash, ids: stash.map((r) => r.id) };
}

const isZero = (p: ValuedPlayer) => p.value === 0 && p.seasonPts === 0 && p.playoffPts === 0 && p.weekly!.every((x) => x === 0);

test("ESPN return after the final week (the patellar-tendon WR): value 0 for the rest of the season, off Stash watch, source shown", () => {
  const { val, ids } = setup();
  const t = val.players.get("torn")!;
  assert.ok(isZero(t), JSON.stringify({ v: t.value, w: t.weekly }));
  assert.equal(t.ret?.seasonOver, true);
  assert.deepEqual(t.seasonStatus, { over: true, source: "espn", why: "ESPN: return Feb 15, 2027, after the final week", auto: { source: "espn", why: "ESPN: return Feb 15, 2027, after the final week" } });
  assert.ok(t.whyItems!.some((d) => d.value === "ESPN: return Feb 15, 2027, after the final week: 0 for every week"), JSON.stringify(t.whyItems));
  assert.deepEqual(detailProblems(t.whyItems!), []);
  assert.ok(!ids.includes("torn"), ids.join(","));
});

test("ESPN return before the playoffs (the hamstring WR) stays on Stash watch with ESPN's date as evidence", () => {
  const { val, stash, ids } = setup();
  const h = val.players.get("ham")!;
  assert.equal(h.seasonStatus, undefined);
  assert.notEqual(h.ret?.seasonOver, true);
  assert.ok(ids.includes("ham"), ids.join(","));
  const row = stash.find((r) => r.id === "ham")!;
  assert.ok(row.details.some((d) => d.label === "ESPN return" && d.value === "Nov 25, 2026 (ESPN estimate)"), JSON.stringify(row.details));
  assert.match(row.summary, /return unconfirmed/, "ESPN's date is evidence only, never the return week");
});

test("no ESPN date is not healthy: still absent (return unconfirmed), still a stash", () => {
  const { val, ids } = setup();
  const n = val.players.get("nodate")!;
  assert.equal(n.seasonStatus, undefined);
  assert.equal(n.ret?.absent, true);
  assert.equal(n.ret?.week, null);
  assert.equal(n.weekly![0], 0, "absent this week");
  assert.ok(ids.includes("nodate"), ids.join(","));
});

test("unknown final-week date: ESPN never decides (the WR stays a stash, return unconfirmed)", () => {
  const { val, ids } = setup({ weekEnds: null });
  assert.equal(val.players.get("torn")!.seasonStatus, undefined);
  assert.ok(ids.includes("torn"));
});

test("designated to return beats ESPN's date (positive evidence of a return); the finding is still shown", () => {
  const { val } = setup({ roster: { status: "RES", statusCode: "R48" } });
  const t = val.players.get("torn")!;
  assert.notEqual(t.ret?.seasonOver, true);
  assert.equal(t.seasonStatus?.over, false);
  assert.equal(t.seasonStatus?.source, "espn");
  assert.match(t.seasonStatus!.why, /designated to return wins$/);
});

test("owner mark wins both ways: 'not out' beats ESPN (back on Stash watch), 'out' zeroes a healthy starter and a stash", () => {
  const { val, ids, stash } = setup({ marks: { torn: false, fine: true, ham: true } });
  const t = val.players.get("torn")!;
  assert.deepEqual(t.seasonStatus, { over: false, source: "owner", why: "Marked not out for the season by the league owner", owner: false, auto: { source: "espn", why: "ESPN: return Feb 15, 2027, after the final week" } });
  assert.notEqual(t.ret?.seasonOver, true);
  assert.equal(t.ret?.absent, true, "not out for the season, still on IR: return unconfirmed");
  assert.ok(ids.includes("torn"), ids.join(","));
  assert.deepEqual(stash.find((r) => r.id === "torn")!.seasonStatus?.owner, false, "the row carries the mark for the toggle");
  const f = val.players.get("fine")!;
  assert.ok(isZero(f));
  assert.deepEqual(f.seasonStatus, { over: true, source: "owner", why: "Marked out for the season by the league owner", owner: true });
  assert.ok(f.whyItems!.some((d) => d.value === "Marked out for the season by the league owner: 0 for every week"), JSON.stringify(f.whyItems));
  assert.ok(isZero(val.players.get("ham")!));
  assert.ok(!ids.includes("ham"), "marked out: never a stash");
  // valueOf on a copy (a free agent's import copy) applies the same mark by id.
  assert.ok(isZero(val.valueOf({ ...POOL[0], id: "fine", name: "fine", pos: "WR", weeks: games([1, 2, 3, 4, 5, 6, 7], ROLE) })));
});

test("owner 'not out' beats Sleeper's ACL rule too; a mark for a player outside the pool is harmless", () => {
  const acl = rawPlayer("acl", "WR", { ecrPos: 60, weeks: games([1, 2, 3], ROLE) });
  acl.sleeperInjury = { status: "IR", bodyPart: "Knee - ACL", rosterStatus: "Inactive" };
  const sig = [acl.id, computePlayerSignals({ ...signalInputFromPlayer(acl)!, roster: { status: "RES", statusCode: "R01" }, status: [] }, { season: 2026, scoring: PPR, asOf: ASOF })] as const;
  const tables: ProjectionTables = { ...emptyTables(), signals: new Map([sig]) };
  const auto = valuePlayers(L(), [...POOL, acl], tables).players.get("acl")!;
  assert.equal(auto.seasonStatus?.source, "sleeper");
  assert.equal(auto.ret?.seasonOver, true);
  const val = valuePlayers(L({ acl: false, ghost: true }), [...POOL, acl], tables);
  const a = val.players.get("acl")!;
  assert.equal(a.seasonStatus?.over, false);
  assert.equal(a.seasonStatus?.auto?.source, "sleeper");
  assert.notEqual(a.ret?.seasonOver, true);
  assert.ok(a.ret!.healthyRate! > 0);
});

test("waivers: a free agent out for the season is a pass, never a claim; Targets never list him", () => {
  const mine = [vp("QB", "QB", 18, 10), vp("RB1", "RB", 14, 30), vp("RB2", "RB", 13, 26), vp("WR1", "WR", 12, 20), vp("WR2", "WR", 3, 0), vp("TE", "TE", 8, 5), vp("FLX", "RB", 9, 4), vp("K", "K", 8, 2), vp("DEF", "DEF", 7, 3)];
  const Lg = league([team("me", mine), team("o", [vp("oQB", "QB", 17, 8)])], undefined, { numTeams: 12 });
  const ps = [...mine, vp("oQB", "QB", 17, 8)];
  const players = new Map(ps.map((p) => [p.id, p]));
  const ctx = { league: Lg, players, teams: analyzeTeams(Lg, players, { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 }) };
  const over = { over: true, source: "espn" as const, why: "ESPN: return Feb 15, 2027, after the final week" };
  const good = vp("FA_good", "WR", 12, 8);
  const done = vp("FA_done", "WR", 12, 8, { seasonStatus: over });
  const r = rankWaivers(ctx, "me", [{ player: good, onWaivers: false }, { player: done, onWaivers: false }], { myPriority: 1 });
  assert.equal(r.freeAgents.find((t) => t.id === "FA_good")!.recommendation, "claim");
  const d = r.freeAgents.find((t) => t.id === "FA_done")!;
  assert.equal(d.recommendation, "pass");
  assert.match(d.summary, /Out for the season: ESPN: return Feb 15, 2027/);
  // Targets: a rising back who is out for the season is never listed.
  const wkR = (week: number, e: number): WeekLine => ({ season: 2026, week, team: "KC", expected: line({ rushYd: e * 10 }), actual: line({ rushYd: e * 5 }), opp: { targets: 2, carries: 5 + week, airYards: 10 } });
  const back = (id: string, extra: Partial<ValuedPlayer> = {}) =>
    vp(id, "RB", 5, 3, { name: id, team: id === "b1" ? "DAL" : "BUF", snapShare: { 1: 0.2, 2: 0.35, 3: 0.55 }, weeks: [wkR(1, 5), wkR(2, 8), wkR(3, 13)], games: 3, ppg26: 5, ppgExp26: 8.7, ...extra });
  const b1 = back("b1");
  const b2 = back("b2", { seasonStatus: over });
  const all = new Map([...players, [b1.id, b1], [b2.id, b2]]);
  const L2 = league([team("me", mine), team("o", [b1, b2])], undefined, { numTeams: 12 });
  const targets = findBreakouts({ league: L2, players: all, teams: analyzeTeams(L2, all, { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 }), myTeamId: "me" }).targets.map((t) => t.player.id);
  assert.ok(targets.includes("b1"), targets.join(","));
  assert.ok(!targets.includes("b2"), "out for the season: never a target");
});
