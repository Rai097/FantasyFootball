// Player labels shared by trades, Targets, Values and waivers (docs/DESIGN.md "Model v4" section 1 + Release (b)).
//  - buy-low: he under-produces his usage (luck = recency-weighted expected − actual ≥ +2.0 pts/game);
//  - sell-high: he over-produces it and touchdowns drive it (luck ≤ −2.0 with the TD part dominant);
//  - market undervalues / overvalues: our value vs the trade market (|edge| ≥ 8 on the market scale).
import type { Luck } from "./signals/types.js";

export const LUCK_LABEL = { buyLow: 2.0, sellHigh: -2.0, minGames: 3 } as const;
export const MARKET_TAG = 8;

export type LuckLabel = "buy-low" | "sell-high";

/** Label from luck, or null (unknown luck, too few games, or within ±2 pts/game). `games` = sample games. */
export function luckLabel(luck: Pick<Luck, "points" | "driver"> | null | undefined, games: number): LuckLabel | null {
  if (!luck || !Number.isFinite(luck.points) || games < LUCK_LABEL.minGames) return null;
  if (luck.points >= LUCK_LABEL.buyLow) return "buy-low";
  if (luck.points <= LUCK_LABEL.sellHigh && luck.driver === "td") return "sell-high";
  return null;
}

export type MarketTag = "market undervalues" | "market overvalues";

/** Market tag from our edge over the market (trueMarket − market), or null. */
export function marketTag(edge: number | undefined): MarketTag | null {
  if (edge === undefined || !Number.isFinite(edge)) return null;
  if (edge >= MARKET_TAG) return "market undervalues";
  if (edge <= -MARKET_TAG) return "market overvalues";
  return null;
}

/** One-line explanation of a luck number for "?" bullets (≤ 90 chars). */
export function luckText(points: number, label: LuckLabel | null): string {
  const sign = points >= 0 ? "+" : "−";
  const v = `${sign}${Math.abs(points).toFixed(1)} pts/g`;
  if (label === "buy-low") return `${v}: scores less than his usage earns (buy-low)`;
  if (label === "sell-high") return `${v}: touchdowns above his usage (sell-high)`;
  return points >= 0 ? `${v}: due for a little more by his usage` : `${v}: a little above his usage`;
}
