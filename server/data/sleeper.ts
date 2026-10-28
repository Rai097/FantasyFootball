// Sleeper public player listing: injury status / body part / notes (DESIGN "Season-ending injuries (2026-10-28)").
// Docs: https://docs.sleeper.com/#players — GET https://api.sleeper.app/v1/players/nfl, no key; Sleeper asks callers to
// fetch it at most once per day (≈ 15 MB) and keep their own copy. Cached on disk for SLEEPER_TTL_HOURS; a failed or
// invalid fetch keeps the previous copy, and with no copy every player's listing stays unknown (never fabricated).
import { fetchCachedMeta } from "./cache.js";
import { normName, normPos, normTeam } from "./names.js";
import { sources } from "./sources.js";
import { seasonEndingWhy } from "../model/returns.js";
import type { Player, SleeperInjury } from "../model/types.js";

/** Once a day (Sleeper's documented limit). */
export const SLEEPER_TTL_HOURS = 24;
/** A real response lists ~12 000 players; fewer than this is a broken body, never written over the good copy. */
export const SLEEPER_MIN_PLAYERS = 1000;

const FANTASY = new Set(["QB", "RB", "WR", "TE", "K"]);

/** One injured player of Sleeper's listing (fields we use). */
export interface SleeperEntry {
  sleeperId: string;
  gsis?: string;
  yahoo?: string;
  name: string;
  team: string;
  pos: string;
  injury: SleeperInjury;
}

const str = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const t = String(v).trim();
  return t ? t : undefined;
};

/** Throws unless the body is Sleeper's player map with at least SLEEPER_MIN_PLAYERS players (the cache validator). */
export function validateSleeperBody(body: string): void {
  const data = JSON.parse(body) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Sleeper: expected an object of players");
  const n = Object.keys(data).length;
  if (n < SLEEPER_MIN_PLAYERS) throw new Error(`Sleeper: only ${n} players in the response`);
}

/** Fantasy-position players Sleeper lists with an injury status (everyone else has none). Throws on a bad body. */
export function parseSleeperPlayers(body: string | unknown): { total: number; injured: SleeperEntry[] } {
  const data = (typeof body === "string" ? JSON.parse(body) : body) as Record<string, Record<string, unknown>> | null;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Sleeper: expected an object of players");
  const injured: SleeperEntry[] = [];
  let total = 0;
  for (const [key, v] of Object.entries(data)) {
    if (!v || typeof v !== "object") continue;
    total++;
    const status = str(v.injury_status);
    const pos = normPos(str(v.position));
    if (!status || !FANTASY.has(pos)) continue;
    const name = str(v.full_name) ?? [str(v.first_name), str(v.last_name)].filter(Boolean).join(" ");
    if (!name) continue;
    const injury: SleeperInjury = { status };
    const bodyPart = str(v.injury_body_part);
    const notes = str(v.injury_notes);
    const rosterStatus = str(v.status);
    if (bodyPart) injury.bodyPart = bodyPart;
    if (notes) injury.notes = notes;
    if (rosterStatus) injury.rosterStatus = rosterStatus;
    const e: SleeperEntry = { sleeperId: str(v.player_id) ?? key, name, team: normTeam(str(v.team)), pos, injury };
    const gsis = str(v.gsis_id);
    const yahoo = str(v.yahoo_id);
    if (gsis) e.gsis = gsis;
    if (yahoo) e.yahoo = yahoo;
    injured.push(e);
  }
  if (!total) throw new Error("Sleeper: no players in the response");
  return { total, injured };
}

export interface SleeperIndex {
  players: Map<string, Player>;
  bySleeper: Map<string, string>;
  byYahoo: Map<string, string>;
  /** normName|pos → ids */
  byName: Map<string, string[]>;
}

/**
 * Set `sleeperInjury` on our players (mutates the db entries while the db is built). Match: Sleeper id (our id map has
 * sleeper_id), then GSIS id, then Yahoo id, then normalised name + position + team (unique). Returns the match count.
 */
export function attachSleeperInjuries(entries: SleeperEntry[], ix: SleeperIndex): number {
  let matched = 0;
  for (const e of entries) {
    let id = ix.bySleeper.get(e.sleeperId);
    if (!id && e.gsis && ix.players.has(e.gsis)) id = e.gsis;
    if (!id && e.yahoo) id = ix.byYahoo.get(e.yahoo);
    if (!id) {
      const cands = (ix.byName.get(`${normName(e.name)}|${e.pos}`) ?? []).filter((c) => ix.players.get(c)?.team === e.team);
      if (cands.length === 1) id = cands[0];
    }
    const p = id ? ix.players.get(id) : undefined;
    if (!p || p.sleeperInjury) continue;
    p.sleeperInjury = { ...e.injury };
    matched++;
  }
  return matched;
}

/**
 * Load Sleeper's listing into the player db (called once per db build). Never throws: on any failure the players keep
 * no listing (unknown). Logs one structured line per call.
 */
export async function loadSleeperInjuries(ix: SleeperIndex): Promise<void> {
  const t0 = Date.now();
  try {
    const got = await fetchCachedMeta(sources.sleeperPlayers, SLEEPER_TTL_HOURS, { validate: validateSleeperBody });
    const { total, injured } = parseSleeperPlayers(got.body);
    const matched = attachSleeperInjuries(injured, ix);
    let seasonEnding = 0;
    for (const p of ix.players.values()) if (seasonEndingWhy(p.sleeperInjury)) seasonEnding++;
    console.log(
      `[sleeper] refresh source=${got.source} ageH=${got.ageH.toFixed(1)} players=${total} injured=${injured.length} matched=${matched} seasonEnding=${seasonEnding} bytes=${got.body.length} ms=${Date.now() - t0}${got.error ? ` error="${got.error}"` : ""}`,
    );
  } catch (err) {
    console.warn(`[sleeper] refresh failed source=none error="${(err as Error).message}" listings=unknown ms=${Date.now() - t0}`);
  }
}
