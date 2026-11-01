// The league owner's per-player "Out for season" marks (DESIGN "Season-over injuries (2026-10-31)").
// One small file per imported league, .data/overrides-<importId>.json, written only by the owner's toggle
// (PUT / DELETE /api/league/import/:id/overrides/:playerId, admin only) under one lock per league; imports, auto-import
// and the ESPN / Sleeper loaders never read-merge-write it. Deleted with the league.
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, removeJson, safeName, writeJson } from "./store.js";
import { withLock } from "./lock.js";

/** Most marks one league may hold (a typo loop or a scripted client cannot grow the file without bound). */
export const MAX_SEASON_MARKS = 500;

export interface SeasonMark {
  /** true = out for the season, false = not out for the season (overrules the automatic sources). */
  seasonOver: boolean;
  setAt: string;
  /** Who set it (display name), for the audit trail. */
  setBy?: string;
}

export interface OverridesFile {
  version: 1;
  players: Record<string, SeasonMark>;
}

export class OverridesError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const VALID_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** Our player ids: gsis ("00-0036322"), "DEF:KC", "fp:…", "yahoo:…" — never a path or a prototype key. */
const VALID_PLAYER = /^[A-Za-z0-9:._-]{1,64}$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

const fileName = (id: string) => `overrides-${id}`;
const filePath = (id: string) => path.join(DATA_DIR, safeName(`${fileName(id)}.json`));

export const isValidPlayerId = (id: string): boolean => VALID_PLAYER.test(id) && !RESERVED.has(id);

function empty(): OverridesFile {
  return { version: 1, players: Object.create(null) as Record<string, SeasonMark> };
}

/** Keeps only well-formed marks (a hand-edited bad entry is dropped, never guessed). */
function clean(raw: unknown): OverridesFile {
  const out = empty();
  const players = raw && typeof raw === "object" ? (raw as { players?: unknown }).players : undefined;
  if (!players || typeof players !== "object" || Array.isArray(players)) return out;
  for (const [id, v] of Object.entries(players as Record<string, unknown>)) {
    if (!isValidPlayerId(id) || !v || typeof v !== "object") continue;
    const m = v as Partial<SeasonMark>;
    if (typeof m.seasonOver !== "boolean") continue;
    out.players[id] = { seasonOver: m.seasonOver, setAt: typeof m.setAt === "string" ? m.setAt : "", ...(typeof m.setBy === "string" ? { setBy: m.setBy.slice(0, 80) } : {}) };
  }
  return out;
}

/**
 * The league's marks. No file = no marks. An unreadable / corrupt file THROWS: the owner's marks are unknown, and
 * serving "automatic" instead would silently undo them (fail closed; the league route shows the error).
 */
export async function readOverrides(id: string): Promise<OverridesFile> {
  if (!VALID_ID.test(id)) throw new OverridesError(400, `Bad import id "${id}"`);
  let text: string;
  try {
    text = await fs.readFile(filePath(id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw err;
  }
  try {
    return clean(JSON.parse(text));
  } catch (err) {
    throw new OverridesError(500, `The owner's season marks for "${id}" are unreadable (${(err as Error).message}); fix or remove ${fileName(id)}.json`);
  }
}

/** player id → mark, for League.seasonMarks (undefined when the league has none). */
export function marksOf(o: OverridesFile): Record<string, boolean> | undefined {
  const ids = Object.keys(o.players);
  if (!ids.length) return undefined;
  const out: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
  for (const id of ids) out[id] = o.players[id].seasonOver;
  return out;
}

/**
 * Set (true / false) or clear (null = back to automatic) one player's mark; read-merge-write under the league's lock.
 * Returns the file as written.
 */
export function setSeasonMark(id: string, playerId: string, value: boolean | null, setBy?: string): Promise<OverridesFile> {
  if (!VALID_ID.test(id)) return Promise.reject(new OverridesError(400, `Bad import id "${id}"`));
  if (!isValidPlayerId(playerId)) return Promise.reject(new OverridesError(400, `Bad player id "${playerId}"`));
  return withLock(`overrides:${id}`, async () => {
    const cur = await readOverrides(id);
    if (value === null) {
      if (!(playerId in cur.players)) return cur;
      delete cur.players[playerId];
    } else {
      if (!(playerId in cur.players) && Object.keys(cur.players).length >= MAX_SEASON_MARKS)
        throw new OverridesError(409, `This league already has ${MAX_SEASON_MARKS} season marks: clear some first`);
      cur.players[playerId] = { seasonOver: value, setAt: new Date().toISOString(), ...(setBy ? { setBy: setBy.slice(0, 80) } : {}) };
    }
    if (Object.keys(cur.players).length) await writeJson(fileName(id), cur);
    else await removeJson(fileName(id));
    return cur;
  });
}

/** Remove the league's marks (the league was deleted). */
export function deleteOverrides(id: string): Promise<void> {
  if (!VALID_ID.test(id)) return Promise.resolve();
  return withLock(`overrides:${id}`, () => removeJson(fileName(id)));
}
