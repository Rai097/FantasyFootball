// Prior-season weekly actual stat lines (ffopportunity ep_weekly), for floor / consistency.
// players.ts keeps only prior-season totals; this reads the same cached file week by week.
import { fetchCached } from "./cache.js";
import { sources } from "./sources.js";
import { parseCsv, num } from "./csv.js";
import type { StatLine } from "../model/types.js";

const actual = (r: Record<string, string>): StatLine => ({
  passYd: num(r.pass_yards_gained),
  passTd: num(r.pass_touchdown),
  passInt: num(r.pass_interception),
  rushYd: num(r.rush_yards_gained),
  rushTd: num(r.rush_touchdown),
  rec: num(r.receptions),
  recYd: num(r.rec_yards_gained),
  recTd: num(r.rec_touchdown),
  twoPt: num(r.pass_two_point_conv) + num(r.rush_two_point_conv) + num(r.rec_two_point_conv),
  fumLost: num(r.rec_fumble_lost) + num(r.rush_fumble_lost),
});

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
