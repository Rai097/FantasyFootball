// Unit tests for the "import" provider (validation, resolution, paste-mode text, settings edits).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Player } from "../model/types.js";
import { normName, normTeam } from "../data/names.js";
import { applySettings, buildImportLeague, ImportError, mergeTeams, parseSlotList, validateImport, type StoredImport } from "./import.js";
import { parseRosterText } from "./import-text.js";
import type { PlayerFinder } from "./yahoo-parse.js";

function mk(id: string, name: string, pos: Player["pos"], team: string, yahoo?: string, injury?: Player["injury"]): Player {
  return { id, name, pos, team, ids: { yahoo }, snapShare: {}, weeks: [], prior: null, ...(injury ? { injury } : {}) };
}
const PLAYERS = [
  mk("P1", "Patrick Mahomes", "QB", "KC", "30123"),
  mk("P2", "Ja'Marr Chase", "WR", "CIN", "34496"),
  mk("P3", "Christian McCaffrey", "RB", "SF"),
  mk("DEF:BUF", "Buffalo Bills", "DEF", "BUF"),
];
const db: PlayerFinder = {
  find(o) {
    if (o.yahoo) {
      const hit = PLAYERS.find((p) => p.ids.yahoo === o.yahoo);
      if (hit) return hit;
    }
    if (o.pos === "DEF") return PLAYERS.find((p) => p.id === `DEF:${normTeam(o.team)}`);
    const c = PLAYERS.filter((p) => normName(p.name) === normName(o.name ?? "") && (!o.pos || p.pos === o.pos));
    return c.find((p) => p.team === normTeam(o.team)) ?? c[0];
  },
};

const body = () => ({
  id: "y1405188",
  name: "Sunday Funday",
  numTeams: 12,
  slots: ["QB", "WR", "WR", "RB", "RB", "TE", "W/R/T", "K", "DEF", "BN", "BN", "IR"],
  scoring: { rec: 1, passTd: 4 },
  regularSeasonEnd: 14,
  finalWeek: 17,
  myTeamId: "2",
  teams: [
    { id: "1", name: "A", players: [{ yahooId: "30123", name: "Patrick Mahomes", pos: "QB", team: "KC" }, { name: "Nobody Known", pos: "WR", team: "NYJ" }] },
    {
      id: "2",
      name: "B",
      players: [
        { name: "Christian McCaffrey", pos: "RB", team: "SF", status: "O", slot: "IR" },
        { name: "Buffalo", pos: "DEF", team: "Buf" },
        { yahooId: "34496", name: "Ja'Marr Chase", pos: "WR", team: "Cin", status: "Q" },
      ],
    },
  ],
  importedAt: "2026-09-30T00:00:00Z",
});

test("validateImport normalises and applies defaults", () => {
  const s = validateImport(body(), new Date("2026-09-30T12:00:00Z"));
  assert.equal(s.id, "y1405188");
  assert.equal(s.slots[6], "FLEX");
  assert.equal(s.scoring.rec, 1);
  assert.equal(s.scoring.passYd, 0.04); // filled from half-PPR default
  assert.equal(s.settingsSource, "page");
  assert.equal(s.myTeamId, "2");
  assert.equal(s.teams[1].players[1].team, "BUF");

  const d = validateImport({ teams: [{ name: "Solo", players: [{ name: "X Y", pos: "RB" }] }] });
  assert.equal(d.settingsSource, "default");
  assert.equal(d.slots.length, 16);
  assert.match(d.id, /^imp/);
});

test("validateImport enforces limits", () => {
  assert.throws(() => validateImport({ teams: [] }), ImportError);
  assert.throws(() => validateImport({ teams: Array.from({ length: 21 }, (_, i) => ({ id: String(i), players: [] })) }), /limit is 20/);
  assert.throws(() => validateImport({ teams: [{ players: Array.from({ length: 41 }, () => ({ name: "A B", pos: "RB" })) }] }), /limit is 40/);
  assert.throws(() => validateImport({ teams: [{ players: [{ pos: "RB" }] }] }), /without a name/);
  assert.throws(() => validateImport({ teams: [{ players: [] }], junk: "x".repeat(1_000_001) }), /1 MB/);
});

test("buildImportLeague resolves players, keeps unmatched, copies injuries without mutating db", () => {
  const s = validateImport(body());
  const l = buildImportLeague(db, s, { season: 2026, currentWeek: 4 });
  assert.equal(l.provider, "import");
  assert.deepEqual(l.teams[0].playerIds, ["P1"]);
  assert.deepEqual(l.teams[0].unmatched, ["Nobody Known (WR, NYJ)"]);
  assert.deepEqual(l.teams[1].playerIds, ["P3", "DEF:BUF", "P2"]);
  assert.deepEqual(l.teams[1].irPlayerIds, ["P3"]);
  assert.equal(l.playerOverrides.P2.injury?.status, "Questionable");
  assert.equal(l.playerOverrides.P3.injury?.status, "Out");
  assert.equal(PLAYERS[1].injury, undefined, "db entry untouched");
  assert.equal(l.myTeamId, "2");
  assert.equal(l.settings.numTeams, 12);
  assert.equal(l.import?.settingsSource, "page");
});

test("applySettings validates and marks settings as user-edited", () => {
  const s = validateImport(body());
  const n = applySettings(s, { scoring: { rec: 0.5, passTd: 6 }, slots: "QB, RB x2, WR*3, W/R/T, BN x6, IR", waiverPriority: 3, myTeamId: "1" });
  assert.equal(n.scoring.rec, 0.5);
  assert.equal(n.scoring.passTd, 6);
  assert.equal(n.slots.filter((x) => x === "BN").length, 6);
  assert.equal(n.waiverPriority, 3);
  assert.equal(n.myTeamId, "1");
  assert.equal(n.settingsSource, "user");
  assert.throws(() => applySettings(s, { slots: "QB, XYZ" }), /Unknown roster slot/);
  assert.throws(() => applySettings(s, { myTeamId: "99" }), /Unknown team/);
  assert.deepEqual(parseSlotList(["QB", "W/T", "Q/W/R/T"]).slots, ["QB", "RFLEX", "SFLEX"]);
});

test("paste mode: roster text formats and team separators", () => {
  const text = [
    "=== Gridiron Gurus ===",
    "QB Patrick Mahomes KC - QB",
    "WR\tJa'Marr Chase Q Cin - WR",
    "No new player Notes",
    "Christian McCaffrey",
    "SF - RB",
    "Some header line: Opp Proj",
    "=== Second Team ===",
    "Josh Allen (QB - BUF)",
    "BN Buffalo Buf - DEF",
    "Josh Allen (QB - BUF)",
  ].join("\n");
  const r = parseRosterText(text);
  assert.equal(r.teams.length, 2);
  assert.deepEqual(
    r.teams[0].players.map((p) => [p.name, p.pos, p.team, p.status ?? "", p.slot ?? ""]),
    [
      ["Patrick Mahomes", "QB", "KC", "", "QB"],
      ["Ja'Marr Chase", "WR", "CIN", "Q", "WR"],
      ["Christian McCaffrey", "RB", "SF", "", ""],
    ],
  );
  assert.deepEqual(
    r.teams[1].players.map((p) => [p.name, p.pos, p.team]),
    [["Josh Allen", "QB", "BUF"], ["Buffalo", "DEF", "BUF"]],
  );
  const single = parseRosterText("Patrick Mahomes KC - QB", "Mine");
  assert.equal(single.teams[0].name, "Mine");
});

test("mergeTeams replaces a team by name and appends new ones", () => {
  const s: StoredImport = validateImport(body());
  const m = mergeTeams(s, [
    { id: "1", name: "b", players: [{ name: "Patrick Mahomes", pos: "QB" }] },
    { id: "1", name: "New", players: [] },
  ]);
  assert.equal(m.teams.length, 3);
  assert.equal(m.teams[1].id, "2");
  assert.equal(m.teams[1].players.length, 1);
  assert.equal(m.teams[2].id, "3");
});
