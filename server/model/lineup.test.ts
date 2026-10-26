import { test } from "node:test";
import assert from "node:assert/strict";
import { optimalLineup, slotLabels } from "./lineup.js";
import { SMALL_SLOTS, vp } from "./testkit.js";
import type { SlotKind } from "./types.js";

const roster = [
  vp("qb1", "QB", 20, 30), vp("qb2", "QB", 18, 10),
  vp("rb1", "RB", 15, 40), vp("rb2", "RB", 12, 25), vp("rb3", "RB", 11, 20),
  vp("wr1", "WR", 14, 35), vp("wr2", "WR", 10, 15), vp("wr3", "WR", 9, 12),
  vp("te1", "TE", 8, 10), vp("te2", "TE", 7.5, 5),
  vp("k1", "K", 8, 2), vp("d1", "DEF", 7, 3),
];

test("exact slots first, FLEX takes best remaining RB/WR/TE", () => {
  const { lineup, bench, starterPpg } = optimalLineup(SMALL_SLOTS, roster);
  const ids = lineup.map((l) => l.player?.id);
  assert.deepEqual(ids, ["qb1", "rb1", "rb2", "wr1", "wr2", "te1", "rb3", "k1", "d1"]);
  assert.equal(lineup.length, 9); // BN / IR are not lineup slots
  assert.equal(starterPpg, 20 + 15 + 12 + 14 + 10 + 8 + 11 + 8 + 7);
  assert.deepEqual(bench.map((p) => p.id), ["wr3", "qb2", "te2"]); // sorted by value
  assert.deepEqual(slotLabels(lineup), ["QB", "RB1", "RB2", "WR1", "WR2", "TE", "FLEX", "K", "DEF"]);
});

test("superflex takes the second QB over a lesser RB/WR", () => {
  const slots: SlotKind[] = ["QB", "RB", "WR", "TE", "SFLEX", "FLEX"];
  const { lineup } = optimalLineup(slots, roster);
  const bySlot = Object.fromEntries(lineup.map((l) => [l.slot, l.player?.id]));
  assert.equal(bySlot.SFLEX, "qb2");
  assert.equal(bySlot.FLEX, "rb2"); // FLEX (narrower) filled before SFLEX
});

test("narrow flex slots fill before wide ones (WRRB, RFLEX before FLEX)", () => {
  const slots: SlotKind[] = ["WR", "RFLEX", "WRRB", "FLEX"];
  const { lineup } = optimalLineup(slots, roster);
  const bySlot = Object.fromEntries(lineup.map((l) => [l.slot, l.player?.id]));
  assert.equal(bySlot.WR, "wr1");
  assert.equal(bySlot.WRRB, "rb1");
  assert.equal(bySlot.RFLEX, "wr2");
  assert.equal(bySlot.FLEX, "rb2");
});

test("players with no games left only start when nothing else is eligible", () => {
  const hurt = vp("rbHurt", "RB", 25, 0, { remainingGames: 0 });
  const r = optimalLineup(["RB", "RB"], [hurt, vp("rbA", "RB", 6, 1)]);
  assert.deepEqual(r.lineup.map((l) => l.player?.id), ["rbA", "rbHurt"]);
  assert.equal(r.starterPpg, 6); // unusable starter contributes 0
  const empty = optimalLineup(["TE"], [vp("x", "RB", 5, 1)]);
  assert.equal(empty.lineup[0].player, null);
});

test("lineup selection and starterPpg use availability-adjusted effPpg", () => {
  // Out QB: 20 ppg healthy rate but only 11 of 13 games left → 16.9 effective; healthy 18 ppg QB starts.
  const outQb = vp("qbOut", "QB", 20, 30, { remainingGames: 11, effPpg: (20 * 11) / 13 });
  const r = optimalLineup(["QB"], [outQb, vp("qbOk", "QB", 18, 20, { effPpg: 18 })]);
  assert.equal(r.lineup[0].player?.id, "qbOk");
  assert.equal(r.starterPpg, 18);
  const only = optimalLineup(["QB"], [outQb]);
  assert.equal(only.starterPpg, Math.round(((20 * 11) / 13) * 100) / 100);
  assert.equal(outQb.ppg, 20, "ppg unchanged");
});

test("injuryRisk: a Questionable starter is discounted ×0.85 and loses a close call; off by default", () => {
  // WR2 at 10 ppg is Questionable (→ 8.5) vs a healthy 9 ppg WR3.
  const q = roster.map((p) => (p.id === "wr2" ? { ...p, injury: { status: "Q", week: 4 } } : p));
  const plain = optimalLineup(SMALL_SLOTS, q);
  assert.ok(plain.lineup.some((l) => l.player?.id === "wr2"), "default ignores injury status");
  assert.ok(plain.lineup.every((l) => l.riskFactor === undefined));

  const adj = optimalLineup(SMALL_SLOTS, q, { injuryRisk: true });
  const ids = adj.lineup.map((l) => l.player?.id);
  assert.ok(ids.includes("wr3") && !ids.includes("wr2"), "healthy 9 ppg beats Q 10 × 0.85");
  assert.equal(adj.starterPpg, 20 + 15 + 12 + 14 + 9 + 8 + 11 + 8 + 7);

  // A clear Q starter still starts, flagged and totalled at the discounted rate; the player object is untouched.
  const star = roster.map((p) => (p.id === "wr1" ? { ...p, injury: { status: "Questionable", week: 4 } } : p));
  const s = optimalLineup(SMALL_SLOTS, star, { injuryRisk: true });
  const slot = s.lineup.find((l) => l.player?.id === "wr1")!;
  assert.equal(slot.riskFactor, 0.85);
  assert.equal(slot.player!.ppg, 14);
  assert.ok(Math.abs(s.starterPpg - (20 + 15 + 12 + 14 * 0.85 + 10 + 8 + 11 + 8 + 7)) < 0.01);
});

test("irIds: an IR-slotted healthy player never starts, stays on the bench, adds nothing to starterPpg", () => {
  const plain = optimalLineup(SMALL_SLOTS, roster);
  assert.ok(plain.lineup.some((l) => l.player?.id === "wr1"), "fixture: wr1 starts when not on IR");
  const r = optimalLineup(SMALL_SLOTS, roster, { irIds: new Set(["wr1"]) });
  assert.ok(!r.lineup.some((l) => l.player?.id === "wr1"));
  assert.ok(r.bench.some((p) => p.id === "wr1"), "IR player stays on the bench list");
  assert.ok(r.starterPpg < plain.starterPpg);
  // Only eligible player at the slot and on IR: the slot stays empty rather than starting him.
  const only = optimalLineup(["TE"], [vp("t", "TE", 9, 5)], { irIds: new Set(["t"]) });
  assert.equal(only.lineup[0].player, null);
  assert.equal(only.starterPpg, 0);
});
