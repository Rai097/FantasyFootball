// Projection accuracy capture (import provider side): which players a capture holds and what it records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projCaptureEntries, type StoredImport } from "./import.js";
import { teamWeeksWithRows, weekKickoffs } from "../model/projLog.js";
import { rawPlayer, line } from "../model/testkit.js";
import { HALF_PPR } from "../model/scoring.js";
import type { Player } from "../model/types.js";

const PLAYERS: Player[] = [
  rawPlayer("qb1", "QB", { name: "Q One", team: "BUF", ids: { yahoo: "1" } }),
  rawPlayer("wr1", "WR", { name: "W One", team: "GB", ids: { yahoo: "2" } }),
  rawPlayer("wr2", "WR", { name: "W Two", team: "NYJ", ids: { yahoo: "3" } }),
  rawPlayer("k1", "K", { name: "K One", team: "BUF", ids: { yahoo: "4" } }),
  rawPlayer("te1", "TE", { name: "T One", team: "BUF", ids: { yahoo: "5" } }),
  rawPlayer("rb1", "RB", { name: "R One", team: "BUF", ids: { yahoo: "6" } }),
];
const db = { find: (o: { yahoo?: string }) => PLAYERS.find((p) => p.ids.yahoo === o.yahoo) };
const s = (projWeek?: number): StoredImport => ({
  id: "x", name: "L", numTeams: 2, slots: [], scoring: HALF_PPR, regularSeasonEnd: 14, finalWeek: 17, importedAt: "2026-10-30T12:00:00.000Z", settingsSource: "page",
  ...(projWeek !== undefined ? { projWeek } : {}),
  teams: [
    { id: "1", name: "A", players: [
      { yahooId: "1", name: "Q One", pos: "QB", slot: "QB", yahooProjWeekly: 20 },
      { yahooId: "2", name: "W One", pos: "WR", slot: "W/R/T", yahooProjWeekly: 12 },
      { yahooId: "4", name: "K One", pos: "K", slot: "K", yahooProjWeekly: 8 },
      { yahooId: "5", name: "T One", pos: "TE", slot: "BN", yahooProjWeekly: 6 },
      { yahooId: "6", name: "R One", pos: "RB", slot: "IR" },
    ] },
  ],
  freeAgents: [{ yahooId: "3", name: "W Two", pos: "WR", yahooProjWeekly: 4 }, { yahooId: "1", name: "Q One", pos: "QB" }],
});
const app = (p: Player) => (p.id === "te1" ? undefined : 7.5);
const all = () => true;

test("capture entries: skill players with a game; starter from the Yahoo slot; free agents with no team; K and no-projection skipped", () => {
  const e = projCaptureEntries(db, s(8), 8, app, all);
  assert.deepEqual(
    e.map((x) => [x.id, x.teamId, x.starter, x.app, x.yahoo]),
    [
      ["qb1", "1", true, 7.5, 20],
      ["wr1", "1", true, 7.5, 12],
      ["rb1", "1", false, 7.5, undefined],
      ["wr2", null, false, 7.5, 4],
    ],
  );
  assert.equal("yahoo" in e.find((x) => x.id === "rb1")!, false, "no Yahoo number → absent, never 0");
  assert.deepEqual(projCaptureEntries(db, s(8), 8, app, (t) => t !== "GB").map((x) => x.id), ["qb1", "rb1", "wr2"], "no game that week → not captured");
});

test("capture entries: Yahoo weekly kept only when it was captured in the same week (paste re-import keeps an old projWeek)", () => {
  for (const pw of [7, undefined]) assert.ok(projCaptureEntries(db, s(pw), 8, app, all).every((x) => x.yahoo === undefined), `projWeek ${pw}`);
});

test("weekKickoffs: per-team kickoff, the week's earliest, and teams with a game even without a time", () => {
  const { kickoffs, teams } = weekKickoffs(
    [
      { week: 8, home: "GB", away: "CAR", kickoff: "2026-10-30T00:15:00.000Z" },
      { week: 8, home: "BUF", away: "BAL", kickoff: "2026-11-01T18:00:00.000Z" },
      { week: 8, home: "NYJ", away: "LV" },
      { week: 9, home: "KC", away: "DEN", kickoff: "2026-11-05T00:00:00.000Z" },
    ],
    8,
  );
  assert.equal(kickoffs.first, "2026-10-30T00:15:00.000Z");
  assert.equal(kickoffs.byTeam.get("BAL"), "2026-11-01T18:00:00.000Z");
  assert.equal(kickoffs.byTeam.has("NYJ"), false);
  assert.deepEqual([...teams].sort(), ["BAL", "BUF", "CAR", "GB", "LV", "NYJ"]);
});

test("teamWeeksWithRows: TEAM|week pairs of the season only", () => {
  const p = [{ weeks: [{ season: 2026, week: 3, team: "GB", actual: line() }, { season: 2025, week: 4, team: "GB", actual: line() }] }];
  assert.deepEqual([...teamWeeksWithRows(p, 2026)], ["GB|3"]);
});
