// Typed fetch wrappers for every endpoint in docs/DESIGN.md "HTTP API contract".
// With `?mock=1` in the page URL all calls are answered by ./mock.ts instead.
import type { BreakoutResponse, BreakoutTargetRow, CardPlayer, DetailItem, StashRow, ValueRow, WaiverRow, League, Position, Scoring, SlotKind, TeamAnalysis, Trade, TradeFinderResult, ValuedPlayer, WaiverTarget } from "../../server/model/types";

export type TradeMode = "now" | "balanced" | "playoffs";
export type { TradeFinderResult };
import type { LeagueView } from "../../server/model/league";
import type { AccuracyResponse } from "../../server/model/projLog";
import { ApiError } from "./lib/errors";

export { ApiError };
export type { WaiverTarget, WaiverRow, StashRow, BreakoutTargetRow, BreakoutResponse, CardPlayer, DetailItem, LeagueView, ValueRow };

/** ValuedPlayer as served by the API. */
export type VP = ValuedPlayer;

export interface AppState {
  season: number;
  currentWeek: number;
  lastRegularWeek: number;
  dbBuiltAt: string;
  playerCount: number;
  yahooConfigured: boolean;
  yahooConnected: boolean;
}

export interface PlayerLite {
  id: string;
  name: string;
  pos: Position;
  team: string;
  ecrOverall?: number;
}

export interface YahooLeague {
  key: string;
  name: string;
  season: number;
  numTeams: number;
  currentWeek: number;
  myTeamKey?: string;
}

export interface Analysis {
  league: League;
  players: Record<string, VP>;
  teams: TeamAnalysis[];
  replacement: Record<string, number>;
  myTeamId: string;
  /** Model caveats shown as a footnote (e.g. "ECR ranks are PPR; points use league scoring."). */
  notes?: string[];
  /** Where players' market values come from ("model" = FantasyCalc unavailable, no market columns). */
  valueSource?: "fantasycalc" | "model";
  /** Value weighting for the request team: playoffs (in a playoff spot) or balanced. */
  valueMode?: "playoffs" | "balanced";
}

export type TradeResult = Trade & { verdict?: string };

export interface WaiversResponse {
  /** Slim rows: only what the Waivers tab renders. */
  freeAgents: WaiverRow[];
  myPriority?: number;
  numTeams: number;
  /** One short line: counts and top names. */
  advice: string;
  /** "How calls work", one rule per item. */
  rules: DetailItem[];
  /** false = the import did not say who is a free agent vs on waivers (re-import to see). */
  faStatusKnown: boolean;
  /** Data problems worth a line (e.g. imported free agents we could not match), when any. */
  notes?: string[];
  /** One line per weak starting position where no free agent beats my starter ("look at trades"). */
  gaps?: string[];
  /** Stash watch: unrostered players out now who matter on their return (≤ 10). */
  stash: StashRow[];
}


export type ProviderId = "demo" | "yahoo" | "import";

export type SettingsSource = "page" | "partial" | "default" | "user";

export interface ImportSummary {
  id: string;
  name: string;
  importedAt: string;
  numTeams: number;
  teams: number;
  settingsSource: SettingsSource;
  /** Who ran the latest import (absent on imports saved before release 5). */
  importedBy?: string;
  hasStandings: boolean;
  hasFreeAgents: boolean;
}

export interface ImportResult {
  id: string;
  name: string;
  teams: { id: string; name: string; players: number }[];
  myTeamId?: string;
  settingsSource: SettingsSource;
  skippedLines?: number;
  importedAt?: string;
  importedBy?: string;
  /** true when the same league was imported before and was updated in place (settings kept). */
  updated?: boolean;
  changes?: { teams: number; playersChanged: number };
}

/** GET /api/import/:id/changes: roster moves between the two most recent imports. */
export interface ImportChanges {
  from: string | null;
  to: string;
  teamsChanged: number;
  playersChanged: number;
  teams: { id: string; name: string; added: string[]; dropped: string[] }[];
}

/** Stored import as returned by GET /api/import/:id (raw rosters, editable settings). */
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
  teams: { id: string; name: string; owner?: string; players: { name: string; pos: string; team?: string }[] }[];
  importedAt: string;
  settingsSource: SettingsSource;
}

export interface ImportSettingsPatch {
  scoring?: Partial<Scoring>;
  slots?: string;
  waiverPriority?: number | null;
  myTeamId?: string;
  name?: string;
  tradeDeadlineWeek?: number | null;
}

export interface Active {
  provider: ProviderId;
  id: string;
  team?: string;
}

export interface TradeQuery {
  mode?: TradeMode;
  partner?: string;
  wantPos?: string;
  maxGive?: number;
  maxGet?: number;
}

/** GET /api/autoimport — server-side scheduled Yahoo import (stopgap until the Yahoo API; docs/DESIGN.md "Auto-import"). */
export interface AutoImportStatus {
  enabled: boolean;
  disabledReason?: string;
  leagueId?: string;
  /** The stored import it refreshes ("y<leagueId>"). */
  importId?: string;
  state: "ok" | "paused";
  reason?: "signed_out" | "captcha" | "empty" | "partial" | "timeout" | "profile_in_use" | "error" | string;
  detail?: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  lastTeams?: number;
  nextRunAt?: string;
  running: boolean;
  timezone?: string;
}

/** GET /api/auth/me: who is signed in and what they may see (docs/DESIGN.md "Discord sign-in"). */
export interface Me {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** The account's own role (stays "admin" while viewing as a user). */
  role: "admin" | "user";
  csrf: string;
  /** The league and team this session is limited to; null = admin view (everything). */
  scope: { leagueId: string; teamId: string } | null;
  actingAs: { discordId: string; note: string | null; leagueId: string; teamId: string } | null;
  /** Dev mode: no Discord config on a development server; every request is the built-in admin. */
  dev?: boolean;
}

export interface AccessOverview {
  users: { discordId: string; leagueId: string; teamId: string; note?: string }[];
  leagues: { id: string; name: string; teams: { id: string; name: string }[] }[];
}

/** Why the API refused this browser: no/expired session, or the Discord account is no longer on the list. */
export type AuthProblem = "signin" | "not_allowed";

let csrfToken = "";
let onAuthProblem: ((p: AuthProblem) => void) | undefined;
/** Set by the app after GET /api/auth/me; sent as X-CSRF-Token on every write. */
export function setCsrf(token: string): void {
  csrfToken = token;
}
/** The app shows the sign-in screen when any request answers 401 (or 403 not_allowed). */
export function setAuthProblemHandler(fn: ((p: AuthProblem) => void) | undefined): void {
  onAuthProblem = fn;
}

export const MOCK = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mock") === "1";

async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, opts: { quietAuth?: boolean } = {}): Promise<T> {
  if (MOCK) {
    const { mockRequest } = await import("./mock");
    return mockRequest(method, path, body) as Promise<T>;
  }
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(
      "Cannot reach the Trade Desk server.",
      0,
      "Start it with `npm run dev`, or add ?mock=1 to the URL to explore the UI with sample data.",
    );
  }
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    if (data === undefined && !text && res.status >= 500) {
      // The Vite dev/preview proxy answers 500 with an empty body when the API server is down.
      throw new ApiError("The Trade Desk server did not respond.", res.status, "Is `npm run dev` still running? Check its terminal for errors, then retry.");
    }
    const e = (data ?? {}) as { error?: string; hint?: string; code?: string };
    if (!opts.quietAuth && (res.status === 401 || (res.status === 403 && e.code === "not_allowed"))) onAuthProblem?.(res.status === 401 ? "signin" : "not_allowed");
    throw new ApiError(e.error ?? `Request failed (${res.status})`, res.status, e.hint ?? (text && !data ? text.slice(0, 200) : undefined), e.code);
  }
  if (data === undefined) throw new ApiError("Server returned an empty or non-JSON response.", res.status, text.slice(0, 200));
  return data as T;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

const base = (a: Active) => `/api/league/${encodeURIComponent(a.provider)}/${encodeURIComponent(a.id)}`;

export const api = {
  me: () => request<Me>("GET", "/api/auth/me", undefined, { quietAuth: true }),
  actAs: (discordId: string | null) => request<Me>("POST", "/api/auth/act-as", { discordId }),
  access: () => request<AccessOverview>("GET", "/api/access"),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),

  state: () => request<AppState>("GET", "/api/state"),
  searchPlayers: (q: string) => request<PlayerLite[]>("GET", `/api/players/search${qs({ q })}`),

  yahooStart: () => request<{ url: string; mode?: "oob" | "redirect" }>("GET", "/auth/yahoo/start"),
  yahooCode: (code: string) => request<{ ok: true }>("POST", "/auth/yahoo/code", { code }),
  yahooDisconnect: () => request<{ ok: true }>("POST", "/auth/yahoo/disconnect"),
  yahooLeagues: () => request<YahooLeague[]>("GET", "/api/yahoo/leagues"),

  league: (a: Pick<Active, "provider" | "id">, refresh = false) =>
    request<League>("GET", `${base(a)}${qs({ refresh: refresh ? 1 : undefined })}`),
  analysis: (a: Active) => request<Analysis>("GET", `${base(a)}/analysis${qs({ team: a.team })}`),
  /** Trade Finder v3: market-value packages, smaller edges, near misses, partners and a summary line. */
  trades2: (a: Active, q: TradeQuery = {}) =>
    request<TradeFinderResult>(
      "GET",
      `${base(a)}/trades2${qs({ team: a.team, mode: q.mode ?? "balanced", partner: q.partner, wantPos: q.wantPos, maxGive: q.maxGive ?? 2, maxGet: q.maxGet ?? 2 })}`,
    ),
  benchUpgrades: (a: Active, mode: TradeMode = "balanced") => request<Trade[]>("GET", `${base(a)}/bench-upgrades${qs({ team: a.team, mode })}`),
  evaluateTrade: (a: Active, partner: string, give: string[], get: string[], mode: TradeMode = "balanced") =>
    request<Trade & { verdict: string }>("POST", `${base(a)}/trade/evaluate`, { team: a.team, partner, give, get, mode }),
  /** League tab: standings, power-score parts, who is above me and why. */
  leagueView: (a: Active) => request<LeagueView>("GET", `${base(a)}/league${qs({ team: a.team })}`),
  /** League tab "Projection accuracy" card: app vs Yahoo weekly projections against actual points (import leagues). */
  accuracy: (a: Active) => request<AccuracyResponse>("GET", `${base(a)}/accuracy`),
  waivers: (a: Active) => request<WaiversResponse>("GET", `${base(a)}/waivers${qs({ team: a.team })}`),
  /** Slim rows (no value explanation); `valueWhy` fetches one player's value bullets on tap. */
  values: (a: Active) => request<ValueRow[]>("GET", `${base(a)}/values${qs({ team: a.team })}`),
  valueWhy: async (a: Active, id: string) => (await request<ValueRow[]>("GET", `${base(a)}/values${qs({ team: a.team, id })}`))[0]?.whyItems ?? [],
  /** Breakout Targets: rising role before rising points (RB / WR / TE). */
  breakouts: (a: Active, pos: "RB" | "WR" | "TE" | "all" | string = "all", limit = 30) =>
    request<BreakoutResponse>("GET", `${base(a)}/breakouts${qs({ team: a.team, pos, limit })}`),

  imports: () => request<ImportSummary[]>("GET", "/api/import"),
  importGet: (id: string) => request<StoredImport>("GET", `/api/import/${encodeURIComponent(id)}`),
  /** Bookmarklet JSON (parsed object) or paste mode { text, teamName, id? }. */
  importPost: (body: unknown) => request<ImportResult>("POST", "/api/import", body),
  importChanges: (id: string) => request<ImportChanges>("GET", `/api/import/${encodeURIComponent(id)}/changes`),
  importDelete: (id: string) => request<{ ok: true }>("DELETE", `/api/import/${encodeURIComponent(id)}`),
  importSettings: (id: string, patch: ImportSettingsPatch) => request<StoredImport>("PUT", `/api/import/${encodeURIComponent(id)}/settings`, patch),
  bookmarkletUrl: () => request<{ url: string; version: string }>("GET", "/api/import/bookmarklet-url"),
  autoImport: () => request<AutoImportStatus>("GET", "/api/autoimport"),
  /** "Refresh from Yahoo now" (admin): 202 running; 409 busy/disabled; 429 within 2 minutes. */
  autoImportRefresh: () => request<{ status: "running"; runId: string }>("POST", "/api/autoimport/refresh"),
};
