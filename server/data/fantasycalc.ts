// FantasyCalc market values (crowd-sourced trade values from real trades). See docs/DESIGN.md "Trade finder v3".
// https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=0.5
import { fetchCached } from "./cache.js";
import { normName, normPos } from "./names.js";
import { getPlayerDb } from "./players.js";
import type { Player } from "../model/types.js";

export interface MarketValue {
  /** Market value scaled so the #1 player = 100. */
  value: number;
  /** FantasyCalc's raw value. */
  raw: number;
  overallRank: number;
  posRank: number;
  /** Raw value change over 30 days. */
  trend30: number;
  /** Share of trades involving this player (0..1), when reported. */
  tradeFreq?: number;
}

export interface MarketOpts {
  numQbs: 1 | 2;
  numTeams: number;
  ppr: 0 | 0.5 | 1;
  dynasty?: boolean;
}

/** One row of FantasyCalc's /values/current response (fields we use). */
export interface FcEntry {
  player: { id: number | string; name: string; sleeperId?: string | null; mflId?: string | null; position: string; maybeTeam?: string | null; maybeAge?: number | null };
  value: number;
  overallRank: number;
  positionRank: number;
  trend30Day?: number | null;
  maybeTradeFrequency?: number | null;
}

export const FC_TTL_HOURS = 12;
/** 12-team, 1-QB, half-PPR redraft (used when no league settings are given). */
export const DEFAULT_MARKET_OPTS: MarketOpts = { numQbs: 1, numTeams: 12, ppr: 0.5 };

/** Round a league's points-per-reception to FantasyCalc's 0 / 0.5 / 1. */
export function pprBucket(rec: number): 0 | 0.5 | 1 {
  const r = Number.isFinite(rec) ? rec : 0.5;
  return r < 0.25 ? 0 : r < 0.75 ? 0.5 : 1;
}

export function fantasyCalcUrl(o: MarketOpts): string {
  const teams = Math.max(8, Math.min(16, Math.round(o.numTeams) || 12));
  return `https://api.fantasycalc.com/values/current?isDynasty=${o.dynasty ? "true" : "false"}&numQbs=${o.numQbs}&numTeams=${teams}&ppr=${o.ppr}`;
}

/** Parse and validate the JSON body; throws on an unexpected shape. */
export function parseFantasyCalc(body: string | unknown): FcEntry[] {
  const data = typeof body === "string" ? JSON.parse(body) : body;
  if (!Array.isArray(data)) throw new Error("FantasyCalc: expected an array");
  const out: FcEntry[] = [];
  for (const e of data) {
    if (!e || typeof e !== "object" || !e.player || typeof e.player.name !== "string" || !Number.isFinite(Number(e.value))) continue;
    out.push({ ...e, value: Number(e.value), overallRank: Number(e.overallRank), positionRank: Number(e.positionRank) });
  }
  if (!out.length) throw new Error("FantasyCalc: no player values in response");
  return out;
}

/**
 * Match FantasyCalc rows to our players (Sleeper id first, then normalised name + position)
 * and scale values so the #1 player = 100. Keys are internal player ids.
 */
export function buildMarketMap(entries: FcEntry[], players: Iterable<Player>): Map<string, MarketValue> {
  const bySleeper = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const p of players) {
    if (p.ids?.sleeper) bySleeper.set(String(p.ids.sleeper), p.id);
    const k = `${normName(p.name)}|${p.pos}`;
    byName.set(k, [...(byName.get(k) ?? []), p.id]);
  }
  const top = Math.max(1, ...entries.map((e) => e.value));
  const out = new Map<string, MarketValue>();
  for (const e of entries) {
    const sid = e.player.sleeperId ? String(e.player.sleeperId) : "";
    let id = sid ? bySleeper.get(sid) : undefined;
    if (!id) {
      const cands = byName.get(`${normName(e.player.name)}|${normPos(e.player.position)}`) ?? [];
      if (cands.length === 1) id = cands[0];
    }
    if (!id || out.has(id)) continue;
    out.set(id, {
      value: Math.round((Math.max(0, e.value) / top) * 1000) / 10,
      raw: e.value,
      overallRank: e.overallRank,
      posRank: e.positionRank,
      trend30: Number(e.trend30Day ?? 0) || 0,
      ...(e.maybeTradeFrequency != null ? { tradeFreq: Number(e.maybeTradeFrequency) } : {}),
    });
  }
  return out;
}

export interface MarketData {
  source: "fantasycalc" | "model";
  values: Map<string, MarketValue>;
  url: string;
  /** Set when source = "model": why the fetch failed. */
  error?: string;
}

const memo = new Map<string, { at: number; p: Promise<MarketData> }>();

/**
 * Market values with their source. On any fetch / parse failure `source` is "model" and
 * `values` is empty: callers fall back to our own value (and the UI shows a warning).
 */
export function getMarketData(opts: MarketOpts = DEFAULT_MARKET_OPTS): Promise<MarketData> {
  const url = fantasyCalcUrl(opts);
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.p;
  const p = (async (): Promise<MarketData> => {
    try {
      const [body, db] = await Promise.all([fetchCached(url, FC_TTL_HOURS), getPlayerDb()]);
      const values = buildMarketMap(parseFantasyCalc(body), db.players.values());
      if (!values.size) throw new Error("FantasyCalc: no players matched");
      return { source: "fantasycalc", values, url };
    } catch (err) {
      console.warn(`[fantasycalc] market values unavailable, using model values: ${(err as Error).message}`);
      memo.delete(url);
      return { source: "model", values: new Map(), url, error: (err as Error).message };
    }
  })();
  memo.set(url, { at: Date.now(), p });
  return p;
}

/** Market values keyed by internal player id (empty Map when FantasyCalc is unavailable). */
export async function getMarketValues(opts: MarketOpts = DEFAULT_MARKET_OPTS): Promise<Map<string, MarketValue>> {
  return (await getMarketData(opts)).values;
}
