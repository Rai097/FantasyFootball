// Fix 2026-10-30 (DESIGN "Fix: team-change prior and TD baseline"): a player whose latest 2025 team is not his current
// team gets a neutral prior (as on a role change), and last season's own TD rate is the TD baseline only from the same
// team and ≥ V4.tdPriorMinGames games; else the position's baseline. Unknown 2025 team = not changed.
// Synthetic players only (generic ids and teams).
import { test } from "node:test";
import assert from "node:assert/strict";
import { V4, emptyTables, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computePlayerSignals } from "./signals/index.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import { PPR } from "../data/fixtures/signals2026.js";
import type { Player, Position, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import type { PlayerGame, PlayerSignalInput, PriorSeason } from "./signals/types.js";

const ASOF = new Date("2026-10-26T00:00:00Z");
const CUR = "KC"; // testkit players' current team
const wk = (week: number, a: Partial<StatLine>): WeekLine => ({
  season: 2026, week, team: CUR, actual: line(a), expected: line(a), opp: { targets: 6, carries: 0, airYards: 60 },
});
const L = () => league([team("a", [])], undefined, { currentWeek: 8, numTeams: 12, scoring: { ...PPR } });
function filler(pos: Position, n = 40): Player[] {
  return Array.from({ length: n }, (_, i) =>
    rawPlayer(`${pos}${i + 1}`, pos, {
      ecrPos: i + 1,
      weeks: Array.from({ length: 6 }, (_, w) => wk(w + 1, { recYd: 120 - i * 2.5, rec: 6 - i * 0.1, recTd: w % 3 === 0 ? 1 : 0, passYd: pos === "QB" ? 280 - i * 3 : 0 })),
      prior: { games: 16, line: line({ recYd: (120 - i * 2.5) * 16, rec: (6 - i * 0.1) * 16, passYd: pos === "QB" ? (280 - i * 3) * 16 : 0 }) },
    }),
  );
}
const POOL = [...filler("QB", 30), ...filler("RB"), ...filler("WR"), ...filler("TE", 30)];
const item = (v: ValuedPlayer, label: string) => v.whyItems?.find((d) => d.label === label)?.value;
const num = (v: ValuedPlayer, label: string) => Number(item(v, label)!.match(/^[\d.]+/)![0]);
const priorW = (v: ValuedPlayer) => Number(item(v, "2025")!.match(/counts as ([\d.]+) games/)![1]);
const grew = (v: ValuedPlayer) => /role grew/.test(item(v, "2025") ?? "");
const finishing = (v: ValuedPlayer) => Number(item(v, "Finishing")?.match(/×([\d.]+)/)?.[1] ?? 1);
const repeat = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x);
/** Points the TD regression adds (receiving TDs, 6 pts in PPR) from the "Touchdowns" line; 0 without one. */
const tdAdd = (v: ValuedPlayer) => {
  const m = item(v, "Touchdowns")?.match(/^([\d.]+) expected\/g regressed to ([\d.]+)/);
  return m ? PPR.recTd * (Number(m[2]) - Number(m[1])) : 0;
};

function input(id: string, gs: { a: Partial<StatLine>; e: Partial<StatLine> }[], prior: PriorSeason): PlayerSignalInput {
  return {
    id, name: id, pos: "WR", team: CUR, status: [],
    games: gs.map((g, i): PlayerGame => ({
      week: i + 1, gameId: `g${i + 1}`, team: CUR, targets: 8, carries: 0, airYards: 80, passAttempts: 0, actual: line(g.a), expected: line(g.e),
    })),
    prior,
  };
}
function run(inputs: PlayerSignalInput[]): Map<string, ValuedPlayer> {
  const tables: ProjectionTables = {
    ...emptyTables(),
    signals: new Map(inputs.map((i) => [i.id, computePlayerSignals(i, { season: 2026, scoring: PPR, asOf: ASOF })])),
  };
  const players = inputs.map((i) => rawPlayer(i.id, "WR", { weeks: i.games.map((g) => wk(g.week, {})) }));
  return valuePlayers(L(), [...POOL, ...players], tables).players;
}

// 2025: 10.0 expected and actual pts/game (receiving only, no TDs: the TD regression stays out of the arithmetic).
const tenPpg = (games: number, lastTeam?: string): PriorSeason => ({
  games, expected: line({ rec: 4 * games, recYd: 60 * games }), actual: line({ rec: 4 * games, recYd: 60 * games }),
  opps: { passAtt: 0, carries: 0, targets: 7 * games }, ...(lastTeam !== undefined ? { lastTeam } : {}),
});
// 2026: 14 expected / 14 actual pts/game: 1.4× and +4 — just under the role-change bar max(1.5 × 10, 10 + 3) = 15.
const jump = (n: number) => repeat(n, { a: { rec: 6, recYd: 80 }, e: { rec: 6, recYd: 80 } });

test("team changer with a just-under-bar jump over lateGames games: prior neutral, rate = his current-role rate", () => {
  assert.equal(V4.lateGames, 4);
  const out = run([input("moved", jump(4), tenPpg(16, "BUF")), input("stayed", jump(4), tenPpg(16, CUR))]);
  const moved = out.get("moved")!;
  const stayed = out.get("stayed")!;
  assert.equal(grew(moved), false, "not a role change: the jump is under the bar");
  assert.equal(priorW(moved), V4.priorK, item(moved, "2025"));
  // Old-team TD rate is not his baseline: the position's (filler WRs score TDs, so his 0 expected TDs regress up).
  const cur = (14 + tdAdd(moved)) * finishing(moved);
  assert.ok(Math.abs(num(moved, "Our model") - cur) <= 0.1, `model ${item(moved, "Our model")} = current-role rate ${cur.toFixed(2)}`);
  const line25 = item(moved, "2025 on another team")!;
  assert.match(line25, /^BUF in 2025: counted at this year's role, [\d.]+ pts\/game$/);
  assert.ok(`2025 on another team: ${line25}`.length <= 90);
  assert.equal(item(moved, "2025 at new role"), undefined);
  // Same jump on the same team: the small-sample prior still pulls (8 − 4 = 4 pseudo-games at 10.0).
  assert.equal(priorW(stayed), V4.priorKSmall - 4);
  assert.equal(item(stayed, "2025 on another team"), undefined);
  assert.ok(num(moved, "Our model") - num(stayed, "Our model") >= 1.5, `moved ${item(moved, "Our model")} vs stayed ${item(stayed, "Our model")}`);
});

test("no team data for the prior (or same team): current behaviour — unknown is never a team change", () => {
  const out = run([input("unknown", jump(3), tenPpg(16)), input("same", jump(3), tenPpg(16, CUR)), input("steady", repeat(3, { a: { rec: 4, recYd: 60 }, e: { rec: 4, recYd: 60 } }), tenPpg(16, CUR))]);
  const unknown = out.get("unknown")!;
  const same = out.get("same")!;
  assert.equal(item(unknown, "Our model"), item(same, "Our model"));
  assert.equal(priorW(unknown), V4.priorKSmall - 3);
  assert.equal(item(unknown, "2025 on another team"), undefined);
  // Same-team steady player, small sample: plain blend with priorKSmall, model = 10.
  const steady = out.get("steady")!;
  assert.equal(priorW(steady), V4.priorKSmall - 3);
  assert.ok(Math.abs(num(steady, "Our model") - 10) <= 0.1, item(steady, "Our model"));
});

/** 6 games with 0.5 expected and actual receiving TDs per game; 2025 TD rate 1 per 7 targets (16 or 4 games). */
function tdCase(id: string, games: number, lastTeam?: string): PlayerSignalInput {
  const prior: PriorSeason = { ...tenPpg(games, lastTeam), actual: line({ rec: 4 * games, recYd: 60 * games, recTd: games }) };
  return input(id, repeat(6, { a: { rec: 6, recYd: 80, recTd: 0.5 }, e: { rec: 6, recYd: 80, recTd: 0.5 } }), prior);
}
const tdSource = (v: ValuedPlayer) => item(v, "Touchdowns")?.match(/\((last season|WR average) /)?.[1];

test("TD baseline: own 2025 rate only from the same team and ≥ tdPriorMinGames games; else the position's", () => {
  assert.equal(V4.tdPriorMinGames, 8);
  const out = run([tdCase("oldTeam", 16, "BUF"), tdCase("sameFull", 16, CUR), tdCase("sameShort", 4, CUR), tdCase("unknownFull", 16)]);
  assert.equal(tdSource(out.get("oldTeam")!), "WR average", item(out.get("oldTeam")!, "Touchdowns"));
  assert.equal(tdSource(out.get("sameFull")!), "last season", item(out.get("sameFull")!, "Touchdowns"));
  assert.equal(tdSource(out.get("sameShort")!), "WR average", item(out.get("sameShort")!, "Touchdowns"));
  assert.equal(tdSource(out.get("unknownFull")!), "last season", item(out.get("unknownFull")!, "Touchdowns"));
  // Same-team full prior: baseline = 2025's 1 TD per 7 targets × his 8 targets/g ≈ 1.14/g (unchanged rule).
  const base = Number(item(out.get("sameFull")!, "Touchdowns")!.match(/last season ([\d.]+)\)/)![1]);
  assert.ok(Math.abs(base - 8 / 7) <= 0.01, `baseline ${base}`);
  // The position's baseline differs from his own (filler WRs: 1 TD per 18 targets), so the swap is visible.
  const posBase = Number(item(out.get("oldTeam")!, "Touchdowns")!.match(/WR average ([\d.]+)\)/)![1]);
  assert.ok(posBase < base - 0.3, `position ${posBase} vs own ${base}`);
});

test("team change under lateGames unflagged games on the new team (1 or 3): the plain prior blend stays", () => {
  const out = run([input("one", jump(1), tenPpg(16, "BUF")), input("three", jump(3), tenPpg(16, "BUF")), input("oneSame", jump(1), tenPpg(16, CUR))]);
  assert.equal(priorW(out.get("oneSame")!), V4.priorKSmall - 1);
  for (const [id, n] of [["one", 1], ["three", 3]] as const) {
    const v = out.get(id)!;
    assert.equal(priorW(v), V4.priorKSmall - n, item(v, "2025"));
    assert.equal(item(v, "2025 on another team"), undefined);
    // Plain blend: (n × current rate + (8 − n) × 10.0) / 8; the current rate carries the position TD baseline.
    const cur = (14 + tdAdd(v)) * finishing(v);
    const want = (n * cur + (V4.priorKSmall - n) * 10) / V4.priorKSmall;
    assert.ok(Math.abs(num(v, "Our model") - want) <= 0.1, `${id}: ${item(v, "Our model")} vs ${want.toFixed(2)}`);
  }
});

test("team changer under priorMinGames sample games: TD regression toward the position baseline (not skipped)", () => {
  const full = tdCase("short", 16, "BUF");
  const v = run([{ ...full, games: full.games.slice(0, 3) }]).get("short")!;
  assert.equal(tdSource(v), "WR average", item(v, "Touchdowns"));
  // 3 games is under lateGames for the team change, but at 17 expected/g this jump clears the role-change bar.
  assert.equal(item(v, "2025 on another team"), undefined);
  assert.ok(item(v, "2025 at new role"), item(v, "2025"));
});
