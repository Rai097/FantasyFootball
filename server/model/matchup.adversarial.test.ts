// ADVERSARIAL tests for the pure matchups model (server/model/matchLog.ts merge + server/model/matchup.ts record).
// Known defects are `todo: "DEFECT …"` so the suite stays green; remove the todo when fixed. Synthetic teams only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanMatchups, mergeMatchCapture, type MatchLog, type MatchPairing, type MatchWeekCapture } from "./matchLog.js";
import { buildMatchup, trackRecord, type LineupSlot, type MatchupContext, type PlayerRef } from "./matchup.js";
import type { ProjEntry } from "./projLog.js";

const SUNDAY = Date.parse("2026-11-01T18:00:00Z");
const FIRST = "2026-10-30T00:15:00.000Z"; // the week's Thursday kickoff
const pair = (a: string, b: string, pa: number | null, pb: number | null, ya: number | null = null, yb: number | null = null): MatchPairing => ({
  mid1: a,
  mid2: b,
  sides: [
    { teamId: a, points: pa, yahooProj: ya },
    { teamId: b, points: pb, yahooProj: yb },
  ],
});
const finalLog = (pairings: MatchPairing[], lock: Record<string, number>): MatchLog => ({
  season: 2026,
  currentWeek: 9,
  weeks: {
    "8": {
      status: "final",
      fetchedAt: "2026-11-03T14:00:00.000Z",
      pairings,
      yahooLock: Object.fromEntries(Object.entries(lock).map(([t, proj]) => [t, { proj, at: "2026-10-29T19:00:00.000Z", pregame: true }])),
      pages: {},
    },
  },
});
/** Projlog starters of week 8: `n` per team at `app` points each (Sunday games, captured Saturday). */
function projlog(teams: Record<string, { n: number; app: number }>): Record<string, ProjEntry> {
  const out: Record<string, ProjEntry> = {};
  for (const [teamId, { n, app }] of Object.entries(teams))
    for (let i = 0; i < n; i++) {
      const id = `p${teamId}-${i}`;
      out[id] = { id, name: id, pos: "WR", team: "CIN", teamId, starter: true, app, capturedAt: "2026-10-31T19:00:00.000Z" };
    }
  return out;
}
const NINE: LineupSlot["kind"][] = ["QB", "WR", "WR", "RB", "TE", "FLEX", "FLEX", "K", "DEF"];
/** The latest import's lineups (week 9 by now): 9 starting slots per team. */
const lineups = (ids: string[]) => new Map(ids.map((t) => [t, NINE.map((kind, i) => ({ kind, player: { id: `now${t}-${i}`, name: "x", pos: "WR", nflTeam: "CIN" } as PlayerRef }))]));
function ctx(log: MatchLog, proj: Record<string, ProjEntry>, over: Partial<MatchupContext> = {}): MatchupContext {
  return {
    week: 8,
    currentWeek: 9,
    now: Date.parse("2026-11-03T15:00:00Z"),
    log,
    proj,
    teams: ["1", "2", "3", "4"].map((id) => ({ id, name: `Team ${id}` })),
    myTeamId: "1",
    lineups: lineups(["1", "2", "3", "4"]),
    lineupWeek: 9,
    resolveRow: () => undefined,
    today: () => undefined,
    gameOf: () => ({ kickoff: SUNDAY }),
    firstKickoff: Date.parse(FIRST),
    ...over,
  };
}

test(
  "record: a team whose projlog holds only some of its starters (log source) is incomplete, never a complete partial sum",
  { todo: "DEFECT lineupOf 'log' source sums whatever starters the projlog captured and reports oursIncomplete 0: on the owner's real projlog (week 8: 4–7 starters per team captured, Thursday players and K/DEF missing) every other team's final-week total is a partial sum counted in winner calls, MAE and bias (dry run: team totals 64–81 vs Yahoo 99–132, 12 team-weeks scored). Fix: compare the captured starter count with the league's starting slots and mark the rest unprojected" },
  () => {
    const log = finalLog([pair("1", "2", 120, 110), pair("3", "4", 100, 130)], { "1": 115, "2": 112, "3": 105, "4": 118 });
    const p = projlog({ "1": { n: 9, app: 13 }, "2": { n: 9, app: 12 }, "3": { n: 5, app: 14 }, "4": { n: 9, app: 13 } });
    const c = (w: number) => (w === 8 ? ctx(log, p) : undefined);
    const r = buildMatchup(c(8)!, c);
    const other = r.others[0].sides.find((s) => s.teamId === "3")!;
    assert.equal(other.ours, null, `team 3: 5 of 9 starters captured → ${other.ours}`);
    assert.ok(other.oursIncomplete >= 4);
    const rec = trackRecord(c, log, "1");
    assert.equal(rec.summary.teamWeeks, 3, "only the three complete team-weeks are scored");
    assert.equal(rec.summary.games, 1, "only game 1–2 has complete projections on both sides");
  },
);

test("record: MAE / bias use the SAME team-weeks for ours and Yahoo's (a team without Yahoo's lock is out of both)", () => {
  const log = finalLog([pair("1", "2", 120, 110)], { "1": 115 }); // team 2: no Yahoo lock
  const p = projlog({ "1": { n: 9, app: 12 }, "2": { n: 9, app: 12 } });
  const c = (w: number) => (w === 8 ? ctx(log, p) : undefined);
  const rec = trackRecord(c, log, "1");
  assert.equal(rec.summary.teamWeeks, 1);
  assert.equal(rec.summary.games, 0, "a game counts only with both sources complete");
  assert.deepEqual([rec.summary.oursMae, rec.summary.yahooMae, rec.summary.oursBias, rec.summary.yahooBias], [12, 5, 12, 5]);
  assert.equal(rec.weeks[0].games[0].yahooCall, null);
});

test(
  "record: a tied final is no call (null), not a miss",
  { todo: "DEFECT (minor) call() returns false for a tied final score, so the week row shows ✗ for both sources although the game is excluded from the counts; a tie should be no call (null)" },
  () => {
    const log = finalLog([pair("1", "2", 110, 110)], { "1": 115, "2": 100 });
    const p = projlog({ "1": { n: 9, app: 13 }, "2": { n: 9, app: 12 } });
    const c = (w: number) => (w === 8 ? ctx(log, p) : undefined);
    const rec = trackRecord(c, log, "1");
    assert.equal(rec.summary.games, 0);
    assert.deepEqual([rec.weeks[0].games[0].oursCall, rec.weeks[0].games[0].yahooCall], [null, null]);
  },
);

test("record: a tie projection is no call; incomplete ours (unprojected starter) never counts as 0", () => {
  const log = finalLog([pair("1", "2", 120, 110), pair("3", "4", 100, 90)], { "1": 110, "2": 110, "3": 100, "4": 90 });
  const p = projlog({ "1": { n: 9, app: 12 }, "2": { n: 9, app: 12 }, "3": { n: 9, app: 10 }, "4": { n: 9, app: 10 } });
  const c = (w: number) => (w === 8 ? ctx(log, p) : undefined);
  const rec = trackRecord(c, log, "1");
  const [g1, g2] = rec.weeks[0].games;
  assert.deepEqual([g1.oursCall, g1.yahooCall], [null, null], "both projected 108 / 110 even");
  assert.equal(g2.oursCall, null, "ours 90 – 90: tie projection");
  assert.equal(g2.yahooCall, true);
  assert.equal(rec.summary.games, 2);
  assert.equal(rec.summary.oursCalls, 0);
});

// ------------------------------------------------------------------ matchLog merge
const cap = (week: number, status: MatchWeekCapture["status"], pairings: MatchPairing[]): MatchWeekCapture => ({ week, status, pairings, pages: [] });
const first = (w: number) => (w === 8 ? FIRST : w === 9 ? "2026-11-06T01:15:00.000Z" : undefined);

test("lock: pre-game Yahoo total locked; later live and final captures never move it; stat corrections update points; older capture ignored", () => {
  let log = mergeMatchCapture(null, { season: 2026, capturedAt: "2026-10-29T19:00:00.000Z", matchupWeek: 8, weeks: [cap(8, "pre", [pair("1", "2", 0, 0, 120, 110)])], firstKickoff: first }).log;
  log = mergeMatchCapture(log, { season: 2026, capturedAt: "2026-11-01T22:00:00.000Z", matchupWeek: 8, weeks: [cap(8, "live", [pair("1", "2", 50, 60, 140, 100)])], firstKickoff: first }).log;
  log = mergeMatchCapture(log, { season: 2026, capturedAt: "2026-11-04T14:00:00.000Z", matchupWeek: 9, weeks: [cap(8, "final", [pair("1", "2", 131.5, 99.2, 131.5, 99.2)])], firstKickoff: first }).log;
  const w = log.weeks["8"];
  assert.deepEqual([w.yahooLock["1"].proj, w.yahooLock["1"].pregame, w.yahooLock["2"].proj], [120, true, 110]);
  // Stat correction Thursday: points change.
  log = mergeMatchCapture(log, { season: 2026, capturedAt: "2026-11-05T14:00:00.000Z", matchupWeek: 9, weeks: [cap(8, "final", [pair("1", "2", 133.1, 99.2, 133.1, 99.2)])], firstKickoff: first }).log;
  assert.equal(log.weeks["8"].pairings[0].sides[0].points, 133.1);
  // A late-arriving older capture never replaces it.
  const old = mergeMatchCapture(log, { season: 2026, capturedAt: "2026-11-02T14:00:00.000Z", matchupWeek: 8, weeks: [cap(8, "live", [pair("1", "2", 1, 1, 1, 1)])], firstKickoff: first });
  assert.equal(old.written, 0);
  assert.equal(old.log.weeks["8"].pairings[0].sides[0].points, 133.1);
  assert.equal(old.log.currentWeek, 9, "an older capture does not move the current week back");
  // Unknown first kickoff: nothing counts as pre-game.
  const unk = mergeMatchCapture(null, { season: 2026, capturedAt: "2026-10-01T00:00:00.000Z", matchupWeek: 5, weeks: [cap(5, "pre", [pair("1", "2", 0, 0, 120, 110)])], firstKickoff: () => undefined }).log;
  assert.deepEqual(unk.weeks["5"].yahooLock, {});
  // New season replaces the log.
  const next = mergeMatchCapture(log, { season: 2027, capturedAt: "2027-09-10T00:00:00.000Z", matchupWeek: 1, weeks: [cap(1, "pre", [pair("1", "2", 0, 0, 1, 1)])], firstKickoff: () => undefined }).log;
  assert.deepEqual(Object.keys(next.weeks), ["1"]);
});

test(
  "merge: a capture with no usable data for a stored FINAL week keeps it final",
  { todo: "DEFECT mergeMatchCapture replaces status (and fetchedAt) unconditionally: a later 'unknown'/'live' capture with 0 pairings and 0 pages turns a final week into 'unknown' and trackRecord drops it; W−1 is never re-fetched after the next rollover, so the loss is permanent" },
  () => {
    let log = mergeMatchCapture(null, { season: 2026, capturedAt: "2026-11-04T14:00:00.000Z", matchupWeek: 9, weeks: [cap(8, "final", [pair("1", "2", 131.5, 99.2, 120, 110)])], firstKickoff: first }).log;
    log = mergeMatchCapture(log, { season: 2026, capturedAt: "2026-11-04T20:00:00.000Z", matchupWeek: 9, weeks: [cap(8, "unknown", [])], firstKickoff: first }).log;
    assert.equal(log.weeks["8"].status, "final");
  },
);

test(
  "merge: Yahoo's current matchup week is recorded even when no week's module was read",
  { todo: "DEFECT (minor) recordMatchLog writes only when written > 0: a capture with matchupWeek but no usable weeks (both modules failed) never stores currentWeek, so after a rollover the Matchup tab keeps opening on the old week" },
  () => {
    const log = mergeMatchCapture(null, { season: 2026, capturedAt: "2026-11-04T14:00:00.000Z", matchupWeek: 9, weeks: [cap(8, "final", [pair("1", "2", 1, 2)])], firstKickoff: first }).log;
    const r = mergeMatchCapture(log, { season: 2026, capturedAt: "2026-11-11T14:00:00.000Z", matchupWeek: 10, weeks: [], firstKickoff: first });
    assert.equal(r.log.currentWeek, 10);
    assert.ok(r.written > 0, "the new current week must reach the file");
  },
);

test("cleanMatchups never throws on fuzzed shapes and never yields a number outside its bounds", () => {
  const atoms: unknown[] = [null, undefined, 0, -1, 1e308, NaN, "", "8", "x".repeat(10_000), [], {}, true, [[[]]], { week: 8 }];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const gen = (d: number): unknown => {
    if (d <= 0 || rnd() < 0.3) return pick(atoms);
    if (rnd() < 0.5) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(d - 1));
    const keys = ["week", "status", "pairings", "pages", "sides", "teamId", "mid1", "mid2", "points", "yahooProj", "rows", "slot", "totalProj", "totalPts", "weeks"];
    return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 5) }, () => [pick(keys), gen(d - 1)]));
  };
  for (let i = 0; i < 3000; i++) {
    const body = { matchupWeek: pick([8, 9, 0, "8", undefined]), matchups: rnd() < 0.5 ? { weeks: gen(4) } : gen(5) };
    const c = cleanMatchups(body);
    for (const w of c.weeks) {
      assert.ok(w.week === c.matchupWeek || w.week === c.matchupWeek! - 1);
      for (const p of w.pairings) for (const s of p.sides) for (const v of [s.points, s.yahooProj]) assert.ok(v === null || (Number.isFinite(v) && v >= -50 && v <= 400));
    }
  }
});
