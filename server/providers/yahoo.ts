// Yahoo Fantasy Sports provider. Owned by the Yahoo developer agent.
// Contract used by server/api.ts — keep these signatures stable.
import type { League, ValuedPlayer, Player } from "../model/types.js";
import type { PlayerDb } from "../data/players.js";

export interface YahooLeagueSummary {
  key: string;
  name: string;
  season: number;
  numTeams: number;
  currentWeek: number;
  myTeamKey?: string;
}

export interface YahooFreeAgent {
  player: Player;
  onWaivers: boolean;
  percentOwned?: number;
}

export interface YahooProvider {
  /** True when YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET are configured. */
  isConfigured(): boolean;
  /** True when a usable (refreshable) token is stored. */
  isConnected(): Promise<boolean>;
  /** Yahoo consent URL for the user to open. */
  authUrl(): string;
  /** Exchange an oob / callback code for tokens and persist them. */
  exchangeCode(code: string): Promise<void>;
  disconnect(): Promise<void>;
  listLeagues(): Promise<YahooLeagueSummary[]>;
  /** Import a league (settings, teams, rosters). Cached in .data unless refresh. */
  getLeague(db: PlayerDb, leagueKey: string, opts?: { refresh?: boolean }): Promise<League>;
  /** Free agents + waiver-wire players for the league, plus my waiver priority. */
  getFreeAgents(db: PlayerDb, leagueKey: string, opts?: { refresh?: boolean }): Promise<{ freeAgents: YahooFreeAgent[]; myPriority?: number }>;
}

const notImplemented = () => {
  throw new Error("Yahoo provider not implemented yet");
};

export const yahoo: YahooProvider = {
  isConfigured: () => false,
  isConnected: async () => false,
  authUrl: notImplemented,
  exchangeCode: notImplemented,
  disconnect: notImplemented,
  listLeagues: notImplemented,
  getLeague: notImplemented,
  getFreeAgents: notImplemented,
};
