// Adversarial: borrowed role and one-game spikes (DESIGN "Fix: vacated role, spikes, depth and roster need
// (2026-10-28)"). Real-copy shapes reproduced with generic ids only.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { usageShape, vacatedGames, type VacGame, type VacPlayer } from "./vacated.js";
import { computeAllSignals } from "./index.js";
import { futureStarterBlock, roleCheck } from "../roleCheck.js";
import { line, vp } from "../testkit.js";
import { PPR } from "../../data/fixtures/signals2026.js";
import type { PlayerGame, PlayerSignalInput, SkillPos } from "./types.js";
import type { StatLine } from "../types.js";

const ASOF = new Date("2026-10-26T00:00:00Z");
const g = (week: number, targets: number, carries = 0, snapShare?: number, team = "AAA"): VacGame => ({ week, team, targets, carries, ...(snapShare !== undefined ? { snapShare } : {}) });
const vpl = (id: string, pos: string, games: VacGame[], team = "AAA"): VacPlayer => ({ id, name: id, pos, team, games });

describe("vacatedGames: who had the larger role is decided on a real sample", () => {
  test("ONE shared opening game (13 vs 15 touches, 46% vs 45% snaps) does not make the other back the lead: no borrowed role", () => {
    // Real copy: a committee split in week 1, the other back out weeks 2–5 → all four of his workhorse games counted 40%
    // (value 2.3 → 0.2). One game is "unknown" elsewhere in this release (healthy share needs ≥ 2 games).
    const me = vpl("rbA", "RB", [g(1, 1, 12, 0.46), g(2, 0, 23, 0.81), g(3, 6, 17, 0.8), g(4, 8, 20, 0.73), g(5, 3, 25, 0.87), g(7, 1, 8, 0.25)]);
    const mate = vpl("rbB", "RB", [g(1, 0, 15, 0.45), g(7, 2, 15, 0.64)]);
    const v = vacatedGames([me, mate]).get("rbA");
    assert.equal(v, undefined, `flagged weeks ${JSON.stringify(v ? [...v.keys()] : [])} on a one-game baseline`);
  });
  test("a starter back from his OWN absence (one limited 44%-snap game before it) is not borrowing a depth WR's role", () => {
    // Real copy: a WR1 played 44% of snaps in week 1, missed weeks 2–5 himself, came back weeks 6–7 as the WR1 while
    // the team's WR3 was out → "Borrowed role: usage rose while <WR3> was out (wk 6, 7)".
    const me = vpl("wrA", "WR", [g(1, 5, 0, 0.44), g(6, 13, 0, 0.76), g(7, 9, 0, 0.91)]);
    const mate = vpl("wrC", "WR", [g(1, 8, 0, 0.7), g(2, 4, 0, 0.71), g(3, 11, 0, 0.76), g(4, 6, 0, 0.41)]);
    const v = vacatedGames([me, mate]).get("wrA");
    assert.equal(v, undefined, `flagged weeks ${JSON.stringify(v ? [...v.keys()] : [])}`);
  });
  // Edge cases that hold today (regression guards).
  test("teammate out from week 1 (no prior game for this team) never flags; traded-away teammate never flags", () => {
    const me = vpl("teA", "TE", [g(1, 2), g(2, 2), g(3, 9), g(4, 9)]);
    const neverPlayed = vpl("wrX", "WR", []);
    assert.equal(vacatedGames([me, neverPlayed]).get("teA"), undefined);
    const traded = vpl("wrT", "WR", [g(1, 9), g(2, 9)], "BBB"); // played for AAA, now on BBB
    traded.games = traded.games.map((x) => ({ ...x, team: "AAA" }));
    assert.equal(vacatedGames([me, traded]).get("teA"), undefined, "gone for good: the role is his, full weight");
  });
  test("a team bye inside the absence does not break 'explained'; a teammate back mid-window ends the flag", () => {
    const me = vpl("teA", "TE", [g(1, 2), g(2, 2), g(3, 8), g(5, 8), g(6, 2), g(7, 2)]); // bye wk 4, mate back wk 6
    const mate = vpl("wrB", "WR", [g(1, 9), g(2, 9), g(6, 9), g(7, 9)]);
    const v = vacatedGames([me, mate]).get("teA")!;
    assert.deepEqual([...v.keys()], [3, 5]);
  });
});

describe("one-game spike: the cap is for a role jump, not a settled starter's variance", () => {
  /** A game whose expected points are `pts` (PPR receiving: 0.1/yd), with fixed usage and snap share. */
  const gm = (week: number, pos: SkillPos, pts: number, usage: { targets?: number; carries?: number; passAttempts?: number }, snap: number): PlayerGame => {
    const ex: Partial<StatLine> = pos === "QB" ? { passYd: pts / 0.04 } : pos === "RB" ? { rushYd: pts * 10 } : { recYd: pts * 10 };
    return { week, gameId: `2026_${week}_AAA`, team: "AAA", targets: usage.targets ?? 0, carries: usage.carries ?? 0, airYards: 0, passAttempts: usage.passAttempts ?? 0, actual: line(ex), expected: line(ex), snapShare: snap };
  };
  const sig = (id: string, pos: SkillPos, games: PlayerGame[]) => {
    const input: PlayerSignalInput = { id, name: id, pos, team: "AAA", games, status: [] };
    return computeAllSignals([input], { season: 2026, scoring: PPR, asOf: ASOF }).get(id)!;
  };
  test("a QB on 100% of snaps every week: one big passing game is not a 'one-game jump' (real copy: 5 starting QBs capped)", () => {
    const pts = [16, 17, 16, 15, 17, 16, 30];
    const s = sig("qb", "QB", pts.map((p, i) => gm(i + 1, "QB", p, { passAttempts: 34 }, 1)));
    assert.deepEqual(s.weeks.filter((w) => w.flags.spike).map((w) => w.week), [], "a QB has no role to borrow or spike");
  });
  test("an every-down WR (90% snaps, 8–9 targets every week) with one 16-target game keeps that game's recency", () => {
    // Real copy: 29 of 98 players averaging ≥ 70% snaps have a capped game (a top RB lost 4.4 value): only the HIGH
    // outlier is discounted, never a low one, so settled starters are biased down.
    const t = [8, 9, 8, 9, 8, 16, 8];
    const s = sig("wr", "WR", t.map((x, i) => gm(i + 1, "WR", x * 1.6, { targets: x }, 0.9)));
    assert.deepEqual(s.weeks.filter((w) => w.flags.spike).map((w) => w.week), [], "variance in a settled role is not a role jump");
  });
  test("a 2-game climb (usage 3 → 5 → 12 after 2s) is a rising role, not a one-game spike, in BOTH the projection and the role check", () => {
    // usageShape's 0.5 × peak bar makes the bigger the latest breakout, the more the game before it looks 'not elevated'.
    const carries = [4, 4, 4, 4, 6, 10, 24];
    const exp = carries.map((c) => c * 0.5);
    const s = sig("rb", "RB", carries.map((c, i) => gm(i + 1, "RB", c * 0.5, { carries: c }, 0.3 + i * 0.08)));
    // The projection already exempts a climbing opportunity share (no cap)...
    assert.deepEqual(s.weeks.filter((w) => w.flags.spike).map((w) => w.week), [], "projection: climbing share is no spike");
    // ...but the waiver role check (same player, same weeks) calls it 'one strong game, not a role yet': two definitions.
    const r = roleCheck({ p: vp("rb", "RB", 8, 0, { team: "AAA" }), weeks: [1, 2, 3, 4, 5, 6, 7], expPpg: exp, players: new Map(), usage: new Map(), offense: new Map() });
    assert.equal(r.spike, false, `role check says spike on ${JSON.stringify(exp)} (usageShape ${JSON.stringify(usageShape(exp))})`);
  });
});

describe("role check: share with the starters healthy follows a riser's current role", () => {
  test("targets 2 → 3 → 7 → 8 of 36 a game (19–22% the last 2 games, no borrowed role): not blocked as a 13.9% share", () => {
    const team = "AAA";
    const wk = (week: number, targets: number) => ({ season: 2026, week, team, actual: line({ rec: targets * 0.6, recYd: targets * 8 }), expected: line({ rec: targets * 0.6, recYd: targets * 8 }), opp: { targets, carries: 0, airYards: 0 } });
    const me = vp("wrR", "WR", 7, 0, { team, weeks: [wk(1, 2), wk(2, 3), wk(3, 7), wk(4, 8)] });
    const usage = new Map([1, 2, 3, 4].map((w) => [`${team}|${w}`, { targets: 36, touches: 60 }]));
    const r = roleCheck({ p: me, weeks: [1, 2, 3, 4], expPpg: [2.2, 3.3, 7.7, 8.8], players: new Map(), chart: ["x1", "x2", "wrR"], usage, offense: new Map() });
    assert.equal(r.sustained, true, "usage up in 2 of the last 3 games");
    const block = futureStarterBlock(r, "WR");
    assert.equal(block, null, `blocked: ${block?.short} (share ${r.healthyShare}, averaged over his pre-rise games)`);
  });
});
