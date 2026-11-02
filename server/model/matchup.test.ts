import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectMatchups } from "../../web/src/import/matchups.js";
import { cleanMatchups, mergeMatchCapture, type MatchLog, type MatchRow } from "./matchLog.js";
import { buildMatchup, liveTotal, MATCHUP, normCdf, starterProjection, teamTotal, trackRecord, winChance, type MatchupCell, type MatchupContext, type PlayerRef } from "./matchup.js";
import type { ProjEntry } from "./projLog.js";

test("win chance: Φ(margin / 35), a named calibration constant; even = 50%", () => {
  assert.equal(MATCHUP.marginSd, 35);
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normCdf(1) - 0.841345) < 1e-6);
  assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 1e-3);
  assert.equal(winChance(0), 0.5);
  assert.equal(winChance(35), 0.84);
  assert.equal(winChance(-35), 0.16);
  assert.equal(winChance(7.4), 0.58);
});

const KICK = { CIN: Date.parse("2026-11-01T17:00:00Z"), DET: Date.parse("2026-10-30T00:15:00Z") };
const ctx0 = (now: string, proj: Record<string, Partial<ProjEntry>> = {}, today: Record<string, number> = {}) => ({
  now: Date.parse(now),
  proj: proj as Record<string, ProjEntry>,
  today: (id: string) => today[id],
  gameOf: (t: string) => (t === "BYE" ? undefined : t in KICK ? { kickoff: KICK[t as keyof typeof KICK] } : {}),
  firstKickoff: KICK.DET,
});
const P = (id: string, nflTeam: string): PlayerRef => ({ id, name: id, pos: "WR", nflTeam });

test("starter projection: before kickoff today's number; after kickoff the LOCKED log value; none → null, never 0; bye = a real 0", () => {
  const c = ctx0("2026-10-31T12:00:00Z", { a: { app: 12.5 }, d: { app: 9 } }, { a: 14, b: 8, d: 3 });
  assert.deepEqual(starterProjection(c, P("a", "CIN")), { ours: 14, locked: false }, "Sunday game, Saturday: today's");
  assert.deepEqual(starterProjection(c, P("d", "DET")), { ours: 9, locked: true }, "Thursday game: locked, today's ignored");
  assert.deepEqual(starterProjection(c, P("b", "DET")), { ours: null, locked: true }, "started, never captured: unknown");
  assert.deepEqual(starterProjection(c, P("x", "BYE")), { ours: 0, locked: false });
  assert.deepEqual(starterProjection(c, P("u", "NYJ")), { ours: null, locked: true }, "own kickoff unknown: the week's first is the cut-off");
  assert.deepEqual(starterProjection(ctx0("2026-10-28T12:00:00Z", { a: { app: 12.5 } }), P("a", "CIN")), { ours: 12.5, locked: false }, "no projection today: the log's pre-kickoff value");
});

test("team total: Σ starters; one missing → incomplete (null + count), an empty slot counts as nothing", () => {
  const cell = (ours: number | null) => ({ ours }) as MatchupCell;
  assert.deepEqual(teamTotal([cell(10), cell(5.25), null]), { ours: 15.3, partial: 15.3, missing: 0 });
  assert.deepEqual(teamTotal([cell(10), cell(null), cell(null)]), { ours: null, partial: 10, missing: 2 }, "display-only partial sum + count");
  assert.deepEqual(teamTotal([cell(null), cell(null)]), { ours: null, partial: null, missing: 2 }, "nothing projected: no partial (never 0)");
  assert.deepEqual(teamTotal([cell(0), cell(0)]), { ours: 0, partial: 0, missing: 0 }, "real zeros (bye / out) are a total of 0");
});

// ------------------------------------------------------------------ fixture-built log (real Yahoo pages, weeks 8 / 7)
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../providers/fixtures/matchups");
let log: MatchLog;
const NOW = "2026-10-31T19:00:00.000Z"; // Saturday of week 8: Thursday's game (DET) played
before(async () => {
  const B = "https://y.test/f1/1405188";
  const pages: Record<string, string> = {
    [B]: "league-home-module-w8-live.html",
    [`${B}?matchup_week=7&module=matchups`]: "league-home-module-w7-final.html",
    [`${B}/matchup?week=8&mid1=4&mid2=7`]: "matchup-w8-live.html",
    [`${B}/matchup?week=7&mid1=4&mid2=3`]: "matchup-w7-final.html",
  };
  const r = await collectMatchups({ base: B, leagueId: "1405188", myTeamId: "4", getPage: async (u) => ({ ok: true, status: 200, html: fs.readFileSync(path.join(dir, pages[u]), "utf8") }) });
  const c = cleanMatchups({ matchupWeek: r.matchupWeek, matchups: r.matchups });
  assert.deepEqual(c.dropped, []);
  const first: Record<number, string> = { 7: "2026-10-23T00:15:00.000Z", 8: "2026-10-30T00:15:00.000Z" };
  log = mergeMatchCapture(null, { season: 2026, capturedAt: NOW, matchupWeek: c.matchupWeek, weeks: c.weeks, firstKickoff: (w) => first[w] }).log;
});

const ref = (r: MatchRow): PlayerRef | undefined => (r.yahooId ? { id: r.pos === "DEF" ? `DEF:${r.team}` : `y${r.yahooId}`, name: r.name ?? "", pos: r.pos ?? "", nflTeam: r.team ?? "" } : undefined);
const TEAMS = Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), name: `Team ${String.fromCharCode(65 + i)}` }));
/** Week-7 projlog: every starter of both owner-pairing teams at 15 pts (Yahoo's locked value 14), except `skip`. */
function proj7(skip: string[] = []): Record<string, ProjEntry> {
  const out: Record<string, ProjEntry> = {};
  for (const s of log.weeks["7"].pages["4-3"].sides)
    for (const r of s.rows) {
      const p = ref(r);
      if (!p || /^(BN|IR)$/.test(r.slot) || skip.includes(p.name)) continue;
      out[p.id] = { id: p.id, name: p.name, pos: p.pos as never, team: p.nflTeam, teamId: s.teamId, starter: true, app: 15, yahoo: 14, capturedAt: "2026-10-22T12:00:00.000Z" };
    }
  return out;
}
function ctxOf(week: number, over: Partial<MatchupContext> = {}): MatchupContext {
  return {
    week,
    currentWeek: 8,
    now: Date.parse(NOW),
    log,
    proj: week === 7 ? proj7() : {},
    teams: TEAMS,
    myTeamId: "4",
    lineups: new Map(),
    lineupWeek: 8,
    resolveRow: ref,
    today: () => 10,
    gameOf: () => ({ kickoff: Date.parse(week === 7 ? "2026-10-26T17:00:00Z" : "2026-11-01T17:00:00Z") }),
    firstKickoff: Date.parse(week === 7 ? "2026-10-23T00:15:00Z" : "2026-10-30T00:15:00Z"),
    starterCount: 9,
    ...over,
  };
}

test("week 7 (final, owner's page): ours = Σ locked starters, Yahoo's final-page total, Yahoo's points; rows by slot, bench apart", () => {
  const r = buildMatchup(ctxOf(7), (w) => ctxOf(w));
  assert.equal(r.status, "final");
  const [me, opp] = r.mine!.sides;
  assert.equal(r.mine!.lineupSource, "page");
  assert.deepEqual([me.teamId, me.ours, me.oursIncomplete, me.yahoo, me.points], ["4", 135, 0, 123.86, 165.78]);
  assert.deepEqual([opp.teamId, opp.yahoo, opp.points], ["3", 134.97, 129.62]);
  assert.equal(me.winPct, 0.5, "same projected totals → 50%");
  const qb = r.mine!.rows[0];
  assert.deepEqual([qb.slot, qb.a!.name, qb.a!.ours, qb.a!.yahoo, qb.a!.points, qb.a!.locked], ["QB", "Joe Burrow", 15, 18.86, 28.88, true]);
  assert.equal(r.mine!.rows.length, 9);
  assert.ok(r.mine!.bench.every((b) => /^(BN|IR)$/.test(b.slot)));
  assert.equal(r.others.length, 5);
  assert.ok(r.others.every((o) => o.sides.every((s) => s.ours === null)), "other teams: no projlog starters → not recorded, never 0");
});

test("a starter without a locked projection → incomplete, excluded from the record; never counted as 0", () => {
  const c = (w: number) => ctxOf(w, w === 7 ? { proj: proj7(["Joe Burrow"]) } : {});
  const r = buildMatchup(c(7), c);
  assert.deepEqual([r.mine!.sides[0].ours, r.mine!.sides[0].oursIncomplete, r.mine!.sides[0].winPct], [null, 1, null]);
  const g = r.record.weeks[0].games[0];
  assert.deepEqual(g.ours, [null, 135]);
  // Fix round 1: Yahoo's record number is Σ the same starters' locked values → Burrow missing for Yahoo too.
  assert.deepEqual([g.yahoo, g.oursMissing, g.yahooMissing, g.yahooPage], [[null, 126], [1, 0], [1, 0], [123.86, 134.97]]);
  assert.equal(g.oursCall, null);
  assert.equal(r.record.summary.games, 0);
  assert.equal(r.record.summary.teamWeeks, 1, "only the complete team-week counts");
});

test("record: winner calls and errors over the SAME team-weeks; owner's game first; weeks without ours = not recorded", () => {
  // Week 7 ours: owner 4 = 9 × 15 + a nudge so we call team 4; team 3 = 135.
  const p = proj7();
  p["y32671"].app = 25; // Burrow
  p["y32671"].yahoo = 5; // Yahoo's locked Burrow: Yahoo projects team 3 ahead
  const c = (w: number) => ctxOf(w, w === 7 ? { proj: p } : {});
  const rec = trackRecord(c, log, "4");
  assert.deepEqual(rec.weeks.map((w) => [w.week, w.recorded, w.games.length]), [[7, true, 6]]);
  const g = rec.weeks[0].games[0];
  assert.equal(g.mine, true);
  assert.deepEqual(g.teams, ["4", "3"]);
  // Fix round 1: Yahoo = Σ the same final starters' locked Yahoo values (8 × 14 + 5 = 117, 9 × 14 = 126); the page's
  // totals ride along as yahooPage (display only).
  assert.deepEqual([g.ours, g.yahoo, g.yahooPage, g.points], [[145, 135], [117, 126], [123.86, 134.97], [165.78, 129.62]]);
  assert.deepEqual([g.oursCall, g.yahooCall], [true, false], "ours called team 4, Yahoo called team 3; team 4 won");
  assert.deepEqual(rec.summary, { games: 1, oursCalls: 1, yahooCalls: 0, teamWeeks: 2, oursMae: r1((Math.abs(165.78 - 145) + Math.abs(129.62 - 135)) / 2), yahooMae: r1((Math.abs(165.78 - 117) + Math.abs(129.62 - 126)) / 2), oursBias: r1((165.78 - 145 + 129.62 - 135) / 2), yahooBias: r1((165.78 - 117 + 129.62 - 126) / 2) });
  // Other games of week 7: none of their starters was captured → incomplete for both sources (9 not projected each),
  // Yahoo's page totals shown apart; listed, not counted.
  assert.ok(rec.weeks[0].games.slice(1).every((x) => x.ours[0] === null && x.yahoo[0] === null && x.yahooPage[0] !== null && x.oursMissing[0] === 9 && x.yahooMissing[0] === 9 && x.oursCall === null && x.yahooCall === null));
});

test("record: a week never captured (no projection log) shows Yahoo's page totals and 'not recorded' ours, out of the metrics", () => {
  const c = (w: number) => ctxOf(w, { proj: {} });
  const rec = trackRecord(c, log, "4");
  const g = rec.weeks[0].games[0];
  assert.equal(rec.weeks[0].recorded, false);
  assert.deepEqual([g.ours, g.yahoo, g.yahooPage, g.oursMissing, g.yahooMissing, g.oursCall, g.yahooCall], [[null, null], [123.86, 134.97], [123.86, 134.97], [0, 0], [0, 0], null, false]);
  assert.deepEqual([rec.summary.games, rec.summary.teamWeeks], [0, 0]);
});

test("record: a final starter on bye counts a real 0 for both sources; an unmatched starter name is missing for both", () => {
  const p = proj7();
  const c = (w: number) => ctxOf(w, w === 7 ? { proj: p, gameOf: (t: string) => (t === "CIN" ? undefined : { kickoff: Date.parse("2026-10-26T17:00:00Z") }) } : {});
  const g = trackRecord(c, log, "4").weeks[0].games[0];
  assert.equal(g.oursMissing[0], 0);
  assert.ok(g.ours[0] !== null && g.ours[0] < 135, `Burrow (CIN, bye) counted 0: ${g.ours[0]}`);
  const unmatched = (w: number) => ctxOf(w, w === 7 ? { proj: p, resolveRow: (r: MatchRow) => (r.name === "Joe Burrow" ? undefined : ref(r)) } : {});
  const u = trackRecord(unmatched, log, "4").weeks[0].games[0];
  assert.deepEqual([u.ours[0], u.yahoo[0], u.oursMissing[0], u.yahooMissing[0]], [null, null, 1, 1]);
});
const r1 = (x: number) => Math.round(x * 10) / 10;

test("week 8 (live, Saturday): Thursday starters locked from the log, Sunday starters today's; Yahoo's live total apart from the (absent) pre-game lock", () => {
  // Every week-8 starter's game is Sunday except the Thursday one we pretend for Joe Burrow's team (CIN).
  const gameOf = (t: string) => ({ kickoff: Date.parse(t === "CIN" ? "2026-10-30T00:15:00Z" : "2026-11-01T17:00:00Z") });
  const r = buildMatchup(ctxOf(8, { gameOf, proj: { y32671: { app: 20.4 } as ProjEntry } }), (w) => ctxOf(w));
  const me = r.mine!.sides[0];
  assert.equal(r.status, "live");
  assert.equal(r.mine!.rows[0].a!.locked, true);
  assert.equal(r.mine!.rows[0].a!.ours, 20.4);
  assert.equal(r.mine!.rows[0].a!.points, null, "not played on the page: null");
  assert.equal(me.ours, r1(20.4 + 8 * 10));
  assert.equal(me.yahoo, null, "first captured after the week's first kickoff: no pre-game lock");
  assert.equal(me.yahooOrig, 131.79);
  assert.equal(me.points, 0);
  assert.ok(me.winPct! > 0.5);
  assert.deepEqual(r.weeks, [7, 8]);
  assert.equal(r.currentWeek, 8);
  assert.equal(r.asOf, NOW);
});

test("the request team is always side a; others carry both teams; no log → empty, nothing invented", () => {
  const r = buildMatchup(ctxOf(8, { myTeamId: "7" }), (w) => ctxOf(w, { myTeamId: "7" }));
  assert.equal(r.mine!.sides[0].teamId, "7");
  assert.equal(r.mine!.rows[0].a!.name, "Josh Allen");
  const empty = buildMatchup(ctxOf(8, { log: null }), () => undefined);
  assert.deepEqual([empty.mine, empty.others, empty.status, empty.asOf, empty.weeks], [null, [], "unknown", null, [8]]);
  assert.deepEqual(empty.record.summary, { games: 0, oursCalls: 0, yahooCalls: 0, teamWeeks: 0, oursMae: null, yahooMae: null, oursBias: null, yahooBias: null });
});

test("import lineup (current week, no page): starters from the latest import's Yahoo slots; an unmatched starter is incomplete", () => {
  const lineups = new Map([
    ["1", [
      { kind: "QB" as const, player: P("q1", "CIN") },
      { kind: "FLEX" as const, player: null, rawName: "Unknown Guy" },
      { kind: "BN" as const, player: P("b1", "CIN") },
    ]],
    ["3", [{ kind: "QB" as const, player: P("q3", "CIN"), yahoo: 17.5 }]],
  ]);
  const r = buildMatchup(ctxOf(8, { myTeamId: "1", lineups }), () => undefined);
  const m = r.mine!;
  assert.equal(m.lineupSource, "import");
  assert.deepEqual(m.rows.map((x) => [x.slot, x.a?.name ?? null, x.b?.name ?? null]), [["QB", "q1", "q3"], ["W/R/T", "Unknown Guy", null]]);
  assert.equal(m.rows[0].b!.yahoo, 17.5);
  assert.deepEqual([m.sides[0].ours, m.sides[0].oursIncomplete], [null, 1]);
  assert.deepEqual([m.sides[1].ours, m.sides[1].oursIncomplete], [10, 0]);
  assert.equal(m.bench[0].a!.name, "b1");
  // A lineup from another week is never used for this one.
  assert.equal(buildMatchup(ctxOf(8, { myTeamId: "1", lineups, lineupWeek: 7 }), () => undefined).mine!.sides[0].ours, null);
});

// ------------------------------------------------------------------ others = the same pairing view (owner 2026-11-01)
const lineupsAll = () =>
  new Map(
    TEAMS.map((t) => [
      t.id,
      [
        { kind: "QB" as const, player: P(`q${t.id}`, "CIN"), yahoo: 18 },
        { kind: "WR" as const, player: P(`w${t.id}`, t.id === "5" ? "DET" : "CIN"), yahoo: 12 },
        { kind: "BN" as const, player: P(`b${t.id}`, "CIN"), yahoo: 7 },
      ],
    ]),
  );
const gameOf8 = (t: string) => ({ kickoff: Date.parse(t === "DET" ? "2026-10-30T00:15:00Z" : "2026-11-01T17:00:00Z") });

test("others: the same rows / bench as mine (one pairingView), from the latest import; per-player points null; mine unchanged", () => {
  const base = buildMatchup(ctxOf(8), (w) => ctxOf(w));
  const r = buildMatchup(ctxOf(8, { lineups: lineupsAll(), gameOf: gameOf8 }), (w) => ctxOf(w));
  assert.deepEqual(r.mine, buildMatchup(ctxOf(8, { gameOf: gameOf8 }), (w) => ctxOf(w)).mine, "mine: the owner's page wins over the import's slots, unchanged");
  assert.equal(base.mine!.lineupSource, "page");
  assert.equal(r.others.length, 5);
  for (const o of r.others) {
    assert.equal(o.lineupSource, "import");
    assert.deepEqual(o.rows.map((x) => x.slot), ["QB", "WR"]);
    assert.deepEqual(o.bench.map((x) => x.slot), ["BN"]);
    assert.ok([...o.rows, ...o.bench].every((x) => x.a!.points === null && x.b!.points === null), "no per-player points for others");
    assert.equal(o.rows[0].a!.yahoo, 18);
    assert.equal(o.rows[0].a!.ours, 10);
    assert.equal(o.rows[0].a!.id, `q${o.sides[0].teamId}`, "side a = the pairing's first team");
    assert.equal(o.rows[0].b!.id, `q${o.sides[1].teamId}`);
  }
  // Full side views for others too (Yahoo's live total, win chance from complete totals).
  const full = r.others.find((o) => !o.sides.some((s) => s.teamId === "5"))!;
  assert.deepEqual(full.sides.map((s) => [s.ours, s.oursIncomplete, s.oursPartial]), [[20, 0, 20], [20, 0, 20]]);
  assert.equal(full.sides[0].winPct, 0.5);
  assert.ok(full.sides.every((s) => s.yahooLive !== null && s.yahooOrig === null), "a live week: the league page's number is Yahoo's Live Proj, never shown as its Orig Proj");
});

test("partial totals (display only): partial sum + count, win % null; the record stays strict", () => {
  // Team 5's WR plays Thursday (DET, started) with no locked projection → 1 not projected.
  const r = buildMatchup(ctxOf(8, { lineups: lineupsAll(), gameOf: gameOf8 }), (w) => ctxOf(w));
  const o = r.others.find((x) => x.sides.some((s) => s.teamId === "5"))!;
  const s5 = o.sides.find((s) => s.teamId === "5")!;
  assert.deepEqual([s5.ours, s5.oursIncomplete, s5.oursPartial, s5.winPct], [null, 1, 10, null]);
  assert.ok(o.sides.every((s) => s.winPct === null), "win % null when either side is incomplete");
  // The record is unchanged by the display-only partial: week 7 with a starter missing is still null + count.
  const c = (w: number) => ctxOf(w, w === 7 ? { proj: proj7(["Joe Burrow"]) } : {});
  const res = buildMatchup(c(7), c);
  assert.deepEqual([res.record.weeks[0].games[0].ours, res.record.weeks[0].games[0].oursMissing], [[null, 135], [1, 0]]);
  assert.equal(res.record.summary.teamWeeks, 1);
  // Mine on the same week: partial = 8 × 15 (the projected starters), ours stays null.
  const me = res.mine!.sides[0];
  assert.deepEqual([me.ours, me.oursIncomplete, me.oursPartial], [null, 1, 120]);
});

test("Yahoo: no pre-game lock (week first captured after Thursday) → yahoo null; my page's Orig Proj, the others' Live Proj from the league page", () => {
  const r = buildMatchup(ctxOf(8, { lineups: lineupsAll() }), (w) => ctxOf(w));
  for (const p of [r.mine!, ...r.others])
    for (const s of p.sides) {
      assert.equal(s.yahoo, null, `lock ${s.teamId}`);
      if (p === r.mine) assert.equal(typeof s.yahooOrig, "number", `orig ${s.teamId}: the matchup page's Total row`);
      else assert.deepEqual([s.yahooOrig, typeof s.yahooLive], [null, "number"], `live ${s.teamId}: the league page while in progress`);
    }
  // A final week: the league page shows Orig Proj (week 7 fixture: 123.86 against 165.78 points), never Live.
  const f = buildMatchup(ctxOf(7), (w) => ctxOf(w));
  assert.ok(f.others.length > 0);
  for (const p of f.others) for (const s of p.sides) assert.equal(s.yahooLive, null, `final ${s.teamId}`);
});

test("ours live: final = points, not started = ours, in progress = the higher; any unknown → null; no game states → null", () => {
  const c = (game: MatchupCell["game"], ours: number | null, points: number | null) => ({ ours, points, ...(game ? { game } : {}) }) as MatchupCell;
  assert.equal(liveTotal([c("final", 22, 42.48), c("pre", 25.66, null), c("live", 10, 6), c("live", 5, 9), null]), 87.1, "42.48 + 25.66 + max(6, 10) + max(9, 5)");
  assert.equal(liveTotal([c("final", 12.4, 6.9), c(undefined, 0, null)]), 6.9, "a final game counts its real points even below ours; a bye counts ours (0)");
  assert.equal(liveTotal([c("final", 12, null)]), null, "final without points: unknown, never 0");
  assert.equal(liveTotal([c("pre", null, null), c("final", 1, 2)]), null, "an unprojected starter: unknown");
  assert.equal(liveTotal([c(undefined, 10, 20), c(undefined, 5, null)]), null, "older captures without game states: unknown");
});
