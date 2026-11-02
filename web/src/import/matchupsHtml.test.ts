// Matchup parsers against REAL Yahoo markup (owner's league 2026-10-31, anonymized: teams "Team A–L").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cellNumber, gameOf, matchupIds, parseMatchupModule, parseMatchupPage } from "./matchupsHtml";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../server/providers/fixtures/matchups");
const fx = (n: string) => readFileSync(path.join(dir, n), "utf8");
const LEAGUE = "1405188";

test("cellNumber: strict numbers only; '–', empty, 'Bye' and text are null, Yahoo's 0.00 stays 0", () => {
  assert.equal(cellNumber("<div >18.86</div>"), 18.86);
  assert.equal(cellNumber('<div ><a href="#pps-1">28.88</a></div>'), 28.88);
  assert.equal(cellNumber("<div >0.00</div>"), 0);
  assert.equal(cellNumber("<div >-2.00</div>"), -2);
  for (const c of ["<div >&#8211;</div>", "<div >&ndash;</div>", "<div ></div>", "<div >Bye</div>", "<div >4 Pass TD</div>", undefined]) assert.equal(cellNumber(c), null, String(c));
});

test("matchupIds: plain and &amp;-encoded matchup links", () => {
  assert.deepEqual(matchupIds("/f1/1/matchup?week=7&mid1=4&mid2=3"), { week: 7, mid1: "4", mid2: "3" });
  assert.deepEqual(matchupIds("/f1/1/matchup?week=12&amp;mid1=10&amp;mid2=11"), { week: 12, mid1: "10", mid2: "11" });
  assert.equal(matchupIds("/f1/1/matchup?week=7&mid1=4"), undefined);
});

test("module week 7 (final): selected week, status, six pairings with team ids from the team links, points and Yahoo's projection", () => {
  const m = parseMatchupModule(fx("league-home-module-w7-final.html"), LEAGUE);
  assert.equal(m.week, 7);
  assert.equal(m.headerWeek, 7);
  assert.equal(m.status, "final");
  assert.equal(m.statusText, "Final results");
  assert.equal(m.pairings.length, 6);
  assert.equal(m.diag.skipped, 0);
  const own = m.pairings[0];
  assert.deepEqual([own.mid1, own.mid2], ["4", "3"]);
  assert.deepEqual(own.sides, [
    { teamId: "4", name: "Team A", record: "6-1-0", points: 165.78, yahooProj: 123.86 },
    { teamId: "3", name: "Team D", record: "5-2-0", points: 129.62, yahooProj: 134.97 },
  ]);
  // Every team appears once; left side = mid1 in every pairing.
  const ids = m.pairings.flatMap((p) => p.sides.map((s) => s.teamId)).sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(ids, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  for (const p of m.pairings) assert.deepEqual([p.sides[0].teamId, p.sides[1].teamId], [p.mid1, p.mid2]);
});

test("module week 8 (in progress): live points (Yahoo's 0.00 kept) and projections", () => {
  const m = parseMatchupModule(fx("league-home-module-w8-live.html"), LEAGUE);
  assert.equal(m.week, 8);
  assert.equal(m.status, "live");
  assert.equal(m.pairings.length, 6);
  assert.deepEqual(m.pairings[0].sides.map((s) => [s.teamId, s.points, s.yahooProj]), [["4", 0, 131.79], ["7", 0, 121.13]]);
  assert.deepEqual(m.pairings[1].sides.map((s) => [s.teamId, s.points, s.yahooProj]), [["1", 52.3, 134.44], ["3", 0, 127.11]]);
});

test("module: a page without the Matchups module is found=false with a short sample, nothing invented", () => {
  const m = parseMatchupModule("<html><body><h1>Sign in</h1></body></html>", LEAGUE);
  assert.equal(m.diag.found, false);
  assert.equal(m.week, undefined);
  assert.deepEqual(m.pairings, []);
  assert.ok((m.diag.sample ?? "").length <= 200);
});

test("matchup page week 7 (final): left = mid1, totals, starters by slot (K and DEF included), bench and IR rows", () => {
  const p = parseMatchupPage(fx("matchup-w7-final.html"), { mid1: "4", mid2: "3" });
  assert.ok(p.sides, JSON.stringify(p.diag));
  const [a, b] = p.sides!;
  assert.equal(a.teamId, "4");
  assert.deepEqual([a.totalProj, a.totalPts, b.totalPts, b.totalProj], [123.86, 165.78, 129.62, 134.97]);
  const burrow = a.rows[0];
  assert.deepEqual(burrow, { slot: "QB", yahooId: "32671", name: "Joe Burrow", pos: "QB", team: "CIN", yahooProj: 18.86, points: 28.88, game: "final" });
  assert.deepEqual(a.rows.map((r) => r.slot), ["QB", "RB", "WR", "WR", "TE", "W/R/T", "W/R/T", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR", "IR"]);
  const def = a.rows.find((r) => r.slot === "DEF")!;
  assert.deepEqual([def.name, def.pos, def.team, def.yahooProj, def.points], ["Browns", "DEF", "CLE", 7.35, 5]);
  assert.ok(def.yahooId, "a defense carries Yahoo's id too (the server resolves it by team)");
  // Starters sum to the Total row (Yahoo's own numbers).
  const starters = a.rows.filter((r) => r.slot !== "BN" && r.slot !== "IR");
  assert.equal(Math.round(starters.reduce((s, r) => s + (r.points ?? 0), 0) * 100) / 100, 165.78);
  // Bench: a bye player's points are "–" = null, his projection Yahoo's 0.00.
  const shakir = b.rows.find((r) => r.name === "Khalil Shakir")!;
  assert.deepEqual([shakir.slot, shakir.points, shakir.yahooProj], ["BN", null, 0]);
  const daniels = a.rows.find((r) => r.name === "Jayden Daniels")!;
  assert.deepEqual([daniels.slot, daniels.points, daniels.yahooProj], ["BN", null, 0]);
  // An "(Empty)" slot: no player, never a made-up name.
  const empty = b.rows.filter((r) => r.slot === "IR").find((r) => !r.name)!;
  assert.ok(empty && empty.yahooId === undefined);
  assert.equal(a.rows.length, b.rows.length);
});

test("matchup page week 8 (pre-game, weather tables nested in player cells): '–' points are null, never 0; injury chips", () => {
  const p = parseMatchupPage(fx("matchup-w8-live.html"), { mid1: "4", mid2: "7" });
  assert.ok(p.sides, JSON.stringify(p.diag));
  const [a, b] = p.sides!;
  assert.deepEqual([a.totalProj, a.totalPts, b.totalPts, b.totalProj], [131.79, 0, 0, 121.13]);
  assert.deepEqual(a.rows[0], { slot: "QB", yahooId: "32671", name: "Joe Burrow", pos: "QB", team: "CIN", yahooProj: 21.84, points: null, game: "pre" });
  assert.equal(a.rows.filter((r) => r.slot !== "BN" && r.slot !== "IR").length, 9);
  assert.ok(a.rows.filter((r) => r.slot !== "BN" && r.slot !== "IR").every((r) => r.points === null));
  assert.equal(b.rows.find((r) => r.name === "Dalton Kincaid")!.status, "Q");
  assert.equal(b.rows.find((r) => r.name === "Carnell Tate")!.status, "O");
  // Bench rows are in the same HTML. The fixture is cut inside its 6th bench row (no </tr>): that half row is dropped,
  // never half-read.
  assert.deepEqual(a.rows.filter((r) => r.slot === "BN").map((r) => r.name), ["Colston Loveland", "T.J. Hockenson", "Germie Bernard", "Jayden Daniels", "Jaylen Waddle"]);
  assert.equal(a.rows.length, b.rows.length);
});

test("matchup page: no stat table → sides undefined with a note", () => {
  const p = parseMatchupPage("<html><body>nothing</body></html>", { mid1: "1", mid2: "2" });
  assert.equal(p.sides, undefined);
  assert.match(p.diag.note ?? "", /statTable/);
});

// The page header's score table as Yahoo serves it (markup verified on the owner's league 2026-11-02; numbers only).
const header = (orig: [number, number], live: [number, number]) =>
  `<table class='M-a'><tr><td class='Fz-xxl Ta-end Pend-lg'>139.88</td><th class='Fz-xxs Ta-c Px-sm Nowrap' scope='row'><div class="Ta-c"><div class="D-ib">vs</div></div></th><td class='Fz-xxl Ta-start Pstart-lg'>112.86</td></tr>` +
  `<tr> <td class='F-shade Ta-end Pend-lg Fz-med Ptop-med'>${orig[0]}</td> <th class='F-shade Ta-c Fz-xxs Px-sm Ptop-med Nowrap' scope='row'>Orig Proj</th> <td class='F-shade Ta-start Pstart-lg Fz-med Ptop-med'>${orig[1]}</td> </tr>` +
  `<tr> <td class='F-shade Ta-end Fz-xs Italic F-positive Pend-lg Pbot-xxl'>${live[0]}</td> <th class='F-shade Ta-c Fz-xxs Px-sm Nowrap Pbot-xxl' scope='row'>Live Proj</th> <td class='F-shade Ta-start Fz-xs Italic F-negative Pstart-lg Pbot-xxl'>${live[1]}</td> </tr></table>`;

test("matchup page: Yahoo's Live Proj from the header, only when its Orig Proj matches the starters' Total row (proves side order)", () => {
  const ids = { mid1: "4", mid2: "7" };
  const ok = parseMatchupPage(header([131.79, 121.13], [165.54, 120.04]) + fx("matchup-w8-live.html"), ids);
  assert.deepEqual(ok.sides!.map((s) => [s.totalProj, s.liveProj]), [[131.79, 165.54], [121.13, 120.04]]);
  const swapped = parseMatchupPage(header([121.13, 131.79], [120.04, 165.54]) + fx("matchup-w8-live.html"), ids);
  assert.deepEqual(swapped.sides!.map((s) => s.liveProj), [undefined, undefined], "header disagrees with the tables: not used");
  assert.match(swapped.diag.note ?? "", /Live Proj not used/);
  const none = parseMatchupPage(fx("matchup-w8-live.html"), ids);
  assert.deepEqual(none.sides!.map((s) => "liveProj" in s), [false, false], "no header: absent, never 0");
});

test("gameOf: real cell texts (2026-11-02) → final / pre / in progress; nothing readable → absent", () => {
  const cell = (t: string) => `<div><a class="name">Joe Burrow</a><span class="Fz-xxs">Cin - QB</span><span>${t}</span></div>`;
  assert.equal(gameOf(cell("Final W 43-36 vs Ten"), 42.48), "final");
  assert.equal(gameOf(cell("Final L 24-28 @ Den"), 18.3), "final");
  assert.equal(gameOf(cell("Mon 8:15 pm vs Chi"), null), "pre");
  assert.equal(gameOf(cell("Q3 5:12 W 14-10 vs Chi"), 6.2), "live", "a score with points, no Final, no kickoff time");
  assert.equal(gameOf(cell("Bye"), null), undefined);
  assert.equal(gameOf("<div>(Empty)</div>", null), undefined);
});

test("matchup page week 8 (pre-game fixture): every starter with a kickoff time reads as not started", () => {
  const [a] = parseMatchupPage(fx("matchup-w8-live.html"), { mid1: "4", mid2: "7" }).sides!;
  const starters = a.rows.filter((r) => r.slot !== "BN" && r.slot !== "IR" && r.name);
  assert.ok(starters.length > 0 && starters.every((r) => r.game === "pre"), JSON.stringify(starters.map((r) => [r.name, r.game])));
});
