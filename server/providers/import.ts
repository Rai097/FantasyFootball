// "import" provider: leagues imported from Yahoo's web pages (bookmarklet JSON or
// pasted roster text), stored as JSON in .data/import-<id>.json. No Yahoo API.
// Stored players keep the raw names/ids; they are resolved against the PlayerDb
// on every load, so a fresher db fixes earlier mismatches automatically.
import fs from "node:fs/promises";
import type { PlayerDb } from "../data/players.js";
import { normPos, normTeam } from "../data/names.js";
import { HALF_PPR } from "../model/scoring.js";
import type { Availability, League, Player, Scoring, SlotKind, Team, TeamRecord } from "../model/types.js";
import { draftBoard } from "./demo.js";
import { withLock } from "./lock.js";
import { DATA_DIR, readJson, removeJson, writeJson } from "./store.js";
import { findPlayer, withYahooStatus, type YahooPlayerEntry } from "./yahoo-parse.js";
import { mergeCapture, SKILL_POS, type Kickoffs, type MergeResult, type ProjEntry, type ProjLog } from "../model/projLog.js";

export const MAX_BYTES = 1_000_000;
export const MAX_TEAMS = 20;
export const MAX_PLAYERS_PER_TEAM = 40;
export const MAX_FREE_AGENTS = 600;

export const DEFAULT_SLOTS: SlotKind[] = ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR"];
const SLOT_KINDS = new Set<SlotKind>(["QB", "RB", "WR", "TE", "K", "DEF", "FLEX", "SFLEX", "RFLEX", "WRRB", "BN", "IR"]);
const SCORING_KEYS = Object.keys(HALF_PPR) as (keyof Scoring)[];

export interface ImportPlayerRaw {
  yahooId?: string;
  name: string;
  pos: string;
  team?: string;
  status?: string;
  slot?: string;
  /** Yahoo's projected fantasy points rest of season / this week (bookmarklet v3, release (d)). Absent = not captured. */
  yahooProj?: number;
  yahooProjWeekly?: number;
}
/** A free agent as imported. `onWaivers` absent = not captured (imports before 2026-10-26): unknown. */
export type ImportFreeAgentRaw = Omit<ImportPlayerRaw, "slot"> & { onWaivers?: boolean };
export interface ImportTeamRaw {
  id: string;
  name: string;
  owner?: string;
  players: ImportPlayerRaw[];
  /** Standings row (bookmarklet, from 2026-10-26). Absent = not captured: shown as unknown. */
  record?: TeamRecord;
  /** This team's place in the rolling waiver order (1 = first claim). Absent = not captured. */
  waiverRank?: number;
}
export type SettingsSource = "page" | "partial" | "default" | "user";

/** What is stored in .data/import-<id>.json (and accepted by POST /api/import). */
export interface StoredImport {
  id: string;
  name: string;
  numTeams: number;
  slots: SlotKind[];
  scoring: Scoring;
  regularSeasonEnd: number;
  finalWeek: number;
  tradeDeadlineWeek?: number;
  myTeamId?: string;
  waiverPriority?: number;
  teams: ImportTeamRaw[];
  freeAgents?: ImportFreeAgentRaw[];
  importedAt: string;
  settingsSource: SettingsSource;
  /** Team names already had the shared league-name prefix removed (set on save; absent on leagues saved before). */
  teamNamesClean?: boolean;
  /** Yahoo league number when imported by the bookmarklet. */
  leagueId?: string;
  diagnostics?: unknown[];
  /** Who ran the latest import / re-import: the signed-in Discord display name ("Admin" in dev mode). Set by the
   *  server (POST /api/import), never taken from the payload. Absent on imports saved before release 5. */
  importedBy?: string;
  /** NFL week the players' Yahoo projections were captured in (the calendar's current week at POST /api/import). Set
   *  by the server, never taken from the payload. Absent = unknown age: the weekly number is dropped as stale. */
  projWeek?: number;
}

export interface ImportSummary {
  id: string;
  name: string;
  importedAt: string;
  numTeams: number;
  teams: number;
  settingsSource: SettingsSource;
  importedBy?: string;
  /** At least one team's record (standings) was captured. */
  hasStandings: boolean;
  /** The free-agent list was captured (waiver advice for this league works). */
  hasFreeAgents: boolean;
}

export class ImportError extends Error {
  status = 400;
  constructor(
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ validation
const str = (v: unknown, max = 100): string | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
};
const int = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
};

export function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,40}$/.test(id);
}

/** Yahoo / user slot token → SlotKind ("W/R/T" → FLEX, "BN" → BN …). */
export function toSlotKind(tok: string): SlotKind | undefined {
  const t = tok.toUpperCase().replace(/\s+/g, "");
  const alias: Record<string, SlotKind> = {
    "W/R/T": "FLEX", "W/R": "WRRB", "W/T": "RFLEX", "Q/W/R/T": "SFLEX", SUPERFLEX: "SFLEX", OP: "SFLEX",
    "D/ST": "DEF", DST: "DEF", IL: "IR", BENCH: "BN",
  };
  const k = (alias[t] ?? t) as SlotKind;
  return SLOT_KINDS.has(k) ? k : undefined;
}

/** "QB, WR x2, RB, FLEX, BN*6" → SlotKind[]; unknown tokens reported. */
export function parseSlotList(input: unknown): { slots: SlotKind[]; unknown: string[] } {
  const tokens = (Array.isArray(input) ? input.map(String) : String(input ?? "").split(/[,;\n]+/)).flatMap((seg) =>
    /^\s*\S+\s*[x×*]\s*\d{1,2}\s*$/i.test(seg) ? [seg.trim()] : seg.trim().split(/\s+/),
  );
  const slots: SlotKind[] = [];
  const unknown: string[] = [];
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^(.+?)(?:\s*[x×*]\s*(\d{1,2}))?$/i.exec(t)!;
    const k = toSlotKind(m[1]);
    if (!k) {
      unknown.push(t);
      continue;
    }
    for (let i = 0; i < Math.min(15, Number(m[2] ?? 1)); i++) slots.push(k);
  }
  return { slots, unknown };
}

function cleanPlayer(v: unknown, where: string, dropped?: (field: string) => void): ImportPlayerRaw {
  const o = (v ?? {}) as Record<string, unknown>;
  const name = str(o.name, 80);
  if (!name) throw new ImportError(`${where}: player without a name`);
  const pos = normPos(str(o.pos, 20)?.split(/[,/]/)[0]) || "";
  const p: ImportPlayerRaw = { name, pos };
  const yid = str(o.yahooId, 20);
  if (yid && /^\d+$/.test(yid)) p.yahooId = yid;
  const team = str(o.team, 5);
  if (team) p.team = normTeam(team);
  const status = str(o.status, 12);
  if (status) p.status = status.toUpperCase();
  const slot = str(o.slot, 10);
  if (slot) p.slot = slot.toUpperCase();
  // Projections: finite numbers in range or nothing (never a guessed 0); a value present but unusable is reported.
  const ros = projNum(o.yahooProj, PROJ_LIMITS.ros);
  if (ros !== undefined) p.yahooProj = ros;
  else if (o.yahooProj !== undefined) dropped?.("yahooProj");
  const wk = projNum(o.yahooProjWeekly, PROJ_LIMITS.week);
  if (wk !== undefined) p.yahooProjWeekly = wk;
  else if (o.yahooProjWeekly !== undefined) dropped?.("yahooProjWeekly");
  return p;
}

/** Sanity bounds for captured Yahoo projections: rest of season ≤ 450 points, one week ≤ 60. */
export const PROJ_LIMITS = { ros: 450, week: 60 } as const;
const projNum = (v: unknown, hi: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= hi ? Math.round(v * 100) / 100 : undefined;

/** Most games a team can have played in one season (wins + losses + ties). */
const MAX_GAMES = 20;
const num = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v.replace(/,/g, "")) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n * 100) / 100 : undefined;
};

/**
 * A standings row from the payload. Wins, losses and ties must all be whole numbers or there is no record (unknown);
 * each optional field that is missing or out of range is left out on its own. Never throws.
 */
export function cleanRecord(v: unknown): TeamRecord | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const wins = int(o.wins, 0, MAX_GAMES);
  const losses = int(o.losses, 0, MAX_GAMES);
  const ties = int(o.ties, 0, MAX_GAMES);
  if (wins === undefined || losses === undefined || ties === undefined || wins + losses + ties > MAX_GAMES) return undefined;
  const r: TeamRecord = { wins, losses, ties };
  const pf = num(o.pointsFor, 0, 20_000);
  if (pf !== undefined) r.pointsFor = pf;
  const pa = num(o.pointsAgainst, 0, 20_000);
  if (pa !== undefined) r.pointsAgainst = pa;
  const rank = int(o.rank, 1, MAX_TEAMS);
  if (rank) r.rank = rank;
  const seed = int(o.seed, 1, MAX_TEAMS);
  if (seed) r.seed = seed;
  const streak = typeof o.streak === "string" ? /^\s*([WLT])\s*-?\s*(\d{1,2})\s*$/i.exec(o.streak) : null;
  if (streak) r.streak = `${streak[1].toUpperCase()}${Number(streak[2])}`;
  return r;
}

/** Waiver ranks only when every captured rank is distinct (two teams at #3 means the page was misread). */
function keepDistinctWaiverRanks(teams: ImportTeamRaw[]): ImportTeamRaw[] {
  const ranks = teams.map((t) => t.waiverRank).filter((r): r is number => r !== undefined);
  if (new Set(ranks).size === ranks.length) return teams;
  return teams.map(({ waiverRank: _w, ...t }) => t);
}

function cleanScoring(v: unknown): Scoring | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const out: Scoring = { ...HALF_PPR };
  let any = false;
  for (const k of SCORING_KEYS) {
    const n = typeof o[k] === "string" ? Number(o[k]) : o[k];
    if (typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 50) {
      out[k] = n;
      any = true;
    }
  }
  return any ? out : undefined;
}

/** Validate and normalise a POST /api/import JSON body. Throws ImportError (400). */
/**
 * Keep the payload's own import time (bookmarklet run, or a browser backup being
 * restored) so an old copy is never relabelled as fresh. Future or invalid → now.
 */
function keepTimestamp(v: unknown, now: Date): string {
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t) && t <= now.getTime() + 5 * 60_000 && t > Date.UTC(2020, 0, 1)) return new Date(t).toISOString();
  }
  return now.toISOString();
}

/**
 * Yahoo's pages name teams "<League name> - <Team>". With one league on screen the prefix is noise, so when every
 * team (at least 2) starts with the same "<x> - " part it is removed. Names that would become empty are kept.
 *
 * Idempotent (it runs on save, and on read for imports saved before the rule): without `leagueName`, the prefix is
 * only removed when what is left does not share a prefix again ("L - Team - One" / "L - Team - Two" is ambiguous and
 * stays as is), so a second pass never strips more. With `leagueName`, only exactly
 * "<leagueName> - " is removed: an already-stripped name never starts with it again.
 */
export function stripLeaguePrefix<T extends { name: string }>(teams: T[], leagueName?: string): T[] {
  if (teams.length < 2) return teams;
  const prefixOf = (name: string) => {
    const sep = name.indexOf(" - ");
    return sep > 0 ? name.slice(0, sep + 3) : undefined;
  };
  const shared = (ns: string[]) => {
    const p = prefixOf(ns[0]);
    return p && ns.every((n) => n.startsWith(p) && n.length > p.length) ? p : undefined;
  };
  const names = teams.map((t) => t.name);
  let prefix: string | undefined;
  if (leagueName !== undefined) {
    const p = `${leagueName.trim()} - `;
    prefix = leagueName.trim() && names.every((n) => n.startsWith(p) && n.trim().length > p.length) ? p : undefined;
  } else {
    prefix = shared(names);
    if (prefix && shared(names.map((n) => n.slice(prefix!.length).trim()))) prefix = undefined;
  }
  if (!prefix) return teams;
  const cut = prefix;
  return teams.map((t) => ({ ...t, name: t.name.slice(cut.length).trim() }));
}

export function validateImport(body: unknown, now = new Date()): StoredImport {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ImportError("Import must be a JSON object", "Paste the text the bookmarklet copied, unchanged.");
  if (JSON.stringify(body).length > MAX_BYTES) throw new ImportError("Import is larger than 1 MB");
  const o = body as Record<string, unknown>;
  if (!Array.isArray(o.teams) || o.teams.length === 0) throw new ImportError("Import has no teams", "The bookmarklet found no rosters: copy its diagnostics and report them.");
  if (o.teams.length > MAX_TEAMS) throw new ImportError(`Too many teams (${o.teams.length}); the limit is ${MAX_TEAMS}`);
  const ids = new Set<string>();
  const teamsIn: ImportTeamRaw[] = o.teams.map((tv, i) => {
    const t = (tv ?? {}) as Record<string, unknown>;
    let id = str(t.id, 20) ?? String(i + 1);
    if (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    const players = Array.isArray(t.players) ? t.players : [];
    if (players.length > MAX_PLAYERS_PER_TEAM) throw new ImportError(`Team ${id} has ${players.length} players; the limit is ${MAX_PLAYERS_PER_TEAM}`);
    const team: ImportTeamRaw = { id, name: str(t.name, 80) ?? `Team ${id}`, players: players.map((p, j) => cleanPlayer(p, `team ${id} player ${j + 1}`)) };
    const owner = str(t.owner, 60);
    if (owner) team.owner = owner;
    const record = cleanRecord(t.record);
    if (record) team.record = record;
    const waiverRank = int(t.waiverRank, 1, MAX_TEAMS);
    if (waiverRank) team.waiverRank = waiverRank;
    return team;
  });
  const teams = keepDistinctWaiverRanks(stripLeaguePrefix(teamsIn));
  const fa = Array.isArray(o.freeAgents) ? o.freeAgents : undefined;
  if (fa && fa.length > MAX_FREE_AGENTS) throw new ImportError(`Too many free agents (${fa.length}); the limit is ${MAX_FREE_AGENTS}`);

  const scoring = cleanScoring(o.scoring);
  const slotsIn = o.slots !== undefined ? parseSlotList(o.slots).slots : [];
  const slots = slotsIn.some((s) => s !== "BN" && s !== "IR") ? slotsIn : undefined;
  const given = str(o.settingsSource, 10);
  const settingsSource: SettingsSource =
    given === "page" || given === "partial" || given === "default" || given === "user" ? given : scoring && slots ? "page" : scoring || slots ? "partial" : "default";

  const rawId = str(o.id, 40);
  const id = rawId && isValidId(rawId) ? rawId : `imp${now.getTime().toString(36)}`;
  const finalWeek = int(o.finalWeek, 1, 18) ?? 17;
  const regularSeasonEnd = Math.min(int(o.regularSeasonEnd, 1, 18) ?? 14, finalWeek);
  const myTeamId = str(o.myTeamId, 20);
  const leagueId = str(o.leagueId, 20);
  const out: StoredImport = {
    id,
    name: str(o.name, 80) ?? "Imported league",
    numTeams: Math.max(teams.length, int(o.numTeams, 1, MAX_TEAMS) ?? teams.length),
    slots: slots ?? DEFAULT_SLOTS,
    scoring: scoring ?? { ...HALF_PPR },
    regularSeasonEnd,
    finalWeek,
    teams,
    importedAt: keepTimestamp(o.importedAt, now),
    settingsSource,
    teamNamesClean: true,
  };
  const deadline = int(o.tradeDeadlineWeek, 1, 18);
  if (deadline) out.tradeDeadlineWeek = deadline;
  if (myTeamId && teams.some((t) => t.id === myTeamId)) out.myTeamId = myTeamId;
  // The importer's own waiver priority: given explicitly, else their team's place in the captured waiver order.
  const wp = int(o.waiverPriority, 1, MAX_TEAMS) ?? teams.find((t) => t.id === out.myTeamId)?.waiverRank;
  if (wp) out.waiverPriority = wp;
  // Available players' projections (import v6): kept like a rostered player's; an unusable one is dropped with a
  // warning in the stored diagnostics (step "validate"), never stored as 0.
  const faDropped: string[] = [];
  if (fa)
    out.freeAgents = fa.map((v, j) => {
      const { slot: _s, ...p } = cleanPlayer(v, `free agent ${j + 1}`, (field) => faDropped.push(`free agent ${j + 1} ${field}`));
      const onWaivers = (v as Record<string, unknown> | null)?.onWaivers;
      return typeof onWaivers === "boolean" ? { ...p, onWaivers } : p;
    });
  if (leagueId && /^\d+$/.test(leagueId)) out.leagueId = leagueId;
  if (Array.isArray(o.diagnostics)) {
    const d = JSON.stringify(o.diagnostics);
    if (d.length < 200_000) out.diagnostics = o.diagnostics;
  }
  if (faDropped.length) {
    const warning = { step: "validate", level: "warning", note: `${faDropped.length} free-agent projection(s) dropped: not a number in range`, dropped: faDropped.slice(0, 10) };
    out.diagnostics = [...(out.diagnostics ?? []), warning];
  }
  return out;
}

// ------------------------------------------------------------------ persistence
const fileName = (id: string) => `import-${id}`;

/** Read-path migration: a league saved before the prefix rule gets its team names cleaned once; others pass through. */
export function cleanStoredTeamNames(s: StoredImport): StoredImport {
  return s.teamNamesClean ? s : { ...s, teams: stripLeaguePrefix(s.teams), teamNamesClean: true };
}

export async function readImport(id: string): Promise<StoredImport | null> {
  if (!isValidId(id)) return null;
  const s = await readJson<StoredImport>(fileName(id));
  // import-<id>-history.json also matches import-*.json: it holds an array, not an import.
  // Leagues saved before the prefix rule are cleaned once on read (no re-import needed); leagues saved since carry
  // teamNamesClean and are never stripped again (a real team named "Team - One" stays intact).
  if (!s || Array.isArray(s) || !Array.isArray(s.teams)) return null;
  return cleanStoredTeamNames(s);
}

export async function saveImport(s: StoredImport): Promise<void> {
  await writeJson(fileName(s.id), s);
}

export async function deleteImport(id: string): Promise<boolean> {
  if (!(await readImport(id))) return false;
  await removeJson(fileName(id));
  return true;
}

/** One row of the imported-league list (Connect tab). */
export function summaryOf(s: StoredImport): ImportSummary {
  return {
    id: s.id,
    name: s.name,
    importedAt: s.importedAt,
    numTeams: s.numTeams,
    teams: s.teams.length,
    settingsSource: s.settingsSource,
    ...(s.importedBy ? { importedBy: s.importedBy } : {}),
    hasStandings: s.teams.some((t) => !!t.record),
    hasFreeAgents: (s.freeAgents?.length ?? 0) > 0,
  };
}

export async function listImports(): Promise<ImportSummary[]> {
  let files: string[] = [];
  try {
    files = await fs.readdir(DATA_DIR);
  } catch {
    return [];
  }
  const out: ImportSummary[] = [];
  for (const f of files) {
    const m = /^import-([A-Za-z0-9_-]{1,40})\.json$/.exec(f);
    if (!m) continue;
    const s = await readImport(m[1]);
    if (s) out.push(summaryOf(s));
  }
  return out.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

/** Settings editable from the UI (PUT /api/import/:id/settings). */
export function applySettings(s: StoredImport, patch: unknown): StoredImport {
  const o = (patch ?? {}) as Record<string, unknown>;
  const next: StoredImport = { ...s };
  if (o.scoring !== undefined) {
    const sc = cleanScoring({ ...s.scoring, ...(o.scoring as object) });
    if (!sc) throw new ImportError("Invalid scoring");
    next.scoring = sc;
  }
  if (o.slots !== undefined) {
    const { slots, unknown } = parseSlotList(o.slots);
    if (unknown.length) throw new ImportError(`Unknown roster slot(s): ${unknown.join(", ")}`, "Use QB, RB, WR, TE, K, DEF, FLEX (W/R/T), WRRB (W/R), RFLEX (W/T), SFLEX (Q/W/R/T), BN, IR.");
    if (!slots.some((x) => x !== "BN" && x !== "IR")) throw new ImportError("Roster needs at least one starting slot");
    if (slots.length > 40) throw new ImportError("Too many roster slots");
    next.slots = slots;
  }
  if (o.waiverPriority !== undefined) {
    if (o.waiverPriority === null || o.waiverPriority === "") delete next.waiverPriority;
    else {
      const wp = int(o.waiverPriority, 1, MAX_TEAMS);
      if (!wp) throw new ImportError("Waiver priority must be a whole number from 1 to 20");
      next.waiverPriority = wp;
    }
  }
  if (o.myTeamId !== undefined) {
    const t = str(o.myTeamId, 20);
    if (!t || !s.teams.some((x) => x.id === t)) throw new ImportError(`Unknown team "${String(o.myTeamId)}"`);
    next.myTeamId = t;
  }
  if (o.name !== undefined) next.name = str(o.name, 80) ?? s.name;
  if (o.numTeams !== undefined) next.numTeams = Math.max(s.teams.length, int(o.numTeams, 1, MAX_TEAMS) ?? s.numTeams);
  if (o.regularSeasonEnd !== undefined) next.regularSeasonEnd = int(o.regularSeasonEnd, 1, 18) ?? s.regularSeasonEnd;
  if (o.finalWeek !== undefined) next.finalWeek = int(o.finalWeek, 1, 18) ?? s.finalWeek;
  if (o.tradeDeadlineWeek !== undefined) {
    const d = int(o.tradeDeadlineWeek, 1, 18);
    if (d) next.tradeDeadlineWeek = d;
    else delete next.tradeDeadlineWeek;
  }
  next.regularSeasonEnd = Math.min(next.regularSeasonEnd, next.finalWeek);
  // A hand-entered priority is the newest fact for the importer's team: it also corrects that team's captured rank
  // (which waiverPriorityOf reads first). The next import with a waiver order replaces it with Yahoo's fresh one.
  if (typeof o.waiverPriority === "number" || (typeof o.waiverPriority === "string" && o.waiverPriority !== "")) {
    const wp = next.waiverPriority;
    if (wp) next.teams = next.teams.map((t) => (t.id === next.myTeamId && t.waiverRank ? { ...t, waiverRank: wp } : t));
  }
  next.settingsSource = "user";
  return next;
}

// ------------------------------------------------------------------ resolution
export type ImportLeague = League & { playerOverrides: Record<string, Player> };
type Finder = Pick<PlayerDb, "find">;

function entryOf(p: ImportPlayerRaw): YahooPlayerEntry {
  return { yahooId: p.yahooId ?? "", name: p.name, pos: normPos(p.pos), team: normTeam(p.team), status: p.status, selectedPosition: p.slot };
}

/** Resolve a raw import entry to a db player (undefined when unmatched). */
export function resolvePlayer(db: Finder, p: ImportPlayerRaw): Player | undefined {
  // Yahoo id first, then name + position (+ team when known).
  return findPlayer(db, entryOf(p));
}

/**
 * The Yahoo projections a player carries in `currentWeek`, from an import captured in `projWeek` (undefined = unknown).
 * This week's number only while the capture week IS the current week (a stale "Proj" is never served as a later
 * week's); the rest-of-season total is kept with its start week, so perception spreads it over the games it covered.
 */
export function projectionsFor(raw: ImportPlayerRaw, projWeek: number | undefined, currentWeek: number): Pick<Player, "yahooProj" | "yahooProjWeekly" | "yahooProjWeek"> | undefined {
  const out: Pick<Player, "yahooProj" | "yahooProjWeekly" | "yahooProjWeek"> = {};
  if (raw.yahooProj !== undefined) {
    out.yahooProj = raw.yahooProj;
    if (projWeek !== undefined) out.yahooProjWeek = projWeek;
  }
  if (raw.yahooProjWeekly !== undefined && projWeek === currentWeek) out.yahooProjWeekly = raw.yahooProjWeekly;
  return Object.keys(out).length ? out : undefined;
}

export function buildImportLeague(db: Finder, s: StoredImport, ctx: { season: number; currentWeek: number }): ImportLeague {
  const overrides: Record<string, Player> = {};
  const teams: Team[] = s.teams.map((t) => {
    const playerIds: string[] = [];
    const irPlayerIds: string[] = [];
    const unmatched: string[] = [];
    for (const raw of t.players) {
      const p = resolvePlayer(db, raw);
      if (!p) {
        unmatched.push(`${raw.name} (${raw.pos || "?"}${raw.team ? `, ${raw.team}` : ""})`);
        continue;
      }
      if (playerIds.includes(p.id)) continue;
      playerIds.push(p.id);
      const sel = raw.slot?.toUpperCase();
      if (sel === "IR" || sel === "IL") irPlayerIds.push(p.id);
      // Copy with Yahoo's injury tag and projections; the shared db entry is never mutated.
      let copy = withYahooStatus(p, entryOf(raw), ctx.currentWeek);
      const proj = projectionsFor(raw, s.projWeek, ctx.currentWeek);
      if (proj) copy = { ...(copy ?? p), ...proj };
      if (copy) overrides[p.id] = copy;
    }
    return {
      id: t.id,
      name: t.name,
      owner: t.owner ?? "",
      playerIds,
      unmatched,
      ...(irPlayerIds.length ? { irPlayerIds } : {}),
      ...(t.record ? { record: { ...t.record } } : {}),
      ...(t.waiverRank ? { waiverRank: t.waiverRank } : {}),
    };
  });
  return {
    provider: "import",
    id: s.id,
    settings: {
      name: s.name,
      season: ctx.season,
      currentWeek: ctx.currentWeek,
      regularSeasonEnd: s.regularSeasonEnd,
      finalWeek: s.finalWeek,
      numTeams: Math.max(s.numTeams, teams.length),
      slots: s.slots,
      scoring: { ...s.scoring },
      isDynasty: false,
      ...(s.tradeDeadlineWeek ? { tradeDeadlineWeek: s.tradeDeadlineWeek } : {}),
      usesFaab: false,
    },
    teams,
    myTeamId: s.myTeamId && teams.some((t) => t.id === s.myTeamId) ? s.myTeamId : teams[0]?.id,
    fetchedAt: s.importedAt,
    import: { settingsSource: s.settingsSource, importedAt: s.importedAt, waiverPriority: s.waiverPriority, leagueId: s.leagueId, ...(s.importedBy ? { importedBy: s.importedBy } : {}) },
    playerOverrides: overrides,
  };
}

/**
 * Waiver priority of `teamId`: its place in the captured waiver order (fresh on every import), else the stored
 * priority, which belongs to the importer's team (`s.myTeamId`) only. Unknown → undefined.
 */
export function waiverPriorityOf(s: StoredImport, teamId: string | undefined): number | undefined {
  if (!teamId) return undefined;
  const rank = s.teams.find((t) => t.id === teamId)?.waiverRank;
  if (rank) return rank;
  return teamId === s.myTeamId ? s.waiverPriority : undefined;
}

/**
 * Free agents: the imported list when present (resolved, minus anyone rostered),
 * else every ECR-ranked player not on a roster (like demo). Waiver priority: see waiverPriorityOf.
 * Free agent vs on waivers comes from the import; when it was not captured (older imports, or the fallback list)
 * the player counts as on waivers (the safe assumption) with availability "unknown".
 */
export function importFreeAgents(
  league: League,
  db: PlayerDb,
  s: StoredImport,
  week: number,
  /** The team the priority is for (the request's own team); none → no priority. */
  teamId?: string,
): { freeAgents: { player: Player; onWaivers: boolean; availability: Availability }[]; myPriority?: number; unmatched?: string[]; notes?: string[] } {
  const rostered = new Set(league.teams.flatMap((t) => t.playerIds));
  const out: { player: Player; onWaivers: boolean; availability: Availability }[] = [];
  const unmatched: string[] = [];
  if (s.freeAgents && s.freeAgents.length) {
    const seen = new Set<string>();
    for (const raw of s.freeAgents) {
      const p = resolvePlayer(db, raw);
      if (!p) {
        unmatched.push(`${raw.name} (${raw.pos || "?"})`);
        continue;
      }
      if (rostered.has(p.id) || seen.has(p.id)) continue;
      seen.add(p.id);
      const availability: Availability = raw.onWaivers === undefined ? "unknown" : raw.onWaivers ? "waivers" : "fa";
      // Yahoo projections under the same staleness rule as rostered players (this week's only in the capture week).
      const proj = projectionsFor(raw, s.projWeek, week);
      const player = withYahooStatus(p, entryOf(raw), week) ?? p;
      out.push({ player: proj ? { ...player, ...proj } : player, onWaivers: raw.onWaivers ?? true, availability });
    }
  } else {
    for (const p of draftBoard(db.players.values())) if (!rostered.has(p.id)) out.push({ player: p, onWaivers: true, availability: "unknown" });
  }
  const myPriority = waiverPriorityOf(s, teamId);
  if (!unmatched.length) return { freeAgents: out, myPriority };
  // Never silently dropped: the count and the first names go to the response notes.
  const shown = unmatched.slice(0, 5).join(", ");
  const note = `${unmatched.length} imported free agent${unmatched.length === 1 ? "" : "s"} not matched to our player list: ${shown}${unmatched.length > 5 ? ", …" : ""}`;
  return { freeAgents: out, myPriority, unmatched, notes: [note] };
}

/** Paste mode: add or replace teams (matched by name, case-insensitive) in an existing import. */
export function mergeTeams(s: StoredImport, incoming: ImportTeamRaw[]): StoredImport {
  const teams = [...s.teams];
  for (const t of incoming) {
    const i = teams.findIndex((x) => x.name.toLowerCase() === t.name.toLowerCase());
    // A paste carries a roster only: the team keeps its id, owner and standings.
    if (i >= 0) teams[i] = { ...teams[i], ...t, id: teams[i].id, owner: teams[i].owner };
    else {
      let n = teams.length + 1;
      while (teams.some((x) => x.id === String(n))) n++;
      teams.push({ ...t, id: String(n) });
    }
  }
  if (teams.length > MAX_TEAMS) throw new ImportError(`Too many teams (${teams.length}); the limit is ${MAX_TEAMS}`);
  return { ...s, teams, numTeams: Math.max(s.numTeams, teams.length) };
}

/** A fresh stored import with Yahoo-default settings (paste mode). */
export function newPasteImport(teams: ImportTeamRaw[], name: string, now = new Date()): StoredImport {
  return {
    id: `imp${now.getTime().toString(36)}`,
    name,
    numTeams: Math.max(12, teams.length),
    slots: DEFAULT_SLOTS,
    scoring: { ...HALF_PPR },
    regularSeasonEnd: 14,
    finalWeek: 17,
    teams,
    myTeamId: teams[0]?.id,
    importedAt: now.toISOString(),
    settingsSource: "default",
  };
}

// ------------------------------------------------------------------ re-import (upsert) and history
export const HISTORY_CAP = 8;

/** One roster snapshot: player keys per team (Yahoo id, else name|pos) plus key → display name. */
export interface ImportSnapshot {
  importedAt: string;
  teams: { id: string; name: string; playerIds: string[] }[];
  names: Record<string, string>;
}
export interface TeamRosterChange {
  id: string;
  name: string;
  added: string[];
  dropped: string[];
}
export interface RosterChanges {
  /** Teams whose roster changed. */
  teams: number;
  /** Roster moves: per team max(added, dropped), summed (a swap counts once). */
  playersChanged: number;
  byTeam: TeamRosterChange[];
}

export const playerKey = (p: ImportPlayerRaw): string => (p.yahooId ? `y${p.yahooId}` : `n${p.name.toLowerCase()}|${(p.pos || "").toUpperCase()}`);

export function snapshotOf(s: StoredImport): ImportSnapshot {
  const names: Record<string, string> = {};
  const teams = s.teams.map((t) => {
    const ids: string[] = [];
    for (const p of t.players) {
      const k = playerKey(p);
      if (ids.includes(k)) continue;
      ids.push(k);
      names[k] = p.name;
    }
    return { id: t.id, name: t.name, playerIds: ids };
  });
  return { importedAt: s.importedAt, teams, names };
}

/** Pair teams of two snapshots: by name (case-insensitive) first, then by id. */
function pairTeams<A extends { id: string; name: string }, B extends { id: string; name: string }>(prev: A[], next: B[]): Map<B, A | undefined> {
  const out = new Map<B, A | undefined>();
  const used = new Set<A>();
  for (const t of next) {
    const hit = prev.find((p) => !used.has(p) && p.name.toLowerCase() === t.name.toLowerCase());
    if (hit) used.add(hit);
    out.set(t, hit);
  }
  for (const t of next) {
    if (out.get(t)) continue;
    const hit = prev.find((p) => !used.has(p) && p.id === t.id);
    if (hit) {
      used.add(hit);
      out.set(t, hit);
    }
  }
  return out;
}

export function diffSnapshots(prev: ImportSnapshot, next: ImportSnapshot): RosterChanges {
  const byTeam: TeamRosterChange[] = [];
  const name = (k: string) => next.names[k] ?? prev.names[k] ?? k;
  const pairs = pairTeams(prev.teams, next.teams);
  const matched = new Set<unknown>();
  for (const [t, p] of pairs) {
    if (p) matched.add(p);
    const before = new Set(p?.playerIds ?? []);
    const after = new Set(t.playerIds);
    const added = t.playerIds.filter((k) => !before.has(k)).map(name);
    const dropped = (p?.playerIds ?? []).filter((k) => !after.has(k)).map(name);
    if (added.length || dropped.length) byTeam.push({ id: t.id, name: t.name, added, dropped });
  }
  for (const p of prev.teams) if (!matched.has(p) && p.playerIds.length) byTeam.push({ id: p.id, name: p.name, added: [], dropped: p.playerIds.map(name) });
  return { teams: byTeam.length, playersChanged: byTeam.reduce((n, t) => n + Math.max(t.added.length, t.dropped.length), 0), byTeam };
}

/** Append a snapshot, keeping the most recent `cap`. */
export function appendSnapshot(history: ImportSnapshot[], snap: ImportSnapshot, cap = HISTORY_CAP): ImportSnapshot[] {
  return [...history, snap].slice(-cap);
}

const historyFile = (id: string) => `import-${id}-history`;

export async function readHistory(id: string): Promise<ImportSnapshot[]> {
  if (!isValidId(id)) return [];
  const h = await readJson<ImportSnapshot[]>(historyFile(id));
  return Array.isArray(h) ? h : [];
}

/** Record `s` in its history file (seeding it with `previous` when the file is empty). */
export async function recordHistory(s: StoredImport, previous?: StoredImport | null): Promise<ImportSnapshot[]> {
  let h = await readHistory(s.id);
  if (!h.length && previous) h = [snapshotOf(previous)];
  h = appendSnapshot(h, snapshotOf(s));
  await writeJson(historyFile(s.id), h);
  return h;
}

export async function deleteHistory(id: string): Promise<void> {
  if (isValidId(id)) await removeJson(historyFile(id));
}

/** Changes between the two most recent snapshots (null when there is only one). */
export function latestChanges(h: ImportSnapshot[]): (RosterChanges & { from: string; to: string }) | null {
  if (h.length < 2) return null;
  const [prev, next] = h.slice(-2);
  return { from: prev.importedAt, to: next.importedAt, ...diffSnapshots(prev, next) };
}

/** The stored import this payload updates: same Yahoo league id, else same import id. */
export async function findExistingImport(incoming: StoredImport): Promise<StoredImport | null> {
  if (incoming.leagueId) {
    const same = await readImport(incoming.id);
    if (same?.leagueId === incoming.leagueId) return same;
    for (const x of await listImports()) {
      const s = await readImport(x.id);
      if (s?.leagueId === incoming.leagueId) return s;
    }
  }
  return readImport(incoming.id);
}

/**
 * Re-import of a league already stored: fresh teams / rosters / free agents,
 * same import id, and the user's settings kept. Settings come from the new
 * payload only when the user never edited them and the payload read them from Yahoo.
 */
export function upsertImport(existing: StoredImport, incoming: StoredImport): { stored: StoredImport; changes: RosterChanges } {
  const takeNewSettings = existing.settingsSource !== "user" && (incoming.settingsSource === "page" || incoming.settingsSource === "partial");
  const base = takeNewSettings ? incoming : existing;
  const next: StoredImport = {
    id: existing.id,
    name: existing.settingsSource === "user" ? existing.name : incoming.name,
    numTeams: Math.max(incoming.teams.length, incoming.numTeams),
    slots: base.slots,
    scoring: { ...base.scoring },
    regularSeasonEnd: base.regularSeasonEnd,
    finalWeek: base.finalWeek,
    teams: incoming.teams,
    importedAt: incoming.importedAt,
    settingsSource: takeNewSettings ? incoming.settingsSource : existing.settingsSource,
  };
  if (base.tradeDeadlineWeek) next.tradeDeadlineWeek = base.tradeDeadlineWeek;
  // A hand-entered priority (settingsSource "user") is kept; otherwise a freshly captured one replaces the old copy.
  const capturedNow = incoming.waiverPriority !== undefined && existing.settingsSource !== "user";
  const wp = capturedNow ? incoming.waiverPriority : existing.waiverPriority ?? incoming.waiverPriority;
  if (wp) next.waiverPriority = wp;
  // My team: the previously chosen team, found by name when Yahoo's team ids changed.
  const oldMine = existing.myTeamId ? existing.teams.find((t) => t.id === existing.myTeamId) : undefined;
  const mine =
    (oldMine && incoming.teams.find((t) => t.name.toLowerCase() === oldMine.name.toLowerCase())?.id) ??
    (existing.myTeamId && incoming.teams.some((t) => t.id === existing.myTeamId) ? existing.myTeamId : undefined) ??
    incoming.myTeamId;
  if (mine) next.myTeamId = mine;
  if (incoming.freeAgents) next.freeAgents = incoming.freeAgents;
  const leagueId = incoming.leagueId ?? existing.leagueId;
  if (leagueId) next.leagueId = leagueId;
  if (incoming.diagnostics) next.diagnostics = incoming.diagnostics;
  // The rosters (and their projections) are the incoming ones: so is the capture week (never the old import's).
  if (incoming.projWeek !== undefined) next.projWeek = incoming.projWeek;
  const stale = carryOverMissing(existing, next);
  if (stale.length) next.diagnostics = [...(next.diagnostics ?? []), ...stale];
  return { stored: next, changes: diffSnapshots(snapshotOf(existing), snapshotOf(next)) };
}

/**
 * Never replace good stored data with "missing" (auto-import fix round 1): a free-agent list the collector failed to read
 * this time (absent, or empty while the stored one is not) is carried over from the stored import and marked stale by a
 * "merge" warning in the diagnostics naming when it was read. Rostered players are filtered out of it on use, so a
 * carried list never offers a player who has since been picked up. Its weekly projections are carried only within the
 * same NFL week (else last week's number would show as this week's). Standings, waiver order and Yahoo projections are
 * NOT carried (a stale record or waiver order must never look current): the auto-import refuses such a run as partial
 * instead (server/autoimport/partial.ts). Mutates `next`; returns the warnings.
 */
function carryOverMissing(existing: StoredImport, next: StoredImport): Record<string, unknown>[] {
  if ((next.freeAgents && next.freeAgents.length) || !existing.freeAgents?.length) return [];
  const sameWeek = existing.projWeek !== undefined && existing.projWeek === next.projWeek;
  next.freeAgents = existing.freeAgents.map(({ yahooProjWeekly, ...p }) => (sameWeek && yahooProjWeekly !== undefined ? { ...p, yahooProjWeekly } : p));
  const since = existing.importedAt;
  return [{ step: "merge", level: "warning", section: "freeAgents", stale: true, since, note: `free agents not read this run: kept the list from ${since}` }];
}

// ------------------------------------------------------------------ projection accuracy log (.data/projlog-<id>.json)
const projLogFile = (id: string) => `projlog-${id}`;

export async function readProjLog(id: string): Promise<ProjLog | null> {
  if (!isValidId(id)) return null;
  const l = await readJson<ProjLog>(projLogFile(id));
  return l && typeof l === "object" && typeof l.season === "number" && l.weeks && typeof l.weeks === "object" ? l : null;
}

export async function deleteProjLog(id: string): Promise<void> {
  if (isValidId(id)) await removeJson(projLogFile(id));
}

/**
 * This import's capture for `week`: every rostered and free-agent skill player (QB/RB/WR/TE) whose NFL team has a game
 * that week, with the app's projection for the week (`appWeek`, undefined = no projection → skipped, never 0) and
 * Yahoo's weekly number only when it was captured in that same week (`projWeek === week`).
 */
export function projCaptureEntries(
  db: Finder,
  s: StoredImport,
  week: number,
  appWeek: (p: Player) => number | undefined,
  hasGame: (team: string) => boolean,
): Omit<ProjEntry, "capturedAt">[] {
  const out = new Map<string, Omit<ProjEntry, "capturedAt">>();
  const add = (raw: ImportPlayerRaw, teamId: string | null, starter: boolean) => {
    const p = resolvePlayer(db, raw);
    if (!p || out.has(p.id) || !SKILL_POS.includes(p.pos) || !hasGame(p.team)) return;
    const app = appWeek(p);
    if (app === undefined || !Number.isFinite(app)) return;
    const e: Omit<ProjEntry, "capturedAt"> = { id: p.id, name: p.name, pos: p.pos, team: p.team, teamId, starter, app };
    if (s.projWeek === week && typeof raw.yahooProjWeekly === "number" && Number.isFinite(raw.yahooProjWeekly)) e.yahoo = raw.yahooProjWeekly;
    out.set(p.id, e);
  };
  for (const t of s.teams)
    for (const raw of t.players) {
      const slot = raw.slot ? toSlotKind(raw.slot) : undefined;
      add(raw, t.id, slot !== undefined && slot !== "BN" && slot !== "IR");
    }
  for (const raw of s.freeAgents ?? []) add(raw, null, false);
  return [...out.values()];
}

/** Merge a capture into .data/projlog-<id>.json (serialized per league). */
export function recordProjLog(
  id: string,
  cap: { season: number; week: number; capturedAt: string; entries: Omit<ProjEntry, "capturedAt">[]; kickoffs: Kickoffs; maxWeek?: number },
): Promise<MergeResult> {
  if (!isValidId(id)) return Promise.reject(new ImportError(`Bad import id "${id}"`));
  // One write at a time per league: two quick imports must not lose each other's read-merge-write.
  return withLock(`projlog:${id}`, async () => {
    const r = mergeCapture(await readProjLog(id), cap);
    if (r.kept) await writeJson(projLogFile(id), r.log, { compact: true });
    return r;
  });
}
