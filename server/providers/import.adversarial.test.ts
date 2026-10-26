// ADVERSARIAL tests (tester, not developer) for Waivers v3 import validation: onWaivers typing, huge lists,
// K/DEF without a Yahoo id, stripLeaguePrefix edge cases, importFreeAgents availability mapping. Pure: a fake
// player finder, no disk, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { importFreeAgents, MAX_FREE_AGENTS, stripLeaguePrefix, upsertImport, validateImport, type StoredImport } from "./import.js";
import type { League, Player } from "../model/types.js";
import type { PlayerDb } from "../data/players.js";

const teams = (names: string[]) => names.map((name, i) => ({ id: String(i + 1), name, players: [{ name: `P${i}`, pos: "QB" }] }));
const body = (extra: Record<string, unknown> = {}) => ({ id: "yA", leagueId: "1", name: "L", teams: teams(["A", "B"]), ...extra });

// ------------------------------------------------------------------ onWaivers typing
test("onWaivers: only real booleans are kept; strings / numbers / null become unknown (absent)", () => {
  const s = validateImport(
    body({
      freeAgents: [
        { name: "Bool True", pos: "WR", onWaivers: true },
        { name: "Bool False", pos: "WR", onWaivers: false },
        { name: "Str True", pos: "WR", onWaivers: "true" },
        { name: "Str False", pos: "WR", onWaivers: "false" },
        { name: "One", pos: "WR", onWaivers: 1 },
        { name: "Zero", pos: "WR", onWaivers: 0 },
        { name: "Null", pos: "WR", onWaivers: null },
        { name: "Obj", pos: "WR", onWaivers: { v: true } },
        { name: "Missing", pos: "WR" },
      ],
    }),
  );
  const by = Object.fromEntries(s.freeAgents!.map((f) => [f.name, f]));
  assert.equal(by["Bool True"].onWaivers, true);
  assert.equal(by["Bool False"].onWaivers, false);
  for (const n of ["Str True", "Str False", "One", "Zero", "Null", "Obj", "Missing"]) {
    assert.equal(by[n].onWaivers, undefined, `${n}: ${JSON.stringify(by[n])}`);
    assert.ok(!("onWaivers" in by[n]), `${n}: key must be absent, not undefined`);
  }
});

test("free-agent entries that are null / not objects throw a 400, never a TypeError", () => {
  for (const bad of [null, 5, "x", [], { pos: "WR" }]) {
    assert.throws(
      () => validateImport(body({ freeAgents: [bad] })),
      (e: Error & { status?: number }) => e.status === 400,
      JSON.stringify(bad),
    );
  }
});

test("huge free-agent lists: MAX accepted, MAX+1 rejected with 400", () => {
  const fa = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Free Agent${i}`, pos: "WR", yahooId: String(10_000 + i), onWaivers: i % 2 === 0 }));
  const ok = validateImport(body({ freeAgents: fa(MAX_FREE_AGENTS) }));
  assert.equal(ok.freeAgents!.length, MAX_FREE_AGENTS);
  assert.equal(ok.freeAgents!.filter((f) => f.onWaivers === true).length, MAX_FREE_AGENTS / 2);
  assert.throws(() => validateImport(body({ freeAgents: fa(MAX_FREE_AGENTS + 1) })), (e: Error & { status?: number }) => e.status === 400);
});

test("K and DEF free agents without a Yahoo id are kept (name + pos + team), with onWaivers", () => {
  const s = validateImport(
    body({
      freeAgents: [
        { name: "Cleveland", pos: "DEF", team: "Cle", onWaivers: false },
        { name: "Cleveland Browns", pos: "D/ST", team: "CLE", onWaivers: true },
        { name: "Long Kicker", pos: "K", team: "Bal", onWaivers: true },
        { name: "Bad Id", pos: "K", yahooId: "abc", onWaivers: false },
      ],
    }),
  );
  const by = Object.fromEntries(s.freeAgents!.map((f) => [f.name, f]));
  assert.deepEqual(by["Cleveland"], { name: "Cleveland", pos: "DEF", team: "CLE", onWaivers: false });
  assert.equal(by["Cleveland Browns"].pos, "DEF", "D/ST normalises to DEF");
  assert.equal(by["Long Kicker"].pos, "K");
  assert.equal(by["Long Kicker"].yahooId, undefined);
  assert.equal(by["Bad Id"].yahooId, undefined, "non-numeric yahooId dropped");
});

// ------------------------------------------------------------------ stripLeaguePrefix
const names = (xs: { name: string }[]) => xs.map((t) => t.name);

test("stripLeaguePrefix: one team is never stripped", () => {
  assert.deepEqual(names(stripLeaguePrefix([{ name: "L - Solo" }])), ["L - Solo"]);
});

test("stripLeaguePrefix: mixed prefixes leave everything unchanged", () => {
  assert.deepEqual(names(stripLeaguePrefix([{ name: "L - A" }, { name: "M - B" }])), ["L - A", "M - B"]);
  assert.deepEqual(names(stripLeaguePrefix([{ name: "L - A" }, { name: "B" }])), ["L - A", "B"]);
});

test("stripLeaguePrefix: prefix-only names are kept (no empty team names)", () => {
  const r = stripLeaguePrefix([{ name: "L - A" }, { name: "L - " }]);
  assert.ok(names(r).every((n) => n.trim().length > 0), JSON.stringify(names(r)));
});

test("stripLeaguePrefix: is idempotent (it runs on save AND on every read)", () => {
  // Every team literally named "<league> - <group> - <team>": one strip on save, then one more on each read
  // would eat the group too ("Team - One" → "One").
  const once = stripLeaguePrefix([{ name: "L - Team - One" }, { name: "L - Team - Two" }]);
  const twice = stripLeaguePrefix(once);
  assert.deepEqual(names(twice), names(once), `strip on read changed already-stripped names: ${JSON.stringify(names(once))} → ${JSON.stringify(names(twice))}`);
});

test("stripLeaguePrefix: a two-team league whose teams are genuinely named 'X - Y' and 'X - Z'", () => {
  // Without the league's own name there is no way to tell; at minimum the result keeps distinct, non-empty names.
  const r = names(stripLeaguePrefix([{ name: "Fire - Ice" }, { name: "Fire - Water" }]));
  assert.equal(new Set(r).size, 2);
  assert.ok(r.every((n) => n.length > 0));
});

test("stripLeaguePrefix: unicode dashes (– — and &#8211;) are handled like ' - ' or left alone, never half-stripped", () => {
  const en = names(stripLeaguePrefix([{ name: "L – A" }, { name: "L – B" }]));
  assert.ok(JSON.stringify(en) === JSON.stringify(["A", "B"]) || JSON.stringify(en) === JSON.stringify(["L – A", "L – B"]), JSON.stringify(en));
  const mixed = names(stripLeaguePrefix([{ name: "L - A" }, { name: "L – B" }]));
  assert.ok(!mixed.includes("A") || mixed.includes("B"), `half-stripped: ${JSON.stringify(mixed)}`);
});

test("stripLeaguePrefix through validateImport: stripping must not create duplicate team names", () => {
  const s = validateImport(body({ teams: teams(["L - A", "L - A ", "L - B"]) }));
  const ns = s.teams.map((t) => t.name);
  // Two teams that only differed by whitespace were already duplicates; just make sure nothing becomes empty.
  assert.ok(ns.every((n) => n.length > 0), JSON.stringify(ns));
});

// ------------------------------------------------------------------ importFreeAgents
function fakeDb(ps: Player[]): PlayerDb {
  const players = new Map(ps.map((p) => [p.id, p]));
  return {
    season: 2026,
    builtAt: "",
    players,
    byYahoo: new Map(),
    bySleeper: new Map(),
    byEspn: new Map(),
    byFp: new Map(),
    byName: new Map(),
    find: (o) => ps.find((p) => (o.yahoo && p.ids.yahoo === o.yahoo) || (p.name === o.name && p.pos === o.pos)),
    search: () => [],
  };
}
const pl = (id: string, name: string, pos: Player["pos"], yahoo?: string): Player => ({ id, name, pos, team: "KC", ids: yahoo ? { yahoo } : {}, snapShare: {}, weeks: [], prior: null });

function stored(fa: StoredImport["freeAgents"]): StoredImport {
  return {
    id: "yA",
    name: "L",
    numTeams: 2,
    slots: ["QB", "BN"],
    scoring: {} as StoredImport["scoring"],
    regularSeasonEnd: 14,
    finalWeek: 17,
    teams: [{ id: "1", name: "A", players: [{ name: "Rostered", pos: "QB", yahooId: "1" }] }],
    freeAgents: fa,
    importedAt: "2026-10-26T00:00:00Z",
    settingsSource: "page",
    waiverPriority: 5,
  };
}
const leagueOf = (rostered: string[]): League => ({
  provider: "import",
  id: "yA",
  settings: { name: "L", season: 2026, currentWeek: 8, regularSeasonEnd: 14, finalWeek: 17, numTeams: 2, slots: ["QB", "BN"], scoring: {} as League["settings"]["scoring"], isDynasty: false },
  teams: [{ id: "1", name: "A", owner: "", playerIds: rostered, unmatched: [] }],
  myTeamId: "1",
  fetchedAt: "",
});

test("importFreeAgents: availability fa / waivers / unknown; unknown counts as on waivers; DEF without id resolves by name", () => {
  const db = fakeDb([pl("r", "Rostered", "QB", "1"), pl("a", "Alpha", "WR", "2"), pl("b", "Bravo", "WR", "3"), pl("c", "Charlie", "RB", "4"), pl("cle", "Cleveland", "DEF")]);
  const { freeAgents, myPriority } = importFreeAgents(
    leagueOf(["r"]),
    db,
    stored([
      { name: "Alpha", pos: "WR", yahooId: "2", onWaivers: false },
      { name: "Bravo", pos: "WR", yahooId: "3", onWaivers: true },
      { name: "Charlie", pos: "RB", yahooId: "4" },
      { name: "Cleveland", pos: "DEF", onWaivers: false },
      { name: "Rostered", pos: "QB", yahooId: "1", onWaivers: false },
      { name: "Alpha", pos: "WR", yahooId: "2", onWaivers: true }, // duplicate: first wins
    ]),
    8,
  );
  const by = Object.fromEntries(freeAgents.map((f) => [f.player.id, f]));
  assert.deepEqual([by.a.onWaivers, by.a.availability], [false, "fa"]);
  assert.deepEqual([by.b.onWaivers, by.b.availability], [true, "waivers"]);
  assert.deepEqual([by.c.onWaivers, by.c.availability], [true, "unknown"]);
  assert.deepEqual([by.cle.onWaivers, by.cle.availability], [false, "fa"]);
  assert.equal(by.r, undefined, "rostered player never a free agent");
  assert.equal(freeAgents.length, 4);
  assert.equal(myPriority, 5);
});

test("importFreeAgents: unresolved imported free agents are reported somewhere (not silently dropped)", () => {
  const db = fakeDb([pl("a", "Alpha", "WR", "2")]);
  const r = importFreeAgents(leagueOf([]), db, stored([{ name: "Alpha", pos: "WR", yahooId: "2", onWaivers: false }, { name: "Nobody Known", pos: "WR", yahooId: "77", onWaivers: true }]), 8) as unknown as Record<string, unknown>;
  const reported = JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "freeAgents")));
  assert.match(reported, /Nobody Known|unmatched|unresolved/i, `importFreeAgents drops unmatched free agents with no count or name: ${reported}`);
});

// ------------------------------------------------------------------ re-import keeps the per-player status fresh
test("upsertImport: a re-import replaces free agents and their onWaivers (no stale status carried over)", () => {
  const prev = validateImport(body({ freeAgents: [{ name: "Old", pos: "WR", onWaivers: true }] }));
  const next = validateImport(body({ freeAgents: [{ name: "Old", pos: "WR", onWaivers: false }] }));
  assert.equal(upsertImport(prev, next).stored.freeAgents![0].onWaivers, false);
  const unknownNow = validateImport(body({ freeAgents: [{ name: "Old", pos: "WR" }] }));
  assert.equal(upsertImport(prev, unknownNow).stored.freeAgents![0].onWaivers, undefined, "an unknown status now must not inherit the old one");
});
