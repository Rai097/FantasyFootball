// Team analysis for every team in a league. See docs/DESIGN.md "Team analysis".
import type { League, Player, Position, SlotKind, Team, TeamAnalysis, TeamRecord, ValuedPlayer } from "./types.js";
import { FLEX_SLOTS, effPpg, optimalLineup, usable } from "./lineup.js";
import { valuationNotes, valuePlayers, type ProjectionTables, type Valuation, type ValueMode } from "./projectionV4.js";
import { teamStrength } from "./teamStrength.js";

export interface LeagueContext {
  league: League;
  valuation: Valuation;
  /** Value weighting of this context (projection v4: playoffs or balanced). */
  mode: ValueMode;
  players: Map<string, ValuedPlayer>;
  teams: TeamAnalysis[];
  replacement: Record<Position, number>;
  /** League-wide caveats shown once in the UI (e.g. "ECR ranks are PPR; points use league scoring."). */
  notes: string[];
}

export const GROUPS = ["QB", "RB", "WR", "TE", "FLEX", "K", "DEF"] as const;
/** Position group a lineup slot counts toward (FLEX-type slots → "FLEX"; bench / IR → null). */
export const groupOf = (slot: SlotKind): string | null =>
  FLEX_SLOTS.includes(slot) ? "FLEX" : slot === "BN" || slot === "IR" ? null : slot;

/**
 * Power score v2 (docs/DESIGN.md "Power score v2"): projected × projected starter ppg + results × actual points per game
 * this season. Bench strength only breaks ties (then wins).
 */
export const POWER_WEIGHTS = { projected: 0.7, results: 0.3 } as const;

/**
 * Actual fantasy points per game this season = pointsFor / games played, from the standings. null = unknown (no record,
 * no points for, 0 points for after games were played — a standings capture without points, not a real 0 — or no
 * games played yet), never 0.
 */
export function actualPpg(record: TeamRecord | undefined): number | null {
  if (!record || record.pointsFor == null) return null;
  const games = record.wins + record.losses + record.ties;
  return games > 0 && record.pointsFor > 0 ? record.pointsFor / games : null;
}

/** Power score: unknown results fall back to the projection, so such a team ranks on projected starters alone. */
export function powerScore(starterPpg: number, actual: number | null): number {
  return POWER_WEIGHTS.projected * starterPpg + POWER_WEIGHTS.results * (actual ?? starterPpg);
}

/** Bench strength (tie-breaker only): summed VORP of the 3 best playable bench players (pts/game above a waiver-level player). */
export function benchStrength(bench: ValuedPlayer[]): number {
  return bench
    .filter(usable)
    .map((p) => p.vorp)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((a, b) => a + b, 0);
}

/** Ids of the players a team has parked in an IR slot (they never start and are not bench depth). */
export const irSet = (team: Team): Set<string> => new Set(team.irPlayerIds ?? []);

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Resolve a team's roster to ValuedPlayers (ids missing from the map are skipped). */
export function rosterOf(team: Team, players: Map<string, ValuedPlayer>): ValuedPlayer[] {
  const out: ValuedPlayer[] = [];
  for (const id of team.playerIds) {
    const p = players.get(id);
    if (p) out.push(p);
  }
  return out;
}

/** Value every player in `pool` (projection v4, the one valuation) and analyse every team. */
export function analyzeLeague(league: League, pool: Iterable<Player>, tables?: ProjectionTables, mode: ValueMode = "balanced"): LeagueContext {
  const valuation = valuePlayers(league, [...pool], tables, mode);
  const teams = analyzeTeams(league, valuation.players, valuation.replacement);
  return { league, valuation, mode, players: valuation.players, teams, replacement: valuation.replacement, notes: valuationNotes(league) };
}

export function analyzeTeams(league: League, players: Map<string, ValuedPlayer>, replacement: Record<Position, number>): TeamAnalysis[] {
  const S = league.settings;
  const n = league.teams.length;
  const needRank = n - Math.floor(n / 3); // rank strictly worse than this = bottom third (9th+ of 12)

  const base = league.teams.map((team) => {
    const roster = rosterOf(team, players);
    const ir = irSet(team);
    // Lineup on v4 lineup pts/game (its next-game availability already applied); Q / D / Out starters whose game is
    // this week are only marked (`riskFactor`, the "check status" chip).
    // IR-slotted players never start (they stay on `bench` for display) and are not bench depth.
    const { lineup, bench, starterPpg } = optimalLineup(S.slots, roster, { injuryRisk: true, irIds: ir });
    const active = bench.filter((p) => !ir.has(p.id));
    const groups: Record<string, { ppg: number; rank: number; count: number; leagueAvg: number }> = {};
    for (const l of lineup) {
      const g = groupOf(l.slot);
      if (!g) continue;
      groups[g] ??= { ppg: 0, rank: 0, count: 0, leagueAvg: 0 };
      groups[g].ppg += effPpg(l.player);
      groups[g].count += 1;
    }
    const benchValue = bench.reduce((a, p) => a + p.value, 0);
    const totalValue = roster.reduce((a, p) => a + p.value, 0);
    const topBenchVorp = benchStrength(active);
    const resultsPpg = actualPpg(team.record);
    const score = powerScore(starterPpg, resultsPpg);
    return { team, roster, lineup, bench, active, starterPpg, groups, benchValue, totalValue, powerScore: score, topBenchVorp, resultsPpg };
  });

  // League ranks / averages per group.
  const groupNames = new Set(base.flatMap((b) => Object.keys(b.groups)));
  for (const g of groupNames) {
    const vals = base.map((b) => b.groups[g]?.ppg ?? 0);
    const avg = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
    for (const b of base) {
      const gr = b.groups[g];
      if (!gr) continue;
      gr.rank = 1 + vals.filter((v) => v > gr.ppg + 1e-9).length;
      gr.leagueAvg = r2(avg);
      gr.ppg = r2(gr.ppg);
    }
  }

  // Power rank: score (as shown, 2 dp), then bench strength, then wins.
  const order = [...base].sort(
    (a, b) =>
      r2(b.powerScore) - r2(a.powerScore) ||
      r2(b.topBenchVorp) - r2(a.topBenchVorp) ||
      (b.team.record?.wins ?? 0) - (a.team.record?.wins ?? 0) ||
      a.team.id.localeCompare(b.team.id),
  );
  const powerRank = new Map(order.map((b, i) => [b.team.id, i + 1]));

  return base.map((b) => {
    const needs: string[] = [];
    for (const g of GROUPS) {
      const gr = b.groups[g];
      if (!gr) continue;
      const starters = b.lineup.filter((l) => groupOf(l.slot) === g).map((l) => l.player);
      const empty = starters.some((p) => !p || !usable(p));
      const best = starters.reduce<ValuedPlayer | null>((m, p) => (p && (!m || p.ppg > m.ppg) ? p : m), null);
      const belowRepl = !best || best.ppg < replacement[best.pos];
      // K / DEF are streamed: only a need when the slot is empty (or its starter cannot play).
      if (g === "K" || g === "DEF") {
        if (empty) needs.push(g);
      } else if (gr.rank > needRank || belowRepl || empty) needs.push(g);
    }
    const surplus: string[] = [];
    for (const pos of ["QB", "RB", "WR", "TE"] as Position[]) {
      const gr = b.groups[pos] ?? b.groups.FLEX;
      if (!gr || gr.count === 0) continue;
      const perSlotAvg = gr.leagueAvg / gr.count;
      if (b.active.some((p) => p.pos === pos && usable(p) && p.ppg >= perSlotAvg)) surplus.push(pos);
    }
    const byeExposure: Record<number, number> = {};
    for (let w = league.settings.currentWeek; w <= league.settings.finalWeek; w++) {
      byeExposure[w] = b.lineup.filter((l) => l.player && l.player.bye === w).length;
    }
    const injuryFlags = b.roster
      .filter((p) => p.injury || (p.remainingGames === 0 && p.team !== "FA"))
      .map((p) => {
        const inj = p.injury ? `${p.injury.status}${p.injury.detail ? `: ${p.injury.detail}` : ""}` : "no games left";
        return `${p.name} (${p.pos}) — ${inj}${p.remainingGames === 0 ? " · 0 games counted" : ""}`;
      });
    return {
      team: b.team,
      lineup: b.lineup,
      bench: b.bench,
      starterPpg: b.starterPpg,
      benchValue: r1(b.benchValue),
      totalValue: r1(b.totalValue),
      groups: b.groups,
      needs,
      surplus,
      powerRank: powerRank.get(b.team.id)!,
      powerScore: r2(b.powerScore),
      resultsPpg: b.resultsPpg == null ? null : r2(b.resultsPpg),
      benchStrength: r2(b.topBenchVorp),
      byeExposure,
      injuryFlags,
      playoffStrength: teamStrength(S, b.roster, irSet(b.team)),
    };
  });
}
