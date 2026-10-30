import { test } from "node:test";
import assert from "node:assert/strict";
import { staleMemo } from "./memo.js";
import {
  buildPlayedWeeks,
  buildPrior,
  buildTables,
  buildPointsAllowed,
  buildSchedule,
  buildStarters,
  buildTeamTotals,
  buildUsualStarters,
  parseEpRows,
  parseGames,
  parseRoster,
  parseSnaps,
  parseStatus,
} from "./signalTables.js";
import { EP_2026, GAMES, INJURIES, ROSTER, SNAPS, IDS, fixtureInputs } from "./fixtures/signals2026.js";
import { DB_STALE_MS, emptyLine } from "./players.js";
import type { EpRow } from "./signalTables.js";
import { score } from "../model/scoring.js";
import { PPR } from "./fixtures/signals2026.js";

test("team totals: file *_team columns win; summing is the fallback", () => {
  const rows = parseEpRows(EP_2026);
  const t = buildTeamTotals(rows).get("CHI|7")!;
  // CHI week 7 (real): 33 team targets per the file, more than the fixture's handful of rows sums to
  assert.equal(t.targets, 33);
  const stripped = rows.map((r) => ({ ...r, fileTeam: undefined }));
  const summed = buildTeamTotals(stripped).get("CHI|7")!;
  const fixtureTargets = rows.filter((r) => r.team === "CHI" && r.week === 7).reduce((a, r) => a + r.targets, 0);
  assert.equal(summed.targets, fixtureTargets);
});

test("starting QB per team-week from games.csv; usual starters (CHI: Caleb Williams only, backups weeks 3-5)", () => {
  const games = parseGames(GAMES, 2026);
  const starters = buildStarters(games, parseEpRows(EP_2026));
  const chi = [1, 2, 3, 4, 5, 6, 7].map((w) => starters.get(`CHI|${w}`)!.qbId);
  assert.deepEqual(chi.map((id) => id === IDS.caleb), [true, true, false, false, false, true, true]);
  assert.equal(starters.get("CHI|3")!.source, "games");
  assert.deepEqual(buildUsualStarters(starters).get("CHI"), [IDS.caleb]);
  assert.equal(starters.get("CHI|8"), undefined, "unplayed week has no starter");
});

test("SEA 2026: returning starter (Darnold weeks 1 and 7, Lock weeks 2-6) → both usual, so no SEA game is qbOut", () => {
  const starters = buildStarters(parseGames(GAMES, 2026), parseEpRows(EP_2026));
  const sea = [1, 2, 3, 4, 5, 6, 7].map((w) => starters.get(`SEA|${w}`)!.qbId);
  assert.deepEqual(sea, [IDS.darnold, IDS.lock, IDS.lock, IDS.lock, IDS.lock, IDS.lock, IDS.darnold]);
  const usual = buildUsualStarters(starters).get("SEA")!;
  assert.deepEqual(usual, [IDS.darnold, IDS.lock].sort());
  assert.ok(sea.every((id) => usual.includes(id)));
});

test("starter fallback: QB names/ids missing in games.csv → most pass attempts in ep_weekly", () => {
  const blanked = GAMES.split("\n")
    .map((l) => (l.startsWith("2026_03_PHI_CHI") ? l.split(",").map((c, i) => (i >= 7 ? "" : c)).join(",") : l))
    .join("\n");
  const s = buildStarters(parseGames(blanked, 2026), parseEpRows(EP_2026)).get("CHI|3")!;
  assert.equal(s.source, "passAttempts");
  assert.equal(s.qbId, "00-0028986"); // Case Keenum, the games.csv starter that week
});

test("practice / report status series per player-week", () => {
  const st = parseStatus(INJURIES).get(IDS.monangai)!;
  assert.deepEqual(
    st.map((w) => [w.week, w.report ?? "-"]),
    [[2, "-"], [3, "-"], [5, "Out"], [6, "Out"], [7, "Out"]],
  );
  assert.equal(st[2].practice, "Did Not Participate In Practice");
});

test("roster info and pfr → gsis mapping feed snap shares", () => {
  const r = parseRoster(ROSTER);
  const kc = r.info.get(IDS.concepcion)!;
  assert.equal(kc.rookieYear, 2026);
  assert.equal(kc.draftNumber, 24);
  assert.equal(r.info.get(IDS.monangai)!.status, "INA");
  const snaps = parseSnaps(SNAPS, r.pfrToGsis).get(IDS.swift)!;
  assert.equal(snaps.find((s) => s.week === 4)!.share, 0.35);
  assert.equal(parseSnaps(SNAPS, new Map()).size, 0, "unmapped ids are unknown, not zero");
});

test("signal inputs: one game per week with team totals, margin, starter and snap share joined", () => {
  const inputs = fixtureInputs();
  const lv = inputs.get(IDS.loveland)!;
  assert.equal(lv.pos, "TE");
  assert.deepEqual(lv.games.map((g) => g.week), [1, 2, 3, 4, 5, 6, 7]);
  const w5 = lv.games[4];
  assert.equal(w5.teamTotals!.targets, 40);
  assert.equal(w5.teamMargin, -24); // 2026_05_CHI_GB result 24 = home GB won by 24
  assert.deepEqual(w5.usualQbIds, [IDS.caleb]);
  assert.notEqual(w5.starterQbId, IDS.caleb);
  assert.equal(w5.snapShare, 0.8);
  assert.equal(lv.prior!.games, 3);
  assert.equal(inputs.get(IDS.monangai)!.games.length, 4);
});

test("staleMemo (the player DB refresh memo): rebuilt after 6 h, bounded, forgets failures", async () => {
  let t = 0;
  let builds = 0;
  const memo = staleMemo<number>(DB_STALE_MS, 2, () => t);
  const make = () => Promise.resolve(++builds);
  assert.equal(await memo.get("a", make), 1);
  t = DB_STALE_MS;
  assert.equal(await memo.get("a", make), 1, "still fresh at exactly 6 h");
  t = DB_STALE_MS + 1;
  assert.equal(await memo.get("a", make), 2, "rebuilt after 6 h");
  await memo.get("b", make);
  await memo.get("c", make);
  assert.equal(memo.size(), 2, "bounded");
  await assert.rejects(memo.get("d", () => Promise.reject(new Error("x"))));
  await new Promise((r) => setImmediate(r));
  assert.equal(await memo.get("d", make), 5, "a failed build is not cached");
});

test("schedule: unplayed games only, both sides, Vegas implied totals from total ± spread", () => {
  const games = parseGames(GAMES, 2026);
  const sched = buildSchedule(games);
  assert.deepEqual(sched.get("CHI")!.get(8), { opp: "SEA", home: false });
  assert.deepEqual(sched.get("SEA")!.get(8), { opp: "CHI", home: true });
  assert.equal(sched.get("CHI")!.has(7), false, "played week 7 is not remaining");
  const lined = new Map(games);
  lined.set("x", { gameId: "x", week: 9, home: "GB", away: "CAR", total: 47.5, spread: 3.5 });
  const s2 = buildSchedule(lined);
  assert.equal(s2.get("GB")!.get(9)!.implied, 25.5);
  assert.equal(s2.get("CAR")!.get(9)!.implied, 22);
});

test("points allowed: the opponents' league-scored points per position, per defense, plus the league average", () => {
  const rows = parseEpRows(EP_2026);
  const { byDefense, leagueAvg } = buildPointsAllowed(rows, parseGames(GAMES, 2026), PPR);
  // CAR faced CHI (week 1) and CLE (week 3); the fixture's only QB row among them is Caleb Williams's week 1.
  const caleb = rows.find((r) => r.playerId === IDS.caleb && r.week === 1)!;
  const car = byDefense.get("CAR")!;
  assert.equal(car.QB!.games, 2);
  assert.ok(Math.abs(car.QB!.pts - score(PPR, caleb.actual, "QB")) < 1e-9);
  assert.ok(leagueAvg.QB! > 0 && leagueAvg.TE! > 0);
  assert.equal(byDefense.has("CHI"), false, "no fixture rows for CHI's opponents: unknown, not 0");
});

test("release (c): roster transaction code kept; reserve / injury-report players without a game get an input; played weeks per team", () => {
  const roster = `season,team,position,status,status_description_abbr,full_name,gsis_id,week
2026,AAA,RB,RES,R48,Generic Back,00-9000001,7
2026,AAA,WR,RES,R01,Generic Wideout,00-9000002,7
2026,AAA,TE,ACT,A01,Generic End,00-9000003,7
2026,AAA,LB,RES,R01,Generic Linebacker,00-9000004,7`;
  const injuries = `season,season_type,team,week,gsis_id,report_status,practice_status
2026,REG,AAA,7,00-9000001,Out,Full Participation in Practice`;
  const games = `game_id,season,game_type,week,home_team,away_team,result
2026_01_AAA_BBB,2026,REG,1,BBB,AAA,3
2026_02_AAA_CCC,2026,REG,2,AAA,CCC,-7
2026_03_AAA_BBB,2026,REG,3,AAA,BBB,`;
  assert.equal(parseRoster(roster).info.get("00-9000001")!.statusCode, "R48");
  const t = buildTables({ season: 2026, epCsv: "", epPriorCsv: "", gamesCsv: games, injuriesCsv: injuries, rosterCsv: roster, snapsCsv: "" });
  const back = t.inputs.get("00-9000001")!;
  assert.equal(back.games.length, 0);
  assert.equal(back.roster!.statusCode, "R48");
  assert.equal(back.status[0].practice, "Full Participation in Practice");
  assert.ok(t.inputs.has("00-9000002"), "reserve list, no report row: still an input");
  assert.ok(!t.inputs.has("00-9000003"), "active, no game, no report: nothing to estimate");
  assert.ok(!t.inputs.has("00-9000004"), "not a skill position");
  const played = buildPlayedWeeks(parseGames(games, 2026));
  assert.deepEqual(played.get("AAA"), [1, 2]);
  assert.deepEqual(played.get("CCC"), [2]);
});

test("prior season: lastTeam is the team of his latest week (unsorted rows, multi-team season); no team → unknown", () => {
  const row = (playerId: string, week: number, team: string): EpRow => ({
    week, gameId: `g${week}`, team, playerId, name: playerId, pos: "RB", passAttempts: 0, targets: 2, carries: 10, airYards: 0, actual: emptyLine(), expected: emptyLine(),
  });
  const prior = buildPrior([row("a", 12, "BBB"), row("a", 3, "AAA"), row("a", 17, "BBB"), row("a", 8, "AAA"), row("b", 5, "CCC"), row("c", 2, "")]);
  assert.equal(prior.get("a")!.lastTeam, "BBB", "traded mid-season: the later team");
  assert.equal(prior.get("a")!.games, 4);
  assert.equal(prior.get("a")!.opps!.carries, 40);
  assert.equal(prior.get("b")!.lastTeam, "CCC");
  assert.equal(prior.get("c")!.lastTeam, undefined, "no team in the rows: unknown");
});
