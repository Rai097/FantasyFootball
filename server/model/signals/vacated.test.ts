// Vacated role + one-game spikes (DESIGN "Fix: vacated role, spikes, depth and roster need (2026-10-28)").
// Synthetic players only (generic ids).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SPIKE, VACATED, settledRole, usageShape, vacatedGames, type VacPlayer } from "./vacated.js";
import { computeAllSignals } from "./index.js";
import { recencyWeights } from "./recency.js";
import { line } from "../testkit.js";
import { PPR } from "../../data/fixtures/signals2026.js";
import type { PlayerGame, PlayerSignalInput, SkillPos } from "./types.js";

const vp = (id: string, pos: string, targets: (number | null)[], extra: Partial<VacPlayer> = {}): VacPlayer => ({
  id,
  name: id,
  pos,
  team: "AAA",
  games: targets.flatMap((t, i) => (t === null ? [] : [{ week: i + 1, team: "AAA", targets: t, carries: 0, snapShare: 0.7 }])),
  ...extra,
});

describe("vacatedGames: a jump while a busier teammate at a competing position was out", () => {
  test("a TE3 whose targets jumped the week the team's WR2 was out → that week is vacated by the WR", () => {
    const te = vp("te3", "TE", [1, 1, 2, 1, 5]);
    const wr = vp("wr2", "WR", [7, 6, 8, 7, null]);
    const m = vacatedGames([te, wr]);
    assert.deepEqual([...(m.get("te3")?.keys() ?? [])], [5]);
    assert.equal(m.get("te3")!.get(5)![0].id, "wr2");
  });
  test("teammate present, lower prior usage, or no longer on the team → not vacated", () => {
    assert.equal(vacatedGames([vp("te3", "TE", [1, 1, 5]), vp("wr2", "WR", [7, 6, 8])]).size, 0, "present");
    assert.equal(vacatedGames([vp("te3", "TE", [1, 1, 5]), vp("wr5", "WR", [1, 1, null])]).size, 0, "less prior usage");
    assert.equal(vacatedGames([vp("te3", "TE", [1, 1, 5]), vp("wr2", "WR", [7, 6, null], { team: "BBB" })]).size, 0, "traded away");
  });
  test("RBs compete with RBs only; a WR out does not vacate an RB's touches", () => {
    const rb2 = vp("rb2", "RB", [3, 3, 9]);
    const wr = vp("wr1", "WR", [9, 9, null]);
    assert.equal(vacatedGames([rb2, wr]).size, 0);
    assert.equal(vacatedGames([rb2, vp("rb1", "RB", [15, 15, null])]).size, 1);
  });
  test("a teammate who left the game early (under 15% snaps after ≥ 50%) counts as out", () => {
    const wr = vp("wr2", "WR", [7, 6, 1]);
    wr.games[2].snapShare = 0.1;
    assert.equal(vacatedGames([vp("te3", "TE", [1, 1, 5]), wr]).get("te3")?.has(3), true);
  });
  test("no earlier game of his own = unknown baseline → never flagged; no jump → never flagged", () => {
    assert.equal(vacatedGames([vp("new", "TE", [null, null, 5]), vp("wr2", "WR", [7, 6, null])]).size, 0);
    assert.equal(vacatedGames([vp("te", "TE", [4, 4, 4]), vp("wr2", "WR", [7, 6, null])]).size, 0);
  });
});

describe("usageShape: higher usage in ≥ 2 of the last 3 games", () => {
  test("one strong game after a quiet role is a spike (watch), its index is capped", () => {
    const s = usageShape([1.5, 1.6, 4.2, 2.7, 5.5, 0.2, 16.2]);
    assert.equal(s.jump, true);
    assert.equal(s.sustained, false);
    assert.equal(s.spike, true);
    assert.deepEqual(s.spikeIdx, [6]);
  });
  test("two of the last three elevated → sustained, no spike", () => {
    const s = usageShape([4, 3.3, 4.1, 3.3, 13, 9.5]);
    assert.equal(s.sustained, true);
    assert.equal(s.spike, false);
  });
  test("a vacated elevated game counts VACATED.weight: two elevated, one borrowed → not sustained", () => {
    const s = usageShape([4, 3.3, 4.1, 3.3, 13, 9.5], [1, 1, 1, 1, 1, VACATED.weight]);
    assert.equal(s.sustained, false);
    assert.equal(s.spike, true);
  });
  test("a 2-game player going 0 → 9.7 is one jump, not a role; 1 game is never sustained", () => {
    assert.equal(usageShape([0, 9.7]).spike, true);
    assert.equal(usageShape([9.7]).sustained, false);
    assert.equal(usageShape([]).spike, false);
  });
  test("a steady starter is neither a jump nor a spike", () => {
    const s = usageShape([12, 11, 13, 12, 12]);
    assert.equal(s.jump, false);
    assert.equal(s.spike, false);
  });
});

test("recencyWeights: a capped game's recency ≤ SPIKE.maxRecency; factors multiply; capped + factor = the stronger one", () => {
  const w = recencyWeights([false, false, false], { capped: new Set([2]), cap: SPIKE.maxRecency, factor: [1, 0.4, 1] });
  assert.equal(w[2], SPIKE.maxRecency);
  assert.ok(Math.abs(w[1] - 0.4 * Math.SQRT1_2) < 1e-12);
  const both = recencyWeights([false, false, false], { capped: new Set([2]), cap: SPIKE.maxRecency, factor: [1, 1, 0.4] });
  assert.equal(both[2], 0.4, "min(cap 0.5, 1 × 0.4), not 0.5 × 0.4");
  const weakFactor = recencyWeights([false, false, false], { capped: new Set([2]), cap: SPIKE.maxRecency, factor: [1, 1, 0.9] });
  assert.equal(weakFactor[2], SPIKE.maxRecency);
});

const ASOF = new Date("2026-10-26T00:00:00Z");
/** A part-time role (40% snaps): a settled ≥ 65%-snap role never spikes (fix round 1), so spike cases use part-timers. */
function input(id: string, pos: SkillPos, targets: (number | null)[], snapShare = 0.4): PlayerSignalInput {
  const games: PlayerGame[] = targets.flatMap((t, i) =>
    t === null
      ? []
      : [{ week: i + 1, gameId: `g${i + 1}`, team: "AAA", targets: t, carries: 0, airYards: t * 10, passAttempts: 0, actual: line({ rec: t * 0.6, recYd: t * 8 }), expected: line({ rec: t * 0.6, recYd: t * 8 }), snapShare }],
  );
  return { id, name: id, pos, team: "AAA", games, status: [] };
}

test("computeAllSignals stamps vacated games: flag, reduced weight, full-weight rate and the spike flag", () => {
  const sig = computeAllSignals([input("te3", "TE", [1, 1, 2, 1, 6]), input("wr2", "WR", [8, 7, 8, 8, null])], { season: 2026, scoring: PPR, asOf: ASOF });
  const te = sig.get("te3")!;
  const last = te.weeks[te.weeks.length - 1];
  assert.equal(last.flags.vacated, true);
  assert.equal(last.flagged, false, "a vacated game stays in the sample and the trend");
  assert.equal(last.flags.spike, true);
  // Spike AND vacated: the stronger single discount (fix round 1), never the product.
  assert.equal(last.weight, Math.min(SPIKE.maxRecency, VACATED.weight));
  assert.deepEqual(te.vacated?.weeks, [5]);
  assert.equal(te.vacated?.by[0].id, "wr2");
  assert.ok(te.vacated!.fullExpPts > te.rates.expPts!, "full-weight rate above the settled one");
  assert.equal(te.spike, true);
  assert.equal(sig.get("wr2")!.vacated, undefined);
});

test("vacatedGames: an absence that started before a quiet game of his does not explain a later jump", () => {
  const te = vp("te2", "TE", [2, 2, 2, 2, 2, 6]);
  const longOut = vp("te1", "TE", [5, 6, 5, null, null, null]);
  assert.equal(vacatedGames([te, longOut]).size, 0, "quiet weeks 4–5 while te1 was already out");
  const fresh = vp("te1", "TE", [5, 6, 5, 5, 5, null]);
  assert.equal(vacatedGames([te, fresh]).get("te2")?.has(6), true);
  // Two straight jumps during one absence: both are vacated.
  const two = vacatedGames([vp("te2", "TE", [2, 2, 2, 2, 6, 6]), vp("te1", "TE", [5, 6, 5, 5, null, null])]);
  assert.deepEqual([...two.get("te2")!.keys()], [5, 6]);
});

test("a climbing opportunity share (WOPR up 3 straight games) is a breakout, not a spike: no cap", () => {
  // WOPR needs team totals: 35 targets / 250 air yards a game.
  const withTotals = (t: number[]) => {
    const p = input("wr", "WR", t);
    p.games = p.games.map((g) => ({ ...g, teamTotals: { targets: 35, airYards: 250, carries: 25 } }));
    return computeAllSignals([p], { season: 2026, scoring: PPR, asOf: ASOF }).get("wr")!;
  };
  const rising = withTotals([6, 6, 6, 6, 7, 9, 14]);
  assert.equal(rising.weeks.some((w) => w.flags.spike), false, "climbing share: not capped");
  const flat = withTotals([6, 6, 6, 6, 6, 6, 14]);
  assert.equal(flat.weeks[6].flags.spike, true, "one jump after a flat role: capped");
});

describe("fix round 1: a known bigger role, his current team, one spike definition", () => {
  test("a one-game teammate sample counts only with last season's role behind it (≥ 4 games)", () => {
    const te = vp("te3", "TE", [1, 1, 5]);
    const oneGame = vp("wr2", "WR", [null, 7, null]);
    assert.equal(vacatedGames([te, oneGame]).size, 0, "one game is unknown");
    const withPrior = { ...oneGame, prior: { games: 15, opps: { targets: 105, carries: 0 } } };
    assert.equal(vacatedGames([te, withPrior]).get("te3")?.has(3), true, "7 targets/g last season: a known bigger role");
    const thinPrior = { ...oneGame, prior: { games: 3, opps: { targets: 21, carries: 0 } } };
    assert.equal(vacatedGames([te, thinPrior]).size, 0, "a 3-game last season is not a role");
  });
  test("only games for his current team can be borrowed", () => {
    const moved = vp("te3", "TE", [1, 1, 5], { team: "BBB" });
    assert.equal(vacatedGames([moved, vp("wr2", "WR", [7, 6, null])]).size, 0);
  });
  test("back from his own absence (missed the team's previous game) → not borrowed", () => {
    const te = vp("te3", "TE", [1, 1, null, 5]);
    const wr = vp("wr2", "WR", [7, 6, 7, null]);
    assert.equal(vacatedGames([te, wr]).size, 0);
    // Control: he played week 3 → week 4 is borrowed.
    assert.equal(vacatedGames([vp("te3", "TE", [1, 1, 1, 5]), wr]).get("te3")?.has(4), true);
  });
  test("usageShape: a bigger latest game never makes the game before it less elevated", () => {
    for (const last of [12, 20, 40]) assert.equal(usageShape([2, 2, 2, 2, 3, 5, last]).sustained, true, `latest ${last}`);
    // A higher game that collapsed below the old role did not hold; a fall after a peak is not elevated.
    assert.deepEqual(usageShape([1.5, 1.6, 4.2, 2.7, 5.5, 0.2, 16.2]).spikeIdx, [6]);
    assert.deepEqual(usageShape([3, 3, 3, 16.2, 5.5, 6]).elevated, [true, false, false]);
  });
  test("settled role: QBs and ≥ 65% snaps over the last 4 games never spike; unknown snaps are not settled", () => {
    const series = [8, 8, 8, 8, 8, 8, 20];
    assert.equal(usageShape(series).spike, true);
    assert.equal(usageShape(series, undefined, { pos: "QB" }).spike, false);
    assert.equal(usageShape(series, undefined, { pos: "WR", snaps: series.map(() => 0.7) }).spike, false);
    assert.deepEqual(usageShape(series, undefined, { pos: "WR", snaps: series.map(() => 0.7) }).spikeIdx, []);
    assert.equal(usageShape(series, undefined, { pos: "WR", snaps: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.9] }).spike, true, "one fill-in game");
    assert.equal(usageShape(series, undefined, { pos: "WR", snaps: series.map(() => undefined) }).spike, true);
    assert.equal(settledRole("WR", [undefined, 0.9]), false, "one known game is not a role");
  });
  test("computeAllSignals keeps his signals without borrowed-role detection (`vacated.own`) for the projection", () => {
    const sig = computeAllSignals([input("te3", "TE", [1, 1, 2, 1, 6]), input("wr2", "WR", [8, 7, 8, 8, null])], { season: 2026, scoring: PPR, asOf: ASOF });
    const alone = computeAllSignals([input("te3", "TE", [1, 1, 2, 1, 6])], { season: 2026, scoring: PPR, asOf: ASOF }).get("te3")!;
    const own = sig.get("te3")!.vacated!.own;
    assert.equal(own.vacated, undefined);
    assert.equal(own.rates.expPts, alone.rates.expPts);
    assert.deepEqual(own.weeks.map((w) => w.weight), alone.weeks.map((w) => w.weight));
  });
  test("a climb over the last 3 games (steps ≥ climbStep, latest elevated) is a rising role, not a spike", () => {
    // 2.4 → 6.0 → 17.1 after a ~4.7 role: 6.0 is under the bar, yet the opportunity rose 3 straight games.
    const s = usageShape([7.6, 4.3, 4.0, 3.0, 2.4, 6.0, 17.1]);
    assert.equal(s.spike, false);
    assert.equal(s.sustained, true);
    assert.deepEqual(s.spikeIdx, []);
    assert.equal(usageShape([4, 4, 4, 4, 4, 4.5, 17]).spike, true, "a 0.5-pt step is noise, not a climb");
    assert.equal(usageShape([4, 4, 4, 4, 2.4, 6, 17.1], [1, 1, 1, 1, 1, 0.4, 0.4]).sustained, false, "a borrowed climb is not his role");
  });
  test("a game he left early neither voids an earlier high game nor unsettles his role", () => {
    const exp = [9, 6.6, 6.5, 19.9, 1.3, 12];
    const snaps = [0.66, 0.69, 0.85, 0.83, 0.03, 0.76];
    assert.equal(settledRole("TE", snaps), true, "0.03 left-early game ignored: 81% snaps");
    assert.equal(usageShape(exp, undefined, { pos: "TE", snaps: snaps.map((x) => Math.min(x, 0.5)).map((x, i) => (i === 4 ? 0.03 : x)) }).sustained, true);
  });
});

describe("fix round 2: a settled role is established on the games BEFORE the candidate spike", () => {
  /** An RB game whose expected points are `pts` (rushing, 0.1/yd) on `snap` of the snaps. */
  const rb = (week: number, pts: number, snap: number): PlayerGame => {
    const ex = line({ rushYd: pts * 10 });
    return { week, gameId: `g${week}`, team: "AAA", targets: 0, carries: Math.round(pts), airYards: 0, passAttempts: 0, actual: ex, expected: ex, snapShare: snap };
  };
  const sigOf = (id: string, pos: SkillPos, games: PlayerGame[]) =>
    computeAllSignals([{ id, name: id, pos, team: "AAA", games, status: [] }], { season: 2026, scoring: PPR, asOf: ASOF }).get(id)!;

  test("a part-time RB whose snaps rose to ~76% only in the last games (48% → 76% → 75%) with one huge game is capped", () => {
    const pts = [8, 8, 8, 8, 8, 8, 24];
    const snaps = [0.42, 0.4, 0.44, 0.48, 0.76, 0.75, 0.8];
    // The window that includes the spike week would call him settled (0.48, 0.76, 0.75, 0.80 = 70%)...
    assert.equal(settledRole("RB", snaps), true, "control: the spike week lifts the old window over 65%");
    // ...the 4 games before it do not (0.40, 0.44, 0.48 … 0.76, 0.75: 61%): he cannot self-exempt with his spike.
    assert.equal(settledRole("RB", snaps.slice(0, 6)), false);
    const shape = usageShape(pts, undefined, { pos: "RB", snaps });
    assert.equal(shape.spike, true);
    assert.deepEqual(shape.spikeIdx, [6]);
    const s = sigOf("rbP", "RB", pts.map((p, i) => rb(i + 1, p, snaps[i])));
    assert.deepEqual(s.weeks.filter((w) => w.flags.spike).map((w) => w.week), [7], "projection caps the spike week");
    assert.ok(s.weeks[6].weight <= SPIKE.maxRecency + 1e-9);
  });

  test("a spike in the middle of the window is judged on the games before IT, not the games after", () => {
    // Settled games after the spike (80%) do not exempt a spike that came out of a 40% role.
    const pts = [8, 8, 8, 8, 24, 8, 8];
    const snaps = [0.4, 0.4, 0.4, 0.4, 0.8, 0.8, 0.8];
    assert.deepEqual(usageShape(pts, undefined, { pos: "RB", snaps }).spikeIdx, [4]);
  });

  test("a long-settled every-down RB / WR with one big game stays exempt; QBs stay exempt without snaps", () => {
    const pts = [12, 13, 12, 14, 12, 13, 30];
    for (const pos of ["RB", "WR"] as const) {
      const snaps = pts.map(() => 0.85);
      const shape = usageShape(pts, undefined, { pos, snaps });
      assert.equal(shape.spike, false, `${pos}: settled before the spike`);
      assert.deepEqual(shape.spikeIdx, []);
      // Spike game in the middle of the window, settled before it.
      assert.deepEqual(usageShape([12, 13, 12, 14, 30, 12, 13], undefined, { pos, snaps }).spikeIdx, [], `${pos}: mid-window`);
    }
    const s = sigOf("rbS", "RB", pts.map((p, i) => rb(i + 1, p, 0.85)));
    assert.deepEqual(s.weeks.filter((w) => w.flags.spike).map((w) => w.week), []);
    assert.equal(usageShape(pts, undefined, { pos: "QB" }).spike, false, "QB, no snaps known");
  });

  test("no known snaps before the spike (fewer than 2 games) is not a settled role", () => {
    // Base = the lowest window game with < 4 games; the spike is game 2, with one known game before it.
    assert.equal(usageShape([4, 20, 5], undefined, { pos: "RB", snaps: [0.9, 0.9, 0.9] }).spike, true);
  });
});
