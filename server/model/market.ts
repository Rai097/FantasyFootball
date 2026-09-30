// Market (perceived) values on ValuedPlayers. See docs/DESIGN.md "Trade finder v3".
import type { LeagueSettings, ValuedPlayer } from "./types.js";
import type { MarketValue } from "../data/fantasycalc.js";

export type ValueSource = "fantasycalc" | "model";

const r1 = (x: number) => Math.round(x * 10) / 10;

/** FantasyCalc query for a league: 2 QBs when there is a superflex or a second QB slot; ppr rounded to 0 / 0.5 / 1. */
export function marketQuery(S: LeagueSettings): { numQbs: 1 | 2; numTeams: number; ppr: 0 | 0.5 | 1; dynasty: boolean } {
  const qbSlots = S.slots.filter((s) => s === "QB" || s === "SFLEX").length;
  const rec = S.scoring.rec;
  return { numQbs: qbSlots >= 2 ? 2 : 1, numTeams: S.numTeams || 12, ppr: rec < 0.25 ? 0 : rec < 0.75 ? 0.5 : 1, dynasty: !!S.isDynasty };
}

/**
 * Set market / marketRank / marketPosRank / edge on every skill player (in place).
 * With `values` null (market unavailable) the fields are cleared and callers use `value`.
 */
export function attachMarket(players: Map<string, ValuedPlayer>, values: Map<string, MarketValue> | null): void {
  for (const p of players.values()) {
    if (!values || p.pos === "K" || p.pos === "DEF") {
      delete p.market;
      delete p.marketRank;
      delete p.marketPosRank;
      delete p.edge;
      continue;
    }
    const m = values.get(p.id);
    p.market = m ? m.value : 0;
    if (m) {
      p.marketRank = m.overallRank;
      p.marketPosRank = m.posRank;
    } else {
      delete p.marketRank;
      delete p.marketPosRank;
    }
    p.edge = r1(p.value - p.market);
  }
}

/** Perceived (market) value; our value when the market is unavailable. */
export const marketOf = (p: ValuedPlayer): number => p.market ?? p.value;
/** True value = our model value. */
export const trueOf = (p: ValuedPlayer): number => p.value;
/** Our value minus market value (0 without market values). */
export const edgeOf = (p: ValuedPlayer): number => (p.market === undefined ? 0 : p.value - p.market);
