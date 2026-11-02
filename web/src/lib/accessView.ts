// Connect → "Who can sign in" (owner only): which Discord accounts can open which team of a league. Pure.
import type { AccessOverview, AccessUser } from "../api";

export interface TeamAccessRow {
  teamId: string;
  teamName: string;
  people: AccessUser[];
}

export interface AccessView {
  leagueId: string;
  leagueName: string;
  rows: TeamAccessRow[];
  /** Listed accounts whose team (or league) is no longer in the import: they can sign in but see an error. */
  stale: AccessUser[];
  /** "3 of 12 teams can sign in". */
  summary: string;
}

/** One row per team of `leagueId` (default: the first imported league), in the league's team order. */
export function accessView(o: AccessOverview, leagueId?: string): AccessView | null {
  const league = o.leagues.find((l) => l.id === leagueId) ?? o.leagues[0];
  if (!league) return null;
  const rows = league.teams.map((t) => ({ teamId: t.id, teamName: t.name, people: o.users.filter((u) => u.leagueId === league.id && u.teamId === t.id) }));
  const known = new Set(o.leagues.flatMap((l) => l.teams.map((t) => `${l.id}/${t.id}`)));
  const stale = o.users.filter((u) => !known.has(`${u.leagueId}/${u.teamId}`));
  const n = rows.filter((r) => r.people.length > 0).length;
  return { leagueId: league.id, leagueName: league.name, rows, stale, summary: `${n} of ${rows.length} teams can sign in` };
}

/** The short label for a listed account: its note (a name), else the Discord ID's last 4 digits. */
export const personLabel = (u: { discordId: string; note?: string }) => u.note || `ID …${u.discordId.slice(-4)}`;

/** Discord user IDs are 17–20 digits today (the server accepts 5–25); strips spaces a paste may carry. */
export function cleanDiscordId(s: string): string | null {
  const id = s.replace(/\s+/g, "");
  return /^\d{5,25}$/.test(id) ? id : null;
}
