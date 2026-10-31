import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredImport } from "../providers/import.js";
import { PARTIAL_RULES, partialReason } from "./partial.js";

function league(sizes: number[], numTeams = sizes.length): StoredImport {
  return {
    id: "y1",
    name: "L",
    numTeams,
    slots: [],
    scoring: {} as StoredImport["scoring"],
    regularSeasonEnd: 14,
    finalWeek: 17,
    settingsSource: "default",
    importedAt: "2026-10-31T00:00:00.000Z",
    teams: sizes.map((n, i) => ({ id: String(i + 1), name: `T${i + 1}`, players: Array.from({ length: n }, (_, j) => ({ name: `P${i}-${j}`, pos: "WR" })) })),
  };
}

test("a full run is fine; small roster churn is fine", () => {
  assert.equal(partialReason(league(Array(12).fill(15)), league(Array(12).fill(15))), null);
  assert.equal(partialReason(league(Array(12).fill(15)), league(Array(12).fill(13))), null);
  assert.equal(partialReason(null, league(Array(12).fill(15))), null);
});

test("fewer teams than stored or than Yahoo's settings report", () => {
  assert.match(String(partialReason(league(Array(12).fill(15)), league(Array(11).fill(15)))), /11 of 12 teams/);
  assert.match(String(partialReason(null, league(Array(11).fill(15), 12))), /11 of 12 teams/);
});

test("any team with 0 players is partial, also on a first import", () => {
  const sizes = Array(12).fill(15);
  sizes[4] = 0;
  assert.match(String(partialReason(league(Array(12).fill(15)), league(sizes))), /1 team read with 0 players/);
  assert.match(String(partialReason(null, league(sizes))), /0 players/);
});

test(`total rostered players under ${PARTIAL_RULES.minPlayerRatio * 100}% of the stored import is partial; the boundary is allowed`, () => {
  const prev = league(Array(10).fill(10)); // 100 players
  assert.match(String(partialReason(prev, league(Array(10).fill(1)))), /10 rostered players read, 100 stored/);
  assert.equal(partialReason(prev, league(Array(10).fill(7))), null, "exactly 70% passes");
  assert.notEqual(partialReason(prev, league([...Array(9).fill(7), 6])), null, "69% is refused");
  assert.equal(partialReason(prev, league(Array(10).fill(5)), { minPlayerRatio: 0.5 }), null, "threshold is config");
});

test("a section the stored import has (standings, waiver order, Yahoo projections) missing from the run is partial", () => {
  const prev = league(Array(4).fill(10));
  prev.teams[0].record = { wins: 5, losses: 3, ties: 0 };
  prev.teams[1].waiverRank = 2;
  prev.teams[2].players[0].yahooProj = 120;
  assert.equal(partialReason(prev, league(Array(4).fill(10))), "not read this run: standings, waiver order, Yahoo projections");
  const full = league(Array(4).fill(10));
  full.teams[3].record = { wins: 1, losses: 7, ties: 0 };
  full.teams[0].waiverRank = 1;
  full.teams[1].players[1].yahooProjWeekly = 12;
  assert.equal(partialReason(prev, full), null, "each section present somewhere: fine");
  assert.equal(partialReason(league(Array(4).fill(10)), league(Array(4).fill(10))), null, "never stored: nothing to lose");
});
