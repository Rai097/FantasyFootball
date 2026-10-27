import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateReturn, mergeStatusWeeks, practiceLevel, returnText, type ReturnInput } from "./returns.js";

const FULL = "Full Participation in Practice";
const LTD = "Limited Participation in Practice";
const DNP = "Did Not Participate In Practice";

// Week 8 is next; his team has a bye in week 10.
const base = (o: Partial<ReturnInput>): ReturnInput => ({
  absence: "reserve",
  status: [],
  currentWeek: 8,
  gameWeeks: [8, 9, 11, 12, 13, 14, 15, 16, 17],
  gamesMissed: 5,
  lastGameWeek: 2,
  ...o,
});

test("practice level: matched by prefix on the nflverse strings", () => {
  assert.deepEqual([FULL, LTD, DNP, "", undefined, "Out"].map(practiceLevel), [3, 2, 1, 0, 0, 0]);
});

test("practice trend DNP → limited → full this week, not ruled out ⇒ next game, high; flagged as a practice upgrade", () => {
  const r = estimateReturn(base({ rosterStatus: "RES", rosterCode: "R48", status: [{ week: 6, practice: DNP }, { week: 7, practice: LTD }, { week: 8, practice: FULL, report: "Questionable" }] }));
  assert.equal(r.returnWeek, 8);
  assert.equal(r.confidence, "high");
  assert.equal(r.practiceUp, true);
  assert.ok(r.reasons.some((x) => x.label === "Practice" && /limited → full/.test(x.value)));
});

test("full practice but ruled out (DTR still in his window) ⇒ the game after next, medium", () => {
  const r = estimateReturn(base({ absence: "dtr", rosterStatus: "RES", status: [{ week: 7, practice: FULL, report: "Out" }, { week: 8, practice: FULL, report: "Out" }] }));
  assert.equal(r.returnWeek, 9);
  assert.equal(r.confidence, "medium");
  assert.equal(r.practiceUp, false, "full both weeks: no upgrade");
});

test("limited this week ⇒ next game (medium) when not ruled out, the game after next when ruled out; skips the bye", () => {
  assert.deepEqual(
    (({ returnWeek, confidence }) => ({ returnWeek, confidence }))(estimateReturn(base({ status: [{ week: 8, practice: LTD, report: "Questionable" }] }))),
    { returnWeek: 8, confidence: "medium" },
  );
  const out = estimateReturn(base({ currentWeek: 9, gameWeeks: [9, 11, 12, 13, 14, 15, 16, 17], status: [{ week: 9, practice: LTD, report: "Out" }] }));
  assert.equal(out.returnWeek, 11, "week 10 is his bye: the game after next is week 11");
  assert.equal(out.confidence, "medium");
});

test("reserve list with no practice signal ⇒ unknown, never a guessed week", () => {
  const r = estimateReturn(base({ rosterStatus: "RES", rosterCode: "R01" }));
  assert.equal(r.returnWeek, null);
  assert.equal(r.confidence, "unknown");
  assert.equal(returnText(r.returnWeek, r.confidence), "return unconfirmed");
  // A did-not-practice row this week (freshly placed on IR) is not a return signal either.
  assert.equal(estimateReturn(base({ rosterStatus: "RES", status: [{ week: 8, practice: DNP, report: "Out" }] })).returnWeek, null);
  // A practice row from before his last game belongs to the old injury.
  const stale = estimateReturn(base({ rosterStatus: "RES", lastGameWeek: 7, gamesMissed: 0, status: [{ week: 6, practice: FULL }] }));
  assert.equal(stale.returnWeek, null);
});

test("designated to return without a practice row this week ⇒ inside the 21-day window, medium", () => {
  const r = estimateReturn(base({ absence: "dtr", rosterStatus: "RES", rosterCode: "R48", status: [{ week: 7, practice: LTD, report: "Out" }] }));
  // Window opened week 7 (first practice row of this absence) → typical activation 2 weeks later (week 9), window ends week 10.
  assert.equal(r.returnWeek, 9);
  assert.equal(r.confidence, "medium");
  assert.ok(r.reasons.some((x) => x.label === "Designated to return" && /wk 7–10/.test(x.value)));
  // No row at all: the window starts now (week 8) → week 10 is a bye → his first game in the window is week 11 (the end).
  const fresh = estimateReturn(base({ absence: "dtr", rosterCode: "R48" }));
  assert.equal(fresh.returnWeek, 11);
  assert.equal(fresh.confidence, "medium");
});

test("IR minimum 4 games is a floor: a practice estimate before it is pushed back and loses 'high'", () => {
  const r = estimateReturn(base({ rosterStatus: "RES", gamesMissed: 2, lastGameWeek: 6, status: [{ week: 8, practice: FULL, report: "Questionable" }] }));
  // Missed 2 → 2 more games (weeks 8, 9) → eligible week 11 (week 10 bye).
  assert.equal(r.returnWeek, 11);
  assert.equal(r.confidence, "medium");
  assert.equal(r.earliestWeek, 11);
  const u = estimateReturn(base({ rosterStatus: "RES", gamesMissed: 1, lastGameWeek: 7 }));
  assert.equal(u.returnWeek, null);
  assert.equal(u.earliestWeek, 12, "unknown return still says when he could be back at the earliest");
});

test("ruled out of one game (not on IR) ⇒ the game after next; suspended / season over ⇒ unknown", () => {
  const o = estimateReturn(base({ absence: "out", gamesMissed: 0, lastGameWeek: 7 }));
  assert.equal(o.returnWeek, 9);
  assert.equal(o.confidence, "medium");
  assert.equal(estimateReturn(base({ absence: "suspended" })).confidence, "unknown");
  assert.equal(estimateReturn(base({ absence: "seasonOver", status: [{ week: 8, practice: FULL }] })).returnWeek, null);
});

test("no games left after the estimate ⇒ unknown; reasons stay short", () => {
  const r = estimateReturn(base({ currentWeek: 17, gameWeeks: [17], status: [{ week: 17, practice: LTD, report: "Out" }] }));
  assert.equal(r.returnWeek, null);
  for (const x of r.reasons) assert.ok(x.value.length <= 90);
});

test("practice upgrade only after a real absence: hurt in last week's game, limited this week ⇒ no 'waiver fight' flag", () => {
  const fresh = estimateReturn(base({ absence: "out", gamesMissed: 0, lastGameWeek: 7, status: [{ week: 8, practice: LTD, report: "Out" }] }));
  assert.equal(fresh.practiceUp, false);
  assert.equal(fresh.returnWeek, 9);
  const back = estimateReturn(base({ absence: "out", gamesMissed: 1, lastGameWeek: 6, status: [{ week: 8, practice: LTD, report: "Out" }] }));
  assert.equal(back.practiceUp, true, "missed a game, now practising: an upgrade");
  const none = estimateReturn(base({ rosterStatus: "RES", lastGameWeek: undefined, gamesMissed: 7 }));
  assert.ok(none.reasons.some((r) => r.label === "Missed" && /all 7 of his team's games this season/.test(r.value)));
});

test("duplicate rows for one week merge to the most severe (lowest known practice, worst game status), in any order", () => {
  const a = { week: 8, practice: FULL };
  const b = { week: 8, practice: LTD, report: "Questionable" };
  const c = { week: 8, report: "Out" };
  for (const rows of [[a, b, c], [c, b, a], [b, c, a]]) assert.deepEqual(mergeStatusWeeks(rows), [{ week: 8, practice: LTD, report: "Out" }]);
  assert.deepEqual(mergeStatusWeeks([{ week: 9 }, { week: 7, practice: DNP }]).map((s) => s.week), [7, 9]);
});

test("designated to return past his 21-day window, not practising this week ⇒ unknown, the window stays visible", () => {
  const r = estimateReturn(base({ absence: "dtr", rosterStatus: "RES", rosterCode: "R48", lastGameWeek: 1, status: [{ week: 3, practice: LTD }] }));
  assert.equal(r.returnWeek, null);
  assert.equal(r.confidence, "unknown");
  assert.ok(r.reasons.some((d) => d.label === "Designated to return" && /wk 3–6/.test(d.value)));
  assert.ok(r.reasons.some((d) => d.label === "Return" && /window closed after wk 6/.test(d.value)));
});

test("IR minimum with no eligible game left: the bullet says so in words", () => {
  const r = estimateReturn(base({ currentWeek: 16, gameWeeks: [16, 17], rosterStatus: "RES", gamesMissed: 0, lastGameWeek: 15 }));
  assert.equal(r.returnWeek, null);
  assert.equal(r.reasons.find((d) => d.label === "IR minimum")?.value, "4 games: missed 0, no eligible game left this season");
});

test("absent on the league source's word only (import IR tag, nflverse active): unknown, says the league lists him on IR", () => {
  const r = estimateReturn(base({ leagueOnly: true, rosterStatus: "ACT", gamesMissed: 1, lastGameWeek: 6 }));
  assert.equal(r.returnWeek, null);
  assert.equal(r.reasons.find((d) => d.label === "Return")?.value, "league lists him on IR, no practice signal: return unconfirmed");
});
