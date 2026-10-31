// Bookmarklet v9 end to end under the fake browser: collect() as before, then the matchups (real, anonymized Yahoo
// matchup pages); a Yahoo without matchup pages changes nothing but the diagnostics.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { page, runBookmarklet, type Route } from "./bookmarkletHarness.js";
import { validateImport } from "./import.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/matchups");
const fx = (n: string) => readFileSync(path.join(dir, n), "utf8");
const MY_TEAM = `<a href="/f1/1405188/4">My Team</a>`;

/** Four teams (team 4 = mine); everything else 404 unless `matchups`. */
const route =
  (matchups: boolean): Route =>
  (url) => {
    const team = /^\/f1\/1405188\/([1-4])$/.exec(url.pathname);
    if (team) return { status: 200, html: page([{ id: `${team[1]}0`, name: `Player ${team[1]}`, teamPos: "Cin - QB" }]).replace("<body>", `<body>${MY_TEAM}`) };
    if (!matchups) return { status: 404, html: "" };
    const q = url.searchParams;
    if (url.pathname === "/f1/1405188" && !url.search) return { status: 200, html: fx("league-home-module-w8-live.html") };
    if (url.pathname === "/f1/1405188" && q.get("module") === "matchups" && q.get("matchup_week") === "7") return { status: 200, html: fx("league-home-module-w7-final.html") };
    if (url.pathname === "/f1/1405188/matchup" && q.get("week") === "8" && q.get("mid1") === "4" && q.get("mid2") === "7") return { status: 200, html: fx("matchup-w8-live.html") };
    if (url.pathname === "/f1/1405188/matchup" && q.get("week") === "7" && q.get("mid1") === "4" && q.get("mid2") === "3") return { status: 200, html: fx("matchup-w7-final.html") };
    return { status: 404, html: "" };
  };

test("v9 bookmarklet: payload carries matchupWeek + matchups (W and W−1, my pages) and the import still validates", async () => {
  const { payload, overlay } = await runBookmarklet(route(true));
  assert.equal(payload.myTeamId, "4");
  assert.equal(payload.matchupWeek, 8);
  assert.deepEqual(payload.matchups.weeks.map((w: any) => [w.week, w.status, w.pairings.length, w.pages.length]), [[8, "live", 6, 1], [7, "final", 6, 1]]);
  assert.match(overlay, /Trade Desk import v9/);
  assert.match(overlay, /matchups: week 8, week 7/);
  assert.ok(JSON.stringify(payload).length < 1_000_000);
  assert.equal(validateImport(payload).teams.length, 4);
});

test("v9 bookmarklet: no matchup pages → the collect() part is identical, only 'matchups' diagnostics are added", async () => {
  const a = (await runBookmarklet(route(false))).payload;
  const b = (await runBookmarklet(route(true))).payload;
  const strip = (p: any) => {
    const { matchups: _m, matchupWeek: _w, diagnostics, importedAt: _t, ...rest } = p;
    return { ...rest, diagnostics: diagnostics.filter((d: any) => d.step !== "matchups" && d.step !== "standings") };
  };
  // Standings differ only because collect()'s own fallback reads the league home page (now served).
  assert.deepEqual(strip(a), strip(b));
  assert.equal(a.matchups, undefined);
  assert.equal(a.matchupWeek, undefined);
  assert.ok(a.diagnostics.some((d: any) => d.step === "matchups" && d.status === 404));
});
