// Matchups and results log (docs/DESIGN.md "Matchups and results log (2026-10-31)"). Pure: validate the payload's
// `matchupWeek` / `matchups` (import v9) defensively, and merge one capture into the stored log
// (.data/matchlog-<importId>.json; I/O in server/providers/import.ts).
// Rules: a newer capture of a week replaces its module data (pairings, points, status) and every matchup page it
// carries; a page it did not re-fetch is kept. Yahoo's projected total per team is LOCKED like ours: the latest capture
// taken before the week's first kickoff; only when none exists, a FINAL week's "Proj" (Yahoo keeps the pre-game
// projection on final pages). A live capture after kickoff never sets or moves the lock.

export type MatchStatus = "final" | "live" | "pre" | "unknown";
const STATUSES: readonly MatchStatus[] = ["final", "live", "pre", "unknown"];
const POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

export interface MatchSide {
  teamId: string;
  name?: string;
  record?: string;
  /** Yahoo's points for the week (live or final); null = not shown. */
  points: number | null;
  /** Yahoo's projected total as shown in this capture (live after kickoff); the locked value is `MatchWeek.yahooLock`. */
  yahooProj: number | null;
}
export interface MatchPairing {
  mid1: string;
  mid2: string;
  sides: [MatchSide, MatchSide];
}
export interface MatchRow {
  slot: string;
  yahooId?: string;
  name?: string;
  pos?: string;
  team?: string;
  status?: string;
  yahooProj: number | null;
  points: number | null;
}
export interface MatchPageSide {
  teamId: string;
  totalProj: number | null;
  totalPts: number | null;
  rows: MatchRow[];
}
export interface MatchPage {
  mid1: string;
  mid2: string;
  sides: [MatchPageSide, MatchPageSide];
}
/** One week as the payload carries it (validated). */
export interface MatchWeekCapture {
  week: number;
  status: MatchStatus;
  statusText?: string;
  pairings: MatchPairing[];
  pages: MatchPage[];
}
export interface CleanMatchups {
  /** Yahoo's current matchup week; undefined = not in the payload or unusable. */
  matchupWeek?: number;
  weeks: MatchWeekCapture[];
  /** Diagnostics notes for what was dropped (never refuses the import). */
  dropped: string[];
}

export interface YahooLock {
  proj: number;
  /** Capture time of the locked value. */
  at: string;
  /** true = captured before the week's first kickoff; false = taken from a final week (recorded late). */
  pregame: boolean;
}
export interface StoredPage extends MatchPage {
  fetchedAt: string;
}
export interface MatchWeek {
  status: MatchStatus;
  statusText?: string;
  /** Time of the capture the module data (pairings, points, status) comes from. */
  fetchedAt: string;
  pairings: MatchPairing[];
  /** Team id → Yahoo's locked projected total for the week. */
  yahooLock: Record<string, YahooLock>;
  /** "mid1-mid2" → the latest capture of that matchup page. */
  pages: Record<string, StoredPage>;
}
export interface MatchLog {
  season: number;
  /** Yahoo's current matchup week at the latest capture. */
  currentWeek?: number;
  currentAt?: string;
  weeks: Record<string, MatchWeek>;
}

export const MATCHLOG_MAX_WEEK = 18;
const MAX_WEEKS_PER_CAPTURE = 3;
const MAX_PAIRINGS = 10;
const MAX_PAGES = 4;
const MAX_ROWS = 30;
/** Plausible bounds: a team total / a player's week. Outside = dropped as unusable, never clamped. */
const TEAM_PTS = { lo: -50, hi: 400 };
const PLAYER_PTS = { lo: -30, hi: 100 };

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const sid = (v: unknown): string | undefined => (typeof v === "string" && /^\d{1,2}$/.test(v) ? v : typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100 ? String(v) : undefined);
const s = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
};
const wk = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MATCHLOG_MAX_WEEK ? v : undefined);
/** A number in range, null for an explicit null; `bad` for anything else (the caller drops the item). */
const BAD = Symbol("bad");
function num(v: unknown, b: { lo: number; hi: number }): number | null | typeof BAD {
  if (v === null || v === undefined) return null;
  return typeof v === "number" && Number.isFinite(v) && v >= b.lo && v <= b.hi ? Math.round(v * 100) / 100 : BAD;
}

function cleanSide(v: unknown): MatchSide | undefined {
  const o = obj(v);
  const teamId = sid(o?.teamId);
  if (!o || !teamId) return undefined;
  const points = num(o.points, TEAM_PTS);
  const yahooProj = num(o.yahooProj, TEAM_PTS);
  if (points === BAD || yahooProj === BAD) return undefined;
  const out: MatchSide = { teamId, points, yahooProj };
  const name = s(o.name, 80);
  if (name) out.name = name;
  const record = s(o.record, 12);
  if (record && /^\d{1,2}-\d{1,2}-\d{1,2}$/.test(record)) out.record = record;
  return out;
}

/** Pairing ids must match their sides (left = mid1): a side that disagrees means a misread, so the item is dropped. */
function cleanPair<T extends { teamId: string }>(o: Record<string, unknown>, clean: (v: unknown) => T | undefined): { mid1: string; mid2: string; sides: [T, T] } | undefined {
  const mid1 = sid(o.mid1);
  const mid2 = sid(o.mid2);
  if (!mid1 || !mid2 || mid1 === mid2 || !Array.isArray(o.sides) || o.sides.length !== 2) return undefined;
  const a = clean(o.sides[0]);
  const b = clean(o.sides[1]);
  if (!a || !b || a.teamId !== mid1 || b.teamId !== mid2) return undefined;
  return { mid1, mid2, sides: [a, b] };
}

function cleanRow(v: unknown): MatchRow | undefined {
  const o = obj(v);
  const slot = s(o?.slot, 12);
  if (!o || !slot) return undefined;
  const yahooProj = num(o.yahooProj, PLAYER_PTS);
  const points = num(o.points, PLAYER_PTS);
  if (yahooProj === BAD || points === BAD) return undefined;
  const row: MatchRow = { slot, yahooProj, points };
  const yahooId = typeof o.yahooId === "string" && /^\d{1,8}$/.test(o.yahooId) ? o.yahooId : undefined;
  if (yahooId) row.yahooId = yahooId;
  const name = s(o.name, 80);
  if (name) row.name = name;
  const pos = s(o.pos, 4)?.toUpperCase();
  if (pos && POS.has(pos)) row.pos = pos;
  const team = s(o.team, 4);
  if (team && /^[A-Za-z]{2,4}$/.test(team)) row.team = team.toUpperCase();
  const status = s(o.status, 8);
  if (status && /^[A-Za-z0-9-]{1,8}$/.test(status)) row.status = status.toUpperCase();
  return row;
}

function cleanPageSide(v: unknown): MatchPageSide | undefined {
  const o = obj(v);
  const teamId = sid(o?.teamId);
  if (!o || !teamId || !Array.isArray(o.rows)) return undefined;
  const totalProj = num(o.totalProj, TEAM_PTS);
  const totalPts = num(o.totalPts, TEAM_PTS);
  if (totalProj === BAD || totalPts === BAD) return undefined;
  const rows: MatchRow[] = [];
  for (const r of o.rows.slice(0, MAX_ROWS)) {
    const c = cleanRow(r);
    if (!c) return undefined; // one unreadable row = the side is not trusted
    rows.push(c);
  }
  return { teamId, totalProj, totalPts, rows };
}

/**
 * The payload's `matchupWeek` and `matchups`, validated. Never throws: a bad week / pairing / page is dropped and named
 * in `dropped`; weeks other than W and W−1 are dropped (one week source: Yahoo's matchup week).
 */
export function cleanMatchups(body: unknown): CleanMatchups {
  const o = obj(body) ?? {};
  const dropped: string[] = [];
  const out: CleanMatchups = { weeks: [], dropped };
  if (o.matchupWeek !== undefined) {
    out.matchupWeek = wk(o.matchupWeek);
    if (out.matchupWeek === undefined) dropped.push("matchupWeek: not a week 1–18");
  }
  if (o.matchups === undefined) return out;
  const m = obj(o.matchups);
  if (!m || !Array.isArray(m.weeks)) {
    dropped.push("matchups: not { weeks: [...] }");
    return out;
  }
  if (out.matchupWeek === undefined) {
    dropped.push("matchups: no matchupWeek, weeks not used");
    return out;
  }
  const W = out.matchupWeek;
  const seen = new Set<number>();
  for (const [i, wv] of m.weeks.slice(0, MAX_WEEKS_PER_CAPTURE).entries()) {
    const w = obj(wv);
    const week = wk(w?.week);
    if (!w || week === undefined || (week !== W && week !== W - 1) || seen.has(week)) {
      dropped.push(`matchups week #${i + 1}: week ${String(w?.week)} is not ${W} or ${W - 1}`);
      continue;
    }
    seen.add(week);
    const status: MatchStatus = STATUSES.includes(w.status as MatchStatus) ? (w.status as MatchStatus) : "unknown";
    const pairings: MatchPairing[] = [];
    const teams = new Set<string>();
    for (const [j, pv] of (Array.isArray(w.pairings) ? w.pairings : []).slice(0, MAX_PAIRINGS).entries()) {
      const p = obj(pv) ? cleanPair(obj(pv)!, cleanSide) : undefined;
      if (!p || teams.has(p.mid1) || teams.has(p.mid2)) {
        dropped.push(`week ${week} pairing #${j + 1}: bad shape`);
        continue;
      }
      teams.add(p.mid1).add(p.mid2);
      pairings.push(p);
    }
    const pages: MatchPage[] = [];
    for (const [j, pv] of (Array.isArray(w.pages) ? w.pages : []).slice(0, MAX_PAGES).entries()) {
      const p = obj(pv) ? cleanPair(obj(pv)!, cleanPageSide) : undefined;
      if (!p) {
        dropped.push(`week ${week} page #${j + 1}: bad shape`);
        continue;
      }
      pages.push(p);
    }
    const statusText = s(w.statusText, 40);
    out.weeks.push({ week, status, ...(statusText ? { statusText } : {}), pairings, pages });
  }
  if (m.weeks.length > MAX_WEEKS_PER_CAPTURE) dropped.push(`matchups: ${m.weeks.length - MAX_WEEKS_PER_CAPTURE} extra week(s) ignored`);
  return out;
}

const ms = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);
export const pageKey = (p: { mid1: string; mid2: string }) => `${p.mid1}-${p.mid2}`;

/**
 * Merge one capture. `firstKickoff(week)` = the week's first NFL kickoff (ISO), undefined when unknown: then no value
 * counts as pre-game (fail safe). Returns the new log and how many weeks were written.
 */
export function mergeMatchCapture(
  log: MatchLog | null,
  cap: { season: number; capturedAt: string; matchupWeek?: number; weeks: MatchWeekCapture[]; firstKickoff: (week: number) => string | undefined },
): { log: MatchLog; written: number } {
  const base: MatchLog = log && log.season === cap.season && obj(log.weeks) ? log : { season: cap.season, weeks: {} };
  const at = ms(cap.capturedAt);
  const next: MatchLog = { ...base, weeks: { ...base.weeks } };
  if (!Number.isFinite(at)) return { log: base, written: 0 };
  if (cap.matchupWeek !== undefined && !(ms(base.currentAt) > at)) {
    next.currentWeek = cap.matchupWeek;
    next.currentAt = cap.capturedAt;
  }
  let written = 0;
  for (const c of cap.weeks) {
    const key = String(c.week);
    const prev = base.weeks[key];
    if (prev && ms(prev.fetchedAt) > at) continue; // an older capture never replaces a newer one
    const first = ms(cap.firstKickoff(c.week));
    const pregame = Number.isFinite(first) && at < first;
    const yahooLock: Record<string, YahooLock> = { ...(prev?.yahooLock ?? {}) };
    const pages: Record<string, StoredPage> = { ...(prev?.pages ?? {}) };
    for (const p of c.pages) pages[pageKey(p)] = { ...p, fetchedAt: cap.capturedAt };
    // Yahoo's total per team in this capture: the matchup page's Total "Proj" when read, else the module's.
    const proj = new Map<string, number>();
    for (const p of c.pairings) for (const sd of p.sides) if (sd.yahooProj !== null) proj.set(sd.teamId, sd.yahooProj);
    for (const p of c.pages) for (const sd of p.sides) if (sd.totalProj !== null) proj.set(sd.teamId, sd.totalProj);
    for (const [team, v] of proj) {
      const old = yahooLock[team];
      if (pregame) {
        if (!old || !old.pregame || ms(old.at) <= at) yahooLock[team] = { proj: v, at: cap.capturedAt, pregame: true };
      } else if (c.status === "final" && (!old || !old.pregame)) yahooLock[team] = { proj: v, at: cap.capturedAt, pregame: false };
    }
    next.weeks[key] = {
      status: c.status,
      ...(c.statusText ? { statusText: c.statusText } : {}),
      fetchedAt: cap.capturedAt,
      // A capture without pairings (module unread) keeps the stored ones: a fetch never removes what it did not re-read.
      pairings: c.pairings.length ? c.pairings : prev?.pairings ?? [],
      yahooLock,
      pages,
    };
    written++;
  }
  for (const w of Object.keys(next.weeks)) if (!wk(Number(w))) delete next.weeks[w];
  return { log: next, written };
}
