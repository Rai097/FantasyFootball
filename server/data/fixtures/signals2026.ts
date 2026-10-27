// Real NFL rows cut from the local cache on 2026-10-26 for the Model v4 signal tests (NFL data only, no league data).
// Players: Colston Loveland (CHI TE), Tre Tucker (LV WR), KC Concepcion (CLE WR), D'Andre Swift + Kyle Monangai (CHI RB);
// plus CHI QB rows (starter fallback). Teams CHI / LV / CLE (+ SEA games.csv rows: returning starter case), weeks 1-7 played (week 8 unplayed in games.csv).
// Columns stripped to what server/data/signalTables.ts reads; values unchanged.

import { buildSignalInputs } from "../signalTables.js";
import type { Scoring } from "../../model/types.js";

/** Source: ffopportunity ep_weekly_2026.csv (cached 2026-10-26). */
export const EP_2026 = `season,posteam,week,game_id,player_id,full_name,position,pass_attempt,rec_attempt,rush_attempt,rec_air_yards,pass_yards_gained,pass_touchdown,pass_interception,rush_yards_gained,rush_touchdown,receptions,rec_yards_gained,rec_touchdown,pass_two_point_conv,rush_two_point_conv,rec_two_point_conv,pass_yards_gained_exp,pass_touchdown_exp,pass_interception_exp,rush_yards_gained_exp,rush_touchdown_exp,receptions_exp,rec_yards_gained_exp,rec_touchdown_exp,pass_two_point_conv_exp,rush_two_point_conv_exp,rec_two_point_conv_exp,rec_fumble_lost,rush_fumble_lost,rec_attempt_team,rec_air_yards_team,rush_attempt_team
2026,CHI,1,2026_01_CHI_CAR,00-0039918,Caleb Williams,QB,29,0,10,0,269,2,0,65,2,0,0,0,0,0,0,245.45,2.73,0.76,52.14,1.08,0,0,0,0,0,0,0,0,29,319,39
2026,CHI,1,2026_01_CHI_CAR,00-0040236,Kyle Monangai,RB,0,2,10,9,0,0,0,100,1,2,24,0,0,0,0,0,0,0,41.68,0.25,1.62,16.13,0.02,0,0,0,0,0,29,319,39
2026,CHI,1,2026_01_CHI_CAR,00-0040126,Colston Loveland,TE,0,2,0,30,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1.16,21.77,0.49,0,0,0,0,0,29,319,39
2026,CHI,1,2026_01_CHI_CAR,00-0036275,D'Andre Swift,RB,0,1,18,4,0,0,0,124,3,1,10,0,0,0,0,0,0,0,65.84,1.53,0.82,8.5,0.01,0,0,0,0,0,29,319,39
2026,CLE,1,2026_01_CLE_JAX,00-0041547,KC Concepcion,WR,0,5,3,63,0,0,0,15,0,4,43,0,0,0,0,0,0,0,17.63,0.01,2.91,38.32,0.11,0,0,0,1,0,22,228,22
2026,LV,1,2026_01_MIA_LV,00-0038563,Tre Tucker,WR,0,4,0,50,0,0,0,0,0,2,27,0,0,0,0,0,0,0,0,0,2.44,34.17,0.21,0,0,0,0,0,30,226,37
2026,CLE,2,2026_02_CLE_TB,00-0041547,KC Concepcion,WR,0,6,1,12,0,0,0,-6,0,6,28,0,0,0,0,0,0,0,7,0.01,4.69,33.07,0.1,0,0,0,0,0,30,108,23
2026,LV,2,2026_02_LV_LAC,00-0038563,Tre Tucker,WR,0,7,0,143,0,0,0,0,0,5,119,1,0,0,0,0,0,0,0,0,3.55,69.92,0.31,0,0,0,0,0,29,283,29
2026,CHI,2,2026_02_MIN_CHI,00-0039918,Caleb Williams,QB,26,0,5,0,138,0,1,42,0,0,0,0,0,0,0,180.37,0.77,0.5,30.24,0.25,0,0,0,0,0,0,0,0,35,189,31
2026,CHI,2,2026_02_MIN_CHI,00-0036275,D'Andre Swift,RB,0,5,16,-15,0,0,0,45,0,5,54,0,0,0,0,0,0,0,69.54,0.67,4.16,26.47,0.41,0,0,0,0,1,35,189,31
2026,CHI,2,2026_02_MIN_CHI,00-0040236,Kyle Monangai,RB,0,2,10,1,0,0,0,47,0,2,11,0,0,0,0,0,0,0,42.13,0.17,1.65,11.84,0.07,0,0,0,0,0,35,189,31
2026,CHI,2,2026_02_MIN_CHI,00-0040126,Colston Loveland,TE,0,3,0,13,0,0,0,0,0,1,3,0,0,0,0,0,0,0,0,0,2.06,16.05,0.38,0,0,0,0,0,35,189,31
2026,CHI,2,2026_02_MIN_CHI,00-0038416,Tyson Bagent,QB,9,0,0,0,54,0,0,0,0,0,0,0,0,0,0,47.85,1.44,0.32,0,0,0,0,0,0,0,0,0,0,35,189,31
2026,CLE,3,2026_03_CAR_CLE,00-0041547,KC Concepcion,WR,0,9,0,36,0,0,0,0,0,2,9,0,0,0,0,0,0,0,0,0,6.58,59.56,0.08,0,0,0,0,0,31,172,30
2026,LV,3,2026_03_LV_NO,00-0038563,Tre Tucker,WR,0,4,0,35,0,0,0,0,0,4,43,0,0,0,0,0,0,0,0,0,2.87,33.17,0.17,0,0,0,0,0,33,273,27
2026,CHI,3,2026_03_PHI_CHI,00-0028986,Case Keenum,QB,34,0,4,0,247,2,0,6,1,0,0,0,0,0,0,243.66,2.23,0.63,7,0.72,0,0,0,0,0,0,0,0,34,209,35
2026,CHI,3,2026_03_PHI_CHI,00-0040126,Colston Loveland,TE,0,4,0,4,0,0,0,0,0,4,31,0,0,0,0,0,0,0,0,0,3.21,25.33,0.31,0,0,0,0,0,34,209,35
2026,CHI,3,2026_03_PHI_CHI,00-0036275,D'Andre Swift,RB,0,3,20,-1,0,0,0,84,0,2,4,0,0,0,0,0,0,0,74.27,1.23,2.11,18.57,0.03,0,0,0,0,0,34,209,35
2026,LV,4,2026_04_KC_LV,00-0038563,Tre Tucker,WR,0,8,0,129,0,0,0,0,0,4,44,0,0,0,0,0,0,0,0,0,4.53,77.35,0.45,0,0,0,0,0,52,456,26
2026,CHI,4,2026_04_NYJ_CHI,00-0038416,Tyson Bagent,QB,34,0,4,0,268,0,1,1,0,0,0,0,0,0,0,270.75,2.27,0.65,5.09,0.04,0,0,0,0,0,0,0,0,34,213,54
2026,CHI,4,2026_04_NYJ_CHI,00-0040126,Colston Loveland,TE,0,9,0,55,0,0,0,0,0,6,57,0,0,0,0,0,0,0,0,0,6.8,68.54,0.88,0,0,0,0,0,34,213,54
2026,CHI,4,2026_04_NYJ_CHI,00-0036275,D'Andre Swift,RB,0,2,15,-12,0,0,0,58,0,2,16,0,0,0,0,0,0,0,61.2,1.17,1.77,12.24,0,0,0,0,0,1,34,213,54
2026,CHI,4,2026_04_NYJ_CHI,00-0040236,Kyle Monangai,RB,0,1,30,-6,0,0,0,146,2,1,4,0,0,0,0,0,0,0,117.74,2.76,0.87,7.63,0,0,0,0,0,0,34,213,54
2026,CLE,4,2026_04_PIT_CLE,00-0041547,KC Concepcion,WR,0,8,0,62,0,0,0,0,0,5,64,0,0,0,0,0,0,0,0,0,5.48,58.44,0.09,0,0,0,0,0,33,251,27
2026,CHI,5,2026_05_CHI_GB,00-0038416,Tyson Bagent,QB,21,0,3,0,87,0,2,17,0,0,0,0,0,0,0,160.89,0.73,0.49,16.39,0.21,0,0,0,0,0,0,0,0,40,332,24
2026,CHI,5,2026_05_CHI_GB,00-0036275,D'Andre Swift,RB,0,5,9,-2,0,0,0,43,1,4,30,0,0,0,0,0,0,0,32.23,1.13,4.09,30.3,0.01,0,0,0,0,0,40,332,24
2026,CHI,5,2026_05_CHI_GB,00-0040126,Colston Loveland,TE,0,5,0,43,0,0,0,0,0,2,19,0,0,0,0,0,0,0,0,0,3.62,48.03,0.02,0,0,0,0,0,40,332,24
2026,CHI,5,2026_05_CHI_GB,00-0028986,Case Keenum,QB,19,0,1,0,108,0,1,4,0,0,0,0,0,0,0,139.36,1.07,0.65,7.43,0,0,0,0,0,0,0,0,0,40,332,24
2026,CLE,5,2026_05_CLE_NYJ,00-0041547,KC Concepcion,WR,0,1,0,3,0,0,0,0,0,1,5,0,0,0,0,0,0,0,0,0,0.74,4.79,0,0,0,0,0,0,33,296,24
2026,LV,5,2026_05_LV_NE,00-0038563,Tre Tucker,WR,0,5,2,55,0,0,0,-6,0,4,41,0,0,0,0,0,0,0,11.56,0.01,3.11,37.38,0.2,0,0,0,0,0,36,219,18
2026,CLE,6,2026_06_BAL_CLE,00-0041547,KC Concepcion,WR,0,6,2,55,0,0,0,2,0,4,37,0,0,0,0,0,0,0,10.54,0.21,4.06,45.67,0.03,0,0,0,0,0,26,209,29
2026,LV,6,2026_06_BUF_LV,00-0038563,Tre Tucker,WR,0,7,0,108,0,0,0,0,0,5,97,2,0,0,0,0,0,0,0,0,3.85,57.29,0.61,0,0,0,0,0,41,351,20
2026,CHI,6,2026_06_CHI_ATL,00-0039918,Caleb Williams,QB,36,0,4,0,293,1,0,3,0,0,0,0,0,0,0,267.46,2.63,0.36,7.51,0.02,0,0,0,0,0,0,0,0,36,141,33
2026,CHI,6,2026_06_CHI_ATL,00-0040126,Colston Loveland,TE,0,7,0,33,0,0,0,0,0,6,65,1,0,0,0,0,0,0,0,0,5.01,43.81,1.16,0,0,0,0,0,36,141,33
2026,CHI,6,2026_06_CHI_ATL,00-0036275,D'Andre Swift,RB,0,5,16,1,0,0,0,44,2,4,26,0,0,0,0,0,0,0,69.28,1.28,4.07,39.14,0.11,0,0,0,0,0,36,141,33
2026,CLE,7,2026_07_CLE_TEN,00-0041547,KC Concepcion,WR,0,10,3,110,0,0,0,23,0,8,129,0,0,0,0,0,0,0,16.79,0.19,6.34,75.24,0.11,0,0,0,0,0,36,295,29
2026,LV,7,2026_07_LA_LV,00-0038563,Tre Tucker,WR,0,12,0,99,0,0,0,0,0,5,103,1,0,0,0,0,0,0,0,0,8.28,98.03,0.16,0,0,0,0,0,45,328,17
2026,CHI,7,2026_07_NE_CHI,00-0039918,Caleb Williams,QB,33,0,5,0,308,2,0,18,0,0,0,0,0,0,0,293.32,1.1,0.7,20.24,0.19,0,0,0,0,0,0,0,0,33,287,30
2026,CHI,7,2026_07_NE_CHI,00-0040126,Colston Loveland,TE,0,12,0,112,0,0,0,0,0,7,69,1,0,0,0,0,0,0,0,0,8.4,111.36,0.36,0,0,0,0,0,33,287,30
2026,CHI,7,2026_07_NE_CHI,00-0036275,D'Andre Swift,RB,0,4,22,-10,0,0,0,78,1,4,12,0,0,0,0,0,0,0,98.4,0.55,3.37,24.74,0.02,0,0,0,0,0,33,287,30
2026,CHI,3,2026_03_PHI_CHI,00-0040236,Kyle Monangai,RB,0,0,10,0,0,0,0,31,0,0,0,0,0,0,0,0,0,0,41.34,0.2,0,0,0,0,0,0,0,0,34,209,35
`;

/** Source: ffopportunity ep_weekly_2025.csv, Loveland weeks 1-3 (cached 2026-10-26). */
export const EP_2025 = `season,posteam,week,game_id,player_id,full_name,position,pass_attempt,rec_attempt,rush_attempt,rec_air_yards,pass_yards_gained,pass_touchdown,pass_interception,rush_yards_gained,rush_touchdown,receptions,rec_yards_gained,rec_touchdown,pass_two_point_conv,rush_two_point_conv,rec_two_point_conv,pass_yards_gained_exp,pass_touchdown_exp,pass_interception_exp,rush_yards_gained_exp,rush_touchdown_exp,receptions_exp,rec_yards_gained_exp,rec_touchdown_exp,pass_two_point_conv_exp,rush_two_point_conv_exp,rec_two_point_conv_exp,rec_fumble_lost,rush_fumble_lost,rec_attempt_team,rec_air_yards_team,rush_attempt_team
2025,CHI,1,2025_01_MIN_CHI,00-0040126,Colston Loveland,TE,0,2,0,5,0,0,0,0,0,2,12,0,0,0,0,0,0,0,0,0,1.59,12.51,0,0,0,0,0,0,35,263,26
2025,CHI,2,2025_02_CHI_DET,00-0040126,Colston Loveland,TE,0,1,0,22,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0.5,13.24,0,0,0,0,0,0,33,337,27
2025,CHI,3,2025_03_DAL_CHI,00-0040126,Colston Loveland,TE,0,3,0,65,0,0,0,0,0,1,31,0,0,0,0,0,0,0,0,0,1.75,46.47,0.02,0,0,0,0,0,28,250,29
`;

/** Source: nflverse schedules/games.csv, 2026 REG weeks 1-8 of CHI/LV/CLE (cached 2026-10-26). */
export const GAMES = `game_id,season,game_type,week,away_team,home_team,result,away_qb_id,home_qb_id,away_qb_name,home_qb_name
2026_01_CHI_CAR,2026,REG,1,CHI,CAR,-22,00-0039918,00-0039150,Caleb Williams,Bryce Young
2026_01_CLE_JAX,2026,REG,1,CLE,JAX,24,00-0033537,00-0036971,Deshaun Watson,Trevor Lawrence
2026_01_MIA_LV,2026,REG,1,MIA,LV,14,00-0038128,00-0029604,Malik Willis,Kirk Cousins
2026_02_MIN_CHI,2026,REG,2,MIN,CHI,-6,00-0032950,00-0039918,Carson Wentz,Caleb Williams
2026_02_CLE_TB,2026,REG,2,CLE,TB,-4,00-0033537,00-0034855,Deshaun Watson,Baker Mayfield
2026_02_LV_LAC,2026,REG,2,LV,LAC,-12,00-0029604,00-0036355,Kirk Cousins,Justin Herbert
2026_03_CAR_CLE,2026,REG,3,CAR,CLE,3,00-0039150,00-0033537,Bryce Young,Deshaun Watson
2026_03_LV_NO,2026,REG,3,LV,NO,-8,00-0029604,00-0040743,Kirk Cousins,Tyler Shough
2026_03_PHI_CHI,2026,REG,3,PHI,CHI,20,00-0036389,00-0028986,Jalen Hurts,Case Keenum
2026_04_PIT_CLE,2026,REG,4,PIT,CLE,3,00-0023459,00-0033537,Aaron Rodgers,Deshaun Watson
2026_04_NYJ_CHI,2026,REG,4,NYJ,CHI,11,00-0030565,00-0028986,Geno Smith,Case Keenum
2026_04_KC_LV,2026,REG,4,KC,LV,-3,00-0033873,00-0029604,Patrick Mahomes,Kirk Cousins
2026_05_CHI_GB,2026,REG,5,CHI,GB,24,00-0038416,00-0036264,Tyson Bagent,Jordan Love
2026_05_LV_NE,2026,REG,5,LV,NE,28,00-0029604,00-0039851,Kirk Cousins,Drake Maye
2026_05_CLE_NYJ,2026,REG,5,CLE,NYJ,5,00-0033537,00-0030565,Deshaun Watson,Geno Smith
2026_06_CHI_ATL,2026,REG,6,CHI,ATL,-8,00-0039918,00-0039917,Caleb Williams,Michael Penix Jr.
2026_06_BAL_CLE,2026,REG,6,BAL,CLE,3,00-0035993,00-0033537,Tyler Huntley,Deshaun Watson
2026_06_BUF_LV,2026,REG,6,BUF,LV,-3,00-0034857,00-0029604,Josh Allen,Kirk Cousins
2026_07_NE_CHI,2026,REG,7,NE,CHI,6,00-0039851,00-0039918,Drake Maye,Caleb Williams
2026_07_CLE_TEN,2026,REG,7,CLE,TEN,-3,00-0033537,00-0040676,Deshaun Watson,Cam Ward
2026_07_LA_LV,2026,REG,7,LA,LV,-14,00-0026498,00-0029604,Matthew Stafford,Kirk Cousins
2026_08_LV_NYJ,2026,REG,8,LV,NYJ,,00-0029604,00-0030565,Kirk Cousins,Geno Smith
2026_08_CLE_PIT,2026,REG,8,CLE,PIT,,00-0033537,00-0023459,Deshaun Watson,Aaron Rodgers
2026_01_NE_SEA,2026,REG,1,NE,SEA,3,00-0039851,00-0034869,Drake Maye,Sam Darnold
2026_02_SEA_ARI,2026,REG,2,SEA,ARI,-24,00-0035704,00-0033119,Drew Lock,Jacoby Brissett
2026_03_SEA_WAS,2026,REG,3,SEA,WAS,2,00-0035704,00-0039910,Drew Lock,Jayden Daniels
2026_04_LAC_SEA,2026,REG,4,LAC,SEA,7,00-0036355,00-0035704,Justin Herbert,Drew Lock
2026_05_SF_SEA,2026,REG,5,SF,SEA,-3,00-0037834,00-0035704,Brock Purdy,Drew Lock
2026_06_SEA_DEN,2026,REG,6,SEA,DEN,3,00-0035704,00-0039732,Drew Lock,Bo Nix
2026_07_KC_SEA,2026,REG,7,KC,SEA,17,00-0033873,00-0034869,Patrick Mahomes,Sam Darnold
2026_08_CHI_SEA,2026,REG,8,CHI,SEA,,00-0039918,00-0034869,Caleb Williams,Sam Darnold
`;

/** Source: nflverse rosters/roster_2026.csv (cached 2026-10-26). */
export const ROSTER = `season,team,position,status,full_name,birth_date,gsis_id,pfr_id,week,rookie_year,draft_number
2026,CHI,RB,ACT,D'Andre Swift,1999-01-14,00-0036275,SwifDA00,7,2020,35
2026,LV,WR,ACT,Tre Tucker,2001-03-08,00-0038563,TuckTr00,7,2023,100
2026,CHI,TE,ACT,Colston Loveland,2004-04-09,00-0040126,LoveCo00,7,2025,10
2026,CHI,RB,INA,Kyle Monangai,2002-06-06,00-0040236,MonaKy00,7,2025,233
2026,CLE,WR,ACT,KC Concepcion,2004-09-24,00-0041547,ConcKC00,7,2026,24
`;

/** Source: nflverse snap_counts/snap_counts_2026.csv (cached 2026-10-26). */
export const SNAPS = `game_id,season,game_type,week,player,pfr_player_id,position,team,offense_snaps,offense_pct
2026_01_CHI_CAR,2026,REG,1,Colston Loveland,LoveCo00,TE,CHI,65,0.87
2026_01_CHI_CAR,2026,REG,1,D'Andre Swift,SwifDA00,RB,CHI,43,0.57
2026_01_CHI_CAR,2026,REG,1,Kyle Monangai,MonaKy00,RB,CHI,32,0.43
2026_01_CLE_JAX,2026,REG,1,KC Concepcion,ConcKC00,WR,CLE,35,0.69
2026_01_MIA_LV,2026,REG,1,Tre Tucker,TuckTr00,WR,LV,48,0.71
2026_02_CLE_TB,2026,REG,2,KC Concepcion,ConcKC00,WR,CLE,38,0.66
2026_02_LV_LAC,2026,REG,2,Tre Tucker,TuckTr00,WR,LV,37,0.59
2026_02_MIN_CHI,2026,REG,2,Colston Loveland,LoveCo00,TE,CHI,64,0.86
2026_02_MIN_CHI,2026,REG,2,D'Andre Swift,SwifDA00,RB,CHI,50,0.68
2026_02_MIN_CHI,2026,REG,2,Kyle Monangai,MonaKy00,RB,CHI,25,0.34
2026_03_CAR_CLE,2026,REG,3,KC Concepcion,ConcKC00,WR,CLE,60,0.86
2026_03_LV_NO,2026,REG,3,Tre Tucker,TuckTr00,WR,LV,40,0.57
2026_03_PHI_CHI,2026,REG,3,Colston Loveland,LoveCo00,TE,CHI,57,0.79
2026_03_PHI_CHI,2026,REG,3,D'Andre Swift,SwifDA00,RB,CHI,50,0.69
2026_03_PHI_CHI,2026,REG,3,Kyle Monangai,MonaKy00,RB,CHI,22,0.31
2026_04_KC_LV,2026,REG,4,Tre Tucker,TuckTr00,WR,LV,56,0.67
2026_04_NYJ_CHI,2026,REG,4,Colston Loveland,LoveCo00,TE,CHI,86,0.92
2026_04_NYJ_CHI,2026,REG,4,Kyle Monangai,MonaKy00,RB,CHI,50,0.54
2026_04_NYJ_CHI,2026,REG,4,D'Andre Swift,SwifDA00,RB,CHI,33,0.35
2026_04_PIT_CLE,2026,REG,4,KC Concepcion,ConcKC00,WR,CLE,59,0.92
2026_05_CHI_GB,2026,REG,5,Colston Loveland,LoveCo00,TE,CHI,55,0.8
2026_05_CHI_GB,2026,REG,5,D'Andre Swift,SwifDA00,RB,CHI,40,0.58
2026_05_CLE_NYJ,2026,REG,5,KC Concepcion,ConcKC00,WR,CLE,11,0.16
2026_05_LV_NE,2026,REG,5,Tre Tucker,TuckTr00,WR,LV,45,0.75
2026_06_BAL_CLE,2026,REG,6,KC Concepcion,ConcKC00,WR,CLE,51,0.81
2026_06_BUF_LV,2026,REG,6,Tre Tucker,TuckTr00,WR,LV,46,0.7
2026_06_CHI_ATL,2026,REG,6,Colston Loveland,LoveCo00,TE,CHI,68,0.88
2026_06_CHI_ATL,2026,REG,6,D'Andre Swift,SwifDA00,RB,CHI,45,0.58
2026_07_CLE_TEN,2026,REG,7,KC Concepcion,ConcKC00,WR,CLE,55,0.79
2026_07_LA_LV,2026,REG,7,Tre Tucker,TuckTr00,WR,LV,56,0.82
2026_07_NE_CHI,2026,REG,7,D'Andre Swift,SwifDA00,RB,CHI,59,0.86
2026_07_NE_CHI,2026,REG,7,Colston Loveland,LoveCo00,TE,CHI,58,0.84
`;

/** Source: nflverse injuries/injuries_2026.csv (cached 2026-10-26). */
export const INJURIES = `season,season_type,team,week,gsis_id,full_name,report_status,practice_status
2026,REG,CHI,2,00-0036275,D'Andre Swift,,Full Participation in Practice
2026,REG,CHI,2,00-0040236,Kyle Monangai,,Full Participation in Practice
2026,REG,CHI,3,00-0040236,Kyle Monangai,,Full Participation in Practice
2026,REG,CHI,4,00-0036275,D'Andre Swift,,Full Participation in Practice
2026,REG,CHI,5,00-0036275,D'Andre Swift,,Full Participation in Practice
2026,REG,CHI,5,00-0040236,Kyle Monangai,Out,Did Not Participate In Practice
2026,REG,CHI,6,00-0040236,Kyle Monangai,Out,Did Not Participate In Practice
2026,REG,CLE,6,00-0041547,KC Concepcion,,Full Participation in Practice
2026,REG,CHI,7,00-0040236,Kyle Monangai,Out,Did Not Participate In Practice
2026,REG,CLE,7,00-0041547,KC Concepcion,,Full Participation in Practice
`;


export const FIXTURE_SOURCES = {
  season: 2026,
  epCsv: EP_2026,
  epPriorCsv: EP_2025,
  gamesCsv: GAMES,
  injuriesCsv: INJURIES,
  rosterCsv: ROSTER,
  snapsCsv: SNAPS,
};
export const fixtureInputs = () => buildSignalInputs(FIXTURE_SOURCES);

export const IDS = {
  loveland: "00-0040126",
  tucker: "00-0038563",
  concepcion: "00-0041547",
  swift: "00-0036275",
  monangai: "00-0040236",
  caleb: "00-0039918",
  darnold: "00-0034869",
  lock: "00-0035704",
} as const;

/** Full PPR (the format of the 2.8 target weight). */
export const PPR: Scoring = { passYd: 0.04, passTd: 4, passInt: -1, rushYd: 0.1, rushTd: 6, rec: 1, recYd: 0.1, recTd: 6, twoPt: 2, fumLost: -2, teRec: 0 };
export const ASOF = new Date("2026-10-26T00:00:00Z");
