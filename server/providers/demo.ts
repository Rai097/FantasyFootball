// Demo provider: a 12-team half-PPR league drafted from real FantasyPros ECR
// with a seeded snake draft. Deterministic for a given seed + player data.
import type { League, Player, Position, SlotKind, Team } from "../model/types.js";
import { HALF_PPR } from "../model/scoring.js";

export const DEMO_SLOTS: SlotKind[] = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR"];
export const DEMO_TEAMS: { name: string; owner: string }[] = [
  { name: "Tuesday Waiver Warriors", owner: "You" },
  { name: "Gridiron Gurus", owner: "Alex" },
  { name: "Hail Mary Heroes", owner: "Brooke" },
  { name: "Fourth & Long", owner: "Carlos" },
  { name: "Red Zone Rebels", owner: "Dana" },
  { name: "Blitz Brigade", owner: "Eli" },
  { name: "Pick Six Pack", owner: "Fatima" },
  { name: "The Audibles", owner: "Grant" },
  { name: "Two-Minute Drill", owner: "Hana" },
  { name: "Sack Lunch", owner: "Ivan" },
  { name: "Goal Line Stand", owner: "Jess" },
  { name: "Flea Flickers", owner: "Kofi" },
];
const PICK_WEIGHTS = [0.55, 0.25, 0.12, 0.08];
const CAPS: Record<Position, number> = { QB: 2, RB: 7, WR: 7, TE: 2, K: 1, DEF: 1 };
/** Share of the ECR top-150 left undrafted (in-season risers), picked from board ranks 31–150. */
export const UNDRAFTED_TOP = 150;
export const UNDRAFTED_FROM = 31;
export const UNDRAFTED_SHARE = 0.1;

/**
 * Skill players from the ECR top-150 who go undrafted in this seed's league, so the
 * demo waiver wire has real targets. Deterministic per seed (own PRNG stream).
 */
export function undraftedPicks(board: Player[], seed: number): Set<string> {
  const rng = prng((seed ^ 0x5bd1e995) >>> 0);
  const top = board.slice(0, UNDRAFTED_TOP);
  const count = Math.round(UNDRAFTED_SHARE * top.length);
  const window = top.slice(UNDRAFTED_FROM - 1).filter((p) => p.pos !== "K" && p.pos !== "DEF");
  for (let i = window.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [window[i], window[j]] = [window[j], window[i]];
  }
  return new Set(window.slice(0, count).map((p) => p.id));
}

/** mulberry32 seeded PRNG → [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DemoInput {
  season: number;
  currentWeek: number;
  players: Iterable<Player>;
  builtAt?: string;
}

/** ECR draft board: redraft-overall order, then players with only a positional rank. */
export function draftBoard(players: Iterable<Player>): Player[] {
  const all = [...players].filter((p) => p.ecrOverall !== undefined || p.ecrPos !== undefined);
  const overall = all.filter((p) => p.ecrOverall !== undefined).sort((a, b) => a.ecrOverall! - b.ecrOverall! || a.id.localeCompare(b.id));
  const posOnly = all.filter((p) => p.ecrOverall === undefined).sort((a, b) => a.ecrPos! - b.ecrPos! || a.id.localeCompare(b.id));
  return overall.concat(posOnly);
}

/** Starting requirements not yet met by a roster (FLEX counted from extra RB/WR/TE). */
function unmet(c: Record<Position, number>) {
  const need: Partial<Record<Position | "FLEX", number>> = {
    QB: Math.max(0, 1 - c.QB),
    RB: Math.max(0, 2 - c.RB),
    WR: Math.max(0, 2 - c.WR),
    TE: Math.max(0, 1 - c.TE),
    K: Math.max(0, 1 - c.K),
    DEF: Math.max(0, 1 - c.DEF),
  };
  const extra = c.RB - Math.min(c.RB, 2) + c.WR - Math.min(c.WR, 2) + c.TE - Math.min(c.TE, 1);
  need.FLEX = extra >= 1 ? 0 : 1;
  const total = Object.values(need).reduce((a, b) => a + (b ?? 0), 0);
  return { need, total };
}

export function buildDemoLeague(input: DemoInput, seed = 42): League {
  const rng = prng(seed);
  const numTeams = DEMO_TEAMS.length;
  const rounds = DEMO_SLOTS.filter((s) => s !== "IR").length;
  const board = draftBoard(input.players);
  // Taken up front, never rostered: ~10% of the top-150 stays on the waiver wire.
  const taken = undraftedPicks(board, seed);
  const rosters: Player[][] = DEMO_TEAMS.map(() => []);

  for (let round = 0; round < rounds; round++) {
    for (let k = 0; k < numTeams; k++) {
      const t = round % 2 === 0 ? k : numTeams - 1 - k;
      const roster = rosters[t];
      const counts: Record<Position, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
      for (const p of roster) counts[p.pos]++;
      const { need, total } = unmet(counts);
      const picksLeft = rounds - round;
      const forced = picksLeft <= total;
      const allowed = (p: Player) => {
        if (counts[p.pos] >= CAPS[p.pos]) return false;
        if (forced) return (need[p.pos] ?? 0) > 0 || ((need.FLEX ?? 0) > 0 && (p.pos === "RB" || p.pos === "WR" || p.pos === "TE"));
        // Kickers and defenses go in the last three rounds, like real drafts.
        if ((p.pos === "K" || p.pos === "DEF") && round < rounds - 3) return false;
        return true;
      };
      const options: Player[] = [];
      for (const p of board) {
        if (taken.has(p.id) || !allowed(p)) continue;
        options.push(p);
        if (options.length === PICK_WEIGHTS.length) break;
      }
      if (!options.length) continue;
      const weights = PICK_WEIGHTS.slice(0, options.length);
      const tw = weights.reduce((a, b) => a + b, 0);
      let x = rng() * tw;
      let pick = options[options.length - 1];
      for (let i = 0; i < options.length; i++) {
        x -= weights[i];
        if (x < 0) {
          pick = options[i];
          break;
        }
      }
      taken.add(pick.id);
      roster.push(pick);
    }
  }

  // Random records for the completed weeks: random pairings, higher random score wins.
  const records = DEMO_TEAMS.map(() => ({ wins: 0, losses: 0, ties: 0, pointsFor: 0 }));
  for (let w = 1; w < input.currentWeek; w++) {
    const order = [...Array(numTeams).keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (let i = 0; i + 1 < order.length; i += 2) {
      const a = order[i];
      const b = order[i + 1];
      const pa = Math.round((85 + rng() * 60) * 10) / 10;
      const pb = Math.round((85 + rng() * 60) * 10) / 10;
      records[a].pointsFor += pa;
      records[b].pointsFor += pb;
      if (pa > pb) (records[a].wins++, records[b].losses++);
      else if (pb > pa) (records[b].wins++, records[a].losses++);
      else (records[a].ties++, records[b].ties++);
    }
  }

  const teams: Team[] = DEMO_TEAMS.map((d, i) => ({
    id: String(i + 1),
    name: d.name,
    owner: d.owner,
    playerIds: rosters[i].map((p) => p.id),
    unmatched: [],
    record: { ...records[i], pointsFor: Math.round(records[i].pointsFor * 10) / 10 },
    irPlayerIds: [],
  }));

  return {
    provider: "demo",
    id: String(seed),
    settings: {
      name: `Demo League (seed ${seed})`,
      season: input.season,
      currentWeek: input.currentWeek,
      regularSeasonEnd: 14,
      finalWeek: 17,
      numTeams,
      slots: DEMO_SLOTS,
      scoring: { ...HALF_PPR },
      isDynasty: false,
      tradeDeadlineWeek: 13,
      usesFaab: false,
    },
    teams,
    myTeamId: "1",
    fetchedAt: input.builtAt ?? new Date().toISOString(),
  };
}

/**
 * Demo waiver wire: every ECR-ranked player not on a roster. All are "on waivers"
 * (rolling list processed Tuesdays). Waiver priority = worst record first.
 */
export function demoFreeAgents(league: League, players: Iterable<Player>): { freeAgents: { player: Player; onWaivers: boolean }[]; myPriority?: number } {
  const rostered = new Set(league.teams.flatMap((t) => t.playerIds));
  const freeAgents = draftBoard(players)
    .filter((p) => !rostered.has(p.id))
    .map((player) => ({ player, onWaivers: true }));
  const order = [...league.teams].sort(
    (a, b) => (a.record?.wins ?? 0) - (b.record?.wins ?? 0) || (a.record?.pointsFor ?? 0) - (b.record?.pointsFor ?? 0) || a.id.localeCompare(b.id),
  );
  const idx = order.findIndex((t) => t.id === league.myTeamId);
  return { freeAgents, myPriority: idx >= 0 ? idx + 1 : undefined };
}
