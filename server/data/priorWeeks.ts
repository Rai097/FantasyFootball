// Prior-season weekly actual stat lines (ffopportunity ep_weekly), for floor / consistency.
// players.ts keeps only prior-season totals; this reads the same cached file week by week.
import { fetchCached } from "./cache.js";
import { sources } from "./sources.js";
import { parseCsv, num } from "./csv.js";
import type { StatLine } from "../model/types.js";
import { lineFrom } from "./players.js";

const actual = (r: Record<string, string>): StatLine => lineFrom(r, "");

/** Regular-season weekly lines by player id (gsis). */
export function parsePriorWeeks(csv: string): Map<string, StatLine[]> {
  const out = new Map<string, StatLine[]>();
  if (!csv) return out;
  for (const r of parseCsv(csv)) {
    if (!r.player_id || (r.season_type ? r.season_type !== "REG" : num(r.week) > 18)) continue;
    const arr = out.get(r.player_id) ?? [];
    arr.push(actual(r));
    out.set(r.player_id, arr);
  }
  return out;
}

const memo = new Map<number, Promise<Map<string, StatLine[]>>>();
/** Weekly lines for `season` (empty map when unavailable). */
export function getPriorWeeks(season: number): Promise<Map<string, StatLine[]>> {
  let p = memo.get(season);
  if (!p) {
    p = fetchCached(sources.epWeekly(season), 24 * 7)
      .then(parsePriorWeeks)
      .catch((e) => {
        console.warn(`[priorWeeks] ${season} unavailable: ${(e as Error).message}`);
        memo.delete(season);
        return new Map<string, StatLine[]>();
      });
    memo.set(season, p);
  }
  return p;
}
