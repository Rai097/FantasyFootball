// ESPN league-wide NFL injuries feed: status + estimated return date (DESIGN "Season-over injuries (2026-10-31)").
// URL: https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries — UNDOCUMENTED public API (ESPN publishes
// no docs for site.api.espn.com; shape verified on real data 2026-10-31: ≈ 8.7 MB, 32 teams, ~800 entries,
// injuries[].injuries[] with status, details.returnDate, athlete.links[].href carrying the ESPN id).
// Evidence only: a return date after the league's final week marks the season over (returns.ts espnSeasonOverWhy);
// a missing entry or date never clears anything. Cached on disk for ESPN_TTL_HOURS; a failed, timed-out or invalid
// fetch keeps the previous copy, and with no copy every player's ESPN entry stays unknown (never fabricated).
import { fetchCachedMeta } from "./cache.js";
import { normPos, normTeam } from "./names.js";
import { sources } from "./sources.js";
import { matchListed, type SleeperIndex } from "./sleeper.js";
import type { EspnInjury } from "../model/types.js";

/** Once a day, like Sleeper (an undocumented feed: keep the load minimal). */
export const ESPN_TTL_HOURS = 24;
/** One attempt per player-DB build (every 6 h): at most 4 attempts a day while ESPN fails; each capped at this. */
export const ESPN_TIMEOUT_MS = 60_000;
/** A real feed lists every team (32) and hundreds of entries; less is a broken body, never written over the good copy. */
export const ESPN_MIN_TEAMS = 20;
export const ESPN_MIN_ENTRIES = 100;

const FANTASY = new Set(["QB", "RB", "WR", "TE", "K"]);

/** One injured fantasy-position player of ESPN's feed (fields we use). */
export interface EspnEntry {
  espnId?: string;
  name: string;
  team: string;
  pos: string;
  injury: EspnInjury;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const t = String(v).trim();
  return t ? t : undefined;
};

function teamsOf(data: unknown): unknown[] {
  if (!isObj(data) || !Array.isArray(data.injuries)) throw new Error("ESPN: expected { injuries: [...] }");
  return data.injuries;
}

/** Throws unless the body is ESPN's injuries feed with ≥ ESPN_MIN_TEAMS teams and ≥ ESPN_MIN_ENTRIES entries. */
export function validateEspnBody(body: string): void {
  const teams = teamsOf(JSON.parse(body));
  let n = 0;
  for (const t of teams) if (isObj(t) && Array.isArray(t.injuries)) n += t.injuries.length;
  if (teams.length < ESPN_MIN_TEAMS) throw new Error(`ESPN: only ${teams.length} teams in the response`);
  if (n < ESPN_MIN_ENTRIES) throw new Error(`ESPN: only ${n} injury entries in the response`);
}

/** The ESPN athlete id from his player-card links (".../player/_/id/3121422/...") or headshot ("/full/3121422.png"). */
function espnIdOf(a: Obj): string | undefined {
  const direct = str(a.id);
  if (direct && /^\d+$/.test(direct)) return direct;
  const hrefs: string[] = [];
  if (Array.isArray(a.links)) for (const l of a.links) if (isObj(l) && typeof l.href === "string") hrefs.push(l.href);
  for (const h of hrefs) {
    const m = /\/id\/(\d+)(?:\/|$)/.exec(h);
    if (m) return m[1];
  }
  const head = isObj(a.headshot) ? str(a.headshot.href) : undefined;
  return head ? /\/players\/full\/(\d+)\.png/.exec(head)?.[1] : undefined;
}

/** Fantasy-position entries of the feed (every status; the rule decides what counts). Throws on a bad body. */
export function parseEspnInjuries(body: string | unknown): { total: number; entries: EspnEntry[] } {
  const teams = teamsOf(typeof body === "string" ? JSON.parse(body) : body);
  const entries: EspnEntry[] = [];
  let total = 0;
  for (const t of teams) {
    if (!isObj(t) || !Array.isArray(t.injuries)) continue;
    for (const i of t.injuries) {
      if (!isObj(i) || !isObj(i.athlete)) continue;
      total++;
      const a = i.athlete;
      const pos = normPos(isObj(a.position) ? str(a.position.abbreviation) : undefined);
      const status = str(i.status);
      const name = str(a.displayName) ?? [str(a.firstName), str(a.lastName)].filter(Boolean).join(" ");
      if (!status || !name || !FANTASY.has(pos)) continue;
      const team = normTeam(isObj(a.team) ? str(a.team.abbreviation) : undefined);
      const d = isObj(i.details) ? i.details : {};
      const injury: EspnInjury = { status };
      const ret = str(d.returnDate);
      if (ret && /^\d{4}-\d{2}-\d{2}/.test(ret)) injury.returnDate = ret.slice(0, 10);
      const type = str(d.type);
      const detail = str(d.detail);
      if (type) injury.type = type;
      if (detail) injury.detail = detail;
      const e: EspnEntry = { name, team, pos, injury };
      const id = espnIdOf(a);
      if (id) e.espnId = id;
      entries.push(e);
    }
  }
  if (!total) throw new Error("ESPN: no injury entries in the response");
  return { total, entries };
}

/** Set `espnInjury` on our players (mutates db entries while the db is built), matched by the shared matcher. */
export function attachEspnInjuries(entries: EspnEntry[], ix: SleeperIndex): number {
  let matched = 0;
  for (const e of entries) {
    const p = matchListed(e, ix);
    if (!p || p.espnInjury) continue;
    p.espnInjury = { ...e.injury };
    matched++;
  }
  return matched;
}

/**
 * Load ESPN's feed into the player db (called once per db build). Never throws: on any failure the players keep no
 * ESPN entry (unknown). Logs one structured line per call.
 */
export async function loadEspnInjuries(ix: SleeperIndex): Promise<void> {
  const t0 = Date.now();
  try {
    const got = await fetchCachedMeta(sources.espnInjuries, ESPN_TTL_HOURS, { validate: validateEspnBody, timeoutMs: ESPN_TIMEOUT_MS });
    const { total, entries } = parseEspnInjuries(got.body);
    const matched = attachEspnInjuries(entries, ix);
    const dated = entries.filter((e) => e.injury.returnDate).length;
    console.log(
      `[espn] refresh source=${got.source} ageH=${got.ageH.toFixed(1)} entries=${total} fantasy=${entries.length} dated=${dated} matched=${matched} bytes=${got.body.length} ms=${Date.now() - t0}${got.error ? ` error="${got.error}"` : ""}`,
    );
  } catch (err) {
    console.warn(`[espn] refresh failed source=none error="${(err as Error).message}" entries=unknown ms=${Date.now() - t0}`);
  }
}
