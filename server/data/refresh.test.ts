// One shared data refresh (players.ts DB_STALE_MS): the player DB, the NFL calendar and the Model v4 signal /
// projection tables rebuild together, so a server running for days advances the week. Injected clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNflState, getNflState } from "./nfl.js";
import { DB_STALE_MS, dataClock, getPlayerDb } from "./players.js";
import { getAllSignals, getProjectionTables } from "./signalTables.js";
import { PPR } from "./fixtures/signals2026.js";

const HEADER = "season,game_type,week,away_team,home_team,away_score,home_score";
const row = (week: number, away: string, home: string, played: boolean) => `2026,REG,${week},${away},${home},${played ? "20,17" : ","}`;

test("NFL calendar: current week = first REG week with an unplayed game; it advances once that game is scored", () => {
  const games = (week7Played: boolean) =>
    [HEADER, row(6, "KC", "DEN", true), row(6, "DAL", "PHI", true), row(7, "KC", "LV", true), row(7, "DAL", "PHI", week7Played), row(8, "KC", "DEN", false), row(8, "DAL", "NYG", false), row(8, "LV", "PHI", false)].join("\n");
  const before = computeNflState(games(false));
  assert.equal(before.currentWeek, 7, "DAL@PHI week 7 unplayed");
  assert.equal(before.completedWeeks, 6);
  assert.equal(before.byes.LV, 6, "first week without a game");
  const after = computeNflState(games(true));
  assert.equal(after.currentWeek, 8);
  assert.equal(after.lastRegularWeek, 8);
  const done = computeNflState([HEADER, row(1, "KC", "DEN", true)].join("\n"));
  assert.equal(done.currentWeek, 2, "season over → last week + 1");
});

test("one shared refresh: player DB, NFL state and projection tables rebuild together after DB_STALE_MS", { timeout: 120_000 }, async () => {
  const real = dataClock.now;
  let t = real();
  dataClock.now = () => t;
  try {
    const db1 = await getPlayerDb();
    assert.equal(await getNflState(), db1.state, "the calendar comes from the current DB build");
    const tables1 = await getProjectionTables(db1.season, PPR);
    const signals1 = await getAllSignals(db1.season, PPR);
    t += DB_STALE_MS;
    assert.equal(await getPlayerDb(), db1, "still fresh at exactly the refresh interval");
    assert.equal(await getProjectionTables(db1.season, PPR), tables1, "tables follow the DB, not their own timer");
    t += 1;
    const db2 = await getPlayerDb();
    assert.notEqual(db2, db1, "rebuilt after the interval");
    assert.equal(db2.generation, db1.generation + 1);
    assert.notEqual(db2.state, db1.state, "calendar recomputed from the schedule on the rebuild");
    assert.equal(await getNflState(), db2.state);
    const tables2 = await getProjectionTables(db2.season, PPR);
    assert.notEqual(tables2, tables1, "projection tables rebuilt with the DB");
    assert.notEqual(await getAllSignals(db2.season, PPR), signals1, "signals rebuilt with the DB");
    assert.equal(await getProjectionTables(db2.season, PPR), tables2, "and memoized again within the new generation");
  } finally {
    dataClock.now = real;
  }
});
