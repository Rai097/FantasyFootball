// Derived tables for Model v4 player signals: pure builders over already-cached files + one thin memoized loader.
// Sources (no new downloads): ffopportunity ep_weekly (season, season-1), nflverse games.csv, injuries, roster,
// snap counts. Column names verified on the 2026-10-26 cache (docs/DESIGN.md "Model v4 — amendments").
import { fetchCached } from "./cache.js";
import { sources } from "./sources.js";
import { parseCsv, num, opt } from "./csv.js";
import { normPos, normTeam } from "./names.js";
import { addLines, DB_STALE_MS, emptyLine, lineFrom } from "./players.js";
import type { StatLine } from "../model/types.js";
import { usualStarters } from "../model/signals/context.js";
import { computeAllSignals, type PlayerSignals } from "../model/signals/index.js";
import {
  SKILL_POS,
  type PlayerGame,
  type PlayerSignalInput,
  type PriorSeason,
  type RosterInfo,
  type SkillPos,
  type StatusWeek,
  type TeamTotals,
} from "../model/signals/types.js";
import type { Scoring } from "../model/types.js";

const tw = (team: string, week: number) => `${team}|${week}`;
const isReg = (r: Record<string, string>) => (r.season_type ? r.season_type === "REG" : num(r.week) <= 18);

export interface EpRow {
  week: number;
  gameId: string;
  team: string;
  playerId: string;
  name: string;
  pos: string;
  passAttempts: number;
  targets: number;
  carries: number;
  airYards: number;
  actual: StatLine;
  expected: StatLine;
  /** The file's own team totals (`*_team` columns), when present. */
  fileTeam?: TeamTotals;
}

/** Regular-season ep_weekly rows. */
export function parseEpRows(csv: string): EpRow[] {
  if (!csv) return [];
  const out: EpRow[] = [];
  for (const r of parseCsv(csv)) {
    if (!r.player_id || !isReg(r)) continue;
    out.push({
      week: num(r.week),
      gameId: r.game_id ?? "",
      team: normTeam(r.posteam),
      playerId: r.player_id,
      name: r.full_name ?? "",
      pos: normPos(r.position),
      passAttempts: num(r.pass_attempt),
      targets: num(r.rec_attempt),
      carries: num(r.rush_attempt),
      airYards: num(r.rec_air_yards),
      actual: lineFrom(r, ""),
      expected: lineFrom(r, "_exp"),
      fileTeam:
        opt(r.rec_attempt_team) !== undefined
          ? { targets: num(r.rec_attempt_team), airYards: num(r.rec_air_yards_team), carries: num(r.rush_attempt_team) }
          : undefined,
    });
  }
  return out;
}

/**
 * Team totals per team-week. The file's `*_team` columns are used when present (they equal the sum over
 * the team's rows on the full file, checked 2026-10-26); otherwise the rows are summed.
 */
export function buildTeamTotals(rows: EpRow[]): Map<string, TeamTotals> {
  const sums = new Map<string, TeamTotals>();
  const fromFile = new Map<string, TeamTotals>();
  for (const r of rows) {
    const k = tw(r.team, r.week);
    const t = sums.get(k) ?? { targets: 0, airYards: 0, carries: 0 };
    t.targets += r.targets;
    t.airYards += r.airYards;
    t.carries += r.carries;
    sums.set(k, t);
    if (r.fileTeam && !fromFile.has(k)) fromFile.set(k, r.fileTeam);
  }
  for (const [k, t] of fromFile) sums.set(k, t);
  return sums;
}

export interface GameInfo {
  gameId: string;
  week: number;
  home: string;
  away: string;
  /** home score − away score; undefined before the game is played. */
  result?: number;
  homeQbId?: string;
  awayQbId?: string;
}

/** Regular-season games of one season from games.csv. */
export function parseGames(csv: string, season: number): Map<string, GameInfo> {
  const out = new Map<string, GameInfo>();
  for (const r of parseCsv(csv)) {
    if (num(r.season) !== season || r.game_type !== "REG") continue;
    out.set(r.game_id, {
      gameId: r.game_id,
      week: num(r.week),
      home: normTeam(r.home_team),
      away: normTeam(r.away_team),
      result: opt(r.result) === undefined ? undefined : num(r.result),
      homeQbId: opt(r.home_qb_id),
      awayQbId: opt(r.away_qb_id),
    });
  }
  return out;
}

export interface Starter {
  qbId: string;
  source: "games" | "passAttempts";
}

/**
 * Starting QB per team-week: games.csv home/away_qb_id; when missing, the team's QB with the most pass
 * attempts that week in ep_weekly.
 */
export function buildStarters(games: Map<string, GameInfo>, rows: EpRow[]): Map<string, Starter> {
  const out = new Map<string, Starter>();
  for (const g of games.values()) {
    if (g.result === undefined) continue;
    if (g.homeQbId) out.set(tw(g.home, g.week), { qbId: g.homeQbId, source: "games" });
    if (g.awayQbId) out.set(tw(g.away, g.week), { qbId: g.awayQbId, source: "games" });
  }
  const best = new Map<string, { id: string; att: number }>();
  for (const r of rows) {
    if (r.passAttempts <= 0) continue;
    const k = tw(r.team, r.week);
    const b = best.get(k);
    if (!b || r.passAttempts > b.att) best.set(k, { id: r.playerId, att: r.passAttempts });
  }
  for (const [k, b] of best) if (!out.has(k)) out.set(k, { qbId: b.id, source: "passAttempts" });
  return out;
}

/** Usual starters per team over the season (most frequent, current, returning: context.ts usualStarters). */
export function buildUsualStarters(starters: Map<string, Starter>): Map<string, string[]> {
  const byTeam = new Map<string, { week: number; qbId: string }[]>();
  for (const [k, s] of starters) {
    const [team, week] = k.split("|");
    const arr = byTeam.get(team) ?? [];
    arr.push({ week: Number(week), qbId: s.qbId });
    byTeam.set(team, arr);
  }
  const out = new Map<string, string[]>();
  for (const [team, starts] of byTeam) {
    const u = usualStarters(starts);
    if (u.length) out.set(team, u);
  }
  return out;
}

/** Team margin by team-week (positive = that team won). */
export function buildMargins(games: Map<string, GameInfo>): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of games.values()) {
    if (g.result === undefined) continue;
    out.set(tw(g.home, g.week), g.result);
    out.set(tw(g.away, g.week), -g.result);
  }
  return out;
}

/** Injury report / practice series per player (gsis id). */
export function parseStatus(csv: string): Map<string, StatusWeek[]> {
  const out = new Map<string, StatusWeek[]>();
  if (!csv) return out;
  for (const r of parseCsv(csv)) {
    if (!r.gsis_id || (r.season_type && r.season_type !== "REG")) continue;
    const arr = out.get(r.gsis_id) ?? [];
    arr.push({ week: num(r.week), report: opt(r.report_status), practice: opt(r.practice_status) });
    out.set(r.gsis_id, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.week - b.week);
  return out;
}

export interface RosterTable {
  info: Map<string, RosterInfo>;
  /** pfr id → gsis id, for the snap-count file. */
  pfrToGsis: Map<string, string>;
}

/** Roster status / birth date / draft capital per gsis id. The file has one row per player per week: keep the latest. */
export function parseRoster(csv: string): RosterTable {
  const info = new Map<string, RosterInfo & { _week: number }>();
  const pfrToGsis = new Map<string, string>();
  if (!csv) return { info, pfrToGsis };
  for (const r of parseCsv(csv)) {
    const id = opt(r.gsis_id);
    if (!id) continue;
    if (opt(r.pfr_id)) pfrToGsis.set(r.pfr_id, id);
    const week = num(r.week);
    const prev = info.get(id);
    if (prev && prev._week > week) continue;
    const draft = opt(r.draft_number);
    const rookie = opt(r.rookie_year);
    info.set(id, {
      _week: week,
      status: opt(r.status),
      birthDate: opt(r.birth_date),
      draftNumber: draft === undefined ? undefined : num(draft),
      rookieYear: rookie === undefined ? undefined : num(rookie),
      pos: normPos(r.position),
      team: normTeam(r.team),
      name: r.full_name,
    });
  }
  return { info, pfrToGsis };
}

export interface SnapRow {
  week: number;
  gameId: string;
  team: string;
  share: number;
  snaps: number;
  pos: string;
  name: string;
}

/** Offensive snap share per gsis id (rows without a pfr→gsis mapping are dropped = unknown). */
export function parseSnaps(csv: string, pfrToGsis: Map<string, string>): Map<string, SnapRow[]> {
  const out = new Map<string, SnapRow[]>();
  if (!csv) return out;
  for (const r of parseCsv(csv)) {
    if (r.game_type && r.game_type !== "REG") continue;
    const id = pfrToGsis.get(r.pfr_player_id);
    if (!id) continue;
    const arr = out.get(id) ?? [];
    arr.push({ week: num(r.week), gameId: r.game_id, team: normTeam(r.team), share: num(r.offense_pct), snaps: num(r.offense_snaps), pos: normPos(r.position), name: r.player });
    out.set(id, arr);
  }
  return out;
}

/** Last season's regular-season totals per player. */
export function buildPrior(rows: EpRow[]): Map<string, PriorSeason> {
  const out = new Map<string, PriorSeason>();
  for (const r of rows) {
    const p = out.get(r.playerId) ?? { games: 0, actual: emptyLine(), expected: emptyLine() };
    p.games += 1;
    p.actual = addLines(p.actual, r.actual);
    p.expected = addLines(p.expected, r.expected);
    out.set(r.playerId, p);
  }
  return out;
}

export interface SignalSources {
  season: number;
  epCsv: string;
  epPriorCsv: string;
  gamesCsv: string;
  injuriesCsv: string;
  rosterCsv: string;
  snapsCsv: string;
}

/**
 * Per-player signal inputs for every skill player with a game this season. A game = an ep_weekly row or a
 * snap-count row with offensive snaps (a snaps-only game counts as zero opportunity).
 */
export function buildSignalInputs(src: SignalSources): Map<string, PlayerSignalInput> {
  const ep = parseEpRows(src.epCsv);
  const totals = buildTeamTotals(ep);
  const games = parseGames(src.gamesCsv, src.season);
  const starters = buildStarters(games, ep);
  const usual = buildUsualStarters(starters);
  const margins = buildMargins(games);
  const status = parseStatus(src.injuriesCsv);
  const roster = parseRoster(src.rosterCsv);
  const snaps = parseSnaps(src.snapsCsv, roster.pfrToGsis);
  const prior = buildPrior(parseEpRows(src.epPriorCsv));

  const out = new Map<string, PlayerSignalInput>();
  const gameOf = (team: string, week: number, gameId: string): PlayerGame => {
    const k = tw(team, week);
    return {
      week,
      gameId,
      team,
      targets: 0,
      carries: 0,
      airYards: 0,
      passAttempts: 0,
      actual: emptyLine(),
      expected: emptyLine(),
      teamTotals: totals.get(k),
      teamMargin: margins.get(k),
      starterQbId: starters.get(k)?.qbId,
      usualQbIds: usual.get(team),
    };
  };
  const ensure = (id: string, name: string, pos: string, team: string): PlayerSignalInput | undefined => {
    let p = out.get(id);
    if (p) return p;
    const r = roster.info.get(id);
    const P = (r?.pos && SKILL_POS.includes(r.pos as SkillPos) ? r.pos : pos === "FB" ? "RB" : pos) as SkillPos;
    if (!SKILL_POS.includes(P)) return undefined;
    p = { id, name: r?.name ?? name, pos: P, team: r?.team ?? team, games: [], roster: r, status: status.get(id) ?? [], prior: prior.get(id) };
    out.set(id, p);
    return p;
  };
  const byWeek = new Map<string, Map<number, PlayerGame>>();
  for (const r of ep) {
    const p = ensure(r.playerId, r.name, r.pos, r.team);
    if (!p) continue;
    const g = { ...gameOf(r.team, r.week, r.gameId), targets: r.targets, carries: r.carries, airYards: r.airYards, passAttempts: r.passAttempts, actual: r.actual, expected: r.expected };
    const m = byWeek.get(p.id) ?? new Map<number, PlayerGame>();
    m.set(r.week, g);
    byWeek.set(p.id, m);
  }
  for (const [id, rows] of snaps) {
    for (const s of rows) {
      const m = byWeek.get(id);
      const g = m?.get(s.week);
      if (g) {
        g.snapShare = s.share;
        continue;
      }
      if (s.snaps <= 0) continue;
      const p = ensure(id, s.name, s.pos, s.team);
      if (!p) continue;
      const mm = m ?? new Map<number, PlayerGame>();
      mm.set(s.week, { ...gameOf(s.team, s.week, s.gameId), snapShare: s.share });
      byWeek.set(id, mm);
    }
  }
  for (const [id, m] of byWeek) out.get(id)!.games = [...m.values()].sort((a, b) => a.week - b.week);
  return out;
}

// ---- thin loader: lazily, refreshed on the player database's cadence (DB_STALE_MS, 6 h) ----

/**
 * Promise memo whose entries expire after `ttlMs` (and on rejection), bounded to `max` keys (oldest dropped).
 * Exported for tests (fake clock).
 */
export function staleMemo<V>(ttlMs: number, max: number, now: () => number = Date.now) {
  const m = new Map<string, { at: number; value: Promise<V> }>();
  return {
    get(key: string, make: () => Promise<V>): Promise<V> {
      const hit = m.get(key);
      if (hit && now() - hit.at <= ttlMs) return hit.value;
      m.delete(key);
      if (m.size >= max) m.delete(m.keys().next().value!);
      const value = make();
      const entry = { at: now(), value };
      m.set(key, entry);
      value.catch(() => {
        if (m.get(key) === entry) m.delete(key);
      });
      return value;
    },
    size: () => m.size,
  };
}

const inputsMemo = staleMemo<Map<string, PlayerSignalInput>>(DB_STALE_MS, 4);

/** Signal inputs for `season` from the cached files (same URLs / TTLs as the player database; rebuilt every 6 h). */
export function getSignalInputs(season: number): Promise<Map<string, PlayerSignalInput>> {
  return inputsMemo.get(String(season), () =>
    Promise.all([
      fetchCached(sources.epWeekly(season), 3).catch(() => ""),
      fetchCached(sources.epWeekly(season - 1), 24 * 7).catch(() => ""),
      fetchCached(sources.schedule, 6),
      fetchCached(sources.injuries(season), 3).catch(() => ""),
      fetchCached(sources.roster(season), 12),
      fetchCached(sources.snaps(season), 6).catch(() => ""),
    ]).then(([epCsv, epPriorCsv, gamesCsv, injuriesCsv, rosterCsv, snapsCsv]) =>
      buildSignalInputs({ season, epCsv, epPriorCsv, gamesCsv, injuriesCsv, rosterCsv, snapsCsv }),
    ),
  );
}

const SIGNALS_MEMO_MAX = 8;
const signalsMemo = staleMemo<Map<string, PlayerSignals>>(DB_STALE_MS, SIGNALS_MEMO_MAX);

/** All skill players' signals for a season under a league's scoring (memoized per process, bounded, 6 h). */
export function getAllSignals(season: number, scoring: Scoring): Promise<Map<string, PlayerSignals>> {
  return signalsMemo.get(`${season}|${JSON.stringify(scoring)}`, () =>
    getSignalInputs(season).then((inputs) => computeAllSignals(inputs.values(), { season, scoring, asOf: new Date() })),
  );
}

/** One player's signals (undefined when he has no game this season or is not a skill player). */
export async function playerSignals(season: number, playerId: string, scoring: Scoring): Promise<PlayerSignals | undefined> {
  return (await getAllSignals(season, scoring)).get(playerId);
}
