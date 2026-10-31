import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanMatchups, MATCHUP_WEEK_SKEW, mergeMatchCapture, trustedMatchupWeek, type MatchLog, type MatchPage, type MatchPairing, type MatchWeekCapture } from "./matchLog.js";

test("trustedMatchupWeek: Yahoo's week only within one week of the calendar's", () => {
  assert.deepEqual([7, 8, 9, 6, 10, 4, undefined].map((w) => trustedMatchupWeek(w, 8)), [7, 8, 9, undefined, undefined, undefined, undefined]);
  assert.equal(MATCHUP_WEEK_SKEW, 1);
});

test("merge (fix round 1): status only moves forward; null points and point-less pages never erase stored numbers; nothing usable = untouched", () => {
  const ko = () => "2026-10-30T00:15:00.000Z";
  const pr = (a: number | null, b: number | null): MatchPairing => ({ mid1: "4", mid2: "3", sides: [{ teamId: "4", points: a, yahooProj: null }, { teamId: "3", points: b, yahooProj: null }] });
  const pg = (pa: number | null, pb: number | null): MatchPage => ({ mid1: "4", mid2: "3", sides: [{ teamId: "4", totalProj: 123.86, totalPts: pa, rows: [] }, { teamId: "3", totalProj: 134.97, totalPts: pb, rows: [] }] });
  let log = mergeMatchCapture(null, { season: 2026, capturedAt: "2026-11-03T14:00:00.000Z", matchupWeek: 9, weeks: [{ week: 8, status: "final", pairings: [pr(165.78, 129.62)], pages: [pg(165.78, 129.62)] }], firstKickoff: ko }).log;
  // A later "live" reading with one score missing and a page without points.
  const r = mergeMatchCapture(log, { season: 2026, capturedAt: "2026-11-03T20:00:00.000Z", matchupWeek: 9, weeks: [{ week: 8, status: "live", pairings: [pr(null, 130.1)], pages: [pg(null, null)] }], firstKickoff: ko });
  assert.equal(r.written, 1);
  log = r.log;
  const w = log.weeks["8"];
  assert.equal(w.status, "final", "never back from final");
  assert.deepEqual(w.pairings[0].sides.map((sd) => sd.points), [165.78, 130.1], "null keeps 165.78; a real reading corrects 129.62 → 130.1");
  assert.deepEqual(w.pages["4-3"].sides.map((sd) => sd.totalPts), [165.78, 129.62], "the point-less page is not stored over the final one");
  const none = mergeMatchCapture(log, { season: 2026, capturedAt: "2026-11-04T20:00:00.000Z", matchupWeek: 9, weeks: [{ week: 8, status: "unknown", pairings: [], pages: [] }], firstKickoff: ko });
  assert.equal(none.written, 0, "same current week, nothing usable: nothing to write");
  assert.deepEqual(none.log.weeks["8"], w);
});

const side = (teamId: string, points: number | null, yahooProj: number | null) => ({ teamId, points, yahooProj });
const row = (over: Record<string, unknown> = {}) => ({ slot: "QB", yahooId: "32671", name: "Joe Burrow", pos: "QB", team: "CIN", yahooProj: 18.86, points: 28.88, ...over });
const page = (mid1: string, mid2: string, projA: number | null, projB: number | null) => ({
  mid1,
  mid2,
  sides: [
    { teamId: mid1, totalProj: projA, totalPts: 0, rows: [row()] },
    { teamId: mid2, totalProj: projB, totalPts: 0, rows: [row({ name: "Jared Goff", yahooId: "29235", team: "DET", points: null })] },
  ],
});
const payload = (over: Record<string, unknown> = {}) => ({
  matchupWeek: 8,
  matchups: {
    weeks: [
      { week: 8, status: "live", statusText: "In progress", pairings: [{ mid1: "4", mid2: "7", sides: [side("4", 0, 131.79), side("7", 0, 121.13)] }], pages: [page("4", "7", 131.79, 121.13)] },
      { week: 7, status: "final", pairings: [{ mid1: "4", mid2: "3", sides: [side("4", 165.78, 123.86), side("3", 129.62, 134.97)] }], pages: [] },
    ],
  },
  ...over,
});

test("cleanMatchups: a good payload passes through; nothing dropped", () => {
  const c = cleanMatchups(payload());
  assert.equal(c.matchupWeek, 8);
  assert.deepEqual(c.dropped, []);
  assert.deepEqual(c.weeks.map((w) => [w.week, w.status, w.pairings.length, w.pages.length]), [[8, "live", 1, 1], [7, "final", 1, 0]]);
  assert.equal(c.weeks[0].pages[0].sides[1].rows[0].points, null, "null stays null");
});

test("cleanMatchups: bad shapes are dropped with a note, never thrown, never coerced to 0", () => {
  for (const bad of [{ matchups: "x" }, { matchups: { weeks: 3 } }, { matchups: null }]) {
    const c = cleanMatchups(payload(bad));
    assert.deepEqual(c.weeks, []);
    assert.ok(c.dropped.length > 0, JSON.stringify(bad));
  }
  assert.deepEqual(cleanMatchups({}), { weeks: [], dropped: [] }, "an older bookmark: nothing, no note");
  assert.equal(cleanMatchups(null).weeks.length, 0);
  let c = cleanMatchups(payload({ matchupWeek: 99 }));
  assert.equal(c.matchupWeek, undefined);
  assert.deepEqual(c.weeks, [], "no usable week source → no weeks");
  // Weeks other than W and W−1 dropped; a side whose team disagrees with mid1/mid2 dropped; a string number dropped.
  const p = payload();
  (p.matchups.weeks as any[]).push({ week: 3, status: "final", pairings: [], pages: [] });
  (p.matchups.weeks[0] as any).pairings.push({ mid1: "1", mid2: "2", sides: [side("2", 1, 1), side("1", 1, 1)] });
  (p.matchups.weeks[1] as any).pairings.push({ mid1: "5", mid2: "6", sides: [side("5", "12" as never, 1), side("6", 1, 1)] });
  (p.matchups.weeks[0] as any).pages.push({ ...page("1", "2", 1, 1), sides: [{ teamId: "1", totalProj: 1, totalPts: 1, rows: [row({ points: 1e9 })] }, page("1", "2", 1, 1).sides[1]] });
  c = cleanMatchups(p);
  assert.deepEqual(c.weeks.map((w) => [w.week, w.pairings.length, w.pages.length]), [[8, 1, 1], [7, 1, 0]]);
  assert.equal(c.dropped.length, 4, c.dropped.join("\n"));
  // Strings are bounded; unknown status → "unknown"; bad row fields are left out, not invented.
  c = cleanMatchups({ matchupWeek: 8, matchups: { weeks: [{ week: 8, status: "weird", pairings: [], pages: [page("4", "7", null, null)] }] } });
  assert.equal(c.weeks[0].status, "unknown");
  assert.equal(c.weeks[0].pages[0].sides[0].totalProj, null);
  const r = cleanMatchups({ matchupWeek: 8, matchups: { weeks: [{ week: 8, pairings: [], pages: [{ ...page("4", "7", 1, 1), sides: [{ teamId: "4", totalProj: 1, totalPts: 1, rows: [{ slot: "QB", yahooId: "x1", pos: "LB", team: "<b>", name: "A".repeat(500), yahooProj: null, points: null }] }, page("4", "7", 1, 1).sides[1]] }] }] } }).weeks[0].pages[0].sides[0].rows[0];
  assert.deepEqual(Object.keys(r).sort(), ["name", "points", "slot", "yahooProj"]);
  assert.equal(r.name!.length, 80);
});

// Week 8 (2026): first kickoff Thursday Oct 29 20:15 ET.
const FIRST: Record<number, string> = { 7: "2026-10-23T00:15:00.000Z", 8: "2026-10-30T00:15:00.000Z", 9: "2026-11-06T01:15:00.000Z" };
const firstKickoff = (w: number) => FIRST[w];
const merge = (log: MatchLog | null, capturedAt: string, weeks: MatchWeekCapture[], matchupWeek = 8, season = 2026) => mergeMatchCapture(log, { season, capturedAt, matchupWeek, weeks, firstKickoff });
const wk8 = (proj4: number, proj7: number, pts4: number | null, status: MatchWeekCapture["status"] = "pre", pages = true): MatchWeekCapture => ({
  week: 8,
  status,
  pairings: [{ mid1: "4", mid2: "7", sides: [side("4", pts4, proj4), side("7", 0, proj7)] }],
  pages: pages ? [page("4", "7", proj4, proj7) as any] : [],
});

test("lock: Yahoo's total = the latest capture before the week's first kickoff; live captures after kickoff never move it; points always update", () => {
  let log = merge(null, "2026-10-27T12:00:00.000Z", [wk8(130, 120, null)]).log;
  log = merge(log, "2026-10-29T12:00:00.000Z", [wk8(131.79, 121.13, null)]).log;
  assert.deepEqual(log.weeks["8"].yahooLock["4"], { proj: 131.79, at: "2026-10-29T12:00:00.000Z", pregame: true });
  // Saturday, after Thursday's kickoff: live projection blends in points → never the locked value.
  log = merge(log, "2026-10-31T15:00:00.000Z", [wk8(140.5, 99, 52.3, "live")]).log;
  assert.equal(log.weeks["8"].yahooLock["4"].proj, 131.79);
  assert.equal(log.weeks["8"].yahooLock["7"].proj, 121.13);
  assert.equal(log.weeks["8"].pairings[0].sides[0].points, 52.3, "points update");
  assert.equal(log.weeks["8"].status, "live");
  // Final: still the pre-game lock.
  log = merge(log, "2026-11-03T15:00:00.000Z", [wk8(150, 100, 160.1, "final")], 9).log;
  assert.equal(log.weeks["8"].yahooLock["4"].proj, 131.79);
  assert.equal(log.weeks["8"].status, "final");
  assert.equal(log.currentWeek, 9);
});

test("lock: a week first recorded late takes the FINAL page's / module's Proj (pregame false); a live one sets nothing", () => {
  let log = merge(null, "2026-10-31T15:00:00.000Z", [wk8(140.5, 99, 52.3, "live")]).log;
  assert.deepEqual(log.weeks["8"].yahooLock, {}, "live after kickoff: no lock");
  const w7: MatchWeekCapture = { week: 7, status: "final", pairings: [{ mid1: "4", mid2: "3", sides: [side("4", 165.78, 123.86), side("3", 129.62, 134.97)] }], pages: [] };
  log = merge(log, "2026-10-31T15:00:00.000Z", [w7]).log;
  assert.deepEqual(log.weeks["7"].yahooLock["4"], { proj: 123.86, at: "2026-10-31T15:00:00.000Z", pregame: false });
  // Unknown first kickoff: never pre-game (fail safe).
  const r = mergeMatchCapture(null, { season: 2026, capturedAt: "2026-01-01T00:00:00.000Z", weeks: [wk8(1, 2, null)], firstKickoff: () => undefined });
  assert.deepEqual(r.log.weeks["8"].yahooLock, {});
});

test("merge: pages replace by pairing, a page not re-fetched is kept; an older capture never replaces a newer one; a new season starts fresh", () => {
  let log = merge(null, "2026-10-29T12:00:00.000Z", [wk8(131.79, 121.13, null)]).log;
  log = merge(log, "2026-10-31T12:00:00.000Z", [wk8(131.79, 121.13, 10, "live", false)]).log;
  assert.ok(log.weeks["8"].pages["4-7"], "page kept although this capture did not read it");
  assert.equal(log.weeks["8"].pages["4-7"].fetchedAt, "2026-10-29T12:00:00.000Z");
  const r = merge(log, "2026-10-30T12:00:00.000Z", [wk8(1, 1, 1, "live")]);
  assert.equal(r.written, 0);
  assert.equal(r.log.weeks["8"].pairings[0].sides[0].points, 10);
  const fresh = merge(log, "2027-09-10T12:00:00.000Z", [wk8(1, 1, null)], 1, 2027).log;
  assert.equal(fresh.season, 2027);
  assert.deepEqual(Object.keys(fresh.weeks), ["8"]);
  assert.equal(fresh.weeks["8"].pages["4-7"].fetchedAt, "2027-09-10T12:00:00.000Z");
});
