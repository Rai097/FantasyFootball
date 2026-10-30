import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accuracyReport,
  mergeCapture,
  outcomeOf,
  playerAccuracy,
  PROJLOG_MAX_WEEK,
  resolveLog,
  vsYahooItem,
  type Kickoffs,
  type Outcome,
  type ProjEntry,
  type ProjLog,
  type ResolvedRow,
} from "./projLog.js";
import { HALF_PPR } from "./scoring.js";
import { detailProblems, line } from "./testkit.js";

const KICK: Kickoffs = { byTeam: new Map([["GB", "2026-10-30T00:15:00.000Z"], ["BUF", "2026-11-01T17:00:00.000Z"]]), first: "2026-10-30T00:15:00.000Z" };
const e = (id: string, team: string, over: Partial<ProjEntry> = {}): Omit<ProjEntry, "capturedAt"> => ({
  id, name: `P ${id}`, pos: "WR", team, teamId: "1", starter: true, app: 10, yahoo: 9, ...over,
});
const cap = (log: ProjLog | null, capturedAt: string, entries: Omit<ProjEntry, "capturedAt">[], week = 8, kickoffs = KICK) =>
  mergeCapture(log, { season: 2026, week, capturedAt, entries, kickoffs });

test("merge: keeps the latest capture taken before HIS kickoff; a post-kickoff capture never overwrites", () => {
  let log = cap(null, "2026-10-28T12:00:00.000Z", [e("a", "GB", { app: 10 }), e("b", "BUF", { app: 5 })]).log;
  // Friday: GB already kicked off (Thursday night), BUF has not.
  const r = cap(log, "2026-10-30T15:00:00.000Z", [e("a", "GB", { app: 0 }), e("b", "BUF", { app: 7 })]);
  log = r.log;
  assert.equal(log.weeks["8"].a.app, 10, "post-kickoff capture ignored");
  assert.equal(log.weeks["8"].a.capturedAt, "2026-10-28T12:00:00.000Z");
  assert.equal(log.weeks["8"].b.app, 7, "pre-kickoff re-import replaces the older capture");
  assert.equal(r.kept, 1);
  assert.equal(r.ignored, 1);
  // A capture exactly at kickoff counts as after.
  log = cap(log, "2026-11-01T17:00:00.000Z", [e("b", "BUF", { app: 99 })]).log;
  assert.equal(log.weeks["8"].b.app, 7);
  // An older capture arriving late never replaces a newer one.
  log = cap(log, "2026-10-27T12:00:00.000Z", [e("b", "BUF", { app: 1 })]).log;
  assert.equal(log.weeks["8"].b.app, 7);
});

test("merge: a player first seen after his kickoff gets no entry", () => {
  const { log, kept } = cap(null, "2026-10-30T15:00:00.000Z", [e("a", "GB")]);
  assert.equal(kept, 0);
  assert.equal(log.weeks["8"], undefined);
});

test("merge: unknown team kickoff falls back to the week's first kickoff; nothing known → nothing recorded", () => {
  // NYJ has no kickoff of its own: the first kickoff (Thursday) is the cut-off.
  let r = cap(null, "2026-10-29T12:00:00.000Z", [e("j", "NYJ")]);
  assert.equal(r.kept, 1);
  r = cap(null, "2026-10-30T15:00:00.000Z", [e("j", "NYJ")]);
  assert.equal(r.kept, 0, "after the week's first kickoff: ignored");
  r = cap(null, "2026-10-01T00:00:00.000Z", [e("j", "NYJ")], 8, { byTeam: new Map() });
  assert.equal(r.kept, 0, "no kickoff known at all: fail safe");
});

test("merge: skill players only, bounded weeks, a new season starts a fresh log, Yahoo absent stays absent", () => {
  const r = cap(null, "2026-10-28T12:00:00.000Z", [e("k", "GB", { pos: "K" }), e("d", "GB", { pos: "DEF" }), e("n", "GB", { app: NaN }), e("y", "GB", { yahoo: undefined })]);
  assert.deepEqual(Object.keys(r.log.weeks["8"]), ["y"]);
  assert.equal("yahoo" in r.log.weeks["8"].y, false);
  assert.equal(cap(null, "2026-10-28T12:00:00.000Z", [e("a", "GB")], PROJLOG_MAX_WEEK + 1).kept, 0);
  assert.equal(cap(null, "2026-10-28T12:00:00.000Z", [e("a", "GB")], 0).kept, 0);
  const old: ProjLog = { season: 2025, weeks: { "3": { a: { ...e("a", "GB"), capturedAt: "2025-09-20T00:00:00.000Z" } } } };
  const fresh = cap(old, "2026-10-28T12:00:00.000Z", [e("b", "BUF")]).log;
  assert.equal(fresh.season, 2026);
  assert.deepEqual(Object.keys(fresh.weeks), ["8"]);
});

const P = { pos: "WR" as const, weeks: [{ season: 2026, week: 7, actual: line({ rec: 5, recYd: 60, recTd: 1 }) }] };
const q = (week: number, final: boolean, rowsIn: boolean) => ({ season: 2026, week, team: "GB", scoring: HALF_PPR, gameFinal: () => final, teamRowsIn: () => rowsIn });

test("outcome: stat row = played (league scoring); no row after a final game with the team's rows in = did not play, never 0", () => {
  assert.deepEqual(outcomeOf(P, q(7, true, true)), { status: "played", pts: 14.5 });
  assert.deepEqual(outcomeOf(P, q(8, true, true)), { status: "dnp" });
  assert.deepEqual(outcomeOf(P, q(8, true, false)), { status: "pending" }, "final score in, weekly stats not yet: pending");
  assert.deepEqual(outcomeOf(P, q(8, false, true)), { status: "pending" });
  assert.deepEqual(outcomeOf(undefined, q(8, false, false)), { status: "pending" });
});

const row = (id: string, week: number, app: number, yahoo: number | undefined, outcome: Outcome, over: Partial<ProjEntry> = {}): ResolvedRow => ({
  id, name: `P ${id}`, pos: "WR", team: "GB", teamId: "1", starter: true, app, ...(yahoo === undefined ? {} : { yahoo }), capturedAt: "x", week, outcome, ...over,
});
const played = (pts: number): Outcome => ({ status: "played", pts });

test("report: app and Yahoo are scored over the SAME player-weeks; DNP, pending and no-Yahoo rows stay out", () => {
  const rows = [
    row("a", 5, 10, 12, played(14)), // app err 4, yahoo err 2
    row("b", 5, 8, 6, played(4), { pos: "RB" }), // app −4, yahoo −2
    row("c", 5, 30, undefined, played(0)), // no Yahoo: app-only, must not move the comparison
    row("d", 5, 12, 11, { status: "dnp" }),
    row("e", 6, 12, 11, { status: "pending" }),
  ];
  const r = accuracyReport(rows);
  assert.deepEqual(r.season, { n: 2, appMae: 4, yahooMae: 2, appBias: 0, yahooBias: 0 });
  assert.deepEqual(r.counts, { captured: 5, compared: 2, noYahoo: 1, dnp: 1, pending: 1 });
  assert.deepEqual(r.weeks, [5]);
  assert.deepEqual(r.byPos.map((p) => [p.pos, p.n, p.appBias]), [["RB", 1, -4], ["WR", 1, 4]]);
  assert.equal(r.appAll.n, 3, "app-only stats include the no-Yahoo row …");
  assert.equal(r.appAll.mae, r2((4 + 4 + 30) / 3), "… separately");
});
const r2 = (x: number) => Math.round(x * 100) / 100;

test("per player: ≥ 3 compared weeks; average actual − Yahoo / − app and beat counts; lists ≤ 5", () => {
  const rows = [
    row("a", 4, 10, 10, played(15)),
    row("a", 5, 10, 10, played(12)),
    row("a", 6, 10, 10, played(8)),
    row("a", 7, 10, 10, played(13)),
    row("b", 5, 10, 10, played(30)),
    row("b", 6, 10, 10, played(30)),
    row("b", 7, 10, undefined, played(30)), // only 2 compared weeks
    row("c", 5, 10, 12, played(5)),
    row("c", 6, 10, 12, played(5)),
    row("c", 7, 10, 12, { status: "dnp" }),
    row("c", 8, 10, 12, played(5)),
  ];
  const m = playerAccuracy(rows);
  assert.deepEqual([...m.keys()].sort(), ["a", "c"]);
  assert.deepEqual(m.get("a"), { id: "a", name: "P a", pos: "WR", team: "GB", weeks: 4, vsYahoo: 2, vsApp: 2, beatYahoo: 3, beatApp: 3 });
  assert.equal(m.get("c")!.weeks, 3, "the DNP week is not a compared week");
  assert.equal(m.get("c")!.vsYahoo, -7);
  const r = accuracyReport(rows);
  assert.deepEqual(r.mostBeat.map((p) => p.id), ["a"]);
  assert.deepEqual(r.mostMissed.map((p) => p.id), ["c"]);
  const many = Array.from({ length: 8 }, (_, i) => [3, 4, 5].map((w) => row(`p${i}`, w, 10, 10, played(11 + i)))).flat();
  assert.equal(accuracyReport(many).mostBeat.length, 5);
});

test("teams: starters at capture over compared rows; bench, free agents, DNP and no-Yahoo starters are not summed", () => {
  const rows = [
    row("a", 5, 10, 12, played(14)),
    row("b", 5, 8, 6, played(4)),
    row("c", 5, 20, 20, played(40), { starter: false }), // bench
    row("f", 5, 20, 20, played(40), { teamId: null, starter: false }), // free agent
    row("d", 5, 12, 11, { status: "dnp" }),
    row("e", 5, 12, undefined, played(3)),
    row("g", 6, 10, 10, played(10), { teamId: "2" }),
  ];
  const r = accuracyReport(rows);
  assert.deepEqual(r.teams, [
    { teamId: "1", weeks: 1, app: 18, yahoo: 18, actual: 18, dnp: 1, noYahoo: 1 },
    { teamId: "2", weeks: 1, app: 10, yahoo: 10, actual: 10, dnp: 0, noYahoo: 0 },
  ]);
});

test("resolveLog walks every week/player; empty log → empty report (no zeros invented)", () => {
  const log: ProjLog = { season: 2026, weeks: { "8": { a: { ...e("a", "GB"), capturedAt: "t" } }, "7": { b: { ...e("b", "BUF"), capturedAt: "t" } } } };
  const rows = resolveLog(log, (x, w) => (w === 7 ? played(5) : { status: "pending" }));
  assert.deepEqual(rows.map((x) => [x.week, x.id, x.outcome.status]), [[7, "b", "played"], [8, "a", "pending"]]);
  const r = accuracyReport(resolveLog(null, () => ({ status: "pending" })));
  assert.equal(r.season.n, 0);
  assert.deepEqual(r.weeks, []);
  assert.deepEqual(r.teams, []);
});

test("Vs Yahoo bullet: only from 3 weeks, one short idea (≤ 90 chars)", () => {
  assert.equal(vsYahooItem(undefined), undefined);
  assert.equal(vsYahooItem({ id: "a", name: "A", pos: "WR", team: "GB", weeks: 2, vsYahoo: 3, vsApp: 1, beatYahoo: 2, beatApp: 1 }), undefined);
  const it = vsYahooItem({ id: "a", name: "A", pos: "WR", team: "GB", weeks: 4, vsYahoo: 2.1, vsApp: 0.4, beatYahoo: 3, beatApp: 2 })!;
  assert.deepEqual(it, { label: "Vs Yahoo", value: "+2.1 pts/wk over 4 wks (beat 3 of 4)", tone: "pos" });
  const worst = vsYahooItem({ id: "a", name: "A", pos: "WR", team: "GB", weeks: 18, vsYahoo: -123.4, vsApp: 0, beatYahoo: 0, beatApp: 0 })!;
  assert.equal(worst.value, "−123.4 pts/wk over 18 wks (beat 0 of 18)");
  assert.deepEqual(detailProblems([it, worst]), []);
});
