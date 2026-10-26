// Unit tests for the bookmarklet's pure HTML parsing (web/src/import/yahooHtml.ts)
// against HAND-WRITTEN, APPROXIMATE fixtures (fixtures/yahoo-web-*.html) — Yahoo's
// real markup has not been seen; these pin down the fallbacks we rely on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { availabilityFrom, htmlToText, mapSlotToken, parseMyTeamId, parsePlayersHtml, parsePosTeam, parseSettingsHtml, playerKey, waiverStatusOf } from "../../web/src/import/yahooHtml.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const html = (n: string) => readFileSync(path.join(dir, n), "utf8");

test("parsePosTeam accepts Team - Pos, Pos - Team and (Pos - Team)", () => {
  assert.deepEqual(parsePosTeam("Patrick Mahomes KC - QB"), { team: "KC", pos: "QB" });
  assert.deepEqual(parsePosTeam("Bench Guy NYJ - WR,TE"), { team: "NYJ", pos: "WR" });
  assert.deepEqual(parsePosTeam("x WR - KC y"), { pos: "WR", team: "KC" });
  assert.deepEqual(parsePosTeam("Josh Allen (QB - BUF)"), { pos: "QB", team: "BUF" });
  assert.equal(parsePosTeam("no position here"), undefined);
});

test("roster page: players, positions, teams, status, slots, de-duplication", () => {
  const r = parsePlayersHtml(html("yahoo-web-roster.html"));
  assert.equal(r.teamName, "Gridiron Gurus");
  const byName = Object.fromEntries(r.players.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(byName).sort(), ["Bench Guy", "Buffalo", "Christian McCaffrey", "Hurt Player", "Ja'Marr Chase", "Patrick Mahomes", "Travis Kelce"]);
  assert.deepEqual(byName["Patrick Mahomes"], { yahooId: "30123", name: "Patrick Mahomes", pos: "QB", team: "KC", slot: "QB" });
  assert.equal(byName["Ja'Marr Chase"].status, "Q");
  assert.equal(byName["Ja'Marr Chase"].team, "CIN");
  assert.equal(byName["Christian McCaffrey"].slot, "W/R/T");
  assert.equal(byName["Travis Kelce"].pos, "TE");
  assert.equal(byName["Travis Kelce"].slot, "TE");
  assert.deepEqual(byName["Buffalo"], { name: "Buffalo", pos: "DEF", team: "BUF", slot: "DEF" });
  assert.equal(byName["Bench Guy"].pos, "WR");
  assert.equal(byName["Hurt Player"].status, "IR");
  assert.equal(byName["Hurt Player"].slot, "IR");
  assert.equal(r.players.filter((p) => p.yahooId === "30123").length, 1);
  assert.ok(r.diag.links >= 8);
  assert.ok(r.diag.sampleRows.length > 0);
});

test("team names starting with 'Team' are kept; generic headings are skipped", () => {
  const r = parsePlayersHtml(`<title>Team Kofi | Sunday Funday | Yahoo! Sports</title><a href="/nfl/players/1">A B</a> KC - QB`);
  assert.equal(r.teamName, "Team Kofi");
  const g = parsePlayersHtml(`<title>Yahoo Fantasy Football</title><h1>Fantasy Football</h1><h2>Flea Flickers</h2><a href="/nfl/players/1">A B</a> KC - QB`);
  assert.equal(g.teamName, "Flea Flickers");
});

test("my team id from navigation", () => {
  assert.equal(parseMyTeamId(html("yahoo-web-roster.html"), "1405188"), "7");
  assert.equal(parseMyTeamId("<a href='/f1/1/3'>Team 3</a>", "1"), undefined);
});

test("page with no player links yields nothing (bookmarklet stops there)", () => {
  const r = parsePlayersHtml("<html><title>League Home | Yahoo</title><body><a href='/f1/1/2'>x</a></body></html>");
  assert.equal(r.players.length, 0);
});

test("fallback: no table rows, name + Team - Pos nearby in a list", () => {
  const r = parsePlayersHtml(`<ul><li><a href="/nfl/players/1">A Player</a><span>Det - RB</span></li><li><a href="/nfl/players/2">B Player</a> (WR - GB)</li></ul>`);
  assert.deepEqual(
    r.players.map((p) => [p.name, p.pos, p.team]),
    [["A Player", "RB", "DET"], ["B Player", "WR", "GB"]],
  );
});

test("settings page: slots, scoring, teams, playoffs", () => {
  const s = parseSettingsHtml(html("yahoo-web-settings.html"));
  assert.equal(s.name, "Sunday Funday");
  assert.equal(s.numTeams, 12);
  assert.deepEqual(s.slots, ["QB", "WR", "WR", "WR", "RB", "RB", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR"]);
  assert.deepEqual(s.scoring, { passYd: 0.04, passTd: 4, passInt: -1, rushYd: 0.1, rushTd: 6, rec: 1, recYd: 0.1, recTd: 6, twoPt: 2, fumLost: -2 });
  assert.equal(s.regularSeasonEnd, 14);
  assert.equal(s.finalWeek, 17);
});

test("settings: count formats and empty page", () => {
  const s = parseSettingsHtml("<p>Roster Positions: QB x1, RB (2), WR: 3, W/R/T, BN x5, IR</p><p>Other Setting: yes</p>");
  assert.deepEqual(s.slots, ["QB", "RB", "RB", "WR", "WR", "WR", "FLEX", "BN", "BN", "BN", "BN", "BN", "IR"]);
  const e = parseSettingsHtml("<p>Nothing</p>");
  assert.equal(e.slots, undefined);
  assert.deepEqual(e.scoring, {});
});

test("helpers", () => {
  assert.equal(mapSlotToken("W/R/T"), "FLEX");
  assert.equal(mapSlotToken("Q/W/R/T"), "SFLEX");
  assert.equal(mapSlotToken("IL"), "IR");
  assert.equal(htmlToText("<p>a&amp;b</p><script>x()</script><td>c</td>"), "a&b\nc");
});

test("player list: owner column tells free agents (FA) from players on waivers (W (Wed)); K and DEF rows parse", () => {
  const r = parsePlayersHtml(html("yahoo-web-players.html"));
  const by = Object.fromEntries(r.players.map((p) => [p.name, p]));
  assert.equal(by["Free Runner"].availability, "FA");
  assert.equal(by["Waiver Wideout"].availability, "W");
  assert.equal(by["Waiver Wideout"].waiverUntil, "Wed");
  assert.equal(by["Dated Tightend"].availability, "W");
  assert.equal(by["Dated Tightend"].waiverUntil, "10/29");
  assert.equal(by["Dated Tightend"].status, "Q");
  assert.equal(by["Plain Passer"].availability, "FA");
  assert.deepEqual(by["Carolina"], { name: "Carolina", pos: "DEF", team: "CAR", availability: "FA" });
  assert.equal(by["Long Kicker"].pos, "K");
  assert.equal(by["Long Kicker"].availability, "W");
  assert.equal(r.diag.availability, "FA:3,W:3,none:0");
  assert.equal(r.diag.availabilityNote, undefined);
});

test("player list without an owner column: no availability, and a diagnostics note", () => {
  const page = html("yahoo-web-players.html").replace(/<td class="Ta-c">[\s\S]*?<\/td>/g, "<td>-</td>");
  const r = parsePlayersHtml(page);
  assert.equal(r.players.length, 6);
  assert.ok(r.players.every((p) => p.availability === undefined));
  assert.equal(r.diag.availability, "FA:0,W:0,none:6");
  assert.equal(r.diag.availabilityNote, "owner column (FA / W) not found");
});

test("availabilityFrom: whole cells only", () => {
  assert.deepEqual(availabilityFrom("Name\tFA\t7"), { availability: "FA" });
  assert.deepEqual(availabilityFrom("Name\tW (Wed)\t7"), { availability: "W", waiverUntil: "Wed" });
  assert.deepEqual(availabilityFrom("Name\tWaivers\t7"), { availability: "W" });
  assert.equal(availabilityFrom("FA Cup Winner KC - WR\tW/R/T\t7"), undefined);
  assert.equal(availabilityFrom("Name\tWAS - WR\t7"), undefined);
});

test("waiverStatusOf: owner column wins, else the status=W list, else unknown", () => {
  const ps = [
    { yahooId: "1", name: "A", pos: "RB", availability: "FA" as const },
    { yahooId: "2", name: "B", pos: "WR" },
    { yahooId: "3", name: "C", pos: "WR" },
    { name: "Carolina", pos: "DEF" },
  ];
  const list = { keys: new Set(["2", "1"]), complete: true, ignored: false };
  const r = waiverStatusOf(ps, list);
  assert.equal(r.onWaivers.get("1"), false); // column says FA (the list disagrees: counted)
  assert.equal(r.onWaivers.get("2"), true);
  assert.equal(r.onWaivers.get("3"), false);
  assert.equal(r.onWaivers.get(playerKey(ps[3])), false);
  assert.deepEqual(r.diag, { fromColumn: 1, fromList: 3, unknown: 0, disagree: 1, listUsed: true });
  // Truncated list: members are on waivers, the rest unknown (not guessed as free agents).
  const t = waiverStatusOf(ps, { ...list, complete: false });
  assert.equal(t.onWaivers.get("2"), true);
  assert.equal(t.onWaivers.get("3"), undefined);
  // Yahoo ignored status=W: the list is not used; no column → unknown, never "everyone on waivers".
  const ig = waiverStatusOf(ps, { ...list, ignored: true });
  assert.equal(ig.onWaivers.get("2"), undefined);
  assert.equal(ig.onWaivers.get("1"), false);
  assert.equal(waiverStatusOf(ps, undefined).diag.unknown, 3);
  // Empty W list and no owner column anywhere: unreadable, so unknown — never "everyone is a free agent".
  const noCol = ps.map(({ availability: _a, ...p }) => p);
  const empty = waiverStatusOf(noCol, { keys: new Set(), complete: true, ignored: false });
  assert.ok([...empty.onWaivers.values()].every((v) => v === undefined));
  assert.equal(empty.diag.listUsed, false);
  // Empty W list with a readable owner column elsewhere: the list is believed (nobody is on waivers).
  assert.equal(waiverStatusOf(ps, { keys: new Set(), complete: true, ignored: false }).onWaivers.get("2"), false);
});
