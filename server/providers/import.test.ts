// Unit tests for the "import" provider (validation, resolution, paste-mode text, settings edits).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Player } from "../model/types.js";
import { normName, normTeam } from "../data/names.js";
import {
  appendSnapshot,
  applySettings,
  buildImportLeague,
  cleanRecord,
  diffSnapshots,
  HISTORY_CAP,
  ImportError,
  importFreeAgents,
  latestChanges,
  mergeTeams,
  parseSlotList,
  snapshotOf,
  stripLeaguePrefix,
  upsertImport,
  validateImport,
  waiverPriorityOf,
  type StoredImport,
} from "./import.js";
import { parseRosterText } from "./import-text.js";
import type { PlayerFinder } from "./yahoo-parse.js";
import type { PlayerDb } from "../data/players.js";

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

// ------------------------------------------------------------------ re-import (upsert)
test("upsertImport: new rosters, same id, user settings preserved, myTeamId re-resolved by name", () => {
  const first = validateImport({ ...body(), leagueId: "1405188", settingsSource: "page" }, new Date("2026-09-20T00:00:00Z"));
  const edited = applySettings(first, { scoring: { rec: 0.5 }, slots: "QB, RB x2, WR x3, TE, W/R/T, K, DEF, BN x5", waiverPriority: 7, myTeamId: "2", tradeDeadlineWeek: 11 });
  // Yahoo renumbered the teams (B is now team 1) and team B dropped Chase for Mahomes.
  const again = body();
  again.id = "y1405188";
  const [a, b] = again.teams;
  a.id = "2";
  b.id = "1";
  b.players = b.players.filter((p) => p.name !== "Ja'Marr Chase");
  b.players.push({ yahooId: "99999", name: "Tank Dell", pos: "WR", team: "HOU" } as (typeof b.players)[number]);
  const incoming = validateImport({ ...again, leagueId: "1405188", settingsSource: "page", scoring: { rec: 1 }, id: "somethingelse" }, new Date("2026-09-30T00:00:00Z"));
  const { stored, changes } = upsertImport(edited, incoming);
  assert.equal(stored.id, first.id);
  assert.equal(stored.importedAt, "2026-09-30T00:00:00.000Z");
  assert.equal(stored.settingsSource, "user");
  assert.equal(stored.scoring.rec, 0.5);
  assert.equal(stored.slots.filter((x) => x === "WR").length, 3);
  assert.equal(stored.waiverPriority, 7);
  assert.equal(stored.tradeDeadlineWeek, 11);
  assert.equal(stored.myTeamId, "1", "team B found by name under its new id");
  assert.equal(stored.teams.find((t) => t.name === "B")!.players.some((p) => p.name === "Tank Dell"), true);
  assert.deepEqual(changes, { teams: 1, playersChanged: 1, byTeam: [{ id: "1", name: "B", added: ["Tank Dell"], dropped: ["Ja'Marr Chase"] }] });
});

test("upsertImport takes freshly extracted settings only when the user never edited them", () => {
  const first = validateImport({ ...body(), settingsSource: "default", scoring: undefined, slots: undefined }, new Date("2026-09-20T00:00:00Z"));
  assert.equal(first.settingsSource, "default");
  const fresh = validateImport({ ...body(), settingsSource: "page", scoring: { rec: 1 } });
  const up = upsertImport({ ...first, waiverPriority: 3 }, fresh).stored;
  assert.equal(up.settingsSource, "page");
  assert.equal(up.scoring.rec, 1);
  assert.equal(up.waiverPriority, 3);
  // A payload without extracted settings keeps what was there.
  const pageFirst = validateImport({ ...body(), settingsSource: "page", scoring: { rec: 0 } });
  const noSettings = validateImport({ ...body(), settingsSource: "default", scoring: { rec: 1 } });
  const kept = upsertImport(pageFirst, noSettings).stored;
  assert.equal(kept.settingsSource, "page");
  assert.equal(kept.scoring.rec, 0);
  assert.deepEqual(upsertImport(pageFirst, noSettings).changes, { teams: 0, playersChanged: 0, byTeam: [] });
});

test("roster history: diff of the two latest snapshots, capped at 8", () => {
  const s0 = validateImport(body(), new Date("2026-09-01T00:00:00Z"));
  let h = [snapshotOf(s0)];
  assert.equal(latestChanges(h), null);
  for (let i = 1; i <= 10; i++) {
    const s = validateImport(body(), new Date(Date.UTC(2026, 8, 1 + i)));
    if (i === 10) s.teams[0].players = [s.teams[0].players[0], { name: "Josh Allen", pos: "QB", team: "BUF" }, { name: "Nobody Else", pos: "RB" }];
    h = appendSnapshot(h, snapshotOf(s));
  }
  assert.equal(h.length, HISTORY_CAP);
  assert.equal(h[0].importedAt, "2026-09-04T00:00:00.000Z");
  const c = latestChanges(h)!;
  assert.equal(c.to, "2026-09-11T00:00:00.000Z");
  assert.equal(c.teams, 1);
  assert.equal(c.playersChanged, 2, "one swap + one pure add");
  assert.deepEqual(c.byTeam[0], { id: "1", name: "A", added: ["Josh Allen", "Nobody Else"], dropped: ["Nobody Known"] });
  // A team missing from the new snapshot reports its players as dropped.
  const gone = diffSnapshots(snapshotOf(s0), { ...snapshotOf(s0), teams: snapshotOf(s0).teams.slice(0, 1) });
  assert.equal(gone.byTeam[0].name, "B");
  assert.equal(gone.byTeam[0].dropped.length, 3);
});

test("free agents keep onWaivers per player (booleans only); missing = unknown, treated as on waivers", () => {
  const s = validateImport({
    ...body(),
    teams: [{ id: "1", name: "A", players: [{ yahooId: "30123", name: "Patrick Mahomes", pos: "QB", team: "KC" }] }],
    myTeamId: "1",
    freeAgents: [
      { yahooId: "34496", name: "Ja'Marr Chase", pos: "WR", team: "Cin", onWaivers: false },
      { name: "Christian McCaffrey", pos: "RB", team: "SF", onWaivers: true },
      { name: "Buffalo", pos: "DEF", team: "Buf", onWaivers: "yes" },
    ],
  });
  assert.equal(s.freeAgents![0].onWaivers, false);
  assert.equal(s.freeAgents![1].onWaivers, true);
  assert.equal("onWaivers" in s.freeAgents![2], false, "non-boolean is dropped, not coerced");
  const l = buildImportLeague(db, s, { season: 2026, currentWeek: 4 });
  const fdb = { ...db, players: new Map(PLAYERS.map((p) => [p.id, p])) } as unknown as PlayerDb;
  const fa = importFreeAgents(l, fdb, s, 4).freeAgents.map((f) => [f.player.id, f.onWaivers, f.availability]);
  assert.deepEqual(fa, [
    ["P2", false, "fa"],
    ["P3", true, "waivers"],
    ["DEF:BUF", true, "unknown"],
  ]);
});

test("league-name prefix is stripped from team names when every team shares it", () => {
  const L = "Kingshot Gridiron Chumps - ";
  const t = (n: string) => ({ name: n });
  assert.deepEqual(stripLeaguePrefix([t(L + "No Cap Rai"), t(L + "Playmaker Caw")]).map((x) => x.name), ["No Cap Rai", "Playmaker Caw"]);
  // Not shared by every team, a single team, or nothing left after the prefix: unchanged.
  assert.deepEqual(stripLeaguePrefix([t(L + "A"), t("Other - B")]).map((x) => x.name), [L + "A", "Other - B"]);
  assert.deepEqual(stripLeaguePrefix([t(L + "A")]).map((x) => x.name), [L + "A"]);
  assert.deepEqual(stripLeaguePrefix([t("X - "), t("X - B")]).map((x) => x.name), ["X - ", "X - B"]);
  // A dash inside a real team name with no shared prefix stays.
  assert.deepEqual(stripLeaguePrefix([t("Run - DMC"), t("Ball - Hogs")]).map((x) => x.name), ["Run - DMC", "Ball - Hogs"]);
  const v = validateImport({ teams: [{ id: "1", name: L + "No Cap Rai", players: [] }, { id: "2", name: L + "Caw", players: [] }] });
  assert.deepEqual(v.teams.map((x) => x.name), ["No Cap Rai", "Caw"]);
});

// ------------------------------------------------------------------ standings and waiver order (2026-10-26)
const withStandings = () => {
  const b = body();
  return {
    ...b,
    teams: [
      { ...b.teams[0], record: { wins: 5, losses: 1, ties: 0, pointsFor: "1,043.2", pointsAgainst: 870.5, rank: 1, streak: "W-3", seed: 1 }, waiverRank: 9 },
      { ...b.teams[1], record: { wins: 1, losses: 5, ties: 0, rank: 12 }, waiverRank: 2 },
    ],
  };
};

test("cleanRecord: whole-number W-L-T required; bad optional fields are dropped one by one, never guessed", () => {
  assert.deepEqual(cleanRecord({ wins: "5", losses: 1, ties: 0, pointsFor: "1,043.25", pointsAgainst: 870.5, rank: 1, streak: "w 3", seed: 2 }), {
    wins: 5, losses: 1, ties: 0, pointsFor: 1043.25, pointsAgainst: 870.5, rank: 1, streak: "W3", seed: 2,
  });
  assert.equal(cleanRecord({ wins: 5, losses: 1 }), undefined, "ties missing = no record");
  assert.equal(cleanRecord({ wins: 5.5, losses: 1, ties: 0 }), undefined);
  assert.equal(cleanRecord({ wins: -1, losses: 1, ties: 0 }), undefined);
  assert.equal(cleanRecord({ wins: 15, losses: 6, ties: 0 }), undefined, "more games than a season holds");
  assert.equal(cleanRecord("5-1-0"), undefined);
  assert.equal(cleanRecord(null), undefined);
  const r = cleanRecord({ wins: 3, losses: 3, ties: 0, pointsFor: "NaN", pointsAgainst: Infinity, rank: 0, seed: 99, streak: "hot" })!;
  assert.deepEqual(r, { wins: 3, losses: 3, ties: 0 });
});

test("validateImport keeps standings and waiver ranks per team; old payloads are unchanged", () => {
  const s = validateImport(withStandings());
  assert.deepEqual(s.teams[0].record, { wins: 5, losses: 1, ties: 0, pointsFor: 1043.2, pointsAgainst: 870.5, rank: 1, streak: "W3", seed: 1 });
  assert.deepEqual(s.teams[1].record, { wins: 1, losses: 5, ties: 0, rank: 12 });
  assert.equal(s.teams[0].waiverRank, 9);
  assert.equal(s.waiverPriority, 2, "the importer's team (myTeamId 2) priority = its waiver rank");
  const old = validateImport(body());
  assert.ok(old.teams.every((t) => !("record" in t) && !("waiverRank" in t)));
  assert.equal(old.waiverPriority, undefined);
  // An explicit waiverPriority wins; out-of-range ranks are dropped; duplicate ranks mean a misread page: all dropped.
  assert.equal(validateImport({ ...withStandings(), waiverPriority: 4 }).waiverPriority, 4);
  const bad = withStandings();
  bad.teams[0].waiverRank = 21;
  assert.equal(validateImport(bad).teams[0].waiverRank, undefined);
  const dup = withStandings();
  dup.teams[0].waiverRank = 2;
  const d = validateImport(dup);
  assert.ok(d.teams.every((t) => t.waiverRank === undefined));
  assert.equal(d.waiverPriority, undefined);
});

test("buildImportLeague fills Team.record and waiverRank; waiver priority per team", () => {
  const s = validateImport(withStandings());
  const l = buildImportLeague(db, s, { season: 2026, currentWeek: 4 });
  assert.equal(l.teams[0].record?.wins, 5);
  assert.equal(l.teams[0].record?.pointsFor, 1043.2);
  assert.equal(l.teams[1].waiverRank, 2);
  assert.equal(buildImportLeague(db, validateImport(body()), { season: 2026, currentWeek: 4 }).teams[0].record, undefined);
  // Each team's own rank; without ranks the stored number belongs to the importer's team only.
  assert.equal(waiverPriorityOf(s, "1"), 9);
  assert.equal(waiverPriorityOf(s, "2"), 2);
  const noRanks = { ...validateImport(body()), waiverPriority: 6 };
  assert.equal(waiverPriorityOf(noRanks, "2"), 6);
  assert.equal(waiverPriorityOf(noRanks, "1"), undefined, "another member never sees the importer's priority");
  assert.equal(waiverPriorityOf(noRanks, undefined), undefined);
  const fdb = { ...db, players: new Map(PLAYERS.map((p) => [p.id, p])) } as unknown as PlayerDb;
  assert.equal(importFreeAgents(l, fdb, s, 4, "1").myPriority, 9);
});

test("re-import refreshes standings; a hand-entered priority is kept; a paste keeps the team's standings", () => {
  const first = validateImport({ ...withStandings(), leagueId: "1405188", settingsSource: "page" });
  const later = withStandings();
  later.teams[1].record = { wins: 2, losses: 5, ties: 0, rank: 11 };
  later.teams[1].waiverRank = 5;
  later.teams[0].waiverRank = 6;
  const incoming = validateImport({ ...later, leagueId: "1405188", settingsSource: "page" });
  const up = upsertImport(first, incoming).stored;
  assert.equal(up.teams[1].record?.wins, 2);
  assert.equal(up.waiverPriority, 5, "never hand-edited: the freshly captured priority replaces the old copy");
  const edited = applySettings(first, { waiverPriority: 8 });
  assert.equal(upsertImport(edited, incoming).stored.waiverPriority, 8, "hand-entered value kept");
  // A re-import whose standings could not be read: records are unknown again, never carried forward as current.
  assert.equal(upsertImport(first, validateImport({ ...body(), leagueId: "1405188" })).stored.teams[0].record, undefined);
  const pasted = mergeTeams(first, [{ id: "x", name: "A", players: [{ name: "Josh Allen", pos: "QB" }] }]);
  assert.equal(pasted.teams[0].record?.wins, 5);
  assert.equal(pasted.teams[0].waiverRank, 9);
  assert.equal(pasted.teams[0].players[0].name, "Josh Allen");
});
