import { fetchCached } from "./cache.js";
import { sources } from "./sources.js";
import { parseCsv } from "./csv.js";
import { normTeam } from "./names.js";

export interface NflState {
  season: number;
  /** Next week to be played (first REG week with an unplayed game). */
  currentWeek: number;
  /** Weeks already fully completed. */
  completedWeeks: number;
  byes: Record<string, number>; // team -> bye week
  lastRegularWeek: number;
}

let cached: NflState | null = null;

export async function getNflState(): Promise<NflState> {
  if (cached) return cached;
  const rows = parseCsv(await fetchCached(sources.schedule, 6));
  const season = Math.max(...rows.map((r) => Number(r.season)));
  const reg = rows.filter((r) => Number(r.season) === season && r.game_type === "REG");
  const weeks = [...new Set(reg.map((r) => Number(r.week)))].sort((a, b) => a - b);
  const lastRegularWeek = weeks[weeks.length - 1];
  let currentWeek = lastRegularWeek + 1;
  for (const w of weeks) {
    if (reg.some((r) => Number(r.week) === w && r.away_score === "")) {
      currentWeek = w;
      break;
    }
  }
  const teams = new Set<string>();
  for (const r of reg) {
    teams.add(normTeam(r.away_team));
    teams.add(normTeam(r.home_team));
  }
  const byes: Record<string, number> = {};
  for (const t of teams) {
    for (const w of weeks) {
      const plays = reg.some((r) => Number(r.week) === w && (normTeam(r.away_team) === t || normTeam(r.home_team) === t));
      if (!plays) {
        byes[t] = w;
        break;
      }
    }
  }
  cached = { season, currentWeek, completedWeeks: currentWeek - 1, byes, lastRegularWeek };
  return cached;
}
