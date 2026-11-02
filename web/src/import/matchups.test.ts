// The matchups collector's fetch plan against real (anonymized) Yahoo pages served by a fake getPage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Payload } from "./collect";
import { collectMatchups, MAX_MATCHUP_FETCHES, moduleHtml, withMatchups, type GetPage } from "./matchups";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../server/providers/fixtures/matchups");
const fx = (n: string) => readFileSync(path.join(dir, n), "utf8");
const ORIGIN = "https://football.fantasysports.yahoo.com";
const BASE = `${ORIGIN}/f1/1405188`;

/** Yahoo as of Saturday of week 8: home page = week 8 module; week 7 final. */
function yahoo(over: Record<string, string | number | "throw"> = {}): { get: GetPage; urls: string[] } {
  const pages: Record<string, string | number | "throw"> = {
    [BASE]: fx("league-home-module-w8-live.html"),
    [`${BASE}?matchup_week=7&module=matchups`]: fx("league-home-module-w7-final.html"),
    [`${BASE}?matchup_week=8&module=matchups`]: fx("league-home-module-w8-live.html"),
    [`${BASE}/matchup?week=8&mid1=4&mid2=7`]: fx("matchup-w8-live.html"),
    [`${BASE}/matchup?week=7&mid1=4&mid2=3`]: fx("matchup-w7-final.html"),
    ...over,
  };
  const urls: string[] = [];
  const get: GetPage = async (url) => {
    urls.push(url);
    const p = pages[url];
    if (p === "throw") throw new TypeError("Failed to fetch");
    if (p === undefined || typeof p === "number") return { ok: false, status: typeof p === "number" ? p : 404, html: "" };
    return { ok: true, status: 200, html: p };
  };
  return { get, urls };
}

test("full run: W from the home page's week picker, W and W−1 pairings, the owner's matchup page for both, 4 fetches", async () => {
  const y = yahoo();
  const r = await collectMatchups({ base: BASE, leagueId: "1405188", myTeamId: "4", getPage: y.get });
  assert.deepEqual(y.urls, [BASE, `${BASE}/matchup?week=8&mid1=4&mid2=7`, `${BASE}?matchup_week=7&module=matchups`, `${BASE}/matchup?week=7&mid1=4&mid2=3`]);
  assert.equal(r.fetches, MAX_MATCHUP_FETCHES);
  assert.equal(r.matchupWeek, 8);
  const [w8, w7] = r.matchups!.weeks;
  assert.deepEqual([w8.week, w8.status, w8.pairings.length, w8.pages.length], [8, "live", 6, 1]);
  assert.deepEqual([w7.week, w7.status, w7.pairings.length, w7.pages.length], [7, "final", 6, 1]);
  const p7 = w7.pages[0];
  assert.deepEqual([p7.mid1, p7.mid2, p7.sides[0].teamId, p7.sides[0].totalProj, p7.sides[0].totalPts], ["4", "3", "4", 123.86, 165.78]);
  assert.deepEqual(p7.sides[0].rows[0], { slot: "QB", yahooId: "32671", name: "Joe Burrow", pos: "QB", team: "CIN", yahooProj: 18.86, points: 28.88, game: "final" });
  assert.equal(w8.pages[0].sides[0].rows[0].points, null, "not played yet: null, never 0");
  // Wire size: what one import adds to the payload.
  assert.ok(JSON.stringify(r.matchups).length < 30_000, `${JSON.stringify(r.matchups).length} bytes`);
  assert.ok(r.diagnostics.some((d) => d.note === "summary" && d.matchupWeek === 8));
});

test("my team unknown: pairings only, no matchup page fetched", async () => {
  const y = yahoo();
  const r = await collectMatchups({ base: BASE, leagueId: "1405188", getPage: y.get });
  assert.deepEqual(y.urls, [BASE, `${BASE}?matchup_week=7&module=matchups`]);
  assert.deepEqual(r.matchups!.weeks.map((w) => [w.week, w.pages.length]), [[8, 0], [7, 0]]);
  assert.ok(r.diagnostics.some((d) => /my team unknown/.test(String(d.note))));
});

test("failures are diagnostics: home page down → nothing; W−1 module down → week W kept; a throwing page → note", async () => {
  let y = yahoo({ [BASE]: 503 });
  let r = await collectMatchups({ base: BASE, leagueId: "1405188", myTeamId: "4", getPage: y.get });
  assert.equal(r.matchupWeek, undefined);
  assert.equal(r.matchups, undefined);
  assert.ok(r.diagnostics.some((d) => d.step === "matchups" && d.status === 503));
  y = yahoo({ [`${BASE}?matchup_week=7&module=matchups`]: "throw", [`${BASE}/matchup?week=8&mid1=4&mid2=7`]: "throw" });
  r = await collectMatchups({ base: BASE, leagueId: "1405188", myTeamId: "4", getPage: y.get });
  assert.equal(r.matchupWeek, 8);
  assert.deepEqual(r.matchups!.weeks.map((w) => [w.week, w.pages.length]), [[8, 0]]);
  assert.equal(r.diagnostics.filter((d) => /fetch failed/.test(String(d.note))).length, 2);
});

test("a module that shows another week than asked is not used; no selected week → nothing", async () => {
  let y = yahoo({ [`${BASE}?matchup_week=7&module=matchups`]: fx("league-home-module-w8-live.html") });
  let r = await collectMatchups({ base: BASE, leagueId: "1405188", myTeamId: "4", getPage: y.get });
  assert.deepEqual(r.matchups!.weeks.map((w) => w.week), [8]);
  assert.ok(r.diagnostics.some((d) => /module showed week 8, expected 7/.test(String(d.note))));
  y = yahoo({ [BASE]: "<html><body>Welcome</body></html>" });
  r = await collectMatchups({ base: BASE, leagueId: "1405188", myTeamId: "4", getPage: y.get });
  assert.equal(r.matchupWeek, undefined);
  assert.deepEqual(y.urls, [BASE]);
});

test("home page without this week's pairings: the week-W module is fetched instead, still at most 4 fetches", async () => {
  const picker = fx("league-home-module-w8-live.html").replace(/<li\b[\s\S]*<\/li>/, "");
  const y = yahoo({ [BASE]: picker });
  const r = await collectMatchups({ base: BASE, leagueId: "1405188", myTeamId: "4", getPage: y.get });
  assert.equal(y.urls.length, MAX_MATCHUP_FETCHES);
  assert.equal(y.urls[1], `${BASE}?matchup_week=8&module=matchups`);
  assert.deepEqual(r.matchups!.weeks.map((w) => [w.week, w.pages.length]), [[8, 1], [7, 0]]);
  assert.ok(r.diagnostics.some((d) => /4-page limit/.test(String(d.note))));
});

test("module responses wrapped in JSON are unwrapped; plain HTML passes through", () => {
  const h = fx("league-home-module-w7-final.html");
  assert.equal(moduleHtml(JSON.stringify({ content: { html: h } })), h);
  assert.equal(moduleHtml(h), h);
  assert.equal(moduleHtml("{not json"), "{not json");
});

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

test("withMatchups: adds matchupWeek + matchups and leaves every collect() field as it was", async () => {
  const before = basePayload();
  const out = await withMatchups(basePayload(), undefined, { origin: ORIGIN, getPage: yahoo().get });
  const { matchupWeek, matchups, diagnostics, ...rest } = out;
  const { diagnostics: d0, ...rest0 } = before;
  assert.deepEqual(rest, rest0);
  assert.deepEqual(diagnostics.slice(0, d0.length), d0, "collect()'s diagnostics first, unchanged");
  assert.ok(diagnostics.slice(d0.length).every((d) => d.step === "matchups"));
  assert.equal(matchupWeek, 8);
  assert.equal(matchups!.weeks.length, 2);
});

test("withMatchups never throws: an unexpected error is one diagnostics note and the payload is collect()'s", async () => {
  const boom: GetPage = () => {
    throw new Error("boom");
  };
  const out = await withMatchups(basePayload(), undefined, { origin: ORIGIN, getPage: boom });
  assert.equal(out.matchups, undefined);
  assert.equal(out.matchupWeek, undefined);
  assert.equal(out.teams.length, 1);
  assert.ok(out.diagnostics.some((d) => d.step === "matchups" && /boom/.test(String(d.note))));
  // No location in node and no origin given: caught too.
  const out2 = await withMatchups(basePayload(), undefined, {});
  assert.ok(out2.diagnostics.some((d) => d.step === "matchups" && /matchups not read/.test(String(d.note))));
});
