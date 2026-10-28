// Projection v4 on a borrowed role (DESIGN "Fix: vacated role, spikes, depth and roster need (2026-10-28)"):
// vacated games count VACATED.weight once the teammate is back; while he stays out the full rate applies week by week.
// Synthetic players only (generic ids).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { emptyTables, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computeAllSignals } from "./signals/index.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import { PPR } from "../data/fixtures/signals2026.js";
import type { Player, Position, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import { signalInputFromPlayer } from "./projectionV4.js";
import type { PlayerSignalInput } from "./signals/types.js";

const ASOF = new Date("2026-10-26T00:00:00Z");
const L = () => league([team("a", [])], undefined, { currentWeek: 8, numTeams: 12, scoring: { ...PPR } });
const wk = (week: number, t: number): WeekLine => {
  const a: Partial<StatLine> = { rec: t * 0.65, recYd: t * 8 };
  return { season: 2026, week, team: "AAA", actual: line(a), expected: line(a), opp: { targets: t, carries: 0, airYards: t * 9 } };
};
const weeks = (ts: (number | null)[]) => ts.flatMap((t, i) => (t === null ? [] : [wk(i + 1, t)]));
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
// A TE whose targets went 2 → 9 the two weeks the team's lead WR was out (weeks 6–7).
const TE = (): Player => rawPlayer("te2", "TE", { team: "AAA", weeks: weeks([2, 2, 3, 2, 2, 9, 9]) });
const WR = (injury?: Player["injury"]): Player => rawPlayer("wr1", "WR", { team: "AAA", weeks: weeks([9, 10, 9, 8, 9, null, null]), ...(injury ? { injury } : {}) });

function value(players: Player[]): Map<string, ValuedPlayer> {
  const inputs = players.map(signalInputFromPlayer).filter((x): x is PlayerSignalInput => !!x);
  const tables: ProjectionTables = { ...emptyTables(), signals: computeAllSignals(inputs, { season: 2026, scoring: PPR, asOf: ASOF }) };
  return valuePlayers(L(), [...POOL, ...players], tables).players;
}
const item = (v: ValuedPlayer, label: string) => v.whyItems?.find((d) => d.label === label)?.value;

describe("projection v4: borrowed role", () => {
  test("teammate back (healthy): the jump games count VACATED.weight → lower rate than if nobody had been out", () => {
    const withWr = value([TE(), WR()]).get("te2")!;
    const alone = value([TE()]).get("te2")!;
    assert.ok(withWr.ppg < alone.ppg - 0.5, `${withWr.ppg} vs ${alone.ppg}`);
    assert.match(item(withWr, "Borrowed role") ?? "", /usage rose while wr1 was out \(wk 6, 7\)/);
    assert.equal(item(withWr, "While he is out"), undefined, "nobody is out now: no full-rate weeks");
  });
  test("teammate out for the season: the full rate applies to every remaining week", () => {
    const out = value([TE(), WR({ status: "IR", detail: "Knee - out for season", week: 7 })]).get("te2")!;
    const back = value([TE(), WR()]).get("te2")!;
    assert.ok(out.ppg > back.ppg + 0.5, `${out.ppg} vs ${back.ppg}`);
    assert.match(item(out, "While he is out") ?? "", /return unknown/);
    // The full-rate weeks never value him above the same player with no borrowed-role detection at all.
    const alone = value([TE()]).get("te2")!;
    assert.ok(out.ppg <= alone.ppg + 0.05, `${out.ppg} vs ${alone.ppg}`);
  });
  test("teammate out with a known return week: full rate before it, settled after", () => {
    const v = value([TE(), WR({ status: "O", detail: "Ankle", week: 8 })]).get("te2")!;
    const back = value([TE(), WR()]).get("te2")!;
    // A one-week "Out" returns next game: only the first week(s) get the factor.
    assert.ok(v.weekly![0] > back.weekly![0], "this week: full role");
    const lastIdx = v.weekly!.length - 1;
    assert.ok(Math.abs(v.weekly![lastIdx] - back.weekly![lastIdx]) < 0.11, "playoffs: settled role");
  });
});

describe("projection v4: borrowed role, fix round 1 (the role is his when the teammate is not due back)", () => {
  test("teammate out for the season → no discount: same rate as with no detection, the why says it counts in full", () => {
    const out = value([TE(), WR({ status: "IR", detail: "Knee - out for season", week: 7 })]).get("te2")!;
    const alone = value([TE()]).get("te2")!;
    assert.ok(Math.abs(out.ppg - alone.ppg) < 1e-9, `${out.ppg} vs ${alone.ppg}`);
    assert.match(item(out, "Borrowed role") ?? "", /counts in full/);
  });
  test("teammate traded away (no longer on the team) → the role is his", () => {
    const traded = rawPlayer("wr1", "WR", { team: "BBB", weeks: weeks([9, 10, 9, 8, 9, null, null]) });
    const v = value([TE(), traded]).get("te2")!;
    const alone = value([TE()]).get("te2")!;
    assert.ok(Math.abs(v.ppg - alone.ppg) < 1e-9, `${v.ppg} vs ${alone.ppg}`);
  });
});
