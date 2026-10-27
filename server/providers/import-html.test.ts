// Unit tests for the bookmarklet's pure HTML parsing (web/src/import/yahooHtml.ts)
// against HAND-WRITTEN, APPROXIMATE fixtures (fixtures/yahoo-web-*.html) — Yahoo's
// real markup has not been seen; these pin down the fallbacks we rely on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { availabilityFrom, htmlToText, mapSlotToken, parseMyTeamId, parsePlayersHtml, parsePosTeam, parseProjectionHtml, parseSettingsHtml, stripMarkupAttrs, parseStandingsHtml, playerKey, rosViewIndicator, navLink, NAV_TEXT, waiverStatusOf } from "../../web/src/import/yahooHtml.js";

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
  // Completeness is judged per position group: the flat list has no defense in it and no defense row had an owner
  // reading, so an empty DEF list cannot be told from an unread one → unknown, not a free agent.
  assert.equal(r.onWaivers.get(playerKey(ps[3])), undefined);
  assert.deepEqual(r.diag, { fromColumn: 1, fromList: 2, unknown: 1, disagree: 1, listUsed: true });
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

test("standings page: rank, W-L-T, points, streak and waiver rank per team, across division tables", () => {
  const r = parseStandingsHtml(html("yahoo-web-standings.html"), "1405188");
  assert.deepEqual(r.rows.map((x) => x.teamId), ["3", "1", "5", "2", "4"], "nav links are not rows");
  assert.deepEqual(r.rows[0], {
    teamId: "3",
    name: "Gridiron Gurus",
    record: { wins: 6, losses: 1, ties: 0, pointsFor: 1043.24, pointsAgainst: 870.5, rank: 1, streak: "W3" },
    waiverRank: 11,
  });
  assert.deepEqual(r.rows[1].record, { wins: 4, losses: 2, ties: 1, pointsFor: 988.1, pointsAgainst: 950.02, rank: 4, streak: "L1" });
  assert.equal(r.rows[3].name, "Hail Mary & Co");
  assert.equal(r.rows[4].record?.pointsAgainst, 1010.8);
  assert.equal(r.rows[4].waiverRank, 1);
  assert.equal(r.diag.tables, 2);
  assert.equal(r.diag.rankFrom, "header");
  assert.deepEqual(r.diag.missing, ["seed"]);
  assert.deepEqual(r.diag.noRecord, []);
});

test("standings without points / waiver columns: those stay unknown and are listed as missing", () => {
  const r = parseStandingsHtml(html("yahoo-web-standings-no-points.html"), "1405188");
  assert.deepEqual(r.rows[0], { teamId: "7", name: "Blitz Kings", record: { wins: 6, losses: 1, ties: 0, rank: 1, streak: "W3" } });
  assert.ok(r.rows.every((x) => x.record?.pointsFor === undefined && x.record?.pointsAgainst === undefined && x.waiverRank === undefined));
  assert.deepEqual(r.rows[2], { teamId: "8", name: "Sack Masters" }, "an unreadable record is left out, not 0-0");
  assert.deepEqual(r.diag.noRecord, ["Sack Masters"]);
  assert.equal(r.diag.rankFrom, "first unlabeled column");
  assert.deepEqual(r.diag.missing, ["points for", "points against", "waiver", "seed"]);
});

test("standings: another league's links, separate W / L / T columns, and a page without a table", () => {
  const sep = `<table><tr><th>Rank</th><th>Team</th><th>W</th><th>L</th><th>T</th><th>Points For</th><th>Waiver Priority</th></tr>
    <tr><td>3</td><td><a href="/f1/999/2">Other League</a></td><td>1</td><td>1</td><td>0</td><td>10</td><td>1</td></tr>
    <tr><td>2</td><td><a href="/f1/1405188/6">Mine</a></td><td>4</td><td>3</td><td>0</td><td>812.5</td><td>7</td></tr></table>`;
  const r = parseStandingsHtml(sep, "1405188");
  assert.deepEqual(r.rows, [{ teamId: "6", name: "Mine", record: { wins: 4, losses: 3, ties: 0, pointsFor: 812.5, rank: 2 }, waiverRank: 7 }]);
  const noT = parseStandingsHtml(sep.replace("<th>T</th>", "<th>Ties?</th>"), "1405188");
  assert.equal(noT.rows[0].record, undefined, "no ties column: no record rather than a guessed 0");
  const none = parseStandingsHtml("<html><body><a href='/f1/1405188/3'>My Team</a></body></html>", "1405188");
  assert.deepEqual(none.rows, []);
  assert.match(none.diag.note ?? "", /no standings table/);
  assert.equal(none.diag.missing.length, 7);
});

// ---------------------------------------------------------------- release (d): Yahoo projections

test("projections (week): the roster page's 'Proj' column, matched by header; no column → a diagnostics note", () => {
  const r = parseProjectionHtml(html("yahoo-web-roster.html"), "week");
  assert.equal(r.diag.column, "Proj");
  assert.equal(r.values.get("30123"), 21.3);
  assert.equal(r.values.get("34496"), 17.9);
  assert.equal(r.values.get("40002"), 0);
  assert.equal(r.values.has("team:buf"), false, "defenses carry no player id");
  const none = parseProjectionHtml(html("yahoo-web-players.html"), "week");
  assert.equal(none.values.size, 0);
  assert.match(none.diag.note!, /no Proj column/);
  assert.ok(none.diag.headers.includes("Fan Pts"), JSON.stringify(none.diag.headers));
});

test("projections: markup inside an attribute (Yahoo's data-tooltip with <table>/<tr>) does not end the table or row early", () => {
  // Real Yahoo pages (2026-10-27) carry data-tooltip="<table>…" on some rows: half the league's rosters went unread.
  const page = html("yahoo-web-team-proj-remaining.html");
  const tip = ` data-tooltip="<table><tr><td>Note</td></tr></table>"`;
  let n = 0;
  const withTips = page.replace(/<a\b(?=[^>]*\/nfl\/players\/)/g, (m) => (n++ < 2 ? m + tip : m));
  assert.equal(n >= 2, true, "fixture has player links to decorate");
  const r = parseProjectionHtml(withTips, "ros");
  assert.deepEqual([...r.values], [...parseProjectionHtml(page, "ros").values]);
  assert.equal(stripMarkupAttrs(`<td class="a" data-tooltip='<tr>x</tr>' title="ok">`), `<td class="a" data-tooltip="" title="ok">`);
});

test("projections (rest of season): Remaining Games view selected → every Fan Pts table (offense, K, DEF); legend table skipped; bad cells skipped", () => {
  // RECONSTRUCTED fixture from the structure seen on Yahoo's real site 2026-10-26 (markup invented).
  const page = html("yahoo-web-team-proj-remaining.html");
  const r = parseProjectionHtml(page, "ros");
  assert.equal(r.diag.viewIndicator, "Remaining Games");
  assert.equal(r.diag.column, "Fan Pts");
  assert.equal(r.diag.tables, 3, "offense + kickers + defense tables; the legend table has no Fan Pts");
  assert.deepEqual([...r.values], [["30123", 235.91], ["34496", 158.2], ["31002", 98]], "'-' and an out-of-range 999.5 are skipped");
  assert.deepEqual([...r.defValues], [["BUF", 81.5]], "defenses (no player id) by team abbreviation");
  assert.equal(r.diag.note, undefined);
  assert.equal(r.diag.sample?.[4], "235.91", "diagnostics carry the first row read");
  // Same page, view not selected (only the Week item's Default-selected left): Fan Pts is not the ROS projection.
  const notSel = parseProjectionHtml(page.replace('class="Navitem  Selected"', 'class="Navitem"'), "ros");
  assert.equal(notSel.values.size, 0);
  assert.equal(notSel.defValues.size, 0);
  assert.equal(notSel.diag.viewIndicator, undefined);
  assert.match(notSel.diag.note!, /Remaining Games view not shown as selected/);
  assert.equal(notSel.diag.column, "Fan Pts", "the headers seen are still recorded");
  // The projected page's this-week view and a normal roster page are never rest-of-season.
  const week = parseProjectionHtml(html("yahoo-web-team-proj.html"), "ros");
  assert.equal(week.values.size, 0);
  assert.match(week.diag.note!, /no Fan Pts column/);
  const roster = parseProjectionHtml(html("yahoo-web-roster.html"), "ros");
  assert.equal(roster.values.size, 0);
  assert.ok(roster.diag.note);
});

test("rosViewIndicator: Remaining Games in an li with class token Selected (or itself selected); Default-selected and other items are not", () => {
  const nav = (cls: string, text = "Remaining Games") => `<ul><li class="Navitem Default-selected"><a href="?a=1">Week 7</a></li><li class="${cls}"><a href="?a=2">${text}</a></li></ul>`;
  assert.equal(rosViewIndicator(nav("Navitem  Selected")), "Remaining Games");
  assert.equal(rosViewIndicator(nav("Navitem selected")), "Remaining Games");
  assert.equal(rosViewIndicator(nav("Navitem")), undefined, "only the Week item is Default-selected");
  assert.equal(rosViewIndicator(nav("Navitem Default-selected")), undefined, "Default-selected is not the token Selected");
  assert.equal(rosViewIndicator(nav("Navitem Selected", "Season Total")), undefined, "another period selected");
  assert.equal(rosViewIndicator('<a aria-current="page" href="?a=2">Remaining Games</a>'), "Remaining Games");
  assert.equal(rosViewIndicator("<h2>Remaining Games</h2>"), undefined, "a heading alone is not a selected view");
});

test("navLink: exact anchor text, entities decoded, resolved against the page; flyout '#' and off-site / other-league links skipped", () => {
  const team = "https://football.fantasysports.yahoo.com/f1/1405188/3";
  const nav = html("yahoo-web-team-nav.html");
  assert.equal(navLink(nav, NAV_TEXT.projected, team), "https://football.fantasysports.yahoo.com/f1/1405188/3?zz1=P&zz2=W");
  assert.equal(navLink(nav, "Stats", team), "https://football.fantasysports.yahoo.com/f1/1405188/3?zz1=S&zz2=W", "'Stats' never matches 'Projected Stats'");
  assert.equal(navLink(nav, NAV_TEXT.remaining, team), undefined);
  const proj = html("yahoo-web-team-proj.html");
  assert.equal(navLink(proj, NAV_TEXT.remaining, navLink(nav, NAV_TEXT.projected, team)!), "https://football.fantasysports.yahoo.com/f1/1405188/3?zz1=P&zz2=RG");
  assert.equal(navLink('<a href="https://evil.example/f1/1405188/3?x">Projected Stats</a>', NAV_TEXT.projected, team), undefined, "off-site");
  assert.equal(navLink('<a href="/f1/999/3?x">Projected Stats</a>', NAV_TEXT.projected, team), undefined, "another league");
  assert.equal(navLink('<a href="javascript:void(0)">Projected Stats</a>', NAV_TEXT.projected, team), undefined);
  assert.equal(navLink("<a href='?x=1&amp;y=2'>Projected Stats</a>", NAV_TEXT.projected, team), "https://football.fantasysports.yahoo.com/f1/1405188/3?x=1&y=2");
});
