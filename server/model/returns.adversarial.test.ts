// ADVERSARIAL tests (tester, not developer) for Model v4 release (c): the return estimator (server/model/returns.ts).
// Edge cases of the practice series, roster codes, the IR floor and the 21-day window, plus invariants over a grid:
// never a guessed week, never a past week, never after the final week, confidence consistent with the evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateReturn, type Absence, type ReturnInput } from "./returns.js";
import { detailProblems } from "./testkit.js";
import type { StatusWeek } from "./signals/types.js";

const FULL = "Full Participation in Practice";
const LTD = "Limited Participation in Practice";
const DNP = "Did Not Participate In Practice";

// Week 8 is next; his team has a bye in week 10.
const GW = [8, 9, 11, 12, 13, 14, 15, 16, 17];
const base = (o: Partial<ReturnInput>): ReturnInput => ({
  absence: "reserve",
  status: [],
  currentWeek: 8,
  gameWeeks: GW,
  gamesMissed: 5,
  lastGameWeek: 2,
  ...o,
});
const pick = (r: ReturnType<typeof estimateReturn>) => ({ returnWeek: r.returnWeek, confidence: r.confidence, practiceUp: r.practiceUp });

test("duplicate rows for the same week (e.g. a traded player listed by both teams): the answer must not depend on row order", () => {
  // Input contract says "any order". Two week-8 rows: one full / no status, one DNP / Out.
  const a: StatusWeek = { week: 8, practice: FULL };
  const b: StatusWeek = { week: 8, practice: DNP, report: "Out" };
  const r1 = estimateReturn(base({ rosterStatus: "RES", gamesMissed: 6, status: [a, b] }));
  const r2 = estimateReturn(base({ rosterStatus: "RES", gamesMissed: 6, status: [b, a] }));
  assert.deepEqual(pick(r1), pick(r2), `order-dependent: [full, dnp] → ${JSON.stringify(pick(r1))}, [dnp, full] → ${JSON.stringify(pick(r2))}`);
});

test("designated to return whose 21-day window has already closed (opened wk 2, now wk 8, no practice this week) is NOT 'back next game'", () => {
  // Window wk 2–5 per the estimator's own rule; past it the player reverts to season-ending IR (DESIGN). Without a
  // practice row this week there is no evidence of a return: the answer must be unknown, not a guessed week.
  const r = estimateReturn(base({ absence: "dtr", rosterStatus: "RES", rosterCode: "R48", lastGameWeek: 1, gamesMissed: 6, status: [{ week: 2, practice: LTD, report: "Out" }] }));
  const win = r.reasons.find((d) => d.label === "Designated to return")?.value ?? "";
  assert.equal(r.returnWeek, null, `window "${win}" closed before week 8, yet the estimate is ${JSON.stringify(pick(r))}`);
});

test("full practice last week then DNP this week (setback): reserve → unknown; one-game out → game after next; never a practice upgrade", () => {
  const st = [{ week: 7, practice: FULL }, { week: 8, practice: DNP, report: "Out" }];
  const res = estimateReturn(base({ rosterStatus: "RES", rosterCode: "R01", status: st }));
  assert.equal(res.returnWeek, null);
  assert.equal(res.confidence, "unknown");
  assert.equal(res.practiceUp, false);
  const out = estimateReturn(base({ absence: "out", gamesMissed: 1, lastGameWeek: 6, status: st }));
  assert.equal(out.returnWeek, 9);
  assert.equal(out.practiceUp, false);
});

test("DNP last week → full this week: reserve (IR minimum served) ⇒ next game, high; Yahoo 'Out' ⇒ game after next; both flagged as an upgrade", () => {
  const st = [{ week: 7, practice: DNP, report: "Out" }, { week: 8, practice: FULL }];
  assert.deepEqual(pick(estimateReturn(base({ rosterStatus: "RES", gamesMissed: 5, status: st }))), { returnWeek: 8, confidence: "high", practiceUp: true });
  assert.deepEqual(pick(estimateReturn(base({ absence: "out", gamesMissed: 1, lastGameWeek: 6, status: st }))), { returnWeek: 9, confidence: "medium", practiceUp: true });
});

test("a player hurt in last week's game (no game missed yet) who practises limited is not a practice upgrade", () => {
  const r = estimateReturn(base({ absence: "out", gamesMissed: 0, lastGameWeek: 7, status: [{ week: 7, practice: FULL }, { week: 8, practice: LTD, report: "Out" }] }));
  assert.equal(r.practiceUp, false);
  const r2 = estimateReturn(base({ absence: "out", gamesMissed: 0, lastGameWeek: 7, status: [{ week: 8, practice: LTD, report: "Questionable" }] }));
  assert.equal(r2.practiceUp, false, "no previous row, hurt last week: still trending down");
});

test("limited and ruled out while the IR floor still binds: the floor wins and confidence is never high", () => {
  const r = estimateReturn(base({ rosterStatus: "RES", gamesMissed: 1, lastGameWeek: 7, status: [{ week: 8, practice: LTD, report: "Out" }] }));
  // Missed 1 → 3 more games (8, 9, 11) → eligible week 12.
  assert.equal(r.returnWeek, 12);
  assert.notEqual(r.confidence, "high");
  assert.equal(r.earliestWeek, 12);
});

test("no injury rows at all: reserve / suspended / season over are unknown; one-game Out is the game after next", () => {
  for (const absence of ["reserve", "suspended", "seasonOver"] as Absence[]) {
    const r = estimateReturn(base({ absence, rosterStatus: absence === "reserve" ? "RES" : "ACT" }));
    assert.equal(r.returnWeek, null, absence);
    assert.equal(r.confidence, "unknown", absence);
    assert.ok(r.reasons.some((d) => d.tone === "warn"), `${absence}: an unknown return carries a warn bullet`);
  }
  assert.equal(estimateReturn(base({ absence: "out", gamesMissed: 0, lastGameWeek: 7 })).returnWeek, 9);
});

test("roster codes: RES with an unknown / non-IR code (R05, R40, R99, W03) still never yields a week without a practice signal", () => {
  for (const code of ["R05", "R40", "R99", "W03", "A01", undefined]) {
    const r = estimateReturn(base({ rosterStatus: "RES", rosterCode: code }));
    assert.equal(r.returnWeek, null, `RES/${code}`);
  }
  // INA / DEV / CUT are not reserve lists: with absence reserve (Yahoo IR) the IR floor still comes from onIr.
  for (const st of ["INA", "DEV", "CUT", "PUP", "???"]) {
    const r = estimateReturn(base({ rosterStatus: st, onIr: true, gamesMissed: 0, lastGameWeek: 7, status: [{ week: 8, practice: FULL }] }));
    assert.ok(r.returnWeek === null || r.returnWeek >= 13, `${st} on IR, missed 0: floor wk 13, got ${r.returnWeek}`);
  }
});

test("too few games left after the IR floor: unknown, and the IR-minimum bullet never prints 'wk —'", () => {
  const r = estimateReturn(base({ currentWeek: 15, gameWeeks: [15, 16, 17], rosterStatus: "RES", gamesMissed: 0, lastGameWeek: 14, status: [{ week: 15, practice: FULL }] }));
  assert.equal(r.returnWeek, null);
  const ir = r.reasons.find((d) => d.label === "IR minimum");
  assert.ok(!ir || !/wk —/.test(ir.value), `bullet reads "${ir?.value}": say "not before the season ends" instead of a dash`);
});

test("empty schedule (season over): every absence is unknown, never a week", () => {
  for (const absence of ["reserve", "dtr", "out"] as Absence[]) {
    const r = estimateReturn(base({ absence, gameWeeks: [], status: [{ week: 8, practice: FULL }] }));
    assert.equal(r.returnWeek, null, absence);
  }
});

test("future practice rows (week > current) are ignored by the designated-to-return window", () => {
  const r = estimateReturn(base({ absence: "dtr", rosterCode: "R48", rosterStatus: "RES", status: [{ week: 11, practice: FULL }] }));
  const win = r.reasons.find((d) => d.label === "Designated to return")?.value ?? "";
  assert.match(win, /wk 8–11/, "window starts now, not at a future row");
});

test("invariants over a grid: week ∈ remaining game weeks, ≥ current, ≤ final; unknown ⇔ null; high only with full practice, not ruled out, no floor; bullets ≤ 90", () => {
  const levels = [undefined, DNP, LTD, FULL];
  const reports = [undefined, "Questionable", "Doubtful", "Out"];
  const absences: Absence[] = ["reserve", "dtr", "out", "suspended", "seasonOver"];
  const schedules = [GW, [8, 9, 10, 11, 12, 13, 14, 15, 16, 17], [16, 17], [17], []];
  let n = 0;
  for (const absence of absences)
    for (const prev of levels)
      for (const cur of levels)
        for (const report of reports)
          for (const gamesMissed of [null, 0, 1, 2, 3, 4, 6])
            for (const gameWeeks of schedules)
              for (const rs of ["RES", "ACT", undefined]) {
                const cw = gameWeeks[0] ?? 18;
                const status: StatusWeek[] = [];
                if (prev) status.push({ week: cw - 1, practice: prev });
                if (cur || report) status.push({ week: cw, ...(cur ? { practice: cur } : {}), ...(report ? { report } : {}) });
                const x: ReturnInput = { absence, rosterStatus: rs, status, currentWeek: cw, gameWeeks, gamesMissed, lastGameWeek: gamesMissed === null ? undefined : Math.max(0, cw - 1 - gamesMissed) };
                const r = estimateReturn(x);
                const tag = JSON.stringify({ absence, prev, cur, report, gamesMissed, gameWeeks, rs });
                n++;
                if (r.returnWeek === null) assert.equal(r.confidence, "unknown", tag);
                else {
                  assert.notEqual(r.confidence, "unknown", tag);
                  assert.ok(gameWeeks.includes(r.returnWeek), `${tag}: week ${r.returnWeek} not a game week`);
                  assert.ok(r.returnWeek >= cw && r.returnWeek <= 17, `${tag}: week ${r.returnWeek}`);
                }
                if (absence === "suspended" || absence === "seasonOver") assert.equal(r.returnWeek, null, tag);
                if (r.confidence === "high") {
                  assert.equal(cur, FULL, `${tag}: high without full practice`);
                  assert.notEqual(report, "Out", `${tag}: high while ruled out`);
                  assert.ok(!r.reasons.some((d) => d.label === "IR minimum"), `${tag}: high although the IR floor bound`);
                }
                if (r.practiceUp) assert.ok(cur === LTD || cur === FULL, `${tag}: upgrade without limited/full practice`);
                assert.ok(r.reasons.length > 0, `${tag}: no evidence bullet`);
                assert.deepEqual(detailProblems(r.reasons), [], tag);
              }
  assert.ok(n > 10_000, `grid size ${n}`);
});
