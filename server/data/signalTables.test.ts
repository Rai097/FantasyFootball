import { test } from "node:test";
import assert from "node:assert/strict";
import {
  staleMemo,
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
import { DB_STALE_MS } from "./players.js";
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

test("signal memos refresh on the player database's cadence (6 h) and forget failures", async () => {
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
