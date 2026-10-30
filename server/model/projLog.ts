// Projection accuracy log (docs/DESIGN.md "Projection accuracy log (2026-10-30)"). Pure: merge a weekly capture of the
// app's and Yahoo's projections into the log (only captures taken before the player's kickoff count), resolve actual
// points, and score both projections over the SAME player-weeks. I/O lives in server/providers/import.ts.
import { score } from "./scoring.js";
import type { DetailItem, Position, Scoring, StatLine } from "./types.js";

export const SKILL_POS: readonly Position[] = ["QB", "RB", "WR", "TE"];
/** Weeks kept (an NFL regular season has 18) and entries per week (rostered + free agents; imports cap FAs at 600). */
export const PROJLOG_MAX_WEEK = 18;
export const PROJLOG_MAX_PER_WEEK = 1200;
/** Resolved weeks a player needs before his own "vs Yahoo" numbers are shown. */
export const MIN_PLAYER_WEEKS = 3;

/** One player's projections for one week, as captured at an import. */
export interface ProjEntry {
  id: string;
  name: string;
  pos: Position;
  /** NFL team at capture. */
  team: string;
  /** Fantasy team holding him at capture; null = free agent. */
  teamId: string | null;
  /** In a starting slot (not BN / IR) at capture. */
  starter: boolean;
  /** The app's projected points for the week (projection v4 weekly: matchup and availability included). */
  app: number;
  /** Yahoo's projected points for the week; absent = not captured for this week. */
  yahoo?: number;
  /** When the import that produced it was taken (ISO). */
  capturedAt: string;
}

/** Stored log: week → player id → the latest capture taken before his kickoff. */
export interface ProjLog {
  season: number;
  weeks: Record<string, Record<string, ProjEntry>>;
}

export interface Kickoffs {
  /** NFL team → kickoff (ISO) of its game that week; a team missing here has no known kickoff. */
  byTeam: ReadonlyMap<string, string>;
  /** Earliest known kickoff of the week (the fail-safe cut-off for a team whose own kickoff is unknown). */
  first?: string;
}

export interface MergeResult {
  log: ProjLog;
  /** Entries written (new or replacing an older pre-kickoff capture). */
  kept: number;
  /** Entries refused: taken at/after kickoff, kickoff unknown, not a skill player, bad number, or an older capture. */
  ignored: number;
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * Merge one capture (all entries share `capturedAt`) into the log for `week`. Per (week, player): keep the latest
 * capture taken BEFORE that player's kickoff; a capture at/after kickoff never overwrites anything. Unknown team kickoff
 * → the week's first kickoff is the cut-off; no kickoff known at all → nothing is recorded (fail safe). A log of an
 * earlier season is replaced (bounded: ≤ PROJLOG_MAX_WEEK weeks × PROJLOG_MAX_PER_WEEK players).
 */
export function mergeCapture(
  log: ProjLog | null,
  cap: { season: number; week: number; capturedAt: string; entries: Omit<ProjEntry, "capturedAt">[]; kickoffs: Kickoffs; maxWeek?: number },
): MergeResult {
  const base: ProjLog = log && log.season === cap.season && log.weeks && typeof log.weeks === "object" ? log : { season: cap.season, weeks: {} };
  const maxWeek = Math.min(cap.maxWeek ?? PROJLOG_MAX_WEEK, PROJLOG_MAX_WEEK);
  const at = ms(cap.capturedAt);
  if (!Number.isInteger(cap.week) || cap.week < 1 || cap.week > maxWeek || !Number.isFinite(at)) return { log: base, kept: 0, ignored: cap.entries.length };
  const key = String(cap.week);
  const week: Record<string, ProjEntry> = { ...(base.weeks[key] ?? {}) };
  let kept = 0;
  let ignored = 0;
  for (const e of cap.entries) {
    const kick = ms(cap.kickoffs.byTeam.get(e.team) ?? cap.kickoffs.first);
    const prev = week[e.id];
    const ok =
      SKILL_POS.includes(e.pos) &&
      finite(e.app) &&
      e.app >= 0 &&
      (e.yahoo === undefined || finite(e.yahoo)) &&
      Number.isFinite(kick) &&
      at < kick &&
      !(prev && ms(prev.capturedAt) > at) &&
      (prev !== undefined || Object.keys(week).length < PROJLOG_MAX_PER_WEEK);
    if (!ok) {
      ignored++;
      continue;
    }
    const entry: ProjEntry = { id: e.id, name: e.name, pos: e.pos, team: e.team, teamId: e.teamId, starter: e.starter, app: r2(e.app), capturedAt: cap.capturedAt };
    if (e.yahoo !== undefined) entry.yahoo = r2(e.yahoo);
    week[e.id] = entry;
    kept++;
  }
  const weeks: ProjLog["weeks"] = {};
  for (const [w, v] of Object.entries(base.weeks)) if (Number(w) >= 1 && Number(w) <= maxWeek) weeks[w] = v;
  if (kept) weeks[key] = week;
  return { log: { season: base.season, weeks }, kept, ignored };
}

/** The week's kickoffs per NFL team (+ the earliest) and every team with a game that week (kickoff known or not). */
export function weekKickoffs(games: Iterable<{ week: number; home: string; away: string; kickoff?: string }>, week: number): { kickoffs: Kickoffs; teams: Set<string> } {
  const byTeam = new Map<string, string>();
  const teams = new Set<string>();
  let first: string | undefined;
  for (const g of games) {
    if (g.week !== week) continue;
    teams.add(g.home);
    teams.add(g.away);
    if (!g.kickoff || !Number.isFinite(Date.parse(g.kickoff))) continue;
    byTeam.set(g.home, g.kickoff);
    byTeam.set(g.away, g.kickoff);
    if (!first || Date.parse(g.kickoff) < Date.parse(first)) first = g.kickoff;
  }
  return { kickoffs: { byTeam, ...(first ? { first } : {}) }, teams };
}

// ------------------------------------------------------------------ actuals
/** "TEAM|week" pairs whose weekly stat rows are in (some player of that NFL team has a line for the week). */
export function teamWeeksWithRows(players: Iterable<{ weeks: { season: number; week: number; team: string }[] }>, season: number): Set<string> {
  const out = new Set<string>();
  for (const p of players) for (const w of p.weeks) if (w.season === season) out.add(`${w.team}|${w.week}`);
  return out;
}

export type Outcome = { status: "played"; pts: number } | { status: "dnp" } | { status: "pending" };

/**
 * Actual result of one player-week under the league's scoring. A stat row = played. No row: "did not play" only when
 * his team's game is final AND that team's rows for the week are in (another player of the team has one); otherwise
 * pending (the weekly stats file lags the final score by hours). Never 0 points for a missing row.
 */
export function outcomeOf(
  player: { pos: Position; weeks: { season: number; week: number; actual: StatLine }[] } | undefined,
  q: { season: number; week: number; team: string; scoring: Scoring; gameFinal: (team: string, week: number) => boolean; teamRowsIn: (team: string, week: number) => boolean },
): Outcome {
  const line = player?.weeks.find((w) => w.season === q.season && w.week === q.week);
  if (line) return { status: "played", pts: r2(score(q.scoring, line.actual, player!.pos)) };
  return q.gameFinal(q.team, q.week) && q.teamRowsIn(q.team, q.week) ? { status: "dnp" } : { status: "pending" };
}

export interface ResolvedRow extends ProjEntry {
  week: number;
  outcome: Outcome;
}

export function resolveLog(log: ProjLog | null, outcome: (e: ProjEntry, week: number) => Outcome): ResolvedRow[] {
  const out: ResolvedRow[] = [];
  if (!log) return out;
  for (const [w, players] of Object.entries(log.weeks)) {
    const week = Number(w);
    for (const e of Object.values(players)) out.push({ ...e, week, outcome: outcome(e, week) });
  }
  return out.sort((a, b) => a.week - b.week || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------ metrics
/** Errors of both projections over the same player-weeks (played, both projections present). */
export interface ErrStats {
  n: number;
  /** Mean |actual − projection|, pts per player-week. */
  appMae: number;
  yahooMae: number;
  /** Mean (actual − projection): positive = the projection ran low. */
  appBias: number;
  yahooBias: number;
}
export interface PlayerAccuracy {
  id: string;
  name: string;
  pos: Position;
  team: string;
  /** Weeks compared (played, both projections present). */
  weeks: number;
  /** Mean actual − Yahoo / actual − app, pts per week. */
  vsYahoo: number;
  vsApp: number;
  /** Weeks he scored more than Yahoo / the app projected. */
  beatYahoo: number;
  beatApp: number;
}
export interface TeamAccuracy {
  teamId: string;
  /** Weeks with at least one compared starter. */
  weeks: number;
  /** Per week: projected starters' total (app, Yahoo) and their actual total, skill starters compared only. */
  app: number;
  yahoo: number;
  actual: number;
  /** Starter-weeks left out: did not play / no Yahoo projection. */
  dnp: number;
  noYahoo: number;
}
export interface AccuracyReport {
  /** Weeks with at least one compared player-week. */
  weeks: number[];
  season: ErrStats;
  byWeek: (ErrStats & { week: number })[];
  byPos: (ErrStats & { pos: Position })[];
  /** Captured player-weeks by state: compared, played without a Yahoo number, did not play, not resolved yet. */
  counts: { captured: number; compared: number; noYahoo: number; dnp: number; pending: number };
  /** App-only errors over every played player-week (incl. those without Yahoo): never mixed into the comparison. */
  appAll: { n: number; mae: number; bias: number };
  mostBeat: PlayerAccuracy[];
  mostMissed: PlayerAccuracy[];
  teams: TeamAccuracy[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;
function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

type Compared = ResolvedRow & { yahoo: number; outcome: { status: "played"; pts: number } };
const isCompared = (r: ResolvedRow): r is Compared => r.outcome.status === "played" && r.yahoo !== undefined;

function errStats(rows: Compared[]): ErrStats {
  const n = rows.length;
  if (!n) return { n: 0, appMae: 0, yahooMae: 0, appBias: 0, yahooBias: 0 };
  let am = 0;
  let ym = 0;
  let ab = 0;
  let yb = 0;
  for (const r of rows) {
    const a = r.outcome.pts - r.app;
    const y = r.outcome.pts - r.yahoo;
    am += Math.abs(a);
    ym += Math.abs(y);
    ab += a;
    yb += y;
  }
  return { n, appMae: r2(am / n), yahooMae: r2(ym / n), appBias: r2(ab / n), yahooBias: r2(yb / n) };
}

/** Per-player comparison (≥ `min` compared weeks). */
export function playerAccuracy(rows: ResolvedRow[], min = MIN_PLAYER_WEEKS): Map<string, PlayerAccuracy> {
  const by = new Map<string, Compared[]>();
  for (const r of rows) if (isCompared(r)) by.set(r.id, [...(by.get(r.id) ?? []), r]);
  const out = new Map<string, PlayerAccuracy>();
  for (const [id, rs] of by) {
    if (rs.length < min) continue;
    const last = rs[rs.length - 1];
    const vy = rs.reduce((a, r) => a + (r.outcome.pts - r.yahoo), 0) / rs.length;
    const va = rs.reduce((a, r) => a + (r.outcome.pts - r.app), 0) / rs.length;
    out.set(id, {
      id,
      name: last.name,
      pos: last.pos,
      team: last.team,
      weeks: rs.length,
      vsYahoo: r1(vy),
      vsApp: r1(va),
      beatYahoo: rs.filter((r) => r.outcome.pts > r.yahoo).length,
      beatApp: rs.filter((r) => r.outcome.pts > r.app).length,
    });
  }
  return out;
}

export function accuracyReport(rows: ResolvedRow[], listSize = 5): AccuracyReport {
  const compared = rows.filter(isCompared);
  const played = rows.filter((r) => r.outcome.status === "played") as (ResolvedRow & { outcome: { status: "played"; pts: number } })[];
  const weeks = [...new Set(compared.map((r) => r.week))].sort((a, b) => a - b);
  const byWeek = weeks.map((week) => ({ week, ...errStats(compared.filter((r) => r.week === week)) }));
  const byPos = SKILL_POS.map((pos) => ({ pos, ...errStats(compared.filter((r) => r.pos === pos)) })).filter((x) => x.n > 0);
  const appAll = played.length
    ? {
        n: played.length,
        mae: r2(played.reduce((a, r) => a + Math.abs(r.outcome.pts - r.app), 0) / played.length),
        bias: r2(played.reduce((a, r) => a + (r.outcome.pts - r.app), 0) / played.length),
      }
    : { n: 0, mae: 0, bias: 0 };
  const players = [...playerAccuracy(rows).values()];
  const mostBeat = players.filter((p) => p.vsYahoo > 0).sort((a, b) => b.vsYahoo - a.vsYahoo || a.name.localeCompare(b.name)).slice(0, listSize);
  const mostMissed = players.filter((p) => p.vsYahoo < 0).sort((a, b) => a.vsYahoo - b.vsYahoo || a.name.localeCompare(b.name)).slice(0, listSize);

  // Teams: starters at capture, same set as everything else (played + both projections); left-outs counted.
  const tmap = new Map<string, { weeks: Set<number>; app: number; yahoo: number; actual: number; dnp: number; noYahoo: number }>();
  for (const r of rows) {
    if (!r.starter || !r.teamId || r.outcome.status === "pending") continue;
    const t = tmap.get(r.teamId) ?? { weeks: new Set<number>(), app: 0, yahoo: 0, actual: 0, dnp: 0, noYahoo: 0 };
    tmap.set(r.teamId, t);
    if (r.outcome.status === "dnp") t.dnp++;
    else if (r.yahoo === undefined) t.noYahoo++;
    else {
      t.weeks.add(r.week);
      t.app += r.app;
      t.yahoo += r.yahoo;
      t.actual += r.outcome.pts;
    }
  }
  const teams: TeamAccuracy[] = [...tmap]
    .filter(([, t]) => t.weeks.size > 0)
    .map(([teamId, t]) => {
      const n = t.weeks.size;
      return { teamId, weeks: n, app: r1(t.app / n), yahoo: r1(t.yahoo / n), actual: r1(t.actual / n), dnp: t.dnp, noYahoo: t.noYahoo };
    })
    .sort((a, b) => a.teamId.localeCompare(b.teamId, undefined, { numeric: true }));

  return {
    weeks,
    season: errStats(compared),
    byWeek,
    byPos,
    counts: {
      captured: rows.length,
      compared: compared.length,
      noYahoo: played.length - compared.length,
      dnp: rows.filter((r) => r.outcome.status === "dnp").length,
      pending: rows.filter((r) => r.outcome.status === "pending").length,
    },
    appAll,
    mostBeat,
    mostMissed,
    teams,
  };
}

const signed1 = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x).toFixed(1)}`;

/** Value-details bullet "Vs Yahoo: +2.1 pts/wk over 4 wks (beat 3 of 4)"; none under MIN_PLAYER_WEEKS weeks. */
export function vsYahooItem(p: PlayerAccuracy | undefined): DetailItem | undefined {
  if (!p || p.weeks < MIN_PLAYER_WEEKS) return undefined;
  const item: DetailItem = { label: "Vs Yahoo", value: `${signed1(p.vsYahoo)} pts/wk over ${p.weeks} wks (beat ${p.beatYahoo} of ${p.weeks})` };
  if (p.vsYahoo >= 1) item.tone = "pos";
  else if (p.vsYahoo <= -1) item.tone = "neg";
  return item;
}

/** GET /api/league/:provider/:id/accuracy (docs/DESIGN.md "Projection accuracy log (2026-10-30)"). */
export interface AccuracyResponse extends Omit<AccuracyReport, "teams"> {
  /** Weeks with at least one capture (resolved or not). */
  capturedWeeks: number[];
  teams: (TeamAccuracy & { name: string })[];
}

export function toAccuracyResponse(log: ProjLog | null, report: AccuracyReport, teamName: (id: string) => string | undefined): AccuracyResponse {
  const capturedWeeks = Object.keys(log?.weeks ?? {})
    .map(Number)
    .filter((w) => Object.keys(log!.weeks[String(w)]).length > 0)
    .sort((a, b) => a - b);
  // A team no longer in the league (renamed / removed) keeps its row under its id, never dropped silently.
  return { ...report, capturedWeeks, teams: report.teams.map((t) => ({ ...t, name: teamName(t.teamId) ?? `Team ${t.teamId}` })) };
}
