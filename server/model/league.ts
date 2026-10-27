// League tab: standings, power rankings split into their two parts (projected starters, actual results), and "who is above
// me and why".
// Pure: built from the TeamAnalysis rows analysis.ts already computes. See docs/DESIGN.md "League tab".
import type { Position, TeamAnalysis, TeamRecord, ValuedPlayer } from "./types.js";
import { GROUPS, POWER_WEIGHTS, groupOf } from "./analysis.js";
import { DEPTH_WEIGHT } from "./teamStrength.js";

export interface LeagueTeamRow {
  id: string;
  name: string;
  owner: string;
  mine: boolean;
  powerRank: number;
  powerScore: number;
  /** POWER_WEIGHTS.projected × starterPpg. */
  projectedPart: number;
  /** POWER_WEIGHTS.results × resultsPpg (× starterPpg when results are unknown). */
  resultsPart: number;
  starterPpg: number;
  /** Actual points per game this season; null = unknown (the results part then uses starterPpg). */
  resultsPpg: number | null;
  /** Tie-breaker only. */
  benchStrength: number;
  /** Standings place by record; null = unknown (no record captured). */
  standingsRank: number | null;
  /** "6-1" / "6-1-1"; "—" when unknown (never "0-0"). */
  record: string;
  pointsFor: number | null;
  pointsAgainst: number | null;
  /** Playoff mode: rank by playoff strength (teamStrength, weeks 15–17); null after the season or when unknown. */
  playoff: PlayoffPart | null;
}

/** A team's playoff strength (teamStrength.ts) and its place by it. Results and record play no part. */
export interface PlayoffPart {
  rank: number;
  /** lineup + DEPTH_WEIGHT × depth, points per week (= My Team's "Playoff strength"). */
  total: number;
  /** Optimal playoff lineup, points per week. */
  lineup: number;
  /** Bench cover for one injured starter, points per week. */
  depth: number;
}

/** Playoff mode's "who is above me": gaps in playoff strength, theirs − mine. */
export interface PlayoffComparison {
  teamId: string;
  name: string;
  rank: number;
  /** Their place on the current power score (for contrast). */
  powerRank: number;
  standingsRank: number | null;
  record: string;
  gap: number;
  lineupGap: number;
  depthGap: number;
  /** One line, ≤ 255 chars. */
  summary: string;
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
  /** Their power score − mine (= projectedPartGap + resultsPartGap). */
  powerGap: number;
  /** Projected starter ppg, theirs − mine. */
  starterGap: number;
  /** Actual points per game, theirs − mine; null when either team's results are unknown. */
  resultsGap: number | null;
  /** Bench strength gap (tie-breaker only). */
  benchGap: number;
  projectedPartGap: number;
  resultsPartGap: number;
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
  weights: { projected: number; results: number };
  /** False when no team has a record (standings were not captured). */
  standingsKnown: boolean;
  /** Teams whose actual points per game is unknown (ranked on projected starters only). */
  resultsUnknown: number;
  /** Every team, by power rank. */
  teams: LeagueTeamRow[];
  /** Teams with a better power rank than mine, best first. */
  above: TeamComparison[];
  /** Teams with a worse power rank, best first. */
  below: TeamComparison[];
  /** Header line, ≤ 255 chars. */
  summary: string;
  /** Playoff mode: the playoff weeks still ahead (empty after the season: no playoff ranking). */
  playoffWeeks: number[];
  depthWeight: number;
  /** Teams with a better playoff rank than mine, best first (empty when playoff strength is unknown). */
  playoffAbove: PlayoffComparison[];
  playoffBelow: PlayoffComparison[];
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

/** Actual ppg behind a team's results part: its starter ppg when results are unknown (same fallback as powerScore). */
const resultsBasis = (t: TeamAnalysis) => t.resultsPpg ?? t.starterPpg;

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

type SummaryInput = Pick<TeamComparison, "starterGap" | "resultsGap" | "benchGap" | "powerGap" | "groups">;

/**
 * One-line "why" for a team relative to me: projected starter pts/wk vs actual pts/game, then the position groups.
 * Names stay in the row head; players go in the details.
 */
export function comparisonSummary(c: SummaryInput, above: boolean): string {
  const ahead = c.groups.filter((g) => g.gap >= 0.05).sort((a, b) => b.gap - a.gap);
  const behind = c.groups.filter((g) => g.gap <= -0.05).sort((a, b) => a.gap - b.gap);
  // Orient everything from the stronger team's side: positive = in the stronger team's favour.
  const dir = above ? 1 : -1;
  const proj = dir * c.starterGap;
  const act = c.resultsGap == null ? null : dir * c.resultsGap;
  const [strong, weak] = above ? [ahead, behind] : [behind, ahead];
  const word = above ? "stronger" : "weaker";
  const you = above ? "your" : "their";
  const projTxt = (x: number) => `${sgn(dir * x)} projected starter pts/wk`;
  const actTxt = (x: number) => `${sgn(dir * x)} actual pts/game`;
  let s: string;
  if (Math.abs(c.powerGap) < 0.005 && Math.abs(proj) < 0.05 && (act == null || Math.abs(act) < 0.05)) {
    s = `Level on power score; ${above ? "ahead" : "behind"} on the tie-breakers (bench depth ${sgn(c.benchGap)}, then wins)`;
  } else if (proj >= 0.05 || act == null || act < 0.05) {
    s = projTxt(proj);
    if (act == null) s += " (results unknown)";
    else if (act >= 0.05) s += ` and ${actTxt(act)}`;
    else if (act <= -0.05) s += `, partly offset by ${you} ${sgn(-act)} actual pts/game`;
    if (!above) s += " vs you";
    s += strong.length ? `: ${word} ${list(strong.slice(0, 2))}` : "";
  } else {
    s = above
      ? `${actTxt(act)} outweighs your ${sgn(-proj)} projected starter pts/wk`
      : `${actTxt(act)} outweighs their ${sgn(-proj)} projected starter pts/wk`;
    s += strong.length ? `; ${word} ${list(strong.slice(0, 1))}` : "";
  }
  const better = weak.slice(0, 2).map((g) => g.group).join(" and ");
  s += weak.length ? (above ? `; you're better at ${better}.` : `; better at ${better}.`) : ".";
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
  const resultsGap = them.resultsPpg != null && me.resultsPpg != null ? r2(them.resultsPpg - me.resultsPpg) : null;
  const benchGap = r2(them.benchStrength - me.benchStrength);
  const projectedPartGap = r2(POWER_WEIGHTS.projected * (them.starterPpg - me.starterPpg));
  const resultsPartGap = r2(POWER_WEIGHTS.results * (resultsBasis(them) - resultsBasis(me)));
  const powerGap = r2(them.powerScore - me.powerScore);
  const keyPlayers = groups
    .filter((g) => g.gap >= 0.05)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 2)
    .map((g) => ({ group: g.group, gap: g.gap, players: topStarters(them, g.group) }));
  const base = { powerGap, starterGap, resultsGap, benchGap, groups };
  return {
    teamId: them.team.id,
    name: them.team.name,
    powerRank: them.powerRank,
    standingsRank: standing,
    record: recordText(them.team.record),
    projectedPartGap,
    resultsPartGap,
    keyPlayers,
    ...base,
    summary: comparisonSummary(base, isAbove),
  };
}

/**
 * Playoff place per team id: playoff strength total, then its lineup part, then team id. Pure projection: no results,
 * no wins. Teams without playoff strength (or no playoff weeks left) are absent.
 */
export function playoffRanks(teams: TeamAnalysis[]): Map<string, PlayoffPart> {
  const known = teams.filter((t) => t.playoffStrength?.weeks.length);
  const sorted = [...known].sort(
    (a, b) =>
      b.playoffStrength!.total - a.playoffStrength!.total ||
      b.playoffStrength!.lineup - a.playoffStrength!.lineup ||
      a.team.id.localeCompare(b.team.id),
  );
  return new Map(sorted.map((t, i) => [t.team.id, { rank: i + 1, total: t.playoffStrength!.total, lineup: t.playoffStrength!.lineup, depth: t.playoffStrength!.depth }]));
}

const weeksText = (w: number[]) => (w.length > 1 ? `wks ${w[0]}–${w[w.length - 1]}` : `wk ${w[0]}`);

/** One line for a team vs me in playoff mode, oriented from the stronger team's side (like comparisonSummary). */
export function playoffSummary(c: Pick<PlayoffComparison, "gap" | "lineupGap" | "depthGap" | "powerRank">, above: boolean, myPowerRank: number, weeks: number[]): string {
  const dir = above ? 1 : -1;
  let s = `${sgn(dir * c.lineupGap)} playoff lineup pts/wk`;
  if (Math.abs(c.depthGap) >= 0.05) s += `, ${sgn(dir * c.depthGap)} bench cover`;
  s += ` ${above ? "" : "for you "}(${weeksText(weeks)})`;
  if (above && c.powerRank > myPowerRank) s += "; below you on current power";
  else if (!above && c.powerRank < myPowerRank) s += "; above you on current power";
  s += ".";
  return s.length > 255 ? `${s.slice(0, 254)}…` : s;
}

export function buildLeagueView(teams: TeamAnalysis[], myTeamId: string): LeagueView {
  const me = teams.find((t) => t.team.id === myTeamId);
  if (!me) throw new Error(`Team ${myTeamId} is not in this league`);
  const standing = standingsRanks(teams);
  const byPower = [...teams].sort((a, b) => a.powerRank - b.powerRank);
  const playoff = playoffRanks(teams);
  const rows: LeagueTeamRow[] = byPower.map((t) => ({
    id: t.team.id,
    name: t.team.name,
    owner: t.team.owner,
    mine: t.team.id === myTeamId,
    powerRank: t.powerRank,
    powerScore: r2(t.powerScore),
    projectedPart: r2(POWER_WEIGHTS.projected * t.starterPpg),
    resultsPart: r2(POWER_WEIGHTS.results * resultsBasis(t)),
    starterPpg: r2(t.starterPpg),
    resultsPpg: t.resultsPpg,
    benchStrength: r2(t.benchStrength),
    standingsRank: standing.get(t.team.id) ?? null,
    record: recordText(t.team.record),
    pointsFor: t.team.record?.pointsFor ?? null,
    pointsAgainst: t.team.record?.pointsAgainst ?? null,
    playoff: playoff.get(t.team.id) ?? null,
  }));
  const others = byPower.filter((t) => t.team.id !== myTeamId);
  const above = others.filter((t) => t.powerRank < me.powerRank).map((t) => compare(t, me, standing.get(t.team.id) ?? null));
  const below = others.filter((t) => t.powerRank > me.powerRank).map((t) => compare(t, me, standing.get(t.team.id) ?? null));
  const myStanding = standing.get(myTeamId) ?? null;
  const n = teams.length;
  let summary = `Power rank ${ord(me.powerRank)} of ${n}`;
  summary += myStanding != null ? `, ${ord(myStanding)} in the standings` : ", standings unknown";
  const resultsUnknown = teams.filter((t) => t.resultsPpg == null).length;
  if (resultsUnknown === n) summary += " (ranked on projected starters only: results unknown)";
  summary += above.length ? `. ${above.length} team${above.length === 1 ? "" : "s"} rated above you.` : ". Nobody is rated above you.";
  const playoffWeeks = me.playoffStrength?.weeks ?? [];
  const mine = playoff.get(myTeamId);
  const playoffCompare = (t: TeamAnalysis): PlayoffComparison => {
    const p = playoff.get(t.team.id)!;
    const base = { gap: r1(p.total - mine!.total), lineupGap: r1(p.lineup - mine!.lineup), depthGap: r1(p.depth - mine!.depth), powerRank: t.powerRank };
    return {
      teamId: t.team.id,
      name: t.team.name,
      rank: p.rank,
      standingsRank: standing.get(t.team.id) ?? null,
      record: recordText(t.team.record),
      ...base,
      summary: playoffSummary(base, p.rank < mine!.rank, me.powerRank, playoffWeeks),
    };
  };
  const byPlayoff = mine ? others.filter((t) => playoff.has(t.team.id)).sort((a, b) => playoff.get(a.team.id)!.rank - playoff.get(b.team.id)!.rank) : [];
  return {
    myTeamId,
    numTeams: n,
    weights: { ...POWER_WEIGHTS },
    standingsKnown: teams.some((t) => t.team.record),
    resultsUnknown,
    teams: rows,
    above,
    below,
    summary,
    playoffWeeks,
    depthWeight: DEPTH_WEIGHT,
    playoffAbove: byPlayoff.filter((t) => playoff.get(t.team.id)!.rank < mine!.rank).map(playoffCompare),
    playoffBelow: byPlayoff.filter((t) => playoff.get(t.team.id)!.rank > mine!.rank).map(playoffCompare),
  };
}
