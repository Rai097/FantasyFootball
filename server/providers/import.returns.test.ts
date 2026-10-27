// Integration (import provider → valuation): a player whose Out / IR status comes only from the Yahoo import (status
// "O" in an IR slot, nflverse lists him active, no practice row) gets a return estimate — "return unconfirmed" — and
// a playoff "hold" value from his healthy role, like any other absent player (Model v4 release (c), fix round 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImportLeague, validateImport } from "./import.js";
import type { PlayerFinder } from "./yahoo-parse.js";
import { normName } from "../data/names.js";
import { playerPool } from "../api.js";
import { analyzeLeague } from "../model/analysis.js";
import { emptyTables } from "../model/projectionV4.js";
import { line, rawPlayer } from "../model/testkit.js";
import type { Player, Position, WeekLine } from "../model/types.js";
import type { PlayerDb } from "../data/players.js";

const wk = (week: number, recYd: number, rec: number): WeekLine => ({
  season: 2026, week, team: "KC", actual: line({ recYd, rec }), expected: line({ recYd, rec }), opp: { targets: rec + 2, carries: 0, airYards: recYd },
});
const games = (n: number, recYd: number, rec: number) => Array.from({ length: n }, (_, i) => wk(i + 1, recYd, rec));
const filler = (pos: Position, n: number): Player[] =>
  Array.from({ length: n }, (_, i) => rawPlayer(`${pos}${i}`, pos, { name: `${pos} Filler ${i}`, ecrPos: i + 1, weeks: games(7, 90 - i * 1.5, 6 - i * 0.08) }));
// Hurt after week 4: four strong games, then nothing. nflverse has no injury or reserve row for him (no tables).
const star = rawPlayer("star", "WR", { name: "Imported Star", team: "KC", ecrPos: 30, weeks: games(4, 105, 7) });
const PLAYERS = [...filler("QB", 14), ...filler("RB", 30), ...filler("WR", 45), ...filler("TE", 14), star];
const db: PlayerFinder = { find: (o) => PLAYERS.find((p) => normName(p.name) === normName(o.name ?? "") && (!o.pos || p.pos === o.pos)) };
const pdb = { players: new Map(PLAYERS.map((p) => [p.id, p])) } as unknown as PlayerDb;

test("import: status O in an IR slot, nothing in nflverse → absent, return unconfirmed, value 0, hold value > 0", () => {
  const s = validateImport({
    name: "Fixture League",
    numTeams: 2,
    slots: ["QB", "WR", "WR", "RB", "TE", "W/R/T", "K", "DEF", "BN", "BN", "IR"],
    scoring: { rec: 1 },
    regularSeasonEnd: 14,
    finalWeek: 17,
    myTeamId: "1",
    teams: [
      { id: "1", name: "Mine", players: [{ name: "Imported Star", pos: "WR", team: "KC", status: "O", slot: "IR" }, { name: "WR Filler 0", pos: "WR", team: "KC" }] },
      { id: "2", name: "Theirs", players: [{ name: "WR Filler 1", pos: "WR", team: "KC" }] },
    ],
    importedAt: "2026-10-20T00:00:00Z",
  });
  const l = buildImportLeague(db, s, { season: 2026, currentWeek: 8 });
  assert.deepEqual(l.teams[0].irPlayerIds, ["star"]);
  assert.equal(l.playerOverrides.star.injury?.status, "Out", "the import copy carries Yahoo's status");
  const ctx = analyzeLeague(l, playerPool(pdb, l), emptyTables(), "balanced");
  const v = ctx.players.get("star")!;
  assert.ok(v.ret, "an import-sourced Out / IR player gets a return object");
  assert.equal(v.ret.absent, true);
  assert.equal(v.ret.week, null);
  assert.equal(v.ret.confidence, "unknown");
  assert.equal(v.ret.reasons.find((d) => d.label === "Return")?.value, "league lists him on IR, no practice signal: return unconfirmed");
  assert.equal(v.value, 0, "lineups / value: 0 while his return is unconfirmed");
  assert.ok((v.ret.healthyRate ?? 0) > 10, `healthy rate ${v.ret.healthyRate}`);
  assert.ok((v.ret.playoffPts ?? 0) > 0, `My Team hold: playoff pts ${v.ret.playoffPts}`);
  assert.ok((v.ret.returnValue ?? 0) > 0, `returnValue ${v.ret.returnValue}`);
  // A healthy teammate on the same import has no return object.
  assert.equal(ctx.players.get("WR0")!.ret, undefined);
});
