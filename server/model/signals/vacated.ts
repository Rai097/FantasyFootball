// Vacated role and one-game spikes (DESIGN "Fix: vacated role, spikes, depth and roster need (2026-10-28)").
// Pure, ONE definition shared by the signals (projection v4: rates, role-change exemption) and Breakout Targets
// (waiver calls): a usage jump while a same-team teammate with more prior usage at a competing position was absent
// is a borrowed role; a jump in only one of the last 3 games is a spike, not a trend.
import type { Position } from "../types.js";

/** Calibration values (config, not hard-coded at call sites). */
export const VACATED = {
  /** A vacated-role game counts this much of its weight once the absent teammate is back (or due back). */
  weight: 0.4,
  /** The jump: usage ≥ max(ratio × his earlier mean, earlier mean + minGain) (targets; RB: carries + targets). */
  jumpRatio: 1.5,
  jumpMinGain: 2,
  /** The teammate's earlier mean usage must beat his by at least this (a real competitor, not a fringe player). */
  minMargin: 1,
  /** ...and be a real role: at least this many targets (pass catchers) / touches (RBs) per game before. */
  minUsage: { PC: 4, RB: 8 },
  /** Left early = under this snap share after ≥ `leftEarlyBefore` on average before (counts as absent). */
  leftEarlyLast: 0.15,
  leftEarlyBefore: 0.5,
  /** Projection: the full (borrowed-role) rate over the settled one is clamped to at most this factor. */
  maxFactor: 2,
  /** The teammate's "bigger role" needs this many of his games for the team before that week (fix round 1: one shared
   *  game is unknown), or last season's role with ≥ `priorMinGames` games. */
  mateMinGames: 2,
  priorMinGames: 4,
  /** Injury evidence for week w (fix round 1, 2026-10-31): his latest injury-report week in [w − staleWeeks, w]
   *  decides (2 = room for a bye week); none → his first report week after w while he still has no game (the same
   *  absence: PUP / IR players are not on the weekly report); none → the roster reserve list (RES). */
  staleWeeks: 2,
} as const;

/** nflverse roster `status` values that mean ON the team (real 2026 roster codes; the dictionary does not enumerate
 *  them): active, inactive, reserve lists, practice squad. Anything else (CUT, RET, TRD, TRC, TRT, EXE, …) keeps the
 *  team that let him go: he is not on the team (fail closed). No roster row = unknown → judged by `team` alone. */
export const ON_TEAM_STATUS: ReadonlySet<string> = new Set(["ACT", "INA", "RES", "DEV"]);

/** "Higher usage in at least 2 of the last 3 games" (expected points per game, league scoring). */
export const SPIKE = {
  window: 3,
  minGames: 2,
  /** Elevated = ≥ max(ratio × earlier mean, earlier mean + minGain) expected pts. */
  ratio: 1.25,
  minGain: 1.5,
  /** ...and at least this share of the best EARLIER game of the window (a 5.5 after a 16.2 is not the new role; a
   *  bigger later game never makes an earlier one look less elevated, fix round 1). */
  peakShare: 0.5,
  /** An isolated spike game's recency weight is capped at this (as if it were 2 games old). */
  maxRecency: 0.5,
  /** A settled role never spikes (fix round 1): mean known snap share over his last `settledGames` games BEFORE the
   *  candidate spike game (fix round 2) ≥ this
   *  (≥ 2 known), and QBs (no role to borrow or spike). */
  settledSnap: 0.65,
  settledGames: 4,
  /** A climb (both steps of the last 3 games up by ≥ this many expected pts, the latest elevated) is a rising role:
   *  a trend, never a spike, in the projection and the role check alike (fix round 1). */
  climbStep: 1,
} as const;

/** Competing group: pass catchers (WR / TE) compete for targets, RBs for touches. */
export const competingGroup = (pos: Position | string): "PC" | "RB" | null => (pos === "WR" || pos === "TE" ? "PC" : pos === "RB" ? "RB" : null);

export interface VacGame {
  week: number;
  team: string;
  targets: number;
  carries: number;
  /** Offensive snap share 0..1; undefined = unknown. */
  snapShare?: number;
}

export interface VacPlayer {
  id: string;
  name: string;
  pos: Position | string;
  /** Current team: a teammate who has since left the team vacated the role for good (not a borrowed role). */
  team: string;
  games: VacGame[];
  /** Last season (signals PriorSeason shape): games and opportunity totals; absent = unknown. */
  prior?: { games: number; opps?: { targets: number; carries: number }; lastTeam?: string };
  /** This season's injury-report rows (nflverse injuries: `report_status` = game status, `practice_status`); with
   *  `roster` the evidence that a teammate with no game this season is hurt, not a healthy scratch (fix 2026-10-31,
   *  fix round 1: week-scoped, real designations only). Absent = no evidence. */
  status?: readonly { week: number; report?: string; practice?: string }[];
  roster?: { status?: string };
}

export interface VacatedBy {
  id: string;
  name: string;
  pos: string;
}

const usageOf = (g: VacGame, group: "PC" | "RB") => (group === "RB" ? g.carries + g.targets : g.targets);
/** Last season's usage per game (≥ VACATED.priorMinGames games with opportunity totals); null = unknown. */
const priorUsage = (p: VacPlayer, group: "PC" | "RB"): number | null => {
  const pr = p.prior;
  if (!pr?.opps || !(pr.games >= VACATED.priorMinGames)) return null;
  const u = (group === "RB" ? pr.opps.carries + pr.opps.targets : pr.opps.targets) / pr.games;
  return Number.isFinite(u) ? u : null; // NaN / missing totals are unknown, never a role
};
/** On the team by the roster (ON_TEAM_STATUS; no roster status = unknown → his `team` decides). */
export const onRoster = (p: VacPlayer): boolean => !p.roster?.status || ON_TEAM_STATUS.has(p.roster.status.trim().toUpperCase());
/**
 * One injury-report row is injury evidence (nflverse injuries dictionary: `report_status` = "Player's status for game
 * on official injury report", `practice_status` = "Player's participation in practice"): game status Out or Doubtful,
 * or Questionable with a Limited / Did-Not-Participate practice. A practice-only row (no game status, even DNP: a
 * rest day or a mid-week row) and Questionable + Full practice are not: he was cleared for the game.
 */
export function injuryRow(r: { report?: string; practice?: string }): boolean {
  const rep = r.report?.trim().toLowerCase() ?? "";
  if (rep === "out" || rep === "doubtful") return true;
  return rep === "questionable" && /limited|did not/i.test(r.practice ?? "");
}
/**
 * Listed hurt for week `week` of an absence with no game yet this season (fix round 1). The nearest report week of
 * that absence decides (an evidence row that week → hurt; only clean rows → cleared, a healthy scratch):
 *  1. his latest report week in [week − staleWeeks, week], else
 *  2. his first report week after `week` and before his first game (any team): the same absence, e.g. a PUP / IR
 *     player who shows up on the report only once he practises again (real 2026: weeks 1–3 on PUP, no rows, Out from
 *     week 4), else
 *  3. the roster reserve list (RES: IR, PUP, NFI; one current row per player, so season-level).
 */
export function hurtAt(p: VacPlayer, week: number): boolean {
  const rows = (p.status ?? []).filter((r) => Number.isFinite(r.week));
  const decide = (wk: number) => rows.some((r) => r.week === wk && injuryRow(r));
  const back = rows.filter((r) => r.week <= week && r.week >= week - VACATED.staleWeeks);
  if (back.length) return decide(Math.max(...back.map((r) => r.week)));
  const firstGame = Math.min(Infinity, ...p.games.map((g) => g.week).filter((w) => Number.isFinite(w)));
  const fwd = rows.filter((r) => r.week > week && r.week < firstGame);
  if (fwd.length) return decide(Math.min(...fwd.map((r) => r.week)));
  return p.roster?.status?.trim().toUpperCase() === "RES";
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Per player: week → the absent teammates whose role he borrowed that week. A game is "vacated" when
 *  - it was for his CURRENT team, and
 *  - a same-team teammate in his competing group (still on the team) with a known bigger role (mean usage over ≥
 *    `mateMinGames` of his games for this team before that week, else last season's per-game usage with ≥
 *    `priorMinGames` games; ≥ his own earlier mean + minMargin and ≥ minUsage) did not play that week or left early, and
 *  - his own usage that week jumped over his earlier mean (games before that week that were not vacated), and
 *  - every earlier game of his in the same absence stretch was a jump too (the absence explains the jump), and
 *  - he did not miss his team's game right before that stretch (a player back from his OWN absence is not borrowing).
 * Or (fix 2026-10-31) the teammate is out since before the season: no game (any team) up to that week, a bigger
 * 2025 role on THIS team (≥ priorMinGames, ≥ the fill-in's own 2025 usage + minMargin and ≥ minUsage), hurt that week
 * (`hurtAt`: a recent Out / Doubtful / Questionable-not-practising row, else RES), and the fill-in's usage that week
 * jumped over his own 2025 usage per game. A teammate whose roster status is not on the team (CUT, RET, TRD, …)
 * never vacates a role (fix round 1).
 * Unknown baselines (no earlier game of his, a one-game teammate sample) never flag: missing data is not a borrowed role.
 */
export function vacatedGames(players: VacPlayer[]): Map<string, Map<number, VacatedBy[]>> {
  const groups = new Map<string, VacPlayer[]>();
  const teamWeeks = new Map<string, Set<number>>();
  for (const p of players) {
    for (const x of p.games) (teamWeeks.get(x.team) ?? teamWeeks.set(x.team, new Set()).get(x.team)!).add(x.week);
    const g = competingGroup(p.pos);
    if (!g) continue;
    // His current team too: a teammate with no game this season (out since before week 1) can still have vacated a role.
    for (const team of new Set([...p.games.map((x) => x.team), ...(p.team && p.team !== "FA" ? [p.team] : [])])) {
      const k = `${team}|${g}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
    }
  }
  const out = new Map<string, Map<number, VacatedBy[]>>();
  for (const [k, mates] of groups) {
    const [team, group] = k.split("|") as [string, "PC" | "RB"];
    const gamesOf = (p: VacPlayer) => p.games.filter((g) => g.team === team).sort((a, b) => a.week - b.week);
    const weeksOfTeam = [...(teamWeeks.get(team) ?? [])].sort((a, b) => a - b);
    for (const p of mates) {
      if (p.team !== team) continue; // only games for his current team can be borrowed
      const mine = gamesOf(p);
      const myWeeks = new Set(mine.map((x) => x.week));
      const flagged = new Set<number>();
      const jumps = new Set<number>();
      const absentAt = (t: VacPlayer, week: number): boolean => {
        const tg = gamesOf(t);
        const before = tg.filter((x) => x.week < week);
        const that = tg.find((x) => x.week === week);
        if (!that) return true;
        const snapsBefore = before.map((x) => x.snapShare).filter((s): s is number => s !== undefined);
        return that.snapShare !== undefined && that.snapShare < VACATED.leftEarlyLast && snapsBefore.length > 0 && mean(snapsBefore) >= VACATED.leftEarlyBefore;
      };
      /** The teammate's usage per game before `week`: ≥ mateMinGames games for this team, else last season; null = unknown. */
      const mateUsage = (t: VacPlayer, week: number): number | null => {
        const before = gamesOf(t).filter((x) => x.week < week);
        if (before.length >= VACATED.mateMinGames) return mean(before.map((x) => usageOf(x, group)));
        return priorUsage(t, group);
      };
      const jumped = (u: number, base: number) => u >= Math.max(VACATED.jumpRatio * base, base + VACATED.jumpMinGain) - 1e-9;
      const myPrior = priorUsage(p, group);
      for (const g of mine) {
        const u = usageOf(g, group);
        const by: VacatedBy[] = [];
        // Out since before the season (fix 2026-10-31): a teammate with NO game for this team before that week, a
        // bigger role on THIS team last season and listed hurt this season. His absence predates every game of the
        // fill-in, so the fill-in's baseline is his own last-season usage (unknown → never flagged) and the
        // "explained" stretch rule below does not apply (there is no absence start to line the jump up with).
        if (myPrior !== null && jumped(u, myPrior)) {
          for (const t of mates) {
            // No game up to AND including that week, for ANY team (a teammate playing week 1 is not out since before
            // it; one playing elsewhere was not out hurt either), still on the team by the roster, hurt that week.
            if (t.id === p.id || t.team !== team || !onRoster(t) || t.games.some((x) => x.week <= g.week)) continue;
            if (t.prior?.lastTeam !== team || !hurtAt(t, g.week)) continue;
            const tMean = priorUsage(t, group);
            if (tMean === null || tMean < myPrior + VACATED.minMargin || tMean < VACATED.minUsage[group]) continue;
            by.push({ id: t.id, name: t.name, pos: String(t.pos) });
          }
        }
        const earlier = mine.filter((x) => x.week < g.week && !flagged.has(x.week));
        const base = earlier.length ? mean(earlier.map((x) => usageOf(x, group))) : null;
        if (base !== null && jumped(u, base)) jumps.add(g.week);
        for (const t of base !== null && jumps.has(g.week) ? mates : []) {
          if (t.id === p.id || t.team !== team || !onRoster(t)) continue;
          if (!gamesOf(t).some((x) => x.week < g.week)) continue;
          const tMean = mateUsage(t, g.week);
          if (tMean === null || tMean < base! + VACATED.minMargin || tMean < VACATED.minUsage[group]) continue;
          if (!absentAt(t, g.week)) continue;
          // The absence must explain the jump: no game of his without a jump earlier in the same absence stretch
          // (a teammate out since week 4 does not explain a week-6 jump after a quiet week 5).
          let explained = true;
          let start = g.week;
          for (const x of [...mine].reverse()) {
            if (x.week >= g.week) continue;
            if (!absentAt(t, x.week)) break;
            if (!jumps.has(x.week)) {
              explained = false;
              break;
            }
            start = x.week;
          }
          // Back from his own absence: he missed his team's game right before the stretch.
          const prevTeamWeek = weeksOfTeam.filter((w) => w < start).pop();
          if (prevTeamWeek !== undefined && !myWeeks.has(prevTeamWeek)) explained = false;
          if (explained) by.push({ id: t.id, name: t.name, pos: String(t.pos) });
        }
        if (!by.length) continue;
        flagged.add(g.week);
        const m = out.get(p.id) ?? out.set(p.id, new Map()).get(p.id)!;
        m.set(g.week, by);
      }
    }
  }
  return out;
}

export interface UsageShape {
  /** Earlier mean the window is compared with (null = unknown: a single game). */
  base: number | null;
  /** Elevated threshold before the peak-share part (null when base is unknown). */
  bar: number | null;
  /** Per game of the last `SPIKE.window`: elevated over the earlier role. */
  elevated: boolean[];
  /** Elevated games of the window, each × its weight (a vacated game counts VACATED.weight). */
  count: number;
  /** The latest game is elevated (a usage jump). */
  jump: boolean;
  /** Higher usage in ≥ SPIKE.minGames of the last SPIKE.window games. */
  sustained: boolean;
  /** A jump in exactly one game of the window (or a single game): a spike, watch only. */
  spike: boolean;
  /** Indices (into the input) of isolated spike games: the projection caps their recency weight. */
  spikeIdx: number[];
}

/** Optional context for usageShape: position and per-game snap share (aligned with the values; undefined = unknown). */
export interface ShapeOpts {
  pos?: Position | string;
  snaps?: readonly (number | undefined)[];
}

/**
 * A settled role (SPIKE.settledSnap over the last SPIKE.settledGames games of `snaps`, ≥ 2 known) or a QB: never a
 * spike. usageShape passes only the games BEFORE the candidate spike game (fix round 2): a player cannot settle his
 * role with the spike week itself.
 */
export function settledRole(pos: Position | string | undefined, snaps: readonly (number | undefined)[] | undefined): boolean {
  if (pos === "QB") return true;
  // A game he left early (< VACATED.leftEarlyLast snaps) says nothing about his role.
  const known = (snaps ?? []).slice(-SPIKE.settledGames).filter((s): s is number => s !== undefined && Number.isFinite(s) && s >= VACATED.leftEarlyLast);
  return known.length >= 2 && mean(known) >= SPIKE.settledSnap - 1e-9;
}

/**
 * Usage shape over expected points per game, oldest first: THE one-game-spike definition, shared by the projection
 * (signals) and the waiver role check (roleCheck.ts). Base = mean of the games before the last 3; with none, the
 * lowest game of the window (a 2-game player going 1 → 8 is one jump, not a trend). A window game is elevated when ≥
 * max(ratio × base, base + minGain, peakShare × the best EARLIER game of the window): a climb (3 → 5 → 12) is two
 * elevated games, a trend, and so is any climb (both steps of the last 3 up ≥ climbStep, the latest elevated); a
 * higher game followed by a game below the base did not hold. `weights` (default 1) discount games in the count (vacated-role games while the teammate
 * is back). A settled role (QB, or ≥ 65% snaps over the games before the candidate spike) never spikes: variance in a
 * settled role is not a role jump.
 */
export function usageShape(us: number[], weights?: number[], opts: ShapeOpts = {}): UsageShape {
  const n = us.length;
  const from = Math.max(0, n - SPIKE.window);
  const win = us.slice(from);
  const before = us.slice(0, from);
  if (!n) return { base: null, bar: null, elevated: [], count: 0, jump: false, sustained: false, spike: false, spikeIdx: [] };
  const base = before.length ? mean(before) : win.length >= 2 ? Math.min(...win) : null;
  const floor = base === null ? null : Math.max(SPIKE.ratio * base, base + SPIKE.minGain);
  const barAt = (i: number) => (floor === null ? null : Math.max(floor, i > 0 ? SPIKE.peakShare * Math.max(...win.slice(0, i)) : 0));
  // A single game with no baseline is "elevated" only if it is a real game at all (> 0): one game, unsustained.
  const raw = win.map((u, i) => {
    const b = barAt(i);
    return b === null ? u > 0 : u >= b - 1e-9;
  });
  // A higher game followed by a collapse below the old role (5.5, 0.2, 16.2) did not hold: it is not the new role
  // (a collapse in a game he left early, under VACATED.leftEarlyLast snaps, is an injury, not a lost role).
  const leftEarly = (i: number) => {
    const sn = opts.snaps?.[from + i];
    return sn !== undefined && sn < VACATED.leftEarlyLast;
  };
  const elevated = raw.map((e, i) => e && !(base !== null && i + 1 < win.length && win[i + 1] < base - 1e-9 && !leftEarly(i + 1)));
  const count = elevated.reduce((a, e, i) => a + (e ? (weights?.[from + i] ?? 1) : 0), 0);
  const jump = elevated[elevated.length - 1] ?? false;
  // A climb over the last 3 games (each step up ≥ climbStep, the latest elevated) is a rising role, not a spike.
  // Borrowed-role games discounted in the count (teammate back) cannot make a climb.
  const climbing =
    jump &&
    win.length === SPIKE.window &&
    win.every((u, i) => i === 0 || (u - win[i - 1] >= SPIKE.climbStep - 1e-9 && (weights?.[from + i] ?? 1) >= 1));
  const sustained = climbing || count >= SPIKE.minGames - 1e-9;
  const nElev = elevated.filter(Boolean).length;
  // Settled is judged on the games before the candidate spike (the first elevated game of the window), never a window
  // that includes it (fix round 2): a part-timer whose snaps rose with his spike week is not a settled starter.
  const firstElev = elevated.indexOf(true);
  const settled = settledRole(opts.pos, firstElev < 0 ? opts.snaps : opts.snaps?.slice(0, from + firstElev));
  const spike = !settled && elevated.some(Boolean) && !sustained && (jump || nElev === 1);
  const spikeIdx = !settled && !sustained && nElev === 1 ? [from + elevated.indexOf(true)] : [];
  return { base, bar: floor, elevated, count, jump, sustained, spike, spikeIdx };
}
