import { parseCsv } from "./csv.js";
import { normTeam } from "./names.js";
import { getPlayerDb } from "./players.js";

export interface NflState {
  season: number;
  /** Next week to be played (first REG week with an unplayed game). */
  currentWeek: number;
  /** Weeks already fully completed. */
  completedWeeks: number;
  byes: Record<string, number>; // team -> bye week
  lastRegularWeek: number;
}

/**
 * The NFL calendar as of the latest data refresh: recomputed from the schedule on every player database rebuild
 * (players.ts DB_STALE_MS), so a server running for days advances the week.
 */
export async function getNflState(): Promise<NflState> {
  return (await getPlayerDb()).state;
}

/** Pure: the calendar from nflverse games.csv (current week = first REG week with an unplayed game). */
export function computeNflState(scheduleCsv: string): NflState {
  const rows = parseCsv(scheduleCsv);
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
  return { season, currentWeek, completedWeeks: currentWeek - 1, byes, lastRegularWeek };
}
