// Projection v4 with a starter out since before the season (DESIGN "Fix: returning starters and season-ending injuries
// (2026-10-31)"): the fill-in's lead role ends when the starter returns; the starter's own tear on PUP is not
// season-ending. Synthetic players only (generic ids).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { emptyTables, signalInputFromPlayer, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computeAllSignals } from "./signals/index.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import { PPR } from "../data/fixtures/signals2026.js";
import type { Player, Position, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import type { PlayerSignalInput, PriorSeason, RosterInfo, StatusWeek } from "./signals/types.js";

const ASOF = new Date("2026-10-26T00:00:00Z");
const L = () => league([team("a", [])], undefined, { currentWeek: 8, numTeams: 12, scoring: { ...PPR } });
const rbLine = (c: number): StatLine => line({ rushYd: c * 4.4, rushTd: c * 0.03 });
const wk = (week: number, c: number): WeekLine => ({ season: 2026, week, team: "AAA", actual: rbLine(c), expected: rbLine(c), opp: { targets: 0, carries: c, airYards: 0 } });
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
const prior = (perGame: number, lastTeam: string): PriorSeason => ({
  games: 16,
  actual: rbLine(perGame * 16),
  expected: rbLine(perGame * 16),
  opps: { passAtt: 0, carries: perGame * 16, targets: 0 },
  lastTeam,
});

// The fill-in: a 6-carry backup last season elsewhere; 3 carries in week 1, then the lead role.
const FILL = (): Player => rawPlayer("rb2", "RB", { team: "AAA", weeks: [3, 20, 8, 22, 21, 18, 22].map((c, i) => wk(i + 1, c)) });
// The starter: no game this season, a 14-carry role on this team last season, on the injury report weeks 5–7.
const START = (extra: Partial<Player> = {}): Player => rawPlayer("rb1", "RB", { team: "AAA", ...extra });
const LISTED: StatusWeek[] = [5, 6, 7].map((week) => ({ week, report: "Out", practice: "Limited Participation in Practice" }));

interface StarterSetup {
  player?: Partial<Player>;
  status?: StatusWeek[];
  roster?: RosterInfo;
}
function value(starter: StarterSetup | null): Map<string, ValuedPlayer> {
  const players = [FILL(), ...(starter ? [START(starter.player)] : [])];
  const inputs = players
    .map((p): PlayerSignalInput | null => {
      const x = signalInputFromPlayer(p);
      if (!x) return null;
      if (p.id === "rb2") return { ...x, prior: prior(6, "BBB") };
      return { ...x, prior: prior(14, "AAA"), status: starter?.status ?? LISTED, ...(starter?.roster ? { roster: starter.roster } : {}) };
    })
    .filter((x): x is PlayerSignalInput => !!x);
  const tables: ProjectionTables = { ...emptyTables(), signals: computeAllSignals(inputs, { season: 2026, scoring: PPR, asOf: ASOF }) };
  return valuePlayers(L(), [...POOL, ...players], tables).players;
}
const item = (v: ValuedPlayer, label: string) => v.whyItems?.find((d) => d.label === label)?.value;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Playoff weeks 15–17 of a weekly array that starts at week 8. */
const playoffs = (v: ValuedPlayer) => sum(v.weekly!.slice(15 - 8, 18 - 8));

describe("projection v4: a starter out since before the season returns", () => {
  test("starter back (activated): the fill-in's lead-role games count 40% → his rate falls toward his old role", () => {
    const back = value({ player: { injury: { status: "Q", week: 8 } }, roster: { status: "ACT" } }).get("rb2")!;
    const alone = value(null).get("rb2")!;
    assert.ok(back.ppg < alone.ppg - 1, `${back.ppg} vs no starter ${alone.ppg}`);
    assert.match(item(back, "Borrowed role") ?? "", /usage rose while rb1 was out \(wk 2, 4, 5, 6, 7\): counts 40%/);
    assert.ok(playoffs(back) < playoffs(alone) - 3, `playoffs ${playoffs(back)} vs ${playoffs(alone)}`);
  });
  test("starter due back (return week known): the fill-in keeps the lead role until then, his playoff weeks drop", () => {
    // Ruled out this week, practising limited → back the game after next (wk 9).
    const due = value({ player: { injury: { status: "O", week: 8 } }, status: [...LISTED, { week: 8, report: "Out", practice: "Limited Participation in Practice" }] });
    const v = due.get("rb2")!;
    assert.equal(due.get("rb1")!.ret?.week, 9);
    const back = value({ player: { injury: { status: "Q", week: 8 } }, roster: { status: "ACT" } }).get("rb2")!;
    const alone = value(null).get("rb2")!;
    assert.ok(v.weekly![0] > back.weekly![0] + 0.5, `wk 8 lead role: ${v.weekly![0]} vs ${back.weekly![0]}`);
    assert.ok(Math.abs(playoffs(v) - playoffs(back)) < 0.35, `playoffs settled: ${playoffs(v)} vs ${playoffs(back)}`);
    assert.ok(playoffs(v) < playoffs(alone) - 3, `playoffs below the no-starter case: ${playoffs(v)} vs ${playoffs(alone)}`);
    assert.match(item(v, "While he is out") ?? "", /rb1 back wk 9/);
  });
  test("starter out for the season (IR + ACL): the role is the fill-in's, same as with no starter", () => {
    const over = value({ player: { sleeperInjury: { status: "IR", bodyPart: "Knee - ACL", rosterStatus: "Inactive" } }, roster: { status: "RES" } });
    assert.equal(over.get("rb1")!.ret?.seasonOver, true);
    const v = over.get("rb2")!;
    const alone = value(null).get("rb2")!;
    assert.ok(Math.abs(v.ppg - alone.ppg) < 0.05, `${v.ppg} vs ${alone.ppg}`);
    assert.match(item(v, "Borrowed role") ?? "", /counts in full/);
  });
  test("the returning starter is not out for the season: an ACL on PUP (hurt before the season) stays a return", () => {
    const pup = value({ player: { sleeperInjury: { status: "PUP", bodyPart: "Knee - ACL", rosterStatus: "Inactive" } }, roster: { status: "RES", statusCode: "R04" } });
    const s = pup.get("rb1")!;
    assert.notEqual(s.ret?.seasonOver, true, "PUP + ACL is not season-ending");
    assert.ok(s.ret, "absent: a return estimate");
    assert.ok((s.ret!.healthyRate ?? 0) > 0, "his 2025 role is known");
  });
  test("an activated starter is valued on his 2025 role (never 0) and his games are not borrowed by anyone", () => {
    const m = value({ player: { injury: { status: "Q", week: 8 } }, roster: { status: "ACT" } });
    const s = m.get("rb1")!;
    assert.ok(s.ppg > 5, `starter ${s.ppg}`);
    assert.equal(item(s, "Borrowed role"), undefined);
  });
});
