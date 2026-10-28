// Is a usage jump a real role? (DESIGN "Fix: vacated role, spikes, depth and roster need (2026-10-28)").
// Pure: spike / sustained usage, borrowed role (signals/vacated.ts, the one definition), depth-chart rank, his share
// with the teammates healthy, and the team's offense level. Breakouts builds a RoleCheck per candidate; waivers gates
// the "future starter" claim on it (futureStarterBlock). Missing inputs are unknown, never a block.
import type { Position, RoleCheck, Scoring, ValuedPlayer } from "./types.js";
import { score } from "./scoring.js";
import { VACATED, usageShape, type VacPlayer, type VacatedBy } from "./signals/vacated.js";

/** Starter level on the depth chart: RB1–2, WR1–3, TE1 (below = TE2+ / WR4+ / RB3+). */
export const DEPTH_STARTER: Partial<Record<Position, number>> = { RB: 2, WR: 3, TE: 1 };
/**
 * Realistic role once healthy: his target share (RB: share of team carries + targets) over his last `shareGames` games
 * without a vacated role must reach `minShare`; on a bottom-`lowOffenseBottom` offense (skill-player fantasy pts/game)
 * the bar is × `lowOffenseMult`. Calibration values.
 */
export const ROLE_ENV = {
  minShare: { RB: 0.2, WR: 0.15, TE: 0.12 } as Partial<Record<Position, number>>,
  shareGames: 4,
  /** Fewer such games than this → share unknown (one game is not a share). */
  minShareGames: 2,
  lowOffenseBottom: 8,
  lowOffenseMult: 1.25,
  /** Team weeks needed before an offense level is known. */
  minTeamWeeks: 3,
};

const SKILL: Position[] = ["QB", "RB", "WR", "TE"];
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** One decimal, so a share just under the bar never reads "15% < 15%". */
const pct1 = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
const usageOf = (pos: Position, o: { targets: number; carries: number }) => (pos === "RB" ? o.targets + o.carries : o.targets);

/** Vacated-role input from a valued player: game lines (targets / carries) plus snap-only weeks (0 usage, he played). */
export function vacPlayerOf(p: ValuedPlayer): VacPlayer {
  const games = p.weeks.map((w) => ({ week: w.week, team: w.team, targets: w.opp?.targets ?? 0, carries: w.opp?.carries ?? 0, snapShare: p.snapShare[w.week] }));
  const have = new Set(games.map((g) => g.week));
  for (const [wk, share] of Object.entries(p.snapShare)) {
    const week = Number(wk);
    if (!have.has(week) && share > 0) games.push({ week, team: p.team, targets: 0, carries: 0, snapShare: share });
  }
  return { id: p.id, name: p.name, pos: p.pos, team: p.team, games: games.sort((a, b) => a.week - b.week) };
}

/** Team offense level: skill players' actual fantasy points per team game (league scoring), ranked 1 = best. */
export function teamOffense(players: Iterable<ValuedPlayer>, s: Scoring): Map<string, { ppg: number; rank: number; of: number }> {
  const byTeamWeek = new Map<string, Map<number, number>>();
  for (const p of players) {
    if (!SKILL.includes(p.pos)) continue;
    for (const w of p.weeks) {
      if (!w.team || w.team === "FA") continue;
      const m = byTeamWeek.get(w.team) ?? byTeamWeek.set(w.team, new Map()).get(w.team)!;
      m.set(w.week, (m.get(w.week) ?? 0) + score(s, w.actual, p.pos));
    }
  }
  const rows = [...byTeamWeek]
    .filter(([, m]) => m.size >= ROLE_ENV.minTeamWeeks)
    .map(([team, m]) => ({ team, ppg: [...m.values()].reduce((a, b) => a + b, 0) / m.size }))
    .sort((a, b) => b.ppg - a.ppg || a.team.localeCompare(b.team));
  return new Map(rows.map((r, i) => [r.team, { ppg: Math.round(r.ppg * 10) / 10, rank: i + 1, of: rows.length }]));
}

/** Team targets and RB-style touches per `${team}|${week}` (all players of that team-week). */
export function teamUsage(players: Iterable<ValuedPlayer>): Map<string, { targets: number; touches: number }> {
  const out = new Map<string, { targets: number; touches: number }>();
  for (const p of players)
    for (const w of p.weeks) {
      if (!w.opp) continue;
      const k = `${w.team}|${w.week}`;
      const t = out.get(k) ?? { targets: 0, touches: 0 };
      t.targets += w.opp.targets;
      t.touches += w.opp.targets + w.opp.carries;
      out.set(k, t);
    }
  return out;
}

/** His share over his last `shareGames` games for his current team without a borrowed role; undefined = unknown. */
export function healthyShare(p: ValuedPlayer, usage: Map<string, { targets: number; touches: number }>, vacatedWeeks: ReadonlySet<number>): number | undefined {
  const games = p.weeks
    .filter((w) => w.opp && w.team === p.team && !vacatedWeeks.has(w.week) && usage.has(`${w.team}|${w.week}`))
    .sort((a, b) => a.week - b.week)
    .slice(-ROLE_ENV.shareGames);
  let mine = 0;
  let team = 0;
  for (const w of games) {
    mine += usageOf(p.pos, w.opp!);
    const t = usage.get(`${w.team}|${w.week}`)!;
    team += p.pos === "RB" ? t.touches : t.targets;
  }
  return games.length >= ROLE_ENV.minShareGames && team > 0 ? mine / team : undefined;
}

/** Out for his team's next game (the chart moves the player behind up): Out / Doubtful / IR / PUP / NFI / suspended. */
export const isOutStatus = (status: string | undefined): boolean =>
  !!status && /^(o|out|d|doubtful|ir|ir-r|pup|pup-r|pup-p|nfi|nfi-r|susp|suspended|injured reserve)$/i.test(status.trim());

/** The absent teammate is back (plays) or due back (a return week is known); a teammate gone for good is not. */
export function isBack(t: ValuedPlayer | undefined, team: string): boolean {
  if (!t || t.team !== team || t.remainingGames <= 0) return false;
  if (t.ret?.absent) return t.ret.week !== null;
  return true;
}

export interface RoleCheckInput {
  p: ValuedPlayer;
  /** Expected pts per week (oldest first) and the week labels (breakouts roleMetrics). */
  weeks: number[];
  expPpg: number[];
  /** vacatedGames(...) for him: week → teammates who were out. */
  vacated?: Map<number, VacatedBy[]>;
  /** Everyone, to look up the absent teammates' status. */
  players: Map<string, ValuedPlayer>;
  /** Depth chart order for his team + position (ids), when known. */
  chart?: string[];
  usage: Map<string, { targets: number; touches: number }>;
  offense: Map<string, { ppg: number; rank: number; of: number }>;
}

export function roleCheck(i: RoleCheckInput): RoleCheck {
  const { p } = i;
  const vac = i.vacated ?? new Map<number, VacatedBy[]>();
  const vacWeeks = [...vac.keys()].sort((a, b) => a - b);
  const by = new Map<string, VacatedBy>();
  for (const list of vac.values()) for (const t of list) by.set(t.id, t);
  const back = by.size > 0 && [...by.values()].every((t) => isBack(i.players.get(t.id), p.team));
  // A borrowed-role game counts VACATED.weight while the teammate is back or due back; in full when he is gone for good.
  const weights = i.weeks.map((w) => (vac.has(w) && back ? VACATED.weight : 1));
  const shape = usageShape(i.expPpg, weights);
  const out: RoleCheck = { sustained: shape.sustained, spike: shape.spike };
  if (vacWeeks.length) out.vacated = { weeks: vacWeeks, by: [...by.values()].map((t) => t.name), back };
  if (i.chart && i.chart.includes(p.id)) {
    const idx = i.chart.indexOf(p.id);
    const outAhead = i.chart.slice(0, idx).filter((id) => isOutStatus(i.players.get(id)?.injury?.status)).length;
    out.chartRank = idx + 1;
    out.chartEffective = idx + 1 - outAhead;
    const level = DEPTH_STARTER[p.pos];
    if (level !== undefined) out.belowStarter = out.chartEffective > level;
  }
  const share = healthyShare(p, i.usage, new Set(vacWeeks));
  if (share !== undefined) out.healthyShare = Math.round(share * 1000) / 1000;
  const off = i.offense.get(p.team);
  if (off) out.offense = off;
  return out;
}

/** Share bar for his position on his team's offense (× lowOffenseMult on a bottom offense); undefined = no bar. */
export function shareBar(r: RoleCheck, pos: Position): number | undefined {
  const base = ROLE_ENV.minShare[pos];
  if (base === undefined) return undefined;
  const low = !!r.offense && r.offense.rank > r.offense.of - ROLE_ENV.lowOffenseBottom;
  return low ? base * ROLE_ENV.lowOffenseMult : base;
}

/**
 * Why a would-be future starter is not one (null = no block). Order: one-game spike, borrowed role, usage not up in
 * 2 of the last 3 games, below starter level on the depth chart, too small a share once healthy (higher bar on a
 * bottom offense). `short` fits a summary sentence, `rule` the details' "Rule" line.
 */
export function futureStarterBlock(r: RoleCheck | undefined, pos: Position): { short: string; rule: string } | null {
  if (!r) return null;
  if (r.vacated && r.vacated.back && !r.sustained)
    return { short: `usage rose while ${r.vacated.by.join(", ")} ${r.vacated.by.length > 1 ? "were" : "was"} out`, rule: "Borrowed role: the starter he filled in for is back or due back" };
  if (r.spike) return { short: "one strong game, not a role yet", rule: "One-game jump: needs higher usage in 2 of his last 3 games" };
  if (!r.sustained) return { short: "usage not up in 2 of his last 3 games", rule: "Rising role needs higher usage in 2 of his last 3 games" };
  if (r.belowStarter) return { short: `listed ${pos}${r.chartEffective} on the depth chart`, rule: `Below starter level on the depth chart (${pos}${r.chartEffective})` };
  const bar = shareBar(r, pos);
  if (bar !== undefined && r.healthyShare !== undefined && r.healthyShare < bar) {
    const low = bar > (ROLE_ENV.minShare[pos] ?? 0);
    const what = pos === "RB" ? "touch share" : "target share";
    return {
      short: `${pct1(r.healthyShare)} ${what} with the starters healthy${low ? " on a low-scoring offense" : ""}`,
      rule: `${what[0].toUpperCase()}${what.slice(1)} with starters healthy ${pct1(r.healthyShare)} < ${pct(bar)}${low ? " (low offense)" : ""}`,
    };
  }
  return null;
}

/** Detail items for the role check (≤ 90 chars each): depth chart, share once healthy, offense, borrowed role, spike. */
export function roleItems(r: RoleCheck, pos: Position): { label: string; value: string; tone?: "pos" | "neg" | "warn" }[] {
  const out: { label: string; value: string; tone?: "pos" | "neg" | "warn" }[] = [];
  out.push({
    label: "Depth chart rank",
    value:
      r.chartRank === undefined
        ? "Unknown: not on the depth chart we have"
        : `${pos}${r.chartRank}${r.chartEffective !== r.chartRank ? ` (${pos}${r.chartEffective} with the injured ahead out)` : ""}`,
    ...(r.belowStarter ? { tone: "warn" as const } : {}),
  });
  const what = pos === "RB" ? "Touch share" : "Target share";
  out.push({ label: `${what}, starters healthy`, value: r.healthyShare === undefined ? "Unknown" : `${pct1(r.healthyShare)} of his team's (last ${ROLE_ENV.shareGames} games)` });
  out.push({ label: "Offense", value: r.offense ? `${ordinal(r.offense.rank)} of ${r.offense.of} in fantasy pts/game (${r.offense.ppg.toFixed(1)})` : "Unknown" });
  if (r.vacated) out.push({ label: "Borrowed role", value: `wk ${r.vacated.weeks.join(", ")} while ${r.vacated.by.join(", ")} ${r.vacated.by.length > 1 ? "were" : "was"} out${r.vacated.back ? " (back or due back)" : ""}`, tone: "warn" });
  if (r.spike) out.push({ label: "One-game jump", value: "Higher usage in only 1 of his last 3 games: watch", tone: "warn" });
  return out;
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
