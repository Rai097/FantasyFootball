// Matchup parsers against REAL Yahoo markup (owner's league 2026-10-31, anonymized: teams "Team A–L").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cellNumber, matchupIds, parseMatchupModule, parseMatchupPage } from "./matchupsHtml";

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
  assert.deepEqual(burrow, { slot: "QB", yahooId: "32671", name: "Joe Burrow", pos: "QB", team: "CIN", yahooProj: 18.86, points: 28.88 });
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
  assert.deepEqual(a.rows[0], { slot: "QB", yahooId: "32671", name: "Joe Burrow", pos: "QB", team: "CIN", yahooProj: 21.84, points: null });
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
