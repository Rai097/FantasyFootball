// League tab: standings, power rankings split into their two parts, and "who is above me and why".
// Pure: built from the TeamAnalysis rows analysis.ts already computes. See docs/DESIGN.md "League tab".
import type { Position, TeamAnalysis, TeamRecord, ValuedPlayer } from "./types.js";
import { GROUPS, POWER_WEIGHTS, groupOf } from "./analysis.js";

export interface LeagueTeamRow {
  id: string;
  name: string;
  owner: string;
  mine: boolean;
  powerRank: number;
  powerScore: number;
  /** POWER_WEIGHTS.starter × starterPpg. */
  starterPart: number;
  /** POWER_WEIGHTS.bench × benchStrength. */
  benchPart: number;
  starterPpg: number;
  benchStrength: number;
  /** Standings place by record; null = unknown (no record captured). */
  standingsRank: number | null;
  /** "6-1" / "6-1-1"; "—" when unknown (never "0-0"). */
  record: string;
  pointsFor: number | null;
  pointsAgainst: number | null;
}

export interface GroupGap {
  group: string;
  theirs: number;
  mine: number;
  /** theirs − mine (starter ppg). */
  gap: number;
}

export interface KeyPlayer {
  id: string;
  name: string;
  pos: Position;
  ppg: number;
}

export interface TeamComparison {
  teamId: string;
  name: string;
  powerRank: number;
  standingsRank: number | null;
  record: string;
  /** Their power score − mine (= starterPartGap + benchPartGap). */
  powerGap: number;
  starterGap: number;
  benchGap: number;
  starterPartGap: number;
  benchPartGap: number;
  /** Per position group, in the fixed GROUPS order (chart order). */
  groups: GroupGap[];
  /** Their top-2 starters at the (up to 2) groups where they lead you most. */
  keyPlayers: { group: string; gap: number; players: KeyPlayer[] }[];
  /** One line, ≤ 255 chars. */
  summary: string;
}

export interface LeagueView {
  myTeamId: string;
  numTeams: number;
  weights: { starter: number; bench: number };
  /** False when no team has a record (standings were not captured). */
  standingsKnown: boolean;
  /** Every team, by power rank. */
  teams: LeagueTeamRow[];
  /** Teams with a better power rank than mine, best first. */
  above: TeamComparison[];
  /** Teams with a worse power rank, best first. */
  below: TeamComparison[];
  /** Header line, ≤ 255 chars. */
  summary: string;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const sgn = (x: number) => `${x > 0 ? "+" : x < 0 ? "-" : ""}${Math.abs(r1(x)).toFixed(1)}`;
const ord = (n: number) => {
  const v = n % 100;
  return `${n}${v >= 11 && v <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
};

export function recordText(r?: TeamRecord): string {
  if (!r) return "—";
  return r.ties ? `${r.wins}-${r.losses}-${r.ties}` : `${r.wins}-${r.losses}`;
}

/**
 * Standings place per team id. The source's own ranks when every team with a record has one; otherwise win% (a tie =
 * half a win), then points for. Teams without a record get null (unknown), never a guessed place.
 */
export function standingsRanks(teams: TeamAnalysis[]): Map<string, number | null> {
  const withRec = teams.filter((t) => t.team.record);
  const out = new Map<string, number | null>(teams.map((t) => [t.team.id, null]));
  if (withRec.length && withRec.every((t) => t.team.record!.rank != null)) {
    for (const t of withRec) out.set(t.team.id, t.team.record!.rank!);
    return out;
  }
  const pct = (r: TeamRecord) => {
    const g = r.wins + r.losses + r.ties;
    return g ? (r.wins + 0.5 * r.ties) / g : 0;
  };
  const sorted = [...withRec].sort(
    (a, b) =>
      pct(b.team.record!) - pct(a.team.record!) ||
      (b.team.record!.pointsFor ?? -1) - (a.team.record!.pointsFor ?? -1) ||
      a.team.id.localeCompare(b.team.id),
  );
  sorted.forEach((t, i) => out.set(t.team.id, i + 1));
  return out;
}

function topStarters(t: TeamAnalysis, group: string): KeyPlayer[] {
  return t.lineup
    .filter((l) => l.player && groupOf(l.slot) === group)
    .map((l) => l.player as ValuedPlayer)
    .sort((a, b) => b.ppg - a.ppg)
    .slice(0, 2)
    .map((p) => ({ id: p.id, name: p.name, pos: p.pos, ppg: r1(p.ppg) }));
}

const list = (gs: GroupGap[]) => {
  const parts = gs.map((g) => `${g.group} (${sgn(g.gap)})`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
};

/** One-line "why" for a team relative to me. Names stay in the row head; players go in the details. */
export function comparisonSummary(c: Pick<TeamComparison, "starterGap" | "benchGap" | "groups">, above: boolean): string {
  const ahead = c.groups.filter((g) => g.gap >= 0.05).sort((a, b) => b.gap - a.gap);
  const behind = c.groups.filter((g) => g.gap <= -0.05).sort((a, b) => a.gap - b.gap);
  let s: string;
  if (above) {
    if (c.starterGap >= 0.05) {
      s = `${sgn(c.starterGap)} starter pts/wk`;
      if (c.benchGap <= -1) s += `, partly offset by your deeper bench (${sgn(-c.benchGap)})`;
      s += ahead.length ? `: stronger ${list(ahead.slice(0, 2))}` : "";
    } else {
      s = `Deeper bench (${sgn(c.benchGap)} bench strength) outweighs your ${sgn(-c.starterGap)} starter pts/wk`;
      s += ahead.length ? `; stronger ${list(ahead.slice(0, 1))}` : "";
    }
    s += behind.length ? `; you're better at ${behind.slice(0, 2).map((g) => g.group).join(" and ")}.` : ".";
  } else {
    if (c.starterGap <= -0.05) {
      s = `${sgn(c.starterGap)} starter pts/wk vs you`;
      if (c.benchGap >= 1) s += `, partly offset by their deeper bench (${sgn(c.benchGap)})`;
      s += behind.length ? `: weaker ${list(behind.slice(0, 2))}` : "";
    } else {
      s = `Thinner bench (${sgn(c.benchGap)} bench strength) outweighs their ${sgn(c.starterGap)} starter pts/wk`;
      s += behind.length ? `; weaker ${list(behind.slice(0, 1))}` : "";
    }
    s += ahead.length ? `; better at ${ahead.slice(0, 2).map((g) => g.group).join(" and ")}.` : ".";
  }
  return s.length > 255 ? `${s.slice(0, 254)}…` : s;
}

function compare(them: TeamAnalysis, me: TeamAnalysis, standing: number | null): TeamComparison {
  const isAbove = them.powerRank < me.powerRank;
  const groupNames = GROUPS.filter((g) => them.groups[g] || me.groups[g]);
  const groups: GroupGap[] = groupNames.map((g) => {
    const theirs = them.groups[g]?.ppg ?? 0;
    const mine = me.groups[g]?.ppg ?? 0;
    return { group: g, theirs: r2(theirs), mine: r2(mine), gap: r2(theirs - mine) };
  });
  const starterGap = r2(them.starterPpg - me.starterPpg);
  const benchGap = r2(them.benchStrength - me.benchStrength);
  const starterPartGap = r2(POWER_WEIGHTS.starter * (them.starterPpg - me.starterPpg));
  const benchPartGap = r2(POWER_WEIGHTS.bench * (them.benchStrength - me.benchStrength));
  const powerGap = r2(them.powerScore - me.powerScore);
  const keyPlayers = groups
    .filter((g) => g.gap >= 0.05)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 2)
    .map((g) => ({ group: g.group, gap: g.gap, players: topStarters(them, g.group) }));
  const base = { powerGap, starterGap, benchGap, groups };
  return {
    teamId: them.team.id,
    name: them.team.name,
    powerRank: them.powerRank,
    standingsRank: standing,
    record: recordText(them.team.record),
    starterPartGap,
    benchPartGap,
    keyPlayers,
    ...base,
    summary: comparisonSummary(base, isAbove),
  };
}

export function buildLeagueView(teams: TeamAnalysis[], myTeamId: string): LeagueView {
  const me = teams.find((t) => t.team.id === myTeamId);
  if (!me) throw new Error(`Team ${myTeamId} is not in this league`);
  const standing = standingsRanks(teams);
  const byPower = [...teams].sort((a, b) => a.powerRank - b.powerRank);
  const rows: LeagueTeamRow[] = byPower.map((t) => ({
    id: t.team.id,
    name: t.team.name,
    owner: t.team.owner,
    mine: t.team.id === myTeamId,
    powerRank: t.powerRank,
    powerScore: r2(t.powerScore),
    starterPart: r2(POWER_WEIGHTS.starter * t.starterPpg),
    benchPart: r2(POWER_WEIGHTS.bench * t.benchStrength),
    starterPpg: r2(t.starterPpg),
    benchStrength: r2(t.benchStrength),
    standingsRank: standing.get(t.team.id) ?? null,
    record: recordText(t.team.record),
    pointsFor: t.team.record?.pointsFor ?? null,
    pointsAgainst: t.team.record?.pointsAgainst ?? null,
  }));
  const others = byPower.filter((t) => t.team.id !== myTeamId);
  const above = others.filter((t) => t.powerRank < me.powerRank).map((t) => compare(t, me, standing.get(t.team.id) ?? null));
  const below = others.filter((t) => t.powerRank > me.powerRank).map((t) => compare(t, me, standing.get(t.team.id) ?? null));
  const myStanding = standing.get(myTeamId) ?? null;
  const n = teams.length;
  let summary = `Power rank ${ord(me.powerRank)} of ${n}`;
  summary += myStanding != null ? `, ${ord(myStanding)} in the standings` : ", standings unknown";
  summary += above.length ? `. ${above.length} team${above.length === 1 ? "" : "s"} rated above you.` : ". Nobody is rated above you.";
  return {
    myTeamId,
    numTeams: n,
    weights: { ...POWER_WEIGHTS },
    standingsKnown: teams.some((t) => t.team.record),
    teams: rows,
    above,
    below,
    summary,
  };
}
