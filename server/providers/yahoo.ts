// Yahoo Fantasy Sports provider: OAuth2 (authorization-code, `oob` by default),
// serialized + token-refreshing API client, and league / free-agent import.
// Pure parsing lives in ./yahoo-parse.ts (unit-tested against fixtures).
//
// Yahoo is not reachable from the build environment, so everything here is
// written against Yahoo's documented shapes and fails loudly: any parse error
// throws a YahooError whose message names the endpoint and includes the first
// 500 characters of the raw response, so a user can paste it back for a fix.
import type { League, Player } from "../model/types.js";
import type { PlayerDb } from "../data/players.js";
import { config } from "../config.js";
import { readJson, writeJson, removeJson, readCached, writeCached } from "./store.js";
import {
  parseGameKey,
  parseLeaguePlayers,
  parseRoster,
  parseSettings,
  parseStandings,
  parseUserGames,
  leagueKeyOfTeam,
  findPlayer,
  resolveTeam,
  withYahooStatus,
  type ParsedSettings,
  type UserLeague,
  type YahooPlayerEntry,
  type YahooTeamRaw,
} from "./yahoo-parse.js";

export { flatten } from "./yahoo-parse.js";

export interface YahooLeagueSummary {
  key: string;
  name: string;
  season: number;
  numTeams: number;
  currentWeek: number;
  myTeamKey?: string;
}

export interface YahooFreeAgent {
  player: Player;
  onWaivers: boolean;
  percentOwned?: number;
  /** Date the player clears waivers (Yahoo `ownership.waiver_date`), when on waivers. */
  waiverDate?: string;
}

/**
 * League plus Yahoo-only extras. `playerOverrides` holds *copies* of PlayerDb
 * players with Yahoo's (fresher) injury status applied — use
 * `playerOverrides[id] ?? db.players.get(id)` when valuing rostered players.
 */
export interface YahooLeague extends League {
  playerOverrides: Record<string, Player>;
  waiverType?: string; // Yahoo waiver_type, e.g. "R" (rolling), "FR" (FAAB + rolling), "continual"
  tradeEndDate?: string; // yyyy-mm-dd
}

export interface YahooProvider {
  /** True when YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET are configured. */
  isConfigured(): boolean;
  /** True when a usable (refreshable) token is stored. */
  isConnected(): Promise<boolean>;
  /** Yahoo consent URL for the user to open. */
  authUrl(): string;
  /** Exchange an oob / callback code for tokens and persist them. */
  exchangeCode(code: string): Promise<void>;
  disconnect(): Promise<void>;
  listLeagues(): Promise<YahooLeagueSummary[]>;
  /** Import a league (settings, teams, rosters). Cached in .data unless refresh. */
  getLeague(db: PlayerDb, leagueKey: string, opts?: { refresh?: boolean }): Promise<YahooLeague>;
  /** Free agents + waiver-wire players for the league, plus my waiver priority. */
  getFreeAgents(
    db: PlayerDb,
    leagueKey: string,
    opts?: { refresh?: boolean },
  ): Promise<{ freeAgents: YahooFreeAgent[]; myPriority?: number; myFaabBalance?: number }>;
  /** "oob" (paste-a-code) or "redirect" (YAHOO_REDIRECT_URI callback). */
  authMode(): "oob" | "redirect";
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** Error carrying the HTTP status to return, Yahoo's raw body and a user hint. */
export class YahooError extends Error {
  constructor(
    message: string,
    public status: number,
    public hint?: string,
    public yahooBody?: string,
    public endpoint?: string,
  ) {
    super(message);
    this.name = "YahooError";
  }
}

/** Pull a human-readable description out of a Yahoo error body (JSON, XML or HTML). */
export function describeYahooBody(text: string): string {
  const t = text.trim();
  if (!t) return "(empty body)";
  try {
    const j = JSON.parse(t);
    const e = j?.error;
    const d = (typeof e === "object" ? e?.description ?? e?.message : undefined) ?? j?.error_description ?? (typeof e === "string" ? e : undefined);
    if (d) return String(d).slice(0, 300);
  } catch {
    /* not JSON */
  }
  const xml = /<(?:yahoo:)?description>([\s\S]*?)<\/(?:yahoo:)?description>/i.exec(t);
  if (xml) return xml[1].trim().slice(0, 300);
  return t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function hintFor(status: number, body: string): string | undefined {
  if (status === 401 || /token_expired|token_rejected|invalid_grant/i.test(body))
    return "Yahoo rejected the login. Click Connect Yahoo again (Connect tab) to re-authorize.";
  if (status === 999) return "Yahoo is rate-limiting this app (error 999). Wait 5–15 minutes, then retry; avoid repeated ?refresh=1.";
  if (status === 403) return "Yahoo denied access. Make sure the connected Yahoo account is a member of this league and the app has Fantasy Sports Read permission.";
  if (status === 404) return "Yahoo could not find that league/team. Check the league key (the league id like 1405188, or a full key like 4xx.l.1405188) and that it belongs to the current NFL season.";
  if (status === 400) return "Yahoo rejected the request. If this persists, paste the error text into an issue.";
  if (status >= 500) return "Yahoo had a server error; try again in a minute.";
  return undefined;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

const AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
const API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";
const TOKEN_FILE = "yahoo-tokens";

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  token_type?: string;
  xoauth_yahoo_guid?: string;
}

const redirectUri = () => config.yahooRedirectUri || "oob";

function requireConfigured(): void {
  if (!config.yahooClientId || !config.yahooClientSecret) {
    throw new YahooError(
      "Yahoo is not configured.",
      400,
      "Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET in .env (see docs/YAHOO_SETUP.md), then restart the server.",
    );
  }
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  requireConfigured();
  const basic = Buffer.from(`${config.yahooClientId}:${config.yahooClientSecret}`).toString("base64");
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ ...params, redirect_uri: redirectUri() }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new YahooError(`Could not reach Yahoo login server: ${(err as Error).message}`, 502, "Check your internet connection.");
  }
  const text = await res.text();
  if (!res.ok) {
    const desc = describeYahooBody(text);
    const grant = params.grant_type;
    const hint =
      grant === "authorization_code"
        ? "The code was rejected — codes expire after a few minutes and work once. Click Connect again and paste the new code. Also check that YAHOO_REDIRECT_URI matches the app (leave it blank for the paste-a-code flow)."
        : "Your saved Yahoo login could not be refreshed. Click Connect Yahoo again.";
    throw new YahooError(`Yahoo token request (${grant}) failed: HTTP ${res.status} ${desc}`, res.status === 400 || res.status === 401 ? 401 : 502, hint, text.slice(0, 2000), TOKEN_URL);
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    throw new YahooError(`Yahoo token response was not JSON. Raw (first 500 chars): ${text.slice(0, 500)}`, 502, undefined, text.slice(0, 2000), TOKEN_URL);
  }
  if (typeof j.access_token !== "string") {
    throw new YahooError(`Yahoo token response had no access_token. Raw (first 500 chars): ${text.slice(0, 500)}`, 502, undefined, text.slice(0, 2000), TOKEN_URL);
  }
  const expiresIn = Number(j.expires_in ?? 3600);
  return {
    access_token: j.access_token,
    refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : "",
    expires_at: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
    token_type: typeof j.token_type === "string" ? j.token_type : undefined,
    xoauth_yahoo_guid: typeof j.xoauth_yahoo_guid === "string" ? j.xoauth_yahoo_guid : undefined,
  };
}

let tokenCache: Tokens | null | undefined; // undefined = not loaded yet
let refreshing: Promise<Tokens> | null = null;

async function loadTokens(): Promise<Tokens | null> {
  if (tokenCache === undefined) tokenCache = await readJson<Tokens>(TOKEN_FILE);
  return tokenCache;
}
async function saveTokens(t: Tokens): Promise<void> {
  tokenCache = t;
  await writeJson(TOKEN_FILE, t, { secret: true });
}

function refreshTokens(): Promise<Tokens> {
  refreshing ??= (async () => {
    const cur = await loadTokens();
    if (!cur?.refresh_token) throw new YahooError("Not connected to Yahoo.", 401, "Click Connect Yahoo on the Connect tab.");
    const next = await tokenRequest({ grant_type: "refresh_token", refresh_token: cur.refresh_token });
    const merged: Tokens = { ...next, refresh_token: next.refresh_token || cur.refresh_token, xoauth_yahoo_guid: next.xoauth_yahoo_guid ?? cur.xoauth_yahoo_guid };
    await saveTokens(merged);
    return merged;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function accessToken(): Promise<string> {
  requireConfigured();
  const t = await loadTokens();
  if (!t?.refresh_token && !t?.access_token) throw new YahooError("Not connected to Yahoo.", 401, "Click Connect Yahoo on the Connect tab.");
  if (!t.access_token || t.expires_at - Date.now() < 60_000) return (await refreshTokens()).access_token;
  return t.access_token;
}

// ---------------------------------------------------------------------------
// API client: one request in flight, small gap between calls, 401 → refresh + retry once
// ---------------------------------------------------------------------------

const GAP_MS = 350;
let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastCallAt + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastCallAt = Date.now();
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

async function rawGet(path: string): Promise<string> {
  const url = `${API_BASE}${path}${path.includes("?") ? "&" : "?"}format=json`;
  const doFetch = async (token: string) => {
    try {
      return await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new YahooError(`Could not reach Yahoo (${path}): ${(err as Error).message}`, 502, "Check your internet connection.", undefined, path);
    }
  };
  let res = await doFetch(await accessToken());
  if (res.status === 401) {
    await res.text().catch(() => "");
    res = await doFetch((await refreshTokens()).access_token);
  }
  const text = await res.text();
  if (!res.ok) {
    const desc = describeYahooBody(text);
    const status = res.status === 999 ? 429 : res.status >= 500 ? 502 : res.status;
    throw new YahooError(`Yahoo API error ${res.status} for ${path}: ${desc}`, status, hintFor(res.status, text), text.slice(0, 2000), path);
  }
  return text;
}

/** GET a Yahoo endpoint and parse it; parse failures include endpoint + raw excerpt. */
function yget<T>(path: string, parse: (json: unknown) => T): Promise<T> {
  return serialized(async () => {
    const text = await rawGet(path);
    try {
      return parse(JSON.parse(text));
    } catch (err) {
      console.error(`[yahoo] parse failure for ${path}. Raw response:\n${text.slice(0, 4000)}`);
      throw new YahooError(
        `Could not parse Yahoo response for ${path}: ${(err as Error).message}. Raw (first 500 chars): ${text.slice(0, 500)}`,
        502,
        "Yahoo's response did not have the expected shape. Please copy this whole error message into a bug report.",
        text.slice(0, 2000),
        path,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// league import
// ---------------------------------------------------------------------------

const TTL_MS = 15 * 60_000;
const loggedStats = new Set<string>();
const loggedSlots = new Set<string>();

interface LeagueRaw {
  parsed: ParsedSettings;
  teams: YahooTeamRaw[];
  myTeamKey?: string;
}

let nflGameKey: Promise<string> | null = null;
function getNflGameKey(): Promise<string> {
  nflGameKey ??= yget("/game/nfl", parseGameKey).catch((e) => {
    nflGameKey = null;
    throw e;
  });
  return nflGameKey;
}

/** Accept "1405188", "nfl.l.1405188", "{gid}.l.1405188" (optionally with a ".t.N" team suffix); return "{gameKey}.l.{id}". */
export async function normalizeLeagueKey(key: string): Promise<string> {
  const k = key.trim().replace(/\.t\.\d+$/i, "");
  const bare = /^\d+$/.exec(k)?.[0] ?? /^nfl\.l\.(\d+)$/i.exec(k)?.[1];
  if (bare) return `${await getNflGameKey()}.l.${bare}`;
  if (!/^\d+\.l\.\d+$/.test(k)) throw new YahooError(`Not a Yahoo league key: ${key}`, 400, "Use the league id (e.g. 1405188) or the full key shown in the league list (e.g. 4xx.l.1405188).");
  return k;
}

async function fetchMyTeamKeys(): Promise<string[]> {
  return (await yget("/users;use_login=1/games;game_keys=nfl/teams", parseUserGames)).myTeamKeys;
}

async function fetchLeagueRaw(key: string): Promise<LeagueRaw> {
  const parsed = await yget(`/league/${key}/settings`, parseSettings);
  const teams = await yget(`/league/${key}/standings`, parseStandings);
  let myTeamKey = teams.find((t) => t.isMine)?.key;
  if (!myTeamKey) {
    try {
      myTeamKey = (await fetchMyTeamKeys()).find((k) => leagueKeyOfTeam(k) === parsed.leagueKey);
    } catch (err) {
      console.warn(`[yahoo] could not determine my team: ${(err as Error).message}`);
    }
  }
  for (const t of teams) {
    t.isMine = t.key === myTeamKey;
    t.players = await yget(`/team/${t.key}/roster/players`, parseRoster);
  }
  const newStats = Object.keys(parsed.ignoredStats).filter((id) => !loggedStats.has(id));
  if (newStats.length) {
    newStats.forEach((id) => loggedStats.add(id));
    console.log(`[yahoo] ignoring stat modifiers (bonuses/other stats): ${newStats.map((id) => `${id}=${parsed.ignoredStats[id]}`).join(", ")}`);
  }
  const newSlots = parsed.unknownSlots.filter((s) => !loggedSlots.has(s));
  if (newSlots.length) {
    newSlots.forEach((s) => loggedSlots.add(s));
    console.log(`[yahoo] skipping unsupported roster slots: ${newSlots.join(", ")}`);
  }
  return { parsed, teams, myTeamKey };
}

function buildLeague(db: PlayerDb, raw: LeagueRaw, fetchedAt: string): YahooLeague {
  const s = raw.parsed.settings;
  const playerOverrides: Record<string, Player> = {};
  const teams = raw.teams.map((t) => {
    const r = resolveTeam(db, t, s.currentWeek, { usesFaab: s.usesFaab });
    Object.assign(playerOverrides, r.overrides);
    return r.team;
  });
  const unmatched = teams.reduce((n, t) => n + t.unmatched.length, 0);
  if (unmatched) console.log(`[yahoo] ${unmatched} rostered players could not be matched to the player database`);
  return {
    provider: "yahoo",
    id: raw.parsed.leagueKey,
    settings: s,
    teams,
    ...(raw.myTeamKey ? { myTeamId: raw.myTeamKey } : {}),
    fetchedAt,
    playerOverrides,
    ...(raw.parsed.waiverType ? { waiverType: raw.parsed.waiverType } : {}),
    ...(raw.parsed.tradeEndDate ? { tradeEndDate: raw.parsed.tradeEndDate } : {}),
  };
}

const inflight = new Map<string, Promise<{ raw: LeagueRaw; fetchedAt: string }>>();

async function getLeagueRaw(leagueKey: string, refresh: boolean): Promise<{ raw: LeagueRaw; fetchedAt: string }> {
  const key = await normalizeLeagueKey(leagueKey);
  const file = `yahoo-league-${key}`;
  if (!refresh) {
    const hit = await readCached<LeagueRaw>(file, TTL_MS);
    if (hit) return { raw: hit.data, fetchedAt: hit.fetchedAt };
  }
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const raw = await fetchLeagueRaw(key);
    const fetchedAt = await writeCached(file, raw);
    return { raw, fetchedAt };
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// free agents
// ---------------------------------------------------------------------------

const FA_PLAN: { pos: string; count: number }[] = [
  { pos: "QB", count: 50 },
  { pos: "RB", count: 50 },
  { pos: "WR", count: 50 },
  { pos: "TE", count: 50 },
  { pos: "K", count: 15 },
  { pos: "DEF", count: 15 },
];
const PAGE = 25; // Yahoo's max page size

async function fetchFreeAgentsRaw(key: string): Promise<YahooPlayerEntry[]> {
  const out: YahooPlayerEntry[] = [];
  for (const { pos, count } of FA_PLAN) {
    for (let start = 0; start < count; start += PAGE) {
      const n = Math.min(PAGE, count - start);
      const page = await yget(`/league/${key}/players;status=A;position=${pos};sort=OR;start=${start};count=${n};out=ownership,percent_owned`, parseLeaguePlayers);
      out.push(...page);
      if (page.length < n) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------

export const yahoo: YahooProvider = {
  isConfigured: () => Boolean(config.yahooClientId && config.yahooClientSecret),

  async isConnected() {
    if (!yahoo.isConfigured()) return false;
    const t = await loadTokens();
    return Boolean(t?.refresh_token);
  },

  authMode: () => (config.yahooRedirectUri ? "redirect" : "oob"),

  authUrl() {
    requireConfigured();
    const q = new URLSearchParams({ client_id: config.yahooClientId, redirect_uri: redirectUri(), response_type: "code", language: "en-us" });
    // Optional explicit scope (e.g. "fspt-r" = Fantasy Sports read) for apps where Yahoo reports a permissions error.
    const scope = (process.env.YAHOO_SCOPE ?? "").trim();
    if (scope) q.set("scope", scope);
    return `${AUTH_URL}?${q.toString()}`;
  },

  async exchangeCode(code: string) {
    const c = code.trim();
    if (!c) throw new YahooError("Missing code.", 400, "Paste the code Yahoo showed you after you clicked Agree.");
    const t = await tokenRequest({ grant_type: "authorization_code", code: c });
    if (!t.refresh_token) console.warn("[yahoo] token response had no refresh_token; you will need to reconnect in an hour");
    await saveTokens(t);
  },

  async disconnect() {
    tokenCache = null;
    await removeJson(TOKEN_FILE);
  },

  async listLeagues() {
    let res: { leagues: UserLeague[]; myTeamKeys: string[] };
    try {
      res = await yget("/users;use_login=1/games;game_keys=nfl/leagues/teams", parseUserGames);
    } catch (err) {
      if (!(err instanceof YahooError) || ![400, 404, 502].includes(err.status)) throw err;
      console.warn(`[yahoo] leagues/teams call failed (${err.message.slice(0, 200)}); falling back to separate calls`);
      res = await yget("/users;use_login=1/games;game_keys=nfl/leagues", parseUserGames);
    }
    if (res.leagues.some((l) => !l.myTeamKey)) {
      try {
        const mine = await fetchMyTeamKeys();
        for (const l of res.leagues) {
          const k = l.myTeamKey ?? mine.find((t) => leagueKeyOfTeam(t) === l.key);
          if (k) l.myTeamKey = k;
        }
      } catch (err) {
        console.warn(`[yahoo] could not list my teams: ${(err as Error).message}`);
      }
    }
    return res.leagues.map((l) => ({ ...l }));
  },

  async getLeague(db, leagueKey, opts = {}) {
    const { raw, fetchedAt } = await getLeagueRaw(leagueKey, Boolean(opts.refresh));
    return buildLeague(db, raw, fetchedAt);
  },

  async getFreeAgents(db, leagueKey, opts = {}) {
    const key = await normalizeLeagueKey(leagueKey);
    const { raw } = await getLeagueRaw(key, false);
    const file = `yahoo-fa-${key}`;
    let entries: YahooPlayerEntry[] | undefined;
    if (!opts.refresh) entries = (await readCached<YahooPlayerEntry[]>(file, TTL_MS))?.data;
    if (!entries) {
      entries = await fetchFreeAgentsRaw(key);
      await writeCached(file, entries);
    }
    const week = raw.parsed.settings.currentWeek;
    const seen = new Set<string>();
    const freeAgents: YahooFreeAgent[] = [];
    let unmatched = 0;
    for (const e of entries) {
      if (e.ownershipType === "team") continue;
      const p = findPlayer(db, e);
      if (!p) {
        unmatched++;
        continue;
      }
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      freeAgents.push({
        player: withYahooStatus(p, e, week) ?? { ...p },
        onWaivers: e.ownershipType === "waivers",
        ...(e.percentOwned !== undefined ? { percentOwned: e.percentOwned } : {}),
        ...(e.waiverDate ? { waiverDate: e.waiverDate } : {}),
      });
    }
    if (unmatched) console.log(`[yahoo] ${unmatched} free agents could not be matched to the player database`);
    const mine = raw.teams.find((t) => t.key === raw.myTeamKey);
    return {
      freeAgents,
      ...(mine?.waiverPriority !== undefined ? { myPriority: mine.waiverPriority } : {}),
      ...(mine?.faabBalance !== undefined ? { myFaabBalance: mine.faabBalance } : {}),
    };
  },
};
