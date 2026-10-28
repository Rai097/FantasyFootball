// Adversarial: projection v4 on a borrowed role whose teammate is gone for the season (DESIGN "Fix: vacated role,
// spikes, depth and roster need (2026-10-28)"). While the teammate stays out the borrowed role IS his role: the design
// says the full rate applies to every remaining week, so he must project like the same player with no borrowed-role
// detection at all. Real copy 2026-10-28: an RB who took over when the starter went on IR for the season lost
// 0.6 ppg / 43% of his value (prior weight 2 → 2.8 games because the role-up check now skips vacated games).
// Synthetic players only (generic ids).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { emptyTables, signalInputFromPlayer, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computeAllSignals } from "./signals/index.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import { PPR } from "../data/fixtures/signals2026.js";
import type { Player, Position, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import type { PlayerSignalInput } from "./signals/types.js";

const ASOF = new Date("2026-10-26T00:00:00Z");
const L = () => league([team("a", [])], undefined, { currentWeek: 8, numTeams: 12, scoring: { ...PPR } });
/** RB week: c carries, t targets (expected = actual, so finishing is neutral). */
const rbWk = (week: number, c: number, t: number): WeekLine => {
  const a: Partial<StatLine> = { rushYd: c * 4.3, rushTd: c * 0.03, rec: t * 0.75, recYd: t * 6 };
  return { season: 2026, week, team: "AAA", actual: line(a), expected: line(a), opp: { targets: t, carries: c, airYards: 0 } };
};
function filler(pos: Position, n = 40): Player[] {
  return Array.from({ length: n }, (_, i) =>
    rawPlayer(`${pos}f${i + 1}`, pos, {
      team: "ZZZ",
      ecrPos: i + 1,
      weeks: Array.from({ length: 6 }, (_, k) => ({ season: 2026, week: k + 1, team: "ZZZ", actual: line({ rec: 6 - i * 0.1, recYd: 120 - i * 2.5 }), expected: line({ rec: 6 - i * 0.1, recYd: 120 - i * 2.5 }) })),
    }),
  );
}
const POOL = [...filler("QB", 30), ...filler("RB"), ...filler("WR"), ...filler("TE", 30)];

function value(players: Player[]): Map<string, ValuedPlayer> {
  const inputs = players.map(signalInputFromPlayer).filter((x): x is PlayerSignalInput => !!x);
  const tables: ProjectionTables = { ...emptyTables(), signals: computeAllSignals(inputs, { season: 2026, scoring: PPR, asOf: ASOF }) };
  return valuePlayers(L(), [...POOL, ...players], tables).players;
}

// Backup RB: 2 weeks of a small role, then the lead back is lost for the season (week 3) and he carries the load.
// Real-copy shape (2026 wk 2–7, bye wk 6): 3 carries, then 17+3, 9+2, 18+0, 25+3 once the lead back was gone.
const BACKUP_GAMES: [number, number, number][] = [[2, 3, 0], [3, 17, 3], [4, 9, 2], [5, 18, 0], [7, 25, 3]];
const backup = (prior: Player["prior"]): Player =>
  rawPlayer("rb2", "RB", { team: "AAA", weeks: BACKUP_GAMES.map(([w, c, t]) => rbWk(w, c, t)), prior });
const lead = (): Player =>
  rawPlayer("rb1", "RB", { team: "AAA", weeks: [rbWk(1, 18, 4), rbWk(2, 19, 4)], injury: { status: "IR", detail: "Knee - out for season", week: 3 } });
// Last season: a small backup role (the classic "backup turned starter" gem).
const SMALL_PRIOR: Player["prior"] = { games: 15, line: line({ rushYd: 15 * 4 * 4.3, rec: 15 * 1, recYd: 15 * 6 }) } as Player["prior"];

describe("projection v4: borrowed role from a teammate out for the season", () => {
  test("no prior: the inheritor projects like the same player with no borrowed-role detection (±3%)", () => {
    const out = value([backup(null), lead()]).get("rb2")!;
    const alone = value([backup(null)]).get("rb2")!;
    assert.match(out.whyItems?.find((d) => d.label === "While he is out")?.value ?? "", /return unknown/, "the full-rate weeks apply");
    assert.ok(Math.abs(out.ppg - alone.ppg) <= 0.03 * alone.ppg, `out-for-season teammate ${out.ppg.toFixed(2)} vs no detection ${alone.ppg.toFixed(2)}`);
  });
  test("small 2025 prior (backup turned starter): the role-up exemption still applies while the starter stays out (±3%)", () => {
    const out = value([backup(SMALL_PRIOR), lead()]).get("rb2")!;
    const alone = value([backup(SMALL_PRIOR)]).get("rb2")!;
    assert.ok(Math.abs(out.ppg - alone.ppg) <= 0.03 * alone.ppg, `out-for-season teammate ${out.ppg.toFixed(2)} vs no detection ${alone.ppg.toFixed(2)}; why: ${out.whyItems?.map((d) => `${d.label}: ${d.value}`).join(" | ")}`);
  });
});
