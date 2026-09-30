// HTTP route handlers (thin). Contract: docs/DESIGN.md "HTTP API contract".
import { Router, type NextFunction, type Request, type Response } from "express";
import { getPlayerDb, type PlayerDb } from "./data/players.js";
import { getNflState } from "./data/nfl.js";
import { yahoo } from "./providers/yahoo.js";
import { buildDemoLeague, demoFreeAgents } from "./providers/demo.js";
import {
  applySettings,
  buildImportLeague,
  deleteImport,
  importFreeAgents,
  isValidId,
  listImports,
  MAX_BYTES,
  mergeTeams,
  newPasteImport,
  readImport,
  saveImport,
  validateImport,
  type StoredImport,
} from "./providers/import.js";
import { parseRosterText } from "./providers/import-text.js";
import { bookmarkletCode, bookmarkletUrl } from "./providers/import-bookmarklet.js";
import { analyzeLeague, type LeagueContext } from "./model/analysis.js";
import { evaluateTrade, findTrades } from "./model/trades.js";
import { rankWaivers, type FreeAgentInput } from "./model/waivers.js";
import type { League, Player, Trade, ValuedPlayer } from "./model/types.js";

const CACHE_TTL_MS = 60_000;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- caching
interface Entry<T> {
  at: number;
  value: Promise<T>;
}
const cache = new Map<string, Entry<unknown>>();
function cached<T>(key: string, refresh: boolean, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Entry<T> | undefined;
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = make();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  // opportunistic sweep
  if (cache.size > 200) for (const [k, e] of cache) if (Date.now() - e.at > CACHE_TTL_MS) cache.delete(k);
  return value;
}
function invalidate(prefix: string) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

// ---------------------------------------------------------------- league loading
type Provider = "demo" | "yahoo" | "import";
function parseProvider(p: string): Provider {
  if (p === "demo" || p === "yahoo" || p === "import") return p;
  throw new HttpError(404, `Unknown provider "${p}"`, "Use provider demo, yahoo or import.");
}

async function mustReadImport(id: string): Promise<StoredImport> {
  const s = await readImport(id);
  if (!s) throw new HttpError(404, `No imported league "${id}"`, "Import it again on the Connect tab.");
  return s;
}

function demoSeed(id: string): number {
  const n = Number(id);
  if (Number.isInteger(n) && n >= 0) return n;
  let h = 0;
  for (const c of id) h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
  return h;
}

async function loadLeague(provider: Provider, id: string, refresh: boolean): Promise<{ db: PlayerDb; league: League }> {
  const db = await getPlayerDb();
  if (provider === "demo") {
    const state = await getNflState();
    const league = buildDemoLeague({ season: db.season, currentWeek: state.currentWeek, players: db.players.values(), builtAt: db.builtAt }, demoSeed(id));
    return { db, league };
  }
  if (provider === "import") {
    const [stored, state] = await Promise.all([mustReadImport(id), getNflState()]);
    return { db, league: buildImportLeague(db, stored, { season: db.season, currentWeek: state.currentWeek }) };
  }
  const league = await yahoo.getLeague(db, id, { refresh });
  return { db, league };
}

/**
 * Player pool for valuation: the PlayerDb, with Yahoo's per-league copies
 * (fresher injury / IR status) substituted where present. Demo and Yahoo share this path.
 */
export function playerPool(db: PlayerDb, league: League): Player[] {
  const overrides = (league as League & { playerOverrides?: Record<string, Player> }).playerOverrides ?? {};
  const out: Player[] = [];
  for (const p of db.players.values()) out.push(overrides[p.id] ?? p);
  for (const [id, p] of Object.entries(overrides)) if (!db.players.has(id)) out.push(p);
  return out;
}

interface Loaded {
  db: PlayerDb;
  league: League;
  ctx: LeagueContext;
}

function loadContext(provider: Provider, id: string, refresh: boolean): Promise<Loaded> {
  if (refresh) invalidate(`${provider}:${id}:`);
  return cached(`${provider}:${id}:ctx`, refresh, async () => {
    const { db, league } = await loadLeague(provider, id, refresh);
    const ctx = analyzeLeague(league, playerPool(db, league));
    return { db, league, ctx };
  });
}

function teamParam(req: Request, league: League, key = "team"): string {
  const raw = (req.query[key] ?? (req.body as Record<string, unknown> | undefined)?.[key]) as string | undefined;
  const team = raw && raw !== "" ? String(raw) : league.myTeamId ?? league.teams[0]?.id;
  if (!team || !league.teams.some((t) => t.id === team)) throw new HttpError(400, `Unknown team "${raw}"`, `Valid team ids: ${league.teams.map((t) => t.id).join(", ")}`);
  return team;
}

const isRefresh = (req: Request) => req.query.refresh === "1" || req.query.refresh === "true";

/** Players worth sending to the UI: rostered, ranked, or with value. */
function relevantPlayers(l: Loaded): ValuedPlayer[] {
  const rostered = new Set(l.league.teams.flatMap((t) => t.playerIds));
  return [...l.ctx.players.values()].filter((p) => rostered.has(p.id) || p.value > 0 || p.ecrOverall !== undefined || p.ecrPos !== undefined);
}

// ---------------------------------------------------------------- errors
type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

export function errorHint(status: number, message: string): string | undefined {
  if (status === 401) return "Your Yahoo session expired or was revoked: reconnect on the Connect tab.";
  if (status === 999 || status === 429) return "Yahoo is rate limiting requests: wait a minute and try again.";
  if (/not implemented|not configured|client.?id/i.test(message)) return "Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET in .env (see docs/YAHOO_SETUP.md), restart, then connect on the Connect tab.";
  if (/not connected|no token/i.test(message)) return "Connect your Yahoo account on the Connect tab first.";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(message)) return "A network request failed: check your internet connection and retry.";
  return undefined;
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const e = err as { status?: number; statusCode?: number; message?: string; hint?: string; yahooBody?: unknown };
  const upstream = Number(e?.status ?? e?.statusCode ?? 500);
  const message = e?.message ?? String(err);
  // Yahoo's 999 (rate limit) is not a valid HTTP status: report it as 429.
  const status = upstream === 999 ? 429 : upstream >= 400 && upstream < 600 ? upstream : 500;
  if (status >= 500) console.error("[api]", err);
  const body: Record<string, unknown> = { error: message };
  const hint = e?.hint ?? errorHint(upstream, message);
  if (hint) body.hint = hint;
  if (e?.yahooBody !== undefined) {
    body.status = upstream;
    body.yahooBody = e.yahooBody;
  }
  res.status(status).json(body);
}

// ---------------------------------------------------------------- routes
export const apiRouter = Router();

apiRouter.get(
  "/api/state",
  h(async (_req, res) => {
    const [db, state] = await Promise.all([getPlayerDb(), getNflState()]);
    let yahooConnected = false;
    try {
      yahooConnected = await yahoo.isConnected();
    } catch {
      yahooConnected = false;
    }
    res.json({
      season: state.season,
      currentWeek: state.currentWeek,
      lastRegularWeek: state.lastRegularWeek,
      dbBuiltAt: db.builtAt,
      playerCount: db.players.size,
      yahooConfigured: yahoo.isConfigured(),
      yahooConnected,
    });
  }),
);

apiRouter.get(
  "/api/players/search",
  h(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.json([]);
    const provider = req.query.provider ? parseProvider(String(req.query.provider)) : "demo";
    const id = req.query.id ? String(req.query.id) : "42";
    const l = await loadContext(provider, id, false);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20) || 20));
    res.json(
      l.db.search(q, limit).map((p) => {
        const v = l.ctx.players.get(p.id);
        return { id: p.id, name: p.name, pos: p.pos, team: p.team, ecrOverall: p.ecrOverall, value: v?.value ?? 0, ppg: v?.ppg ?? 0 };
      }),
    );
  }),
);

apiRouter.get(
  "/api/yahoo/leagues",
  h(async (_req, res) => {
    res.json(await yahoo.listLeagues());
  }),
);

apiRouter.get(
  "/api/league/:provider/:id",
  h(async (req, res) => {
    const l = await loadContext(parseProvider(req.params.provider), req.params.id, isRefresh(req));
    res.json(l.league);
  }),
);

apiRouter.get(
  "/api/league/:provider/:id/analysis",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const l = await loadContext(provider, req.params.id, isRefresh(req));
    const team = teamParam(req, l.league);
    const players: Record<string, ValuedPlayer> = {};
    for (const p of relevantPlayers(l)) players[p.id] = p;
    res.json({ league: l.league, players, teams: l.ctx.teams, replacement: l.ctx.replacement, myTeamId: team, notes: l.ctx.notes });
  }),
);

apiRouter.get(
  "/api/league/:provider/:id/trades",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const l = await loadContext(provider, req.params.id, isRefresh(req));
    const team = teamParam(req, l.league);
    const partner = req.query.partner ? String(req.query.partner) : undefined;
    if (partner && !l.league.teams.some((t) => t.id === partner)) throw new HttpError(400, `Unknown partner "${partner}"`);
    if (partner === team) throw new HttpError(400, "Partner must be a different team");
    const wantPos = req.query.wantPos ? String(req.query.wantPos).toUpperCase() : undefined;
    const maxGive = Number(req.query.maxGive ?? 2) || 2;
    const maxGet = Number(req.query.maxGet ?? 2) || 2;
    const key = `${provider}:${req.params.id}:trades:${team}:${partner ?? ""}:${wantPos ?? ""}:${maxGive}:${maxGet}`;
    const trades = await cached<Trade[]>(key, false, async () => findTrades(l.ctx, team, { partnerId: partner, wantPos, maxGive, maxGet }));
    res.json(trades);
  }),
);

apiRouter.post(
  "/api/league/:provider/:id/trade/evaluate",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const l = await loadContext(provider, req.params.id, false);
    const body = (req.body ?? {}) as { team?: string; partner?: string; give?: unknown; get?: unknown };
    const team = teamParam(req, l.league);
    const partner = body.partner ? String(body.partner) : undefined;
    if (!partner || !l.league.teams.some((t) => t.id === partner)) throw new HttpError(400, `Unknown partner "${partner ?? ""}"`, "Pass { team, partner, give: string[], get: string[] }.");
    if (partner === team) throw new HttpError(400, "Partner must be a different team");
    const ids = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
    res.json(evaluateTrade(l.ctx, team, partner, ids(body.give), ids(body.get)));
  }),
);

apiRouter.get(
  "/api/league/:provider/:id/waivers",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const refresh = isRefresh(req);
    const l = await loadContext(provider, req.params.id, refresh);
    const team = teamParam(req, l.league);
    const key = `${provider}:${req.params.id}:waivers:${team}`;
    const result = await cached(key, refresh, async () => {
      let fas: { player: Player; onWaivers: boolean; percentOwned?: number }[];
      let myPriority: number | undefined;
      let league = l.league;
      if (provider === "demo") {
        const d = demoFreeAgents({ ...l.league, myTeamId: team }, l.db.players.values());
        fas = d.freeAgents;
        myPriority = d.myPriority;
      } else if (provider === "import") {
        const stored = await mustReadImport(req.params.id);
        const d = importFreeAgents(l.league, l.db, stored, l.league.settings.currentWeek);
        fas = d.freeAgents;
        myPriority = team === l.league.myTeamId ? d.myPriority : undefined;
      } else {
        const y = await yahoo.getFreeAgents(l.db, req.params.id, { refresh });
        fas = y.freeAgents;
        myPriority = team === l.league.myTeamId ? y.myPriority : undefined;
        if (team === l.league.myTeamId && y.myFaabBalance !== undefined) {
          league = { ...l.league, teams: l.league.teams.map((t) => (t.id === team ? { ...t, faabRemaining: y.myFaabBalance } : t)) };
        }
      }
      const rostered = new Set(l.league.teams.flatMap((t) => t.playerIds));
      const seen = new Set<string>();
      const input: FreeAgentInput[] = [];
      for (const f of fas) {
        if (rostered.has(f.player.id) || seen.has(f.player.id)) continue;
        seen.add(f.player.id);
        input.push({ player: l.ctx.valuation.valueOf(f.player), onWaivers: f.onWaivers, percentOwned: f.percentOwned });
      }
      return rankWaivers({ ...l.ctx, league }, team, input, { myPriority });
    });
    res.json(result);
  }),
);

apiRouter.get(
  "/api/league/:provider/:id/values",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const l = await loadContext(provider, req.params.id, isRefresh(req));
    if (req.query.team) teamParam(req, l.league); // validate only
    const owner = new Map<string, string>();
    for (const t of l.league.teams) for (const id of t.playerIds) owner.set(id, t.id);
    const rows = relevantPlayers(l)
      .sort((a, b) => b.value - a.value || b.ppg - a.ppg || a.name.localeCompare(b.name))
      .map((p) => ({ ...p, ownerTeamId: owner.get(p.id), rostered: owner.has(p.id) }));
    res.json(rows);
  }),
);

// ---------------------------------------------------------------- import (Yahoo web pages, no API)
apiRouter.get(
  "/api/import/bookmarklet.js",
  h(async (req, res) => {
    if (req.query.format === "url") return res.json({ url: await bookmarkletUrl() });
    res.type("application/javascript").set("Cache-Control", "no-cache").send(await bookmarkletCode());
  }),
);

apiRouter.get(
  "/api/import",
  h(async (_req, res) => {
    res.json(await listImports());
  }),
);

apiRouter.post(
  "/api/import",
  h(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") throw new HttpError(400, "Expected a JSON body", "Send the bookmarklet JSON, or { text, teamName } for pasted roster text.");
    if (JSON.stringify(body).length > MAX_BYTES) throw new HttpError(413, "Import is larger than 1 MB");
    let stored: StoredImport;
    let skippedLines: number | undefined;
    if (typeof body.text === "string") {
      const teamName = typeof body.teamName === "string" && body.teamName.trim() ? body.teamName.trim().slice(0, 80) : "My Team";
      const parsed = parseRosterText(body.text, teamName);
      skippedLines = parsed.skippedLines;
      if (!parsed.teams.length) throw new HttpError(400, "No players found in the pasted text", 'Each player line should look like "Patrick Mahomes KC - QB" or "Josh Allen (QB - BUF)".');
      const targetId = typeof body.id === "string" && body.id ? body.id : undefined;
      const existing = targetId && parsed.teams.length === 1 ? await readImport(targetId) : null;
      if (targetId && parsed.teams.length === 1 && !existing) throw new HttpError(404, `No imported league "${targetId}"`);
      stored = existing ? mergeTeams(existing, parsed.teams) : newPasteImport(parsed.teams, parsed.teams.length > 1 ? "Pasted league" : `${teamName} (pasted)`);
      for (const t of stored.teams) if (t.players.length > 40) throw new HttpError(400, `Team "${t.name}" has ${t.players.length} players; the limit is 40`);
      stored.importedAt = new Date().toISOString();
    } else {
      stored = validateImport(body);
    }
    await saveImport(stored);
    invalidate(`import:${stored.id}:`);
    res.json({
      id: stored.id,
      name: stored.name,
      teams: stored.teams.map((t) => ({ id: t.id, name: t.name, players: t.players.length })),
      myTeamId: stored.myTeamId,
      settingsSource: stored.settingsSource,
      ...(skippedLines !== undefined ? { skippedLines } : {}),
    });
  }),
);

apiRouter.get(
  "/api/import/:id",
  h(async (req, res) => {
    const { diagnostics: _d, ...rest } = await mustReadImport(req.params.id);
    res.json(rest);
  }),
);

apiRouter.put(
  "/api/import/:id/settings",
  h(async (req, res) => {
    const next = applySettings(await mustReadImport(req.params.id), req.body);
    await saveImport(next);
    invalidate(`import:${next.id}:`);
    const { diagnostics: _d, ...rest } = next;
    res.json(rest);
  }),
);

apiRouter.delete(
  "/api/import/:id",
  h(async (req, res) => {
    if (!isValidId(req.params.id) || !(await deleteImport(req.params.id))) throw new HttpError(404, `No imported league "${req.params.id}"`);
    invalidate(`import:${req.params.id}:`);
    res.json({ ok: true });
  }),
);

apiRouter.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found", hint: "See docs/DESIGN.md for the API contract." });
});
