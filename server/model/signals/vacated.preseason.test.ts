// Vacated role by a teammate out since before the season (DESIGN "Fix: returning starters and season-ending injuries
// (2026-10-31)"): the starter has no game this season, so the fill-in's lead role is borrowed from him. Synthetic
// players only (generic ids).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { hurtAt, injuryRow, onRoster, vacatedGames, type VacPlayer } from "./vacated.js";

/** RB with `touches` per week (null = no game), all carries. */
const rb = (id: string, touches: (number | null)[], extra: Partial<VacPlayer> = {}): VacPlayer => ({
  id,
  name: id,
  pos: "RB",
  team: "AAA",
  games: touches.flatMap((t, i) => (t === null ? [] : [{ week: i + 1, team: "AAA", targets: 0, carries: t, snapShare: 0.6 }])),
  ...extra,
});
/** Last season: `perGame` touches over 16 games for `team`. */
const prior = (perGame: number, team: string) => ({ games: 16, opps: { carries: perGame * 16, targets: 0 }, lastTeam: team });
/** Out on the injury report every week (fix round 1: a game status, week-scoped). */
const hurt = { status: [1, 2, 3, 4, 5, 6, 7].map((week) => ({ week, report: "Out" })) };
// The fill-in: a 6-touch backup last season (another team), 3 touches in week 1, then the lead role.
const fillIn = () => rb("rb2", [3, 20, 8, 22, 21, 18, 22], { prior: prior(6, "BBB") });
// The starter: no game this season, a 13-touch role on THIS team last season, on the injury report this season.
const starter = (extra: Partial<VacPlayer> = {}) => rb("rb1", [], { prior: prior(13, "AAA"), ...hurt, ...extra });

describe("vacatedGames: teammate out since before the season", () => {
  test("every game above the fill-in's own 2025 role is borrowed from the starter (quiet early games are not)", () => {
    const m = vacatedGames([fillIn(), starter()]);
    assert.deepEqual([...(m.get("rb2")?.keys() ?? [])], [2, 4, 5, 6, 7], "week 1 (3) and week 3 (8 < 1.5 × 6) are his own role");
    assert.equal(m.get("rb2")!.get(2)![0].id, "rb1");
    assert.equal(m.has("rb1"), false, "the starter has no games: nothing of his is borrowed");
  });
  test("a teammate with no prior, a prior on another team, or no injury listing is unknown → never flagged", () => {
    assert.equal(vacatedGames([fillIn(), starter({ prior: undefined })]).size, 0, "no 2025 role");
    assert.equal(vacatedGames([fillIn(), starter({ prior: { games: 3, opps: { carries: 45, targets: 0 }, lastTeam: "AAA" } })]).size, 0, "3-game 2025");
    assert.equal(vacatedGames([fillIn(), starter({ prior: prior(13, "CCC") })]).size, 0, "2025 on another team (signed later)");
    assert.equal(vacatedGames([fillIn(), starter({ status: [], roster: { status: "ACT" } })]).size, 0, "healthy scratch: no injury evidence");
    assert.equal(vacatedGames([fillIn(), starter({ status: undefined, roster: { status: "RES" } })]).size, 1, "a reserve list is evidence");
    assert.equal(vacatedGames([fillIn(), starter({ team: "CCC" })]).size, 0, "starter no longer on the team");
  });
  test("the fill-in's baseline is unknown without his own 2025 role (≥ 4 games) → never flagged", () => {
    assert.equal(vacatedGames([rb("rb2", [3, 20, 9, 22], {}), starter()]).size, 0);
    assert.equal(vacatedGames([rb("rb2", [3, 20, 9, 22], { prior: { games: 2, opps: { carries: 12, targets: 0 } } }), starter()]).size, 0);
  });
  test("the starter's 2025 role must beat the fill-in's (margin and minimum usage)", () => {
    assert.equal(vacatedGames([fillIn(), starter({ prior: prior(6.5, "AAA") })]).size, 0, "6.5 < 6 + margin");
    assert.equal(vacatedGames([rb("rb2", [3, 20], { prior: prior(2, "BBB") }), starter({ prior: prior(7, "AAA") })]).size, 0, "7 < 8 touches minimum");
  });
  test("a teammate who plays that week is not out since before it; weeks after his first game use the usual rule", () => {
    // The starter plays from week 4: weeks 2 (before his first game) is borrowed; weeks 4+ he is present.
    const m = vacatedGames([fillIn(), starter({ games: [4, 5, 6, 7].map((week) => ({ week, team: "AAA", targets: 0, carries: 15, snapShare: 0.6 })) })]);
    assert.deepEqual([...(m.get("rb2")?.keys() ?? [])], [2]);
    // Week 1 of a teammate who played week 1 is never "out since before the season".
    const both = vacatedGames([rb("rb2", [20], { prior: prior(6, "BBB") }), starter({ games: [{ week: 1, team: "AAA", targets: 0, carries: 15 }] })]);
    assert.equal(both.size, 0);
  });
});

describe("injury evidence and team membership (fix round 1, 2026-10-31)", () => {
  const FULL = "Full Participation in Practice";
  const LTD = "Limited Participation in Practice";
  const DNP = "Did Not Participate In Practice";
  test("a row is evidence only with a game status: Out / Doubtful, or Questionable while not practising fully", () => {
    assert.equal(injuryRow({ report: "Out", practice: FULL }), true);
    assert.equal(injuryRow({ report: "Doubtful" }), true);
    assert.equal(injuryRow({ report: "Questionable", practice: LTD }), true);
    assert.equal(injuryRow({ report: "Questionable", practice: DNP }), true);
    assert.equal(injuryRow({ report: "Questionable", practice: FULL }), false, "practising fully: cleared");
    assert.equal(injuryRow({ report: "Questionable" }), false, "no practice info");
    assert.equal(injuryRow({ practice: DNP }), false, "practice-only row (rest day / mid-week)");
    assert.equal(injuryRow({ practice: FULL }), false);
    assert.equal(injuryRow({}), false);
  });
  test("week-scoped: the latest report week in [w − 2, w] decides; a clean week clears him", () => {
    const p = rb("rb1", [], { status: [{ week: 1, report: "Out" }, { week: 4, practice: FULL }] });
    assert.equal(hurtAt(p, 1), true);
    assert.equal(hurtAt(p, 3), true, "week-1 Out within 2 weeks");
    assert.equal(hurtAt(p, 4), false, "week-4 clean row decides");
    assert.equal(hurtAt(p, 6), false, "week 4 still the latest in [4, 6]");
    assert.equal(hurtAt(p, 8), false, "no row in [6, 8], none after, not on reserve: unknown → not hurt");
  });
  test("no recent row: his first report week after w within the same absence decides (PUP / IR → Out on return)", () => {
    const pup = rb("rb1", [], { status: [4, 5, 6, 7].map((week) => ({ week, report: "Out", practice: LTD })), roster: { status: "ACT" } });
    assert.deepEqual([1, 2, 3, 4, 7].map((w) => hurtAt(pup, w)), [true, true, true, true, true]);
    const scratch = rb("rb1", [], { status: [{ week: 4, practice: FULL }], roster: { status: "ACT" } });
    assert.equal(hurtAt(scratch, 1), false, "first row after is clean: a healthy scratch");
    // A row after his first game is another absence: never evidence for weeks before that game.
    const later = rb("rb1", [null, null, null, 16], { status: [{ week: 5, report: "Out" }] });
    assert.equal(hurtAt(later, 2), false);
    assert.equal(hurtAt(later, 5), true);
  });
  test("no row near or after: the roster reserve list (RES) decides; NaN weeks are ignored", () => {
    assert.equal(hurtAt(rb("rb1", [], { roster: { status: "RES" } }), 5), true);
    assert.equal(hurtAt(rb("rb1", [], { roster: { status: "ACT" } }), 5), false);
    assert.equal(hurtAt(rb("rb1", [], { status: [{ week: Number.NaN, report: "Out" }] }), 5), false);
  });
  test("on the team: ACT / INA / RES / DEV or no roster status; CUT, RET, TRD, TRC, TRT, EXE, unknown codes are not", () => {
    for (const st of ["ACT", "INA", "RES", "DEV", undefined]) assert.equal(onRoster(rb("x", [], { roster: { status: st } })), true, String(st));
    assert.equal(onRoster(rb("x", [])), true, "no roster row: his team decides");
    for (const st of ["CUT", "RET", "TRD", "TRC", "TRT", "EXE", "XYZ"]) assert.equal(onRoster(rb("x", [], { roster: { status: st } })), false, st);
  });
  test("a teammate cut / traded mid-season (old team kept on his roster row) never vacates a role by the usual rule", () => {
    // He played weeks 1-3 for the team, then left: the fill-in's role from week 4 is his own, not borrowed.
    const fill = rb("rb2", [5, 4, 5, 18, 19, 20]);
    const gone = rb("rb1", [15, 16, 15]);
    assert.deepEqual([...(vacatedGames([fill, gone]).get("rb2")?.keys() ?? [])], [4, 5, 6], "still on the team (control)");
    for (const st of ["CUT", "TRD", "RET"]) assert.equal(vacatedGames([fill, { ...gone, roster: { status: st } }]).size, 0, st);
  });
  test("a NaN / missing 2025 total is unknown: never a role", () => {
    assert.equal(vacatedGames([fillIn(), starter({ prior: { games: Number.NaN, opps: { carries: 200, targets: 0 }, lastTeam: "AAA" } })]).size, 0);
    assert.equal(vacatedGames([fillIn(), starter({ prior: { games: 16, opps: { carries: Number.NaN, targets: 0 }, lastTeam: "AAA" } })]).size, 0);
  });
});
