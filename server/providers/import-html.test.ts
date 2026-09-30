// Unit tests for the bookmarklet's pure HTML parsing (web/src/import/yahooHtml.ts)
// against HAND-WRITTEN, APPROXIMATE fixtures (fixtures/yahoo-web-*.html) — Yahoo's
// real markup has not been seen; these pin down the fallbacks we rely on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToText, mapSlotToken, parseMyTeamId, parsePlayersHtml, parsePosTeam, parseSettingsHtml } from "../../web/src/import/yahooHtml.js";

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
