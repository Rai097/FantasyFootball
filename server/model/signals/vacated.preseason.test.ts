// Vacated role by a teammate out since before the season (DESIGN "Fix: returning starters and season-ending injuries
// (2026-10-31)"): the starter has no game this season, so the fill-in's lead role is borrowed from him. Synthetic
// players only (generic ids).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { vacatedGames, type VacPlayer } from "./vacated.js";

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
const hurt = { status: [{ week: 5 }] };
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
