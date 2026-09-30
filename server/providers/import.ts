// "import" provider: leagues imported from Yahoo's web pages (bookmarklet JSON or
// pasted roster text), stored as JSON in .data/import-<id>.json. No Yahoo API.
// Stored players keep the raw names/ids; they are resolved against the PlayerDb
// on every load, so a fresher db fixes earlier mismatches automatically.
import fs from "node:fs/promises";
import type { PlayerDb } from "../data/players.js";
import { normPos, normTeam } from "../data/names.js";
import { HALF_PPR } from "../model/scoring.js";
import type { League, Player, Scoring, SlotKind, Team } from "../model/types.js";
import { draftBoard } from "./demo.js";
import { DATA_DIR, readJson, removeJson, writeJson } from "./store.js";
import { findPlayer, withYahooStatus, type YahooPlayerEntry } from "./yahoo-parse.js";

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
}
export interface ImportTeamRaw {
  id: string;
  name: string;
  owner?: string;
  players: ImportPlayerRaw[];
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
  freeAgents?: Omit<ImportPlayerRaw, "slot">[];
  importedAt: string;
  settingsSource: SettingsSource;
  /** Yahoo league number when imported by the bookmarklet. */
  leagueId?: string;
  diagnostics?: unknown[];
}

export interface ImportSummary {
  id: string;
  name: string;
  importedAt: string;
  numTeams: number;
  teams: number;
  settingsSource: SettingsSource;
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

function cleanPlayer(v: unknown, where: string): ImportPlayerRaw {
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
  return p;
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
export function validateImport(body: unknown, now = new Date()): StoredImport {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ImportError("Import must be a JSON object", "Paste the text the bookmarklet copied, unchanged.");
  if (JSON.stringify(body).length > MAX_BYTES) throw new ImportError("Import is larger than 1 MB");
  const o = body as Record<string, unknown>;
  if (!Array.isArray(o.teams) || o.teams.length === 0) throw new ImportError("Import has no teams", "The bookmarklet found no rosters: copy its diagnostics and report them.");
  if (o.teams.length > MAX_TEAMS) throw new ImportError(`Too many teams (${o.teams.length}); the limit is ${MAX_TEAMS}`);
  const ids = new Set<string>();
  const teams: ImportTeamRaw[] = o.teams.map((tv, i) => {
    const t = (tv ?? {}) as Record<string, unknown>;
    let id = str(t.id, 20) ?? String(i + 1);
    if (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    const players = Array.isArray(t.players) ? t.players : [];
    if (players.length > MAX_PLAYERS_PER_TEAM) throw new ImportError(`Team ${id} has ${players.length} players; the limit is ${MAX_PLAYERS_PER_TEAM}`);
    const team: ImportTeamRaw = { id, name: str(t.name, 80) ?? `Team ${id}`, players: players.map((p, j) => cleanPlayer(p, `team ${id} player ${j + 1}`)) };
    const owner = str(t.owner, 60);
    if (owner) team.owner = owner;
    return team;
  });
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
    importedAt: now.toISOString(),
    settingsSource,
  };
  const deadline = int(o.tradeDeadlineWeek, 1, 18);
  if (deadline) out.tradeDeadlineWeek = deadline;
  if (myTeamId && teams.some((t) => t.id === myTeamId)) out.myTeamId = myTeamId;
  const wp = int(o.waiverPriority, 1, MAX_TEAMS);
  if (wp) out.waiverPriority = wp;
  if (fa) out.freeAgents = fa.map((p, j) => cleanPlayer(p, `free agent ${j + 1}`)).map(({ slot: _s, ...p }) => p);
  if (leagueId && /^\d+$/.test(leagueId)) out.leagueId = leagueId;
  if (Array.isArray(o.diagnostics)) {
    const d = JSON.stringify(o.diagnostics);
    if (d.length < 200_000) out.diagnostics = o.diagnostics;
  }
  return out;
}

// ------------------------------------------------------------------ persistence
const fileName = (id: string) => `import-${id}`;

export async function readImport(id: string): Promise<StoredImport | null> {
  if (!isValidId(id)) return null;
  return readJson<StoredImport>(fileName(id));
}

export async function saveImport(s: StoredImport): Promise<void> {
  await writeJson(fileName(s.id), s);
}

export async function deleteImport(id: string): Promise<boolean> {
  if (!(await readImport(id))) return false;
  await removeJson(fileName(id));
  return true;
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
    if (s) out.push({ id: s.id, name: s.name, importedAt: s.importedAt, numTeams: s.numTeams, teams: s.teams.length, settingsSource: s.settingsSource });
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
      // Copy with Yahoo's injury tag; the shared db entry is never mutated.
      const copy = withYahooStatus(p, entryOf(raw), ctx.currentWeek);
      if (copy) overrides[p.id] = copy;
    }
    return { id: t.id, name: t.name, owner: t.owner ?? "", playerIds, unmatched, ...(irPlayerIds.length ? { irPlayerIds } : {}) };
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
    import: { settingsSource: s.settingsSource, importedAt: s.importedAt, waiverPriority: s.waiverPriority, leagueId: s.leagueId },
    playerOverrides: overrides,
  };
}

/**
 * Free agents: the imported list when present (resolved, minus anyone rostered),
 * else every ECR-ranked player not on a roster (like demo). Waiver priority is whatever the user entered.
 */
export function importFreeAgents(league: League, db: PlayerDb, s: StoredImport, week: number): { freeAgents: { player: Player; onWaivers: boolean }[]; myPriority?: number } {
  const rostered = new Set(league.teams.flatMap((t) => t.playerIds));
  const out: { player: Player; onWaivers: boolean }[] = [];
  if (s.freeAgents && s.freeAgents.length) {
    const seen = new Set<string>();
    for (const raw of s.freeAgents) {
      const p = resolvePlayer(db, raw);
      if (!p || rostered.has(p.id) || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ player: withYahooStatus(p, entryOf(raw), week) ?? p, onWaivers: true });
    }
  } else {
    for (const p of draftBoard(db.players.values())) if (!rostered.has(p.id)) out.push({ player: p, onWaivers: true });
  }
  return { freeAgents: out, myPriority: s.waiverPriority };
}

/** Paste mode: add or replace teams (matched by name, case-insensitive) in an existing import. */
export function mergeTeams(s: StoredImport, incoming: ImportTeamRaw[]): StoredImport {
  const teams = [...s.teams];
  for (const t of incoming) {
    const i = teams.findIndex((x) => x.name.toLowerCase() === t.name.toLowerCase());
    if (i >= 0) teams[i] = { ...t, id: teams[i].id, owner: teams[i].owner };
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
