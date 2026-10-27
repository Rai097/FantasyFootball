// Adversarial tests for import v3 projections (Model v4 release (d)): hostile payloads and stale captures.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Player } from "../model/types.js";
import { normName, normTeam } from "../data/names.js";
import { buildImportLeague, validateImport } from "./import.js";
import type { PlayerFinder } from "./yahoo-parse.js";

function mk(id: string, name: string, pos: Player["pos"], team: string, yahoo?: string): Player {
  return { id, name, pos, team, ids: { yahoo }, snapShare: {}, weeks: [], prior: null };
}
const PLAYERS = [mk("P1", "Patrick Mahomes", "QB", "KC", "30123"), mk("P2", "Ja'Marr Chase", "WR", "CIN", "34496"), mk("P3", "Christian McCaffrey", "RB", "SF")];
const db: PlayerFinder = {
  find(o) {
    if (o.yahoo) {
      const hit = PLAYERS.find((p) => p.ids.yahoo === o.yahoo);
      if (hit) return hit;
    }
    return PLAYERS.find((p) => normName(p.name) === normName(o.name ?? "") && (!o.pos || p.pos === o.pos) && (!o.team || p.team === normTeam(o.team)));
  },
};
const payload = (players: unknown[]) => ({
  name: "L",
  numTeams: 2,
  teams: [
    { id: "1", name: "A", players },
    { id: "2", name: "B", players: [{ name: "Christian McCaffrey", pos: "RB", team: "SF" }] },
  ],
});

test("hostile projection values never throw and never reach a player (objects, booleans, Infinity, -0, arrays, huge)", () => {
  const hostile: unknown[] = [{}, true, Infinity, -Infinity, [12], { valueOf: () => 12 }, 1e308, 450.001, Number.MAX_VALUE, "1e2", ""];
  for (const v of hostile) {
    const s = validateImport(payload([{ name: "Patrick Mahomes", pos: "QB", team: "KC", yahooId: "30123", yahooProj: v, yahooProjWeekly: v }]));
    const p = s.teams[0].players[0];
    assert.equal(p.yahooProj, undefined, `yahooProj ${String(v)}`);
    assert.equal(p.yahooProjWeekly, undefined, `yahooProjWeekly ${String(v)}`);
    const l = buildImportLeague(db, s, { season: 2026, currentWeek: 8 });
    assert.equal(l.playerOverrides.P1?.yahooProj, undefined);
  }
  const zero = validateImport(payload([{ name: "Patrick Mahomes", pos: "QB", team: "KC", yahooProj: -0 }])).teams[0].players[0];
  assert.ok(zero.yahooProj === undefined || zero.yahooProj === 0, "-0 is stored as 0 (JSON round-trips it to 0) or dropped");
});

test("a player listed twice keeps one projection (no crash, value from one of the rows, db entry untouched)", () => {
  const s = validateImport(
    payload([
      { name: "Patrick Mahomes", pos: "QB", team: "KC", yahooId: "30123", yahooProj: 200 },
      { name: "Patrick Mahomes", pos: "QB", team: "KC", yahooId: "30123", yahooProj: 250 },
    ]),
  );
  const l = buildImportLeague(db, s, { season: 2026, currentWeek: 8 });
  assert.ok([200, 250].includes(l.playerOverrides.P1.yahooProj!));
  assert.equal(PLAYERS[0].yahooProj, undefined);
});

test("a v2 payload (no projections) builds a league with no projection fields at all", () => {
  const s = validateImport(payload([{ name: "Patrick Mahomes", pos: "QB", team: "KC", yahooId: "30123" }]));
  const l = buildImportLeague(db, s, { season: 2026, currentWeek: 8 });
  for (const p of Object.values(l.playerOverrides)) assert.ok(p.yahooProj === undefined && p.yahooProjWeekly === undefined);
  assert.equal(l.playerOverrides.P1, undefined, "no override copy is made without projections or an injury tag");
});

test("stale capture: this week's Yahoo projection from an import made in week 8 is not applied as week 9's", () => {
  // The owner imports on Tuesday of week 8 and does not re-import before week 9. Nothing in the stored import records
  // the week the projections belong to, so buildImportLeague copies week 8's "Proj" number into week 9 (perception
  // then replaces his week-9 points with it) and spreads the week 8–17 rest-of-season total over weeks 9–17.
  const s = validateImport(payload([{ name: "Patrick Mahomes", pos: "QB", team: "KC", yahooId: "30123", yahooProj: 200, yahooProjWeekly: 31 }]));
  const wk8 = buildImportLeague(db, s, { season: 2026, currentWeek: 8 }).playerOverrides.P1;
  const wk9 = buildImportLeague(db, s, { season: 2026, currentWeek: 9 }).playerOverrides.P1;
  assert.ok(
    !(wk8?.yahooProjWeekly === 31 && wk9?.yahooProjWeekly === 31),
    "the same weekly projection is served as 'this week' in two different NFL weeks: the import must record its week and drop / rescale stale projections",
  );
});
