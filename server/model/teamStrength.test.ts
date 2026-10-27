import { test } from "node:test";
import assert from "node:assert/strict";
import { DEPTH_WEIGHT, teamStrength } from "./teamStrength.js";
import { league, vp } from "./testkit.js";
import type { SlotKind, ValuedPlayer } from "./types.js";

// Week 8 of a season whose playoffs run 15-17; weekly points start at week 8.
const SLOTS: SlotKind[] = ["QB", "RB", "WR", "FLEX", "BN", "BN", "IR"];
const S = league([], SLOTS, { currentWeek: 8 }).settings;
/** A player scoring `pts` every week 8..17 except the listed weeks (0). */
const P = (id: string, pos: ValuedPlayer["pos"], pts: number, zero: number[] = []) =>
  vp(id, pos, pts, 10, { weeklyFrom: 8, weekly: Array.from({ length: 10 }, (_, i) => (zero.includes(8 + i) ? 0 : pts)) });

test("lineup = mean optimal playoff-week lineup; a playoff bye costs that week", () => {
  const roster = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("wr2", "WR", 10)];
  const t = teamStrength(S, roster);
  assert.deepEqual(t.weeks, [15, 16, 17]);
  assert.equal(t.lineup, 59);
  const bye = teamStrength(S, [P("qb", "QB", 20), P("rb", "RB", 15, [16]), P("wr", "WR", 14), P("wr2", "WR", 10)]);
  assert.equal(bye.lineup, 59 - 15 / 3);
});

test("depth: bench points recovered when one random starter is out; total = lineup + 0.25 × depth", () => {
  const thin = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("wr2", "WR", 10)];
  // No bench: losing any starter recovers nothing.
  assert.equal(teamStrength(S, thin).depth, 0);
  const deep = [...thin, P("rb2", "RB", 9)];
  const t = teamStrength(S, deep);
  // Starters QB 20, RB 15, WR 14, FLEX WR2 10 (rb2 9 on the bench). Out QB: nobody covers (0). Out RB: rb2 → +9.
  // Out WR: wr2 moves to WR, rb2 FLEX → +9. Out FLEX wr2: rb2 → +9. Mean = 27 / 4 = 6.75.
  assert.equal(t.depth, 6.8);
  assert.equal(t.total, Math.round((59 + DEPTH_WEIGHT * 6.75) * 10) / 10);
});

test("IR-slot players never count; after the season everything is 0", () => {
  const roster = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("star", "WR", 30)];
  const withIr = teamStrength(S, roster, new Set(["star"]));
  assert.equal(withIr.lineup, 49);
  assert.equal(teamStrength(S, roster).lineup, 79);
  const late = league([], SLOTS, { currentWeek: 18 }).settings;
  assert.deepEqual(teamStrength(late, roster), { lineup: 0, depth: 0, total: 0, weeks: [] });
});

// Injured trade pieces fix round 1 (owner 2026-10-26): a returner counts at his expected availability in the playoffs.
const back = (id: string, pts: number, week: number) =>
  P(id, "WR", pts, Array.from({ length: week - 8 }, (_, i) => 8 + i));
test("IR slot: a player back ~wk 12 counts in the playoff lineup from his return (he leaves the IR slot); out for the season or no return estimate never", () => {
  const base = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("wr2", "WR", 10)];
  const star = back("star", 30, 12);
  star.ret = { week: 12, confidence: "medium", reasons: [], absent: true, practiceUp: false };
  const ir = new Set(["star"]);
  // Playoff lineup: QB 20 + RB 15 + WR star 30 + FLEX wr 14 = 79 (wr2 to the bench).
  assert.equal(teamStrength(S, [...base, star], ir).lineup, 79);
  const done = { ...star, ret: { ...star.ret, seasonOver: true as const } };
  assert.equal(teamStrength(S, [...base, done], ir).lineup, 59, "out for the season: never");
  const { ret: _r, ...noRet } = star;
  assert.equal(teamStrength(S, [...base, noRet], ir).lineup, 59, "no return estimate: never");
});

// Injured trade pieces fix round 2: an unconfirmed return is a scenario mix, p × lineup(back at full rate from week
// current + 4) + (1 − p) × lineup(without him), p = ½ — never a ½-rate player inside one lineup.
const UNK = (id: string, healthy: number, o: Partial<ValuedPlayer> = {}): ValuedPlayer =>
  vp(id, "WR", 0, 0, {
    remainingGames: 0, weeklyFrom: 8, weekly: Array(10).fill(0),
    ret: { week: null, confidence: "unknown", reasons: [], absent: true, practiceUp: false, healthyRate: healthy, tradeValue: 30, backWeekly: [0, 0, 0, 0, ...Array(6).fill(healthy)] },
    ...o,
  });
test("return unconfirmed: ½ × lineup with him back (ret.backWeekly from week current + 4) + ½ × lineup without him, in or out of the IR slot", () => {
  const base = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("wr2", "WR", 10)];
  const unk = UNK("unk", 28);
  // Back: unk 28 starts at WR, wr 14 FLEX, wr2 10 benched → 77; not back: 59 → ½ × 77 + ½ × 59 = 68.
  assert.equal(teamStrength(S, [...base, unk]).lineup, 68);
  assert.equal(teamStrength(S, [...base, unk], new Set(["unk"])).lineup, 68);
  // Fixture without backWeekly: the same scenario from the healthy rate (byes 0).
  const { backWeekly: _e, ...ret } = unk.ret!;
  assert.equal(teamStrength(S, [...base, { ...unk, ret }]).lineup, 68);
  assert.equal(teamStrength(S, [...base, { ...unk, ret: { ...ret, seasonOver: true as const } }]).lineup, 59, "out for the season: 0");
});

test("Jensen case: a 12-ppg returner over a 9.6 FLEX is worth ½ × (12 − 9.6) per playoff week, not 0 (½ × 12 = 6 never starts)", () => {
  const base = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("flex", "WR", 9.6)];
  const without = teamStrength(S, base).lineup;
  const withHim = teamStrength(S, [...base, UNK("u", 12)]).lineup;
  assert.ok(Math.abs(withHim - without - 0.5 * (12 - 9.6)) < 0.051, `${withHim} − ${without}`);
});

test("a returner who would start at any rate is worth ½ × his rate per playoff week", () => {
  const base = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14)]; // FLEX empty without him
  assert.ok(Math.abs(teamStrength(S, [...base, UNK("u", 11)]).lineup - teamStrength(S, base).lineup - 5.5) < 0.051);
});

test("depth under the mix: bench cover is each scenario's cover weighted by its probability", () => {
  const base = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("wr2", "WR", 10)];
  // Not back: no bench (depth 0). Back: unk 28 WR, wr 14 FLEX, wr2 10 bench; out QB 0, out RB 0 (no RB), out unk 10
  // (wr to WR, wr2 FLEX), out wr 10 → 20 recovered over 4 starters. Mixed: (½ × 20) / (½ × 4 + ½ × 4) = 2.5.
  assert.equal(teamStrength(S, [...base, UNK("unk", 28)]).depth, 2.5);
});

test("k > 2 unconfirmed returns: top 2 mixed exactly, the rest at expected points — between the all-½ lineup and the exact 2^k mix", () => {
  // One WR + one FLEX open behind nobody: three 12-pt returners compete for two slots.
  const base = [P("qb", "QB", 20), P("rb", "RB", 15)];
  const three = [UNK("a", 12), UNK("b", 12), UNK("c", 12)];
  const got = teamStrength(S, [...base, ...three]).lineup - teamStrength(S, base).lineup;
  // Exact: P(0 back) = 1/8 → 0, P(1) = 3/8 → 12, P(≥ 2) = 4/8 → 24 → 4.5 + 12 = 16.5.
  const exact = (3 / 8) * 12 + (4 / 8) * 24;
  // All deterministic at ½: two 6-pt players start → 12.
  const allHalf = 12;
  assert.ok(got >= allHalf - 0.05 && got <= exact + 0.05, `k=3 gain ${got}: expected within [${allHalf}, ${exact}]`);
  // Here: a, b mixed exactly, c at 6: 0 back → c 6; one back → 12 + 6; both → 24 → ¼ × 6 + ½ × 18 + ¼ × 24 = 16.5.
  assert.ok(Math.abs(got - 16.5) < 0.051, `${got}`);
  // Four returners for two slots: still bounded by the exact mix (1 − P(<2 back)) and never above two full starters.
  const four = [...three, UNK("d", 12)];
  const g4 = teamStrength(S, [...base, ...four]).lineup - teamStrength(S, base).lineup;
  const exact4 = (4 / 16) * 12 + (11 / 16) * 24;
  assert.ok(g4 >= allHalf - 0.05 && g4 <= exact4 + 0.05 && g4 <= 24, `k=4 gain ${g4} vs exact ${exact4}`);
});

test("a confirmed return stays deterministic: his projection's own weekly points from the return week", () => {
  const base = [P("qb", "QB", 20), P("rb", "RB", 15), P("wr", "WR", 14), P("wr2", "WR", 10)];
  const conf = { ...back("c", 28, 12), ret: { week: 12, confidence: "medium" as const, reasons: [], absent: true, practiceUp: false, healthyRate: 28 } };
  assert.equal(teamStrength(S, [...base, conf]).lineup, 77);
});
