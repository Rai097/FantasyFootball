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
  deleteProjLog,
  findExistingImport,
  importFreeAgents,
  isValidId,
  latestChanges,
  listImports,
  MAX_BYTES,
  mergeTeams,
  newPasteImport,
  projCaptureEntries,
  readHistory,
  readProjLog,
  recordProjLog,
  readImport,
  recordHistory,
  saveImport,
  upsertImport,
  validateImport,
  type RosterChanges,
  type StoredImport,
} from "./providers/import.js";
import { parseRosterText } from "./providers/import-text.js";
import { createHash } from "node:crypto";
import { bookmarkletCode, bookmarkletUrl } from "./providers/import-bookmarklet.js";
import { analyzeLeague, analyzeTeams, type LeagueContext } from "./model/analysis.js";
import { buildLeagueView } from "./model/league.js";
import { attachFloor } from "./model/signals.js";
import { defaultMode, type ValueMode } from "./model/projectionV4.js";
import { getProjectionTables, getSeasonTables } from "./data/signalTables.js";
import { accuracyReport, outcomeOf, playerAccuracy, resolveLog, teamWeeksWithRows, toAccuracyResponse, vsYahooItem, weekKickoffs, type AccuracyResponse, type ResolvedRow } from "./model/projLog.js";
import type { ProjectionTables } from "./model/projectionV4.js";
import { getPriorWeeks } from "./data/priorWeeks.js";
import { findBenchUpgrades } from "./model/benchUpgrades.js";
import { evaluateTradeV3, findTradesV3 } from "./model/tradesV3.js";
import { attachPerception } from "./model/perception.js";
import { attachMarket, marketQuery, type ValueSource } from "./model/market.js";
import { parseMode } from "./model/rosterScore.js";
import { rankWaivers, toWaiversResponse, type FreeAgentInput } from "./model/waivers.js";
import { stashWatch } from "./model/stash.js";
import { findBreakouts, type MarketValue } from "./model/breakouts.js";
import { getDepthChart } from "./data/depthCharts.js";
import { getMarketData, pprBucket } from "./data/fantasycalc.js";
import { errors as authErrors, pinnedTeam, scopeOf } from "./auth/guard.js";
import type { Availability, BreakoutResponse, BreakoutResult, BreakoutTarget, CardPlayer, League, Player, Trade, TradeFinderResult, ValuedPlayer, ValueRow, WaiverBreakout, WaiverTarget } from "./model/types.js";

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
 * trades2, bench, waivers, breakouts) are keyed `${provider}:${id}:…`.
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

interface Base {
  db: PlayerDb;
  league: League;
  /** Projection v4 inputs: signals, remaining schedule, points allowed (league scoring). */
  tables: ProjectionTables;
}

/** League + projection tables, cached per league (the expensive part shared by both value modes). */
function loadBase(provider: Provider, id: string, refresh: boolean): Promise<Base> {
  if (refresh) invalidate(`${provider}:${id}:`);
  return cached(`${provider}:${id}:base`, false, async () => {
    const { db, league } = await loadLeague(provider, id, refresh);
    return { db, league, tables: await getProjectionTables(db.season, league.settings.scoring) };
  });
}

/**
 * Valued league for one value mode (projection v4: "playoffs" for a team in a playoff spot, else "balanced"; at most
 * two contexts per league). Without a mode: the default team's mode (league.myTeamId).
 */
async function loadContext(provider: Provider, id: string, refresh: boolean, mode?: ValueMode): Promise<Loaded> {
  const base = await loadBase(provider, id, refresh);
  const m = mode ?? defaultMode(base.league, base.league.myTeamId);
  return cached(`${provider}:${id}:ctx:${m}`, false, async () => {
    const { db, league, tables } = base;
    const ctx = analyzeLeague(league, playerPool(db, league), tables, m);
    // Market (perceived) values for Trade Finder v3 and the Values tab; our values when unavailable.
    const md = await getMarketData(marketQuery(league.settings));
    const valueSource: ValueSource = md.source === "fantasycalc" && md.values.size ? "fantasycalc" : "model";
    attachMarket(ctx.players, valueSource === "fantasycalc" ? md.values : null);
    // v3.1 weekly floor (lineup contribution blends it in); then re-analyse teams.
    attachFloor(ctx.players, await getPriorWeeks(db.season - 1), league.settings.scoring);
    ctx.teams = analyzeTeams(league, ctx.players, ctx.replacement);
    // Release (d): how other managers see each player (Yahoo projection / FantasyPros rank + recent games).
    attachPerception(ctx.players.values(), league.settings, tables.schedule);
    // Projection accuracy log: "Vs Yahoo" value bullet for players with ≥ 3 compared weeks (never breaks the league).
    if (provider === "import") {
      try {
        const acc = playerAccuracy(await resolvedRows(db, league, id));
        for (const p of ctx.players.values()) {
          const item = vsYahooItem(acc.get(p.id));
          if (item) p.whyItems = [...(p.whyItems ?? []), item];
        }
      } catch (e) {
        console.warn(`[projlog] accuracy bullets skipped for ${id}: ${(e as Error).message}`);
      }
    }
    return { db, league, ctx, valueSource };
  });
}

/** The request team and the league valued in that team's mode (playoffs when it holds a playoff spot). */
async function loadForTeam(req: Request, provider: Provider, id: string, refresh: boolean): Promise<{ l: Loaded; team: string }> {
  const base = await loadBase(provider, id, refresh);
  const team = teamParam(req, base.league, provider);
  return { l: await loadContext(provider, id, false, defaultMode(base.league, team)), team };
}

/**
 * The team a request acts for. Team scope comes only from the guard: a user (or an admin viewing as one) on
 * their imported league is pinned to their access-list team; `league.myTeamId` (whoever imported) is only the
 * admin's default.
 */
function teamParam(req: Request, league: League, provider: Provider, key = "team"): string {
  const raw = (req.query[key] ?? (req.body as Record<string, unknown> | undefined)?.[key]) as string | undefined;
  const pinned = pinnedTeam(scopeOf(req), provider);
  if (pinned) {
    if (raw !== undefined && raw !== "" && raw !== pinned) throw authErrors.team();
    if (!league.teams.some((t) => t.id === pinned)) throw new HttpError(400, `Your team "${pinned}" is not in this league's import`, "Ask the league owner to check your team in the access list, or re-import the league.");
    return pinned;
  }
  const team = raw && raw !== "" ? String(raw) : league.myTeamId ?? league.teams[0]?.id;
  if (!team || !league.teams.some((t) => t.id === team)) throw new HttpError(400, `Unknown team "${raw}"`, `Valid team ids: ${league.teams.map((t) => t.id).join(", ")}`);
  return team;
}

/** Defence in depth: the guard already refused these before routing. */
function requireAdmin(req: Request): void {
  if (scopeOf(req).role !== "admin") throw authErrors.adminOnly();
}
function requireOwnImport(req: Request, id: string): void {
  const s = scopeOf(req);
  if (s.role !== "admin" && id !== s.leagueId) throw authErrors.league();
}


/** The league as this request should see it (a pinned user sees their own team as "my team"). */
function leagueFor(req: Request, provider: Provider, league: League): League {
  const mine = pinnedTeam(scopeOf(req), provider);
  return mine && mine !== league.myTeamId ? { ...league, myTeamId: mine } : league;
}

const isRefresh = (req: Request) => req.query.refresh === "1" || req.query.refresh === "true";

/** Players worth sending to the UI: rostered, ranked, or with value. */
function relevantPlayers(l: Loaded): ValuedPlayer[] {
  const rostered = new Set(l.league.teams.flatMap((t) => t.playerIds));
  return [...l.ctx.players.values()].filter((p) => rostered.has(p.id) || p.value > 0 || p.ecrOverall !== undefined || p.ecrPos !== undefined);
}

/** GET /values row (types.ts ValueRow): only the rendered fields; edge unset when the market value is missing or estimated. */
export function toValueRow(p: ValuedPlayer, ownerTeamId: string | undefined, withWhy = false): ValueRow {
  const row: ValueRow = {
    id: p.id, name: p.name, pos: p.pos, team: p.team, value: p.value, ppg: p.ppg, ppg26: p.ppg26, ppgExp26: p.ppgExp26,
    games: p.games, posRank: p.posRank, rostered: ownerTeamId !== undefined,
  };
  if (ownerTeamId !== undefined) row.ownerTeamId = ownerTeamId;
  if (p.injury) row.injury = p.injury;
  if (p.ecrOverall !== undefined) row.ecrOverall = p.ecrOverall;
  if (p.luck !== undefined) row.luck = p.luck;
  if (p.label) row.label = p.label;
  if (p.market !== undefined) row.market = p.market;
  if (p.marketRank !== undefined) row.marketRank = p.marketRank;
  if (p.marketEstimated) row.marketEstimated = true;
  // Listed in the market (rank known) and not our estimate → a real edge; otherwise unknown ("—").
  if (p.edge !== undefined && p.marketRank !== undefined && !p.marketEstimated) row.edge = p.edge;
  if (withWhy && p.whyItems?.length) row.whyItems = p.whyItems;
  return row;
}

/** The slim player for card rows (no weekly lines). */
export function toCardPlayer(p: ValuedPlayer): CardPlayer {
  const c: CardPlayer = { id: p.id, name: p.name, pos: p.pos, team: p.team, value: p.value, ppg: p.ppg };
  if (p.injury) c.injury = p.injury;
  if (p.whyItems?.length) c.whyItems = p.whyItems;
  return c;
}

/** GET /breakouts response: prose thesis dropped (server-only), slim players. */
export function toBreakoutResponse(r: BreakoutResult): BreakoutResponse {
  return { how: r.how, targets: r.targets.map(({ thesis: _t, player, ...t }: BreakoutTarget) => ({ ...t, player: toCardPlayer(player) })) };
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
  if (typeof (err as { code?: unknown })?.code === "string" && status < 500 && (err as { status?: number }).status) body.code = (err as { code: string }).code;
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
): Promise<{ input: FreeAgentInput[]; myPriority?: number; league: League; notes?: string[] }> {
  let notes: string[] | undefined;
  let fas: { player: Player; onWaivers: boolean; availability?: Availability; percentOwned?: number }[];
  let myPriority: number | undefined;
  let league = l.league;
  if (provider === "demo") {
    const d = demoFreeAgents({ ...l.league, myTeamId: team }, l.db.players.values());
    fas = d.freeAgents;
    myPriority = d.myPriority;
  } else if (provider === "import") {
    const stored = await mustReadImport(id);
    // Priority: the team's own place in the captured waiver order, else the importer's stored number (their team only).
    const d = importFreeAgents(l.league, l.db, stored, l.league.settings.currentWeek, team);
    fas = d.freeAgents;
    myPriority = d.myPriority;
    notes = d.notes;
  } else {
    const y = await yahoo.getFreeAgents(l.db, id, { refresh });
    fas = y.freeAgents;
    // Yahoo's priority / FAAB belong to the connected account's team (league.myTeamId), whoever asks: never shown as
    // another team's, and the cached result (keyed by team) does not depend on who asked first.
    const owner = l.league.myTeamId;
    myPriority = team === owner ? y.myPriority : undefined;
    if (team === owner && y.myFaabBalance !== undefined) {
      league = { ...l.league, teams: l.league.teams.map((t) => (t.id === team ? { ...t, faabRemaining: y.myFaabBalance } : t)) };
    }
  }
  const rostered = new Set(l.league.teams.flatMap((t) => t.playerIds));
  const seen = new Set<string>();
  const input: FreeAgentInput[] = [];
  for (const f of fas) {
    if (rostered.has(f.player.id) || seen.has(f.player.id)) continue;
    seen.add(f.player.id);
    input.push({ player: l.ctx.valuation.valueOf(f.player), onWaivers: f.onWaivers, availability: f.availability, percentOwned: f.percentOwned });
  }
  return { input, myPriority, league, ...(notes ? { notes } : {}) };
}

/** Breakout Targets signal for every unrostered player in the breakout pool (feeds the waiver calls). */
async function faBreakoutSignals(l: Loaded, team: string): Promise<Map<string, WaiverBreakout>> {
  const depth = await getDepthChart(l.db.season);
  const r = findBreakouts({ league: l.league, players: l.ctx.players, teams: l.ctx.teams, myTeamId: team, depth, limit: 10_000 });
  return new Map(
    r.targets
      .filter((t) => t.where.type === "fa")
      .map((t) => [t.player.id, { tier: t.tier, score: t.score, situation: t.components.situation, oppLevel: t.components.oppLevel, thesis: t.thesis, role: t.role }]),
  );
}

/** FantasyCalc market values for this league's format (null when unavailable). */
async function loadMarketValues(league: League): Promise<Map<string, MarketValue> | null> {
  const S = league.settings;
  const qbSlots = S.slots.filter((x) => x === "QB" || x === "SFLEX").length;
  const d = await getMarketData({ numQbs: qbSlots >= 2 ? 2 : 1, numTeams: S.numTeams || 12, ppr: pprBucket(S.scoring.rec), dynasty: S.isDynasty });
  return d.source === "fantasycalc" && d.values.size ? d.values : null;
}

// ---------------------------------------------------------------- projection accuracy log
/** The league's captured player-weeks with their actual results (league scoring; did-not-play / pending kept apart). */
async function resolvedRows(db: PlayerDb, league: League, id: string): Promise<ResolvedRow[]> {
  const log = await readProjLog(id);
  if (!log || log.season !== db.season) return [];
  const { games } = await getSeasonTables(db.season);
  const final = new Set<string>();
  for (const g of games.values()) if (g.result !== undefined) (final.add(`${g.home}|${g.week}`), final.add(`${g.away}|${g.week}`));
  const rowsIn = teamWeeksWithRows(db.players.values(), db.season);
  const q = { season: db.season, scoring: league.settings.scoring, gameFinal: (t: string, w: number) => final.has(`${t}|${w}`), teamRowsIn: (t: string, w: number) => rowsIn.has(`${t}|${w}`) };
  return resolveLog(log, (e, week) => outcomeOf(db.players.get(e.id), { ...q, week, team: e.team }));
}

/**
 * After an import is saved: value the league and record this week's app + Yahoo projections for every rostered and
 * free-agent skill player with a game (only players whose kickoff is still ahead count). Runs after the response,
 * one at a time per league; a failure is logged and never fails the import.
 */
let projCaptures: Promise<unknown> = Promise.resolve();
export const projCaptureIdle = (): Promise<unknown> => projCaptures;
function captureProjections(stored: StoredImport, capturedAt: string): void {
  const run = (async () => {
    const l = await loadContext("import", stored.id, false);
    const week = l.league.settings.currentWeek;
    const { games } = await getSeasonTables(l.db.season);
    const { kickoffs, teams } = weekKickoffs(games.values(), week);
    const appWeek = (p: Player): number | undefined => {
      const v = l.ctx.players.get(p.id);
      if (!v?.weekly || v.weeklyFrom === undefined) return undefined;
      const x = v.weekly[week - v.weeklyFrom];
      return typeof x === "number" && Number.isFinite(x) ? x : undefined;
    };
    const entries = projCaptureEntries(l.db, stored, week, appWeek, (t) => teams.has(t));
    const r = await recordProjLog(stored.id, { season: l.db.season, week, capturedAt, entries, kickoffs, maxWeek: l.league.settings.finalWeek });
    if (r.kept) invalidate(`import:${stored.id}:accuracy`);
    console.log(`[projlog] import=${stored.id} week=${week} kept=${r.kept} ignored=${r.ignored}`);
  })().catch((e) => console.warn(`[projlog] capture failed for ${stored.id}: ${(e as Error).message}`));
  projCaptures = projCaptures.then(() => run);
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
  h(async (req, res) => {
    requireAdmin(req);
    res.json(await yahoo.listLeagues());
  }),
);

apiRouter.get(
  "/api/league/:provider/:id",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const l = await loadBase(provider, req.params.id, isRefresh(req));
    res.json(leagueFor(req, provider, l.league));
  }),
);

apiRouter.get(
  "/api/league/:provider/:id/analysis",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const { l, team } = await loadForTeam(req, provider, req.params.id, isRefresh(req));
    const players: Record<string, ValuedPlayer> = {};
    for (const p of relevantPlayers(l)) players[p.id] = p;
    const body = { league: leagueFor(req, provider, l.league), players, teams: l.ctx.teams, replacement: l.ctx.replacement, myTeamId: team, notes: l.ctx.notes, valueSource: l.valueSource, valueMode: l.ctx.mode };
    // My Team renders the value bullets and return estimates ("hold: back ~wk N") of the request team's players only:
    // everyone else's stay out of this big payload.
    const mine = new Set(l.ctx.teams.find((t) => t.team.id === team)?.team.playerIds ?? []);
    res.type("application/json").send(
      JSON.stringify(body, function (this: { id?: unknown }, k, v) {
        return (k === "whyItems" || k === "ret") && !(typeof this.id === "string" && mine.has(this.id)) ? undefined : v;
      }),
    );
  }),
);

// League tab: standings, power rankings (starter vs bench parts) and "who is above me and why" (DESIGN.md "League tab").
apiRouter.get(
  "/api/league/:provider/:id/league",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const { l, team } = await loadForTeam(req, provider, req.params.id, isRefresh(req));
    res.json(buildLeagueView(l.ctx.teams, team));
  }),
);

// Trade Finder v3 (market-value packages; same shape as v2 plus valueSource / partners). UI uses this.
apiRouter.get(
  "/api/league/:provider/:id/trades2",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const { l, team } = await loadForTeam(req, provider, req.params.id, isRefresh(req));
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
    const { l, team } = await loadForTeam(req, provider, req.params.id, isRefresh(req));
    const mode = parseMode(req.query.mode);
    const key = `${provider}:${req.params.id}:bench:${team}:${mode}`;
    // v3 engine: same eligibility and QB rule as the finder; both players market ≥ 3 and value ≥ 3, the one I get market ≥ 8 or value ≥ 5; my season lineup +0.8 pts/week.
    res.json(await cached<Trade[]>(key, false, async () => findBenchUpgrades(l.ctx, team, { mode })));
  }),
);

apiRouter.post(
  "/api/league/:provider/:id/trade/evaluate",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const body = (req.body ?? {}) as { team?: string; partner?: string; give?: unknown; get?: unknown; mode?: unknown };
    const { l, team } = await loadForTeam(req, provider, req.params.id, false);
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
    const { l, team } = await loadForTeam(req, provider, req.params.id, refresh);
    const key = `${provider}:${req.params.id}:waivers:${team}`;
    const result = await cached(key, refresh, async () => {
      const [{ input, myPriority, league, notes }, breakouts] = await Promise.all([
        freeAgentInputs(l, provider, req.params.id, team, refresh),
        faBreakoutSignals(l, team),
      ]);
      const stash = stashWatch({
        players: l.ctx.players.values(),
        rostered: new Set(league.teams.flatMap((t) => t.playerIds)),
        unmatched: league.teams.flatMap((t) => t.unmatched ?? []),
        availability: new Map(input.map((f) => [f.player.id, f.availability ?? (f.onWaivers ? "waivers" : "fa")])),
        flexLevel: l.ctx.valuation.flexLevel,
        regularSeasonEnd: league.settings.regularSeasonEnd,
        finalWeek: league.settings.finalWeek,
        usesFaab: league.settings.usesFaab,
      });
      const r = toWaiversResponse(rankWaivers({ ...l.ctx, league }, team, input, { myPriority, breakouts }), stash);
      return notes ? { ...r, notes } : r;
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
    const { l, team } = await loadForTeam(req, provider, req.params.id, refresh);
    const rawPos = String(req.query.pos ?? "all").toUpperCase();
    if (!["RB", "WR", "TE", "ALL"].includes(rawPos)) throw new HttpError(400, `Unknown pos "${req.query.pos}"`, "Use pos=RB, WR, TE or all.");
    const pos = rawPos === "ALL" ? "all" : (rawPos as "RB" | "WR" | "TE");
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 30) || 30));
    const cheapOnly = req.query.cheap === "1" || req.query.cheap === "true";
    const key = `${provider}:${req.params.id}:breakouts:${team}:${pos}:${limit}:${cheapOnly ? 1 : 0}`;
    const result = await cached<BreakoutResponse>(key, refresh, async () => {
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
        const breakouts = await faBreakoutSignals(l, team);
        const w = rankWaivers({ ...l.ctx, league: fa.league }, team, fa.input, { myPriority: fa.myPriority, limit: fa.input.length, breakouts });
        waivers = new Map(w.freeAgents.map((x) => [x.id, x]));
      }
      return toBreakoutResponse(findBreakouts({ league: l.league, players: l.ctx.players, teams: l.ctx.teams, myTeamId: team, depth, market, waivers, pos, limit, cheapOnly }));
    });
    res.json(result);
  }),
);

// Projection accuracy: app vs Yahoo weekly projections against actual points (import leagues only; no log → empty).
apiRouter.get(
  "/api/league/:provider/:id/accuracy",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    if (provider !== "import") throw new HttpError(404, "Projection accuracy is tracked for imported leagues only");
    requireOwnImport(req, req.params.id);
    const id = req.params.id;
    const body = await cached<AccuracyResponse>(`import:${id}:accuracy`, isRefresh(req), async () => {
      const { db, league } = await loadBase("import", id, false);
      const log = await readProjLog(id);
      const rows = await resolvedRows(db, league, id);
      return toAccuracyResponse(log && log.season === db.season ? log : null, accuracyReport(rows), (t) => league.teams.find((x) => x.id === t)?.name);
    });
    res.json(body);
  }),
);

apiRouter.get(
  "/api/league/:provider/:id/values",
  h(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    // With ?team= the values follow that team's mode; without, the league's default team.
    const l = req.query.team ? (await loadForTeam(req, provider, req.params.id, isRefresh(req))).l : await loadContext(provider, req.params.id, isRefresh(req));
    const owner = new Map<string, string>();
    for (const t of l.league.teams) for (const id of t.playerIds) owner.set(id, t.id);
    // ?id=<player>: that one row with its value explanation (the Values "?" fetches it on tap, keeping the list small).
    if (req.query.id) {
      const p = l.ctx.players.get(String(req.query.id));
      if (!p) throw new HttpError(404, `Unknown player "${req.query.id}"`);
      return res.json([toValueRow(p, owner.get(p.id), true)]);
    }
    const rows = relevantPlayers(l)
      .sort((a, b) => b.value - a.value || b.ppg - a.ppg || a.name.localeCompare(b.name))
      .map((p) => toValueRow(p, owner.get(p.id)));
    res.json(rows);
  }),
);

// ---------------------------------------------------------------- import (Yahoo web pages, no API)
apiRouter.get(
  "/api/import/bookmarklet.js",
  h(async (_req, res) => {
    // no-store: Cloudflare caches ".js" paths at the edge and gave browsers a 4-hour copy of an old bookmarklet.
    res.type("application/javascript").set("Cache-Control", "no-store").send(await bookmarkletCode());
  }),
);

// The bookmark link for the Connect page. Not a ".js" path (Cloudflare edge-caches those) and never cached, so a
// deploy changes the next drag at once; `version` lets the UI and the import box show which code a bookmark holds.
apiRouter.get(
  "/api/import/bookmarklet-url",
  h(async (_req, res) => {
    const code = await bookmarkletCode();
    const version = createHash("sha256").update(code).digest("hex").slice(0, 8);
    res.set("Cache-Control", "no-store").json({ url: await bookmarkletUrl(), version });
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
  h(async (req, res) => {
    const s = scopeOf(req);
    const all = await listImports();
    res.json(s.role === "admin" ? all : all.filter((x) => x.id === s.leagueId));
  }),
);

/** Display name stamped on an import: the Discord name, "Admin" in dev mode (no real account). */
export function importerName(scope: { dev: boolean; name: string }): string {
  const n = scope.name.replace(/\s+/g, " ").trim().slice(0, 60);
  return scope.dev || !n ? "Admin" : n;
}

/** The admin-owned, league-level fields of an import (everything except rosters, free agents and timestamps). */
function leagueSettingsOf(s: StoredImport): Partial<StoredImport> {
  const { name, numTeams, slots, scoring, regularSeasonEnd, finalWeek, tradeDeadlineWeek, waiverPriority, settingsSource, leagueId } = s;
  return { name, numTeams, slots, scoring, regularSeasonEnd, finalWeek, tradeDeadlineWeek, waiverPriority, settingsSource, leagueId };
}

apiRouter.post(
  "/api/import",
  h(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") throw new HttpError(400, "Expected a JSON body", "Send the bookmarklet JSON, or { text, teamName } for pasted roster text.");
    if (JSON.stringify(body).length > MAX_BYTES) throw new HttpError(413, "Import is larger than 1 MB");
    // A user (or an admin viewing as one) may only (re-)import their own league, and never sets "my team".
    const scope = scopeOf(req);
    const ownLeague = scope.role === "admin" ? undefined : scope.leagueId;
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
      if (ownLeague !== undefined && (targetId !== ownLeague || parsed.teams.length !== 1)) throw authErrors.league();
      previous = targetId && parsed.teams.length === 1 ? await readImport(targetId) : null;
      if (targetId && parsed.teams.length === 1 && !previous) throw new HttpError(404, `No imported league "${targetId}"`);
      stored = previous ? mergeTeams(previous, parsed.teams) : newPasteImport(parsed.teams, parsed.teams.length > 1 ? "Pasted league" : `${teamName} (pasted)`);
      for (const t of stored.teams) if (t.players.length > 40) throw new HttpError(400, `Team "${t.name}" has ${t.players.length} players; the limit is 40`);
      stored.importedAt = new Date().toISOString();
    } else {
      const incoming = validateImport(body);
      // Release (d) fix: the NFL week the Yahoo projections belong to (a later week drops the stale weekly number).
      incoming.projWeek = (await getNflState()).currentWeek;
      // Same Yahoo league again: update rosters in place, keep the user's settings.
      previous = await findExistingImport(incoming);
      if (ownLeague !== undefined && (previous?.id ?? incoming.id) !== ownLeague) throw authErrors.league();
      if (ownLeague !== undefined) delete incoming.myTeamId;
      if (previous) ({ stored, changes } = upsertImport(previous, { ...incoming, importedAt: new Date().toISOString() }));
      else stored = incoming;
    }
    if (ownLeague !== undefined) {
      if (previous?.myTeamId) stored.myTeamId = previous.myTeamId;
      else delete stored.myTeamId;
      // League settings are admin-only: a user's re-import refreshes rosters and free agents, nothing else.
      if (previous) stored = { ...stored, ...leagueSettingsOf(previous) };
    }
    // Who ran this import (header "League updated … · by <name>"): the session's name, never the payload's.
    // Not a league setting, so a member's re-import sets it too.
    stored = { ...stored, importedBy: importerName(scope) };
    await saveImport(stored);
    await recordHistory(stored, previous);
    invalidateLeague("import", stored.id);
    // Capture time = the server's clock at save (never the payload's importedAt, which a first import may carry over):
    // later than the bookmarklet's read, so the before-kickoff rule errs on the safe side.
    captureProjections(stored, new Date().toISOString());
    res.json({
      id: stored.id,
      name: stored.name,
      teams: stored.teams.map((t) => ({ id: t.id, name: t.name, players: t.players.length })),
      myTeamId: ownLeague !== undefined ? scope.teamId : stored.myTeamId,
      settingsSource: stored.settingsSource,
      importedAt: stored.importedAt,
      importedBy: stored.importedBy,
      updated: !!previous,
      ...(changes ? { changes: { teams: changes.teams, playersChanged: changes.playersChanged } } : {}),
      ...(skippedLines !== undefined ? { skippedLines } : {}),
    });
  }),
);

apiRouter.get(
  "/api/import/:id/history",
  h(async (req, res) => {
    requireOwnImport(req, req.params.id);
    await mustReadImport(req.params.id);
    const h = await readHistory(req.params.id);
    res.json(h.map((x) => ({ importedAt: x.importedAt, teams: x.teams.map((t) => ({ id: t.id, name: t.name, count: t.playerIds.length })) })));
  }),
);

apiRouter.get(
  "/api/import/:id/changes",
  h(async (req, res) => {
    requireOwnImport(req, req.params.id);
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
    requireOwnImport(req, req.params.id);
    const { diagnostics: _d, ...rest } = await mustReadImport(req.params.id);
    res.json(rest);
  }),
);

apiRouter.put(
  "/api/import/:id/settings",
  h(async (req, res) => {
    requireAdmin(req);
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
    requireAdmin(req);
    if (!isValidId(req.params.id) || !(await deleteImport(req.params.id))) throw new HttpError(404, `No imported league "${req.params.id}"`);
    await deleteHistory(req.params.id);
    await deleteProjLog(req.params.id);
    invalidateLeague("import", req.params.id);
    res.json({ ok: true });
  }),
);

apiRouter.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found", hint: "See docs/DESIGN.md for the API contract." });
});
