/**
 * Free, keyless data sources hosted on GitHub.
 *  - nflverse-data: play-by-play-derived rosters, injuries, snap counts, schedules.
 *  - ffverse/ffopportunity: weekly actual + *expected* fantasy production per player.
 *  - dynastyprocess/data: FantasyPros expert-consensus rankings (ECR) mirror,
 *    dynasty trade values, and the cross-platform player-id map.
 */
const NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download";
const DP = "https://raw.githubusercontent.com/dynastyprocess/data/master/files";
const FFOPP = "https://github.com/ffverse/ffopportunity/releases/download/latest-data";

export const sources = {
  schedule: `${NFLVERSE}/schedules/games.csv`,
  roster: (season: number) => `${NFLVERSE}/rosters/roster_${season}.csv`,
  injuries: (season: number) => `${NFLVERSE}/injuries/injuries_${season}.csv`,
  snaps: (season: number) => `${NFLVERSE}/snap_counts/snap_counts_${season}.csv`,
  /** ~55 MB, daily ESPN depth-chart snapshots (2025+ format: dt, team, gsis_id, pos_abb, pos_slot, pos_rank). */
  depthCharts: (season: number) => `${NFLVERSE}/depth_charts/depth_charts_${season}.csv`,
  epWeekly: (season: number) => `${FFOPP}/ep_weekly_${season}.csv`,
  playerIds: `${DP}/db_playerids.csv`,
  ecr: `${DP}/db_fpecr_latest.csv`,
  ecrWeekly: `${DP}/fp_latest_weekly.csv`,
  dynastyValues: `${DP}/values-players.csv`,
};
