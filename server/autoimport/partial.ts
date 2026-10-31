// Partial-run rules for the auto-import (stopgap until the Yahoo API; docs/DESIGN.md "Auto-import (stopgap until Yahoo
// API)"). Pure: a run whose rosters look cut short must never replace a fuller stored league. The caller turns a
// reason into PartialImportError (status reason "partial"; nothing is written).
import type { StoredImport } from "../providers/import.js";

export interface PartialRules {
  /** Refuse when the run's total rostered players fall below this share of the stored import's (0.7 = 70%). */
  minPlayerRatio: number;
}

/** Config: the thresholds (owner brief, fix round 1). */
export const PARTIAL_RULES: PartialRules = { minPlayerRatio: 0.7 };

const players = (s: Pick<StoredImport, "teams">) => s.teams.reduce((a, t) => a + t.players.length, 0);

/**
 * Why `incoming` looks like a partial read, or null when it is fine. Checked in order: fewer teams than stored, fewer
 * teams than Yahoo's settings report, a team with 0 players (a null team entry becomes one), total rostered players
 * below `minPlayerRatio` of the stored import, a section the stored import has (standings, waiver order, Yahoo
 * projections) missing entirely. With nothing stored, only the per-run checks apply.
 */
export function partialReason(previous: StoredImport | null, incoming: StoredImport, rules: PartialRules = PARTIAL_RULES): string | null {
  if (previous && incoming.teams.length < previous.teams.length) return `${incoming.teams.length} of ${previous.teams.length} teams read`;
  if (incoming.numTeams > incoming.teams.length) return `${incoming.teams.length} of ${incoming.numTeams} teams read`;
  const empty = incoming.teams.filter((t) => t.players.length === 0).length;
  if (empty) return `${empty} team${empty === 1 ? "" : "s"} read with 0 players`;
  if (previous) {
    const was = players(previous);
    const now = players(incoming);
    if (was > 0 && now < was * rules.minPlayerRatio) return `${now} rostered players read, ${was} stored (under ${Math.round(rules.minPlayerRatio * 100)}%)`;
    const lost = SECTIONS.filter(([, has]) => has(previous) && !has(incoming)).map(([name]) => name);
    if (lost.length) return `not read this run: ${lost.join(", ")}`;
  }
  return null;
}

/**
 * Optional sections a run can drop that must not be replaced by "missing" and cannot be carried over without looking
 * current (a stale record / waiver order / projection): a run that lost one is partial. Free agents are carried over
 * instead (upsertImport), so they are not listed here.
 */
const SECTIONS: [string, (s: StoredImport) => boolean][] = [
  ["standings", (s) => s.teams.some((t) => t.record)],
  ["waiver order", (s) => s.teams.some((t) => t.waiverRank)],
  ["Yahoo projections", (s) => s.teams.some((t) => t.players.some((p) => p.yahooProj !== undefined || p.yahooProjWeekly !== undefined))],
];
