// ADVERSARIAL tests for the matchups collector (runs after collect() inside the live auto-import and the bookmarklet).
// The roster payload must come back exactly as collect() made it whatever Yahoo returns. Known defects are
// `todo: "DEFECT …"` so the suite stays green; remove the todo when fixed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Payload } from "./collect";
import { withMatchups, type GetPage } from "./matchups";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../server/providers/fixtures/matchups");
const fx = (n: string) => readFileSync(path.join(dir, n), "utf8");
const ORIGIN = "https://football.fantasysports.yahoo.com";
const BASE = `${ORIGIN}/f1/1405188`;
const basePayload = (): Payload => ({
  source: "yahoo-bookmarklet",
  id: "y1405188",
  leagueId: "1405188",
  name: "L",
  numTeams: 12,
  slots: ["QB"],
  scoring: { rec: 1 },
  regularSeasonEnd: 14,
  finalWeek: 17,
  myTeamId: "4",
  settingsSource: "page",
  teams: [{ id: "4", name: "Team A", players: [{ name: "Joe Burrow", pos: "QB", yahooId: "32671" }] }],
  importedAt: "2026-10-31T12:00:00.000Z",
  diagnostics: [{ step: "team" }],
});
/** collect()'s part of the payload must be untouched: everything but the appended "matchups" diagnostics. */
function assertCollectPartIntact(out: Payload & { matchupWeek?: number; matchups?: unknown }) {
  const { matchupWeek: _w, matchups: _m, diagnostics, ...rest } = out;
  const { diagnostics: d0, ...rest0 } = basePayload();
  assert.deepEqual(rest, rest0);
  assert.deepEqual(diagnostics.slice(0, d0.length), d0);
  assert.ok(diagnostics.slice(d0.length).every((d) => d.step === "matchups"));
}
const pageOf = (html: string): GetPage => async () => ({ ok: true, status: 200, html });

test("Yahoo signed out (302 followed to the login page, ok: true): no matchupWeek, collect()'s payload intact", async () => {
  const login = `<!doctype html><html><head><title>Yahoo Login</title></head><body><form id="login-username-form"><input name="username"></form></body></html>`;
  const out = await withMatchups(basePayload(), undefined, { origin: ORIGIN, getPage: pageOf(login) });
  assert.equal(out.matchupWeek, undefined);
  assert.equal(out.matchups, undefined);
  assertCollectPartIntact(out);
});

test("garbage bodies (JSON wrappers without the module, binary, 5000 self-paired pairings, HTML with a picker but no options) → nothing, never a throw", async () => {
  const bodies = [
    `{"html":"<div>nothing here</div>","x":[1,2,{"y":null}]}`,
    `[`,
    "\u0000\u0001�".repeat(1000),
    `<div id="matchupweek"><select></select></div>`,
    `<div id="matchupweek"><select><option value="?matchup_week=99" selected>Week 99</option></select></div>`,
    `<div id="matchupweek"><select><option value="?matchup_week=0" selected>Week 0</option></select></div>`,
    "<li data-target=\"/f1/1405188/matchup?week=8&mid1=1&mid2=1\">".repeat(5000),
  ];
  for (const b of bodies) {
    const out = await withMatchups(basePayload(), undefined, { origin: ORIGIN, getPage: pageOf(b) });
    assertCollectPartIntact(out);
    // A week the server would refuse (0 / 99) may be carried; the server's cleanMatchups drops it (server tests).
    assert.ok(out.matchups === undefined || out.matchups.weeks.every((w) => w.pairings.length === 0 || w.week >= 1));
  }
});

test("a fetch rejecting with a non-Error (null) never throws out of withMatchups", async () => {
  const get: GetPage = async (url) => {
    if (url === BASE) return { ok: true, status: 200, html: fx("league-home-module-w8-live.html") };
    throw null;
  };
  const out = await withMatchups(basePayload(), undefined, { origin: ORIGIN, getPage: get });
  assertCollectPartIntact(out);
});

test(
  "a Yahoo page that never answers cannot hold the finished roster read: withMatchups returns within a bounded time",
  { todo: "DEFECT no timeout: defaultGetPage is a bare fetch() with no AbortSignal and withMatchups has no overall budget; one hung Yahoo response (4 extra page reads after collect() finished) holds the whole payload until the auto-import's 3-min attempt timeout / 4-min run deadline discards the roster read too. Suggest a per-fetch AbortSignal.timeout(~15 s) and an overall matchups budget (~30 s)" },
  async () => {
    const hang: GetPage = () => new Promise(() => undefined);
    const t = Symbol("timeout");
    const r = await Promise.race([withMatchups(basePayload(), undefined, { origin: ORIGIN, getPage: hang }), new Promise((res) => setTimeout(() => res(t), 300))]);
    assert.notEqual(r, t, "withMatchups still pending after 300 ms with a hung page");
  },
);
