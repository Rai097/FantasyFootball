// Typed fetch wrappers for every endpoint in docs/DESIGN.md "HTTP API contract".
// With `?mock=1` in the page URL all calls are answered by ./mock.ts instead.
import type { League, Position, TeamAnalysis, Trade, ValuedPlayer, WaiverTarget } from "../../server/model/types";
import { ApiError } from "./lib/errors";

export { ApiError };
export type { WaiverTarget };

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
}

export type TradeResult = Trade & { verdict?: string };

export interface WaiversResponse {
  freeAgents: WaiverTarget[];
  myPriority?: number;
  numTeams: number;
  advice: string;
}

export type ValueRow = VP & { ownerTeamId?: string };

export type ProviderId = "demo" | "yahoo";

export interface Active {
  provider: ProviderId;
  id: string;
  team?: string;
}

export interface TradeQuery {
  partner?: string;
  wantPos?: string;
  maxGive?: number;
  maxGet?: number;
}

export const MOCK = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mock") === "1";

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (MOCK) {
    const { mockRequest } = await import("./mock");
    return mockRequest(method, path, body) as Promise<T>;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
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
    const e = (data ?? {}) as { error?: string; hint?: string };
    throw new ApiError(e.error ?? `Request failed (${res.status})`, res.status, e.hint ?? (text && !data ? text.slice(0, 200) : undefined));
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
  state: () => request<AppState>("GET", "/api/state"),
  searchPlayers: (q: string) => request<PlayerLite[]>("GET", `/api/players/search${qs({ q })}`),

  yahooStart: () => request<{ url: string }>("GET", "/auth/yahoo/start"),
  yahooCode: (code: string) => request<{ ok: true }>("POST", "/auth/yahoo/code", { code }),
  yahooDisconnect: () => request<{ ok: true }>("POST", "/auth/yahoo/disconnect"),
  yahooLeagues: () => request<YahooLeague[]>("GET", "/api/yahoo/leagues"),

  league: (a: Pick<Active, "provider" | "id">, refresh = false) =>
    request<League>("GET", `${base(a)}${qs({ refresh: refresh ? 1 : undefined })}`),
  analysis: (a: Active) => request<Analysis>("GET", `${base(a)}/analysis${qs({ team: a.team })}`),
  trades: (a: Active, q: TradeQuery = {}) =>
    request<Trade[]>(
      "GET",
      `${base(a)}/trades${qs({ team: a.team, partner: q.partner, wantPos: q.wantPos, maxGive: q.maxGive ?? 2, maxGet: q.maxGet ?? 2 })}`,
    ),
  evaluateTrade: (a: Active, partner: string, give: string[], get: string[]) =>
    request<Trade & { verdict: string }>("POST", `${base(a)}/trade/evaluate`, { team: a.team, partner, give, get }),
  waivers: (a: Active) => request<WaiversResponse>("GET", `${base(a)}/waivers${qs({ team: a.team })}`),
  values: (a: Active) => request<ValueRow[]>("GET", `${base(a)}/values${qs({ team: a.team })}`),
};
