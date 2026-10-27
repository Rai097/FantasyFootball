// Stash watch (docs/DESIGN.md "Model v4" section 4 + "Release (c) implemented"): unrostered players who are out now
// (Out / IR / reserve / PUP / suspended) or have had 0 snaps in their team's last 2 games, with a flex-level role when
// healthy, ranked by playoff-weighted points from their return week. Pure: reads projection v4's `ret` numbers.
import type { Availability, DetailItem, Position, StashCall, StashRow, ValuedPlayer } from "./types.js";
import { returnText } from "./returns.js";

export const STASH_WATCH = { limit: 10 } as const;
export type { StashCall, StashRow };

export interface StashInput {
  players: Iterable<ValuedPlayer>;
  /** Every player on any roster in the league (IR slots included). */
  rostered: Set<string>;
  /** Free agent / on waivers per player when the league source says; missing = status unknown. */
  availability: Map<string, Availability>;
  flexLevel: Partial<Record<Position, number>>;
  regularSeasonEnd: number;
  finalWeek: number;
  usesFaab?: boolean;
  limit?: number;
}

const f1 = (x: number) => x.toFixed(1);
const PRACTICE_FLAG = "practice upgrade: about to become a waiver fight";

export function stashWatch(x: StashInput): StashRow[] {
  const rows: StashRow[] = [];
  for (const p of x.players) {
    const r = p.ret;
    const floor = x.flexLevel[p.pos];
    if (!r || x.rostered.has(p.id) || p.team === "FA" || p.pos === "K" || p.pos === "DEF") continue;
    if (r.healthyRate === undefined || floor === undefined || r.healthyRate < floor || !r.stashScore || r.playoffPts === undefined) continue;
    const availability = x.availability.get(p.id) ?? "unknown";
    const call: StashCall = availability === "fa" ? "add" : availability === "waivers" ? "claim-cheap" : "check";
    const callText =
      call === "add" ? "Add now while free" : call === "claim-cheap" ? (x.usesFaab ? "On waivers — bid only a little" : "On waivers — claim only if priority is cheap") : "Status unknown — add only if he is a free agent";
    const back = returnText(r.week, r.confidence);
    const po = `${x.regularSeasonEnd + 1}–${x.finalWeek}`;
    const details: DetailItem[] = [
      { label: "Role when healthy", value: `${f1(r.healthyRate)} pts/game (${r.healthySource === "prior" ? "2025 expected per game" : "his games before the absence"}), flex level ${f1(floor)}` },
      { label: "Return", value: r.week === null ? `unconfirmed${r.earliestWeek ? `, wk ${r.earliestWeek} at the earliest` : ""}` : back, ...(r.week === null ? { tone: "warn" as const } : {}) },
      ...r.reasons.filter((d) => d.label !== "Return"),
      { label: "Playoff value", value: `${f1(r.playoffPts)} pts in weeks ${po}${r.week === null ? " (× 0.5: return unconfirmed)" : ""}` },
      {
        label: "Why now",
        value:
          call === "add"
            ? "free today: costs only a bench spot, before his return makes him a claim"
            : call === "claim-cheap"
              ? "needs a waiver claim: worth it only when your priority (or bid) is cheap"
              : "free agent or on waivers is not captured: re-import to see",
      },
    ];
    if (r.practiceUp) details.push({ label: "Practice", value: PRACTICE_FLAG, tone: "pos" });
    const row: StashRow = {
      id: p.id,
      name: p.name,
      pos: p.pos,
      team: p.team,
      summary: `${p.name} · ${p.pos} · ${p.team} · ${back} · playoff value ${f1(r.playoffPts)}`.slice(0, 255),
      call,
      callText,
      availability,
      backWeek: r.week,
      confidence: r.confidence,
      playoffPts: r.playoffPts,
      healthyRate: r.healthyRate,
      stashScore: r.stashScore,
      details,
    };
    if (p.injury) row.injury = p.injury;
    if (r.practiceUp) row.flag = PRACTICE_FLAG;
    rows.push(row);
  }
  rows.sort((a, b) => b.stashScore - a.stashScore || b.healthyRate - a.healthyRate || a.id.localeCompare(b.id));
  return rows.slice(0, x.limit ?? STASH_WATCH.limit);
}
