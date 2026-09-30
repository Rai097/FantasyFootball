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
 * Set market / marketRank / marketPosRank / trueMarket / edge on every skill player (in place).
 * trueMarket maps our value onto the market's scale by rank (quantile mapping), so edges compare
 * like with like. A player the market list omits but we rank inside it gets market = trueMarket
 * (marketEstimated, edge 0) instead of a spurious 0. With `values` null the fields are cleared.
 */
export function attachMarket(players: Map<string, ValuedPlayer>, values: Map<string, MarketValue> | null): void {
  const skill = [...players.values()].filter((p) => p.pos !== "K" && p.pos !== "DEF");
  for (const p of players.values()) {
    delete p.market;
    delete p.marketRank;
    delete p.marketPosRank;
    delete p.marketEstimated;
    delete p.trueMarket;
    delete p.edge;
  }
  if (!values) return;
  // Market scale: every skill player's market value (0 when unlisted), high → low.
  const scale = skill.map((p) => values.get(p.id)?.value ?? 0).sort((a, b) => b - a);
  const listed = values.size;
  const ranked = [...skill].sort((a, b) => b.value - a.value || b.ppg - a.ppg);
  ranked.forEach((p, i) => {
    const m = values.get(p.id);
    const tm = p.value > 0 ? scale[i] ?? 0 : 0;
    p.trueMarket = r1(tm);
    if (m) {
      p.market = m.value;
      p.marketRank = m.overallRank;
      p.marketPosRank = m.posRank;
    } else if (i < listed && tm >= 3) {
      p.market = p.trueMarket;
      p.marketEstimated = true;
    } else p.market = 0;
    p.edge = r1(p.trueMarket - p.market);
  });
}

/** Perceived (market) value; our value when the market is unavailable. */
export const marketOf = (p: ValuedPlayer): number => p.market ?? p.value;
/** True value on the market scale (our value when the market is unavailable). */
export const trueOf = (p: ValuedPlayer): number => p.trueMarket ?? p.value;
/** trueMarket − market (0 without market values). */
export const edgeOf = (p: ValuedPlayer): number => p.edge ?? 0;
