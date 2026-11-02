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
  /** Listed accounts not on a row above: another imported league's team, or a team (league) no longer imported
   * (`gone`: they can sign in but see an error). Never hidden, so each can be removed. */
  others: { user: AccessUser; label: string; gone: boolean }[];
  /** "3 of 12 teams can sign in". */
  summary: string;
}

/** One row per team of `leagueId` (default: the first imported league), in the league's team order. */
export function accessView(o: AccessOverview, leagueId?: string): AccessView | null {
  const league = o.leagues.find((l) => l.id === leagueId) ?? o.leagues[0];
  if (!league) return null;
  const rows = league.teams.map((t) => ({ teamId: t.id, teamName: t.name, people: o.users.filter((u) => u.leagueId === league.id && u.teamId === t.id) }));
  const others = o.users
    .filter((u) => u.leagueId !== league.id || !league.teams.some((t) => t.id === u.teamId))
    .map((user) => {
      const l = o.leagues.find((x) => x.id === user.leagueId);
      const t = l?.teams.find((x) => x.id === user.teamId);
      return { user, label: l && t ? `${l.name} · ${t.name}` : `Team ${user.teamId} (gone)`, gone: !t };
    });
  const n = rows.filter((r) => r.people.length > 0).length;
  return { leagueId: league.id, leagueName: league.name, rows, others, summary: `${n} of ${rows.length} teams can sign in` };
}

/** The short label for a listed account: its note (a name), else the Discord ID's last 4 digits. */
export const personLabel = (u: { discordId: string; note?: string }) => u.note || `ID …${u.discordId.slice(-4)}`;

/** Discord user IDs are 17–20 digits today (the server accepts 5–25); strips spaces a paste may carry. */
export function cleanDiscordId(s: string): string | null {
  const id = s.replace(/\s+/g, "");
  return /^\d{5,25}$/.test(id) ? id : null;
}
