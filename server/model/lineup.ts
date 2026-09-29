// Optimal lineup + slot eligibility. See docs/DESIGN.md "Lineup".
import type { LineupSlot, Position, SlotKind, ValuedPlayer } from "./types.js";

export const SLOT_ELIGIBILITY: Record<SlotKind, Position[]> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  WRRB: ["RB", "WR"],
  RFLEX: ["WR", "TE"],
  SFLEX: ["QB", "RB", "WR", "TE"],
  BN: [],
  IR: [],
};

/** Order in which slot kinds are filled: exact slots, then flex slots narrow → wide. */
const FILL_ORDER: SlotKind[] = ["QB", "RB", "WR", "TE", "K", "DEF", "WRRB", "RFLEX", "FLEX", "SFLEX"];
export const FLEX_SLOTS: SlotKind[] = ["WRRB", "RFLEX", "FLEX", "SFLEX"];

export const isStartingSlot = (s: SlotKind) => s !== "BN" && s !== "IR";
export const eligible = (slot: SlotKind, pos: Position) => SLOT_ELIGIBILITY[slot].includes(pos);

/** Player can contribute this season (not out for the year, has a projection). */
export const usable = (p: ValuedPlayer) => p.remainingGames > 0 && p.ppg > 0;
/** ppg that counts toward starterPpg (0 for players who cannot play). */
export const effPpg = (p: ValuedPlayer | null) => (p && usable(p) ? p.ppg : 0);

export interface LineupResult {
  lineup: LineupSlot[];
  bench: ValuedPlayer[];
  starterPpg: number;
}

const byStrength = (a: ValuedPlayer, b: ValuedPlayer) =>
  Number(usable(b)) - Number(usable(a)) || b.ppg - a.ppg || b.value - a.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Greedy optimal lineup. Exact slots take the best eligible players first, then
 * flex slots from narrowest to widest. Unusable players (0 games left / 0 ppg)
 * only fill a slot when nothing else is eligible.
 */
export function optimalLineup(slots: SlotKind[], roster: ValuedPlayer[]): LineupResult {
  const starting = slots.map((s, i) => ({ s, i })).filter((x) => isStartingSlot(x.s));
  const sorted = [...roster].sort(byStrength);
  const used = new Set<string>();
  const assigned: (ValuedPlayer | null)[] = new Array(slots.length).fill(null);
  for (const kind of FILL_ORDER) {
    for (const { s, i } of starting) {
      if (s !== kind) continue;
      const pick = sorted.find((p) => !used.has(p.id) && eligible(s, p.pos));
      if (pick) {
        used.add(pick.id);
        assigned[i] = pick;
      }
    }
  }
  const lineup: LineupSlot[] = starting.map(({ s, i }) => ({ slot: s, player: assigned[i] }));
  const bench = roster.filter((p) => !used.has(p.id)).sort((a, b) => b.value - a.value || b.ppg - a.ppg);
  const starterPpg = lineup.reduce((a, l) => a + effPpg(l.player), 0);
  return { lineup, bench, starterPpg: Math.round(starterPpg * 100) / 100 };
}

/** Labels like "RB1", "RB2", "FLEX" for a lineup (numbered when a slot kind repeats). */
export function slotLabels(lineup: { slot: SlotKind }[]): string[] {
  const total: Record<string, number> = {};
  for (const l of lineup) total[l.slot] = (total[l.slot] ?? 0) + 1;
  const seen: Record<string, number> = {};
  return lineup.map((l) => {
    seen[l.slot] = (seen[l.slot] ?? 0) + 1;
    return total[l.slot] > 1 ? `${l.slot}${seen[l.slot]}` : l.slot;
  });
}
