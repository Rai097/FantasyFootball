// HTTP route handlers (thin). Contract: docs/DESIGN.md "HTTP API contract".
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Router, type NextFunction, type Request, type Response } from "express";
import { getPlayerDb, type PlayerDb } from "./data/players.js";
import { getNflState } from "./data/nfl.js";
import { yahoo } from "./providers/yahoo.js";
import { buildDemoLeague, demoFreeAgents } from "./providers/demo.js";
import {
  applySettings,
  buildImportLeague,
  deleteHistory,
  deleteImport,
  findExistingImport,
  importFreeAgents,
  isValidId,
  latestChanges,
  listImports,
  MAX_BYTES,
  mergeTeams,
  newPasteImport,
  readHistory,
  readImport,
  recordHistory,
  saveImport,
  upsertImport,
  validateImport,
  type RosterChanges,
  type StoredImport,
} from "./providers/import.js";
import { parseRosterText } from "./providers/import-text.js";
import { bookmarkletCode, bookmarkletUrl } from "./providers/import-bookmarklet.js";
import { analyzeLeague, analyzeTeams, type LeagueContext } from "./model/analysis.js";
import { attachFloor, attachRisers } from "./model/signals.js";
import { getPriorWeeks } from "./data/priorWeeks.js";
import { findTrades } from "./model/trades.js";
import { findBenchUpgrades } from "./model/tradesV2.js";
import { benchUpgradeFilter, evaluateTradeV3, findTradesV3, qbRuleNote } from "./model/tradesV3.js";
import { attachMarket, marketQuery, type ValueSource } from "./model/market.js";
import { parseMode } from "./model/rosterScore.js";
import { rankWaivers, type FreeAgentInput } from "./model/waivers.js";
import { findBreakouts, type MarketValue } from "./model/breakouts.js";
import { getDepthChart } from "./data/depthCharts.js";
import { getMarketData, pprBucket } from "./data/fantasycalc.js";
import type { BreakoutResult, League, Player, Trade, TradeFinderResult, ValuedPlayer, WaiverTarget } from "./model/types.js";

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
export function cached<T>(key: string, refresh: boolean, make: () => Promise<T>): Promise<T> {
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
/**
 * Drop every cached result for one league. All league caches (ctx = league + analysis,
 * trades, trades2, bench, waivers, breakouts) are keyed `${provider}:${id}:…`.
 */
export function invalidateLeague(provider: string, id: string): void {
  invalidate(`${provider}:${id}:`);
}
/** Cached keys (tests). */
export const cacheKeys = (): string[] => [...cache.keys()];

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
  /** Where ValuedPlayer.market came from ("model" = FantasyCalc unavailable; market fields unset). */
  valueSource: ValueSource;
}

function loadContext(provider: Provider, id: string, refresh: boolean): Promise<Loaded> {
  if (refresh) invalidate(`${provider}:${id}:`);
  return cached(`${provider}:${id}:ctx`, refresh, async () => {
    const { db, league } = await loadLeague(provider, id, refresh);
    const ctx = analyzeLeague(league, playerPool(db, league));
    // Market (perceived) values for Trade Finder v3 and the Values tab; our values when unavailable.
    const md = await getMarketData(marketQuery(league.settings));
    const valueSource: ValueSource = md.source === "fantasycalc" && md.values.size ? "fantasycalc" : "model";
    attachMarket(ctx.players, valueSource === "fantasycalc" ? md.values : null);
    // v3.1 signals: role risers (ppg blends recent expected points) and weekly floor; then re-analyse teams.
    attachRisers(ctx.players, league.settings);
    attachFloor(ctx.players, await getPriorWeeks(db.season - 1), league.settings.scoring);
    ctx.teams = analyzeTeams(league, ctx.players, ctx.replacement);
    return { db, league, ctx, valueSource };
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

// ---------------------------------------------------------------- free agents (waivers + breakouts)
async function freeAgentInputs(
  l: Loaded,
  provider: Provider,
  id: string,
  team: string,
  refresh: boolean,
): Promise<{ input: FreeAgentInput[]; myPriority?: number; league: League }> {
  let fas: { player: Player; onWaivers: boolean; percentOwned?: number }[];
  let myPriority: number | undefined;
  let league = l.league;
  if (provider === "demo") {
    const d = demoFreeAgents({ ...l.league, myTeamId: team }, l.db.players.values());
    fas = d.freeAgents;
    myPriority = d.myPriority;
  } else if (provider === "import") {
    const stored = await mustReadImport(id);
    const d = importFreeAgents(l.league, l.db, stored, l.league.settings.currentWeek);
    fas = d.freeAgents;
    myPriority = team === l.league.myTeamId ? d.myPriority : undefined;
  } else {
    const y = await yahoo.getFreeAgents(l.db, id, { refresh });
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
  return { input, myPriority, league };
}

/** FantasyCalc market values for this league's format (null when unavailable). */
async function loadMarketValues(league: League): Promise<Map<string, MarketValue> | null> {
  const S = league.settings;
  const qbSlots = S.slots.filter((x) => x === "QB" || x === "SFLEX").length;
  const d = await getMarketData({ numQbs: qbSlots >= 2 ? 2 : 1, numTeams: S.numTeams || 12, ppr: pprBucket(S.scoring.rec), dynasty: S.isDynasty });
  return d.source === "fantasycalc" && d.values.size ? d.values : null;
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
    res.json({ league: l.league, players, teams: l.ctx.teams, replacement: l.ctx.replacement, myTeamId: team, notes: l.ctx.notes, valueSource: l.valueSource });
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

// Trade Finder v3 (market-value packages; same shape as v2 plus valueSource / partners). UI uses this.
apiRouter.get(
  "/api/league/:provider/:id/trades2",
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
    const mode = parseMode(req.query.mode);
    const key = `${provider}:${req.params.id}:trades2:${team}:${mode}:${partner ?? ""}:${wantPos ?? ""}:${maxGive}:${maxGet}`;
    const result = await cached<TradeFinderResult>(key, false, async () => {
      const { simulated: _simulated, ...r } = findTradesV3(l.ctx, team, { partnerId: partner, wantPos, maxGive, maxGet, mode, valueSource: l.valueSource });
      return r;
    });
    res.json(result);
  }),
);

apiRouter.get(
  "/api/league/:provider/:id/bench-upgrades",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const l = await loadContext(provider, req.params.id, isRefresh(req));
    const team = teamParam(req, l.league);
    const mode = parseMode(req.query.mode);
    const key = `${provider}:${req.params.id}:bench:${team}:${mode}`;
    // v3: same eligibility and QB rule as the finder; both players market ≥ 3 and value ≥ 3, the one I get market ≥ 8 or value ≥ 5; my season lineup +0.8 pts/week.
    res.json(
      await cached<Trade[]>(key, false, async () => {
        const ok = benchUpgradeFilter(l.ctx, team);
        return findBenchUpgrades(l.ctx, team, { mode, accept: (m, g, j, partnerId) => ok(m, g, j.sim.myParts.season, partnerId) }).map((t) => {
          const qb = qbRuleNote(l.ctx, team, t.them.teamId, t.me.gives, t.them.gives);
          return qb ? { ...t, notes: [...(t.notes ?? []), ...qb] } : t;
        });
      }),
    );
  }),
);

apiRouter.post(
  "/api/league/:provider/:id/trade/evaluate",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const l = await loadContext(provider, req.params.id, false);
    const body = (req.body ?? {}) as { team?: string; partner?: string; give?: unknown; get?: unknown; mode?: unknown };
    const team = teamParam(req, l.league);
    const partner = body.partner ? String(body.partner) : undefined;
    if (!partner || !l.league.teams.some((t) => t.id === partner)) throw new HttpError(400, `Unknown partner "${partner ?? ""}"`, "Pass { team, partner, give: string[], get: string[] }.");
    if (partner === team) throw new HttpError(400, "Partner must be a different team");
    const ids = (x: unknown) => (Array.isArray(x) ? x.map(String) : []);
    res.json(evaluateTradeV3(l.ctx, team, partner, ids(body.give), ids(body.get), parseMode(body.mode ?? req.query.mode)));
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
      const { input, myPriority, league } = await freeAgentInputs(l, provider, req.params.id, team, refresh);
      return rankWaivers({ ...l.ctx, league }, team, input, { myPriority });
    });
    res.json(result);
  }),
);

// Breakout Targets: rising role before rising points (RB/WR/TE), FA or on other rosters.
apiRouter.get(
  "/api/league/:provider/:id/breakouts",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const refresh = isRefresh(req);
    const l = await loadContext(provider, req.params.id, refresh);
    const team = teamParam(req, l.league);
    const rawPos = String(req.query.pos ?? "all").toUpperCase();
    if (!["RB", "WR", "TE", "ALL"].includes(rawPos)) throw new HttpError(400, `Unknown pos "${req.query.pos}"`, "Use pos=RB, WR, TE or all.");
    const pos = rawPos === "ALL" ? "all" : (rawPos as "RB" | "WR" | "TE");
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 30) || 30));
    const cheapOnly = req.query.cheap === "1" || req.query.cheap === "true";
    const key = `${provider}:${req.params.id}:breakouts:${team}:${pos}:${limit}:${cheapOnly ? 1 : 0}`;
    const result = await cached<BreakoutResult>(key, refresh, async () => {
      const [depth, market, fa] = await Promise.all([
        getDepthChart(l.db.season),
        loadMarketValues(l.league).catch(() => null),
        freeAgentInputs(l, provider, req.params.id, team, refresh).catch((e) => {
          console.warn(`[breakouts] free agents unavailable: ${(e as Error).message}`);
          return null;
        }),
      ]);
      let waivers: Map<string, WaiverTarget> | undefined;
      if (fa) {
        const w = rankWaivers({ ...l.ctx, league: fa.league }, team, fa.input, { myPriority: fa.myPriority, limit: fa.input.length });
        waivers = new Map(w.freeAgents.map((x) => [x.id, x]));
      }
      return findBreakouts({ league: l.league, players: l.ctx.players, teams: l.ctx.teams, myTeamId: team, depth, market, waivers, pos, limit, cheapOnly });
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

const IMPORT_DOC = fileURLToPath(new URL("../docs/IMPORT.md", import.meta.url));
apiRouter.get(
  "/api/docs/import",
  h(async (_req, res) => {
    res.type("text/plain; charset=utf-8").send(await fs.readFile(IMPORT_DOC, "utf8"));
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
    let previous: StoredImport | null = null;
    let changes: RosterChanges | undefined;
    let skippedLines: number | undefined;
    if (typeof body.text === "string") {
      const teamName = typeof body.teamName === "string" && body.teamName.trim() ? body.teamName.trim().slice(0, 80) : "My Team";
      const parsed = parseRosterText(body.text, teamName);
      skippedLines = parsed.skippedLines;
      if (!parsed.teams.length) throw new HttpError(400, "No players found in the pasted text", 'Each player line should look like "Patrick Mahomes KC - QB" or "Josh Allen (QB - BUF)".');
      const targetId = typeof body.id === "string" && body.id ? body.id : undefined;
      previous = targetId && parsed.teams.length === 1 ? await readImport(targetId) : null;
      if (targetId && parsed.teams.length === 1 && !previous) throw new HttpError(404, `No imported league "${targetId}"`);
      stored = previous ? mergeTeams(previous, parsed.teams) : newPasteImport(parsed.teams, parsed.teams.length > 1 ? "Pasted league" : `${teamName} (pasted)`);
      for (const t of stored.teams) if (t.players.length > 40) throw new HttpError(400, `Team "${t.name}" has ${t.players.length} players; the limit is 40`);
      stored.importedAt = new Date().toISOString();
    } else {
      const incoming = validateImport(body);
      // Same Yahoo league again: update rosters in place, keep the user's settings.
      previous = await findExistingImport(incoming);
      if (previous) ({ stored, changes } = upsertImport(previous, { ...incoming, importedAt: new Date().toISOString() }));
      else stored = incoming;
    }
    await saveImport(stored);
    await recordHistory(stored, previous);
    invalidateLeague("import", stored.id);
    res.json({
      id: stored.id,
      name: stored.name,
      teams: stored.teams.map((t) => ({ id: t.id, name: t.name, players: t.players.length })),
      myTeamId: stored.myTeamId,
      settingsSource: stored.settingsSource,
      importedAt: stored.importedAt,
      updated: !!previous,
      ...(changes ? { changes: { teams: changes.teams, playersChanged: changes.playersChanged } } : {}),
      ...(skippedLines !== undefined ? { skippedLines } : {}),
    });
  }),
);

apiRouter.get(
  "/api/import/:id/history",
  h(async (req, res) => {
    await mustReadImport(req.params.id);
    const h = await readHistory(req.params.id);
    res.json(h.map((x) => ({ importedAt: x.importedAt, teams: x.teams.map((t) => ({ id: t.id, name: t.name, count: t.playerIds.length })) })));
  }),
);

apiRouter.get(
  "/api/import/:id/changes",
  h(async (req, res) => {
    const s = await mustReadImport(req.params.id);
    const c = latestChanges(await readHistory(req.params.id));
    res.json(
      c
        ? { from: c.from, to: c.to, teamsChanged: c.teams, playersChanged: c.playersChanged, teams: c.byTeam }
        : { from: null, to: s.importedAt, teamsChanged: 0, playersChanged: 0, teams: [] },
    );
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
    invalidateLeague("import", next.id);
    const { diagnostics: _d, ...rest } = next;
    res.json(rest);
  }),
);

apiRouter.delete(
  "/api/import/:id",
  h(async (req, res) => {
    if (!isValidId(req.params.id) || !(await deleteImport(req.params.id))) throw new HttpError(404, `No imported league "${req.params.id}"`);
    await deleteHistory(req.params.id);
    invalidateLeague("import", req.params.id);
    res.json({ ok: true });
  }),
);

apiRouter.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found", hint: "See docs/DESIGN.md for the API contract." });
});
