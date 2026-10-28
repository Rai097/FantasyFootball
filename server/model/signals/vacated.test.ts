// Vacated role + one-game spikes (DESIGN "Fix: vacated role, spikes, depth and roster need (2026-10-28)").
// Synthetic players only (generic ids).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SPIKE, VACATED, usageShape, vacatedGames, type VacPlayer } from "./vacated.js";
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

test("recencyWeights: a capped game's recency ≤ SPIKE.maxRecency; factors multiply", () => {
  const w = recencyWeights([false, false, false], { capped: new Set([2]), cap: SPIKE.maxRecency, factor: [1, 0.4, 1] });
  assert.equal(w[2], SPIKE.maxRecency);
  assert.ok(Math.abs(w[1] - 0.4 * Math.SQRT1_2) < 1e-12);
});

const ASOF = new Date("2026-10-26T00:00:00Z");
function input(id: string, pos: SkillPos, targets: (number | null)[]): PlayerSignalInput {
  const games: PlayerGame[] = targets.flatMap((t, i) =>
    t === null
      ? []
      : [{ week: i + 1, gameId: `g${i + 1}`, team: "AAA", targets: t, carries: 0, airYards: t * 10, passAttempts: 0, actual: line({ rec: t * 0.6, recYd: t * 8 }), expected: line({ rec: t * 0.6, recYd: t * 8 }), snapShare: 0.7 }],
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
  assert.equal(last.weight, SPIKE.maxRecency * VACATED.weight);
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
