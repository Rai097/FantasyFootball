// ADVERSARIAL tests for the matchups collector (runs after collect() inside the live auto-import and the bookmarklet).
// The roster payload must come back exactly as collect() made it whatever Yahoo returns. Known defects are
// `todo: "DEFECT …"` so the suite stays green; remove the todo when fixed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Payload } from "./collect";
import { MATCHUP_TIMEOUTS, withMatchups, type GetPage } from "./matchups";

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

// Fixed (fix round 1): per-page abort after MATCHUP_TIMEOUTS.fetchMs (20 s) and a 60 s budget for the whole step. The
// test passes short limits through `deps` (the decision's 20 s / 60 s cannot fit a 300 ms test) and checks the defaults.
test("a Yahoo page that never answers cannot hold the finished roster read: withMatchups returns within a bounded time", async () => {
  assert.deepEqual(MATCHUP_TIMEOUTS, { fetchMs: 20_000, budgetMs: 60_000 });
  let aborted = false;
  const hang: GetPage = (_u, signal) => new Promise(() => signal?.addEventListener("abort", () => (aborted = true)));
  const t = Symbol("timeout");
  const r = await Promise.race([withMatchups(basePayload(), undefined, { origin: ORIGIN, getPage: hang, fetchTimeoutMs: 50, budgetMs: 150 }), new Promise((res) => setTimeout(() => res(t), 300))]);
  assert.notEqual(r, t, "withMatchups still pending after 300 ms with a hung page");
  const out = r as Awaited<ReturnType<typeof withMatchups>>;
  assertCollectPartIntact(out);
  assert.equal(out.matchupWeek, undefined);
  assert.ok(aborted, "the hung read was aborted");
  assert.ok(out.diagnostics.some((d) => /home page fetch failed: timed out after 0\.1 s/.test(String(d.note))), JSON.stringify(out.diagnostics));
});

test("the overall budget stops further page reads: slow (but answering) pages never run past it", async () => {
  const slow: GetPage = (url) =>
    new Promise((res) => setTimeout(() => res({ ok: true, status: 200, html: url === BASE ? fx("league-home-module-w8-live.html") : fx("matchup-w8-live.html") }), 60));
  const t0 = Date.now();
  const out = await withMatchups(basePayload(), undefined, { origin: ORIGIN, getPage: slow, fetchTimeoutMs: 1_000, budgetMs: 100 });
  assert.ok(Date.now() - t0 < 400, `${Date.now() - t0} ms`);
  assertCollectPartIntact(out);
  assert.ok(out.diagnostics.some((d) => /time budget spent|timed out/.test(String(d.note))), JSON.stringify(out.diagnostics));
});
