// DESIGN "Fix: role-change trust ramp (2026-10-30)" (projectionV4.ts makeBase, roleRunGames, roleTrustOf): on a role
// change the prior moves from last season's rate toward his current-role rate by V4.roleTrust per games in the new
// role (net games: 1 → 0.25, 2 → 0.5, 3 → 0.8, ≥ 4 → 1.0); a role vacated for the season is trusted fully; team changes keep their gate.
// Synthetic players only (generic ids).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { V4, emptyTables, roleRunGames, roleTrustOf, signalInputFromPlayer, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computeAllSignals, computePlayerSignals } from "./signals/index.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import { PPR } from "../data/fixtures/signals2026.js";
import type { Player, Position, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import type { PlayerGame, PlayerSignalInput, PlayerSignals, PriorSeason } from "./signals/types.js";

const ASOF = new Date("2026-10-26T00:00:00Z");
const L = () => league([team("a", [])], undefined, { currentWeek: 8, numTeams: 12, scoring: { ...PPR } });
const wk = (week: number, a: Partial<StatLine>, tm = "ZZZ"): WeekLine => ({
  season: 2026, week, team: tm, actual: line(a), expected: line(a), opp: { targets: 6, carries: 0, airYards: 60 },
});
function filler(pos: Position, n = 40): Player[] {
  return Array.from({ length: n }, (_, i) =>
    rawPlayer(`${pos}f${i + 1}`, pos, {
      team: "ZZZ",
      ecrPos: i + 1,
      weeks: Array.from({ length: 6 }, (_, w) => wk(w + 1, { recYd: 120 - i * 2.5, rec: 6 - i * 0.1, rushYd: pos === "RB" ? 80 - i : 0, passYd: pos === "QB" ? 280 - i * 3 : 0 })),
      prior: { games: 16, line: line({ recYd: (120 - i * 2.5) * 16, rec: (6 - i * 0.1) * 16, passYd: pos === "QB" ? (280 - i * 3) * 16 : 0 }) },
    }),
  );
}
const POOL = [...filler("QB", 30), ...filler("RB"), ...filler("WR"), ...filler("TE", 30)];
const item = (v: ValuedPlayer, label: string) => v.whyItems?.find((d) => d.label === label)?.value;
const num = (v: ValuedPlayer, label: string) => Number(item(v, label)!.match(/^[\d.]+/)![0]);
const dump = (v: ValuedPlayer) => v.whyItems?.map((d) => `${d.label}: ${d.value}`).join(" | ");

// Receiving-only, no TDs (the TD regression stays out of the arithmetic), actual = expected (finishing 1.0).
const BACKUP = { rec: 2, recYd: 20 }; // 4 pts
const STARTER = { rec: 6, recYd: 100 }; // 16 pts
const PRIOR: PriorSeason = { games: 16, expected: line({ rec: 32, recYd: 320 }), actual: line({ rec: 32, recYd: 320 }) }; // 4.0 → bar 7

function input(id: string, gs: Partial<StatLine>[], prior: PriorSeason, teams?: string[]): PlayerSignalInput {
  return {
    id, name: id, pos: "WR", team: "KC", status: [],
    games: gs.map((a, i): PlayerGame => ({
      week: i + 1, gameId: `g${i + 1}`, team: teams?.[i] ?? "KC", targets: 8, carries: 0, airYards: 80, passAttempts: 0, actual: line(a), expected: line(a),
    })),
    prior,
  };
}
function run(inputs: PlayerSignalInput[]): { players: Map<string, ValuedPlayer>; sigs: Map<string, PlayerSignals> } {
  const sigs = new Map(inputs.map((i) => [i.id, computePlayerSignals(i, { season: 2026, scoring: PPR, asOf: ASOF })]));
  const tables: ProjectionTables = { ...emptyTables(), signals: sigs };
  const players = inputs.map((i) => rawPlayer(i.id, "WR", { team: "KC", weeks: i.games.map((g) => wk(g.week, {}, g.team)) }));
  return { players: valuePlayers(L(), [...POOL, ...players], tables).players, sigs };
}
/** The model the ramp must give: current-role rate from the signals, prior moved `trust` of the way, priorK pseudo-games. */
function expected(sig: PlayerSignals, trust: number) {
  const cur = sig.rates.expPts! * (sig.efficiency?.shrunk ?? 1);
  const prior = (sig.talent.priorExpPpg! + sig.talent.priorActPpg!) / 2;
  const n = sig.weeks.filter((w) => !w.flagged).length + 0.25 * sig.weeks.filter((w) => w.flagged).length;
  const used = prior + trust * (cur - prior);
  return { cur, prior, used, model: (n * cur + V4.priorK * used) / (n + V4.priorK) };
}
const rep = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x);

describe("role-change trust ramp", () => {
  test("pure helpers: the table, ≥ 4 → 1.0, and a below-bar game inside the run counts against him", () => {
    assert.equal(roleTrustOf(2), 0.5);
    assert.equal(roleTrustOf(3), 0.8);
    assert.equal(roleTrustOf(4), 1);
    assert.equal(roleTrustOf(9), 1);
    assert.equal(roleTrustOf(1), 0.25);
    assert.equal(roleTrustOf(0), 0);
    assert.equal(roleRunGames(4, [4, 4, 16, 16]), 2);
    assert.equal(roleRunGames(4, [4, 16, 4, 16, 16]), 2, "3 at the bar − 1 low-usage dud inside the run = 2 net");
    assert.equal(roleRunGames(4, [16, 4, 4, 16, 16]), 1, "two duds inside the run cost two games");
    assert.equal(roleRunGames(4, [16, 4, 4, 4, 16]), 0, "net never below 0");
    // The bar is on usage (expected points): a game with big usage and few points is at the bar and counts for him.
    assert.equal(roleRunGames(4, [7, 7]), 2, "exactly at the bar counts");
    assert.equal(roleRunGames(0, [16, 16]), 0);
  });

  test("2 / 3 / 4 / 5 games in the new role → prior moves 50% / 80% / 100% / 100% toward the current-role rate", () => {
    const { players, sigs } = run([
      input("r2", [...rep(3, BACKUP), ...rep(2, STARTER)], PRIOR),
      input("r3", [...rep(3, BACKUP), ...rep(3, STARTER)], PRIOR),
      input("r4", [...rep(2, BACKUP), ...rep(4, STARTER)], PRIOR),
      input("r5", [BACKUP, ...rep(5, STARTER)], PRIOR),
    ]);
    for (const [id, n, trust] of [["r2", 2, 0.5], ["r3", 3, 0.8], ["r4", 4, 1], ["r5", 5, 1]] as const) {
      const v = players.get(id)!;
      assert.match(item(v, "2025") ?? "", /role grew/, `${id}: ${dump(v)}`);
      const e = expected(sigs.get(id)!, trust);
      assert.ok(Math.abs(num(v, "Our model") - e.model) <= 0.05, `${id}: model ${item(v, "Our model")} vs ${e.model.toFixed(2)}`);
      assert.ok(Math.abs(num(v, "2025 at new role") - e.used) <= 0.05, `${id}: ${item(v, "2025 at new role")} vs ${e.used.toFixed(2)}`);
      const b = item(v, "2025 at new role")!;
      if (trust < 1) assert.match(b, new RegExp(`^[\\d.]+ pts/game: ${trust * 100}% toward this year's role \\(${n} games in it\\)$`));
      else assert.match(b, /^[\d.]+ pts\/game: counted at this year's role and finishing$/);
      assert.ok(`2025 at new role: ${b}`.length <= 90, b);
      if (trust < 1) assert.ok(e.model < e.cur - 0.3 && e.model > e.prior, `${id}: between prior and current role`);
    }
    // More evidence never lowers the trust-driven rate gap: the 2-game prior sits below the 3-game prior's share.
    const e2 = expected(sigs.get("r2")!, 0.5), e3 = expected(sigs.get("r3")!, 0.8);
    assert.ok((e2.used - e2.prior) / (e2.cur - e2.prior) < (e3.used - e3.prior) / (e3.cur - e3.prior));
  });

  test("a low-usage game inside the run counts against him (3 at the bar − 1 dud = 2 → 50%)", () => {
    const { players, sigs } = run([input("dud", [BACKUP, BACKUP, STARTER, BACKUP, STARTER, STARTER], PRIOR)]);
    const v = players.get("dud")!;
    assert.match(item(v, "2025 at new role") ?? "", /50% toward this year's role \(2 games in it\)$/, dump(v));
    const e = expected(sigs.get("dud")!, 0.5);
    assert.ok(Math.abs(num(v, "Our model") - e.model) <= 0.05, `model ${item(v, "Our model")} vs ${e.model.toFixed(2)}`);
  });

  test("no role change: raw prior with the small-sample weight, unchanged", () => {
    const steady: PriorSeason = { games: 16, expected: line({ rec: 96, recYd: 1920 }), actual: line({ rec: 96, recYd: 1920 }) }; // 18
    const { players } = run([input("held", rep(3, { rec: 7, recYd: 100 }), steady)]);
    const v = players.get("held")!;
    assert.equal(item(v, "2025 at new role"), undefined);
    assert.ok(Math.abs(num(v, "Our model") - (3 * 17 + 5 * 18) / 8) <= 0.15, item(v, "Our model"));
  });

  test("team changer with ≥ lateGames games on the new team: neutral (trust 1.0) even with only 2 games above the bar", () => {
    const moved: PriorSeason = { ...PRIOR, lastTeam: "BUF" };
    const { players, sigs } = run([input("tc", [...rep(2, BACKUP), ...rep(2, STARTER)], moved)]);
    const v = players.get("tc")!;
    const e = expected(sigs.get("tc")!, 1);
    assert.ok(Math.abs(num(v, "Our model") - e.cur) <= 0.05, `model ${item(v, "Our model")} vs ${e.cur.toFixed(2)}: ${dump(v)}`);
    assert.match(item(v, "2025 at new role") ?? "", /counted at this year's role and finishing$/, dump(v));
  });

  test("team changer under lateGames games and no role change keeps the raw-prior blend (unchanged)", () => {
    const moved: PriorSeason = { games: 16, expected: line({ rec: 96, recYd: 1920 }), actual: line({ rec: 96, recYd: 1920 }), lastTeam: "BUF" };
    const { players } = run([input("tc3", rep(3, { rec: 7, recYd: 100 }), moved)]);
    const v = players.get("tc3")!;
    assert.equal(item(v, "2025 at new role"), undefined);
    assert.equal(item(v, "2025 on another team"), undefined);
    assert.ok(Math.abs(num(v, "Our model") - (3 * 17 + 5 * 18) / 8) <= 0.15, item(v, "Our model"));
  });
});

describe("role-change trust ramp: known cause (role vacated for the season) → full trust", () => {
  const vwk = (week: number, t: number): WeekLine => {
    const a: Partial<StatLine> = { rec: t * 0.65, recYd: t * 8 };
    return { season: 2026, week, team: "AAA", actual: line(a), expected: line(a), opp: { targets: t, carries: 0, airYards: t * 9 } };
  };
  const weeks = (ts: (number | null)[]) => ts.flatMap((t, i) => (t === null ? [] : [vwk(i + 1, t)]));
  // 2025: 16 games at 2 targets/game (2.9 pts/game). 2026: targets jump to 9 the two weeks the lead WR was out.
  const tePrior = { games: 16, line: line({ rec: 16 * 1.3, recYd: 16 * 16 }) };
  const TE = (): Player => rawPlayer("te2", "TE", { team: "AAA", weeks: weeks([2, 2, 3, 2, 2, 9, 9]), prior: tePrior });
  const WR = (injury?: Player["injury"]): Player => rawPlayer("wr1", "WR", { team: "AAA", weeks: weeks([9, 10, 9, 8, 9, null, null]), ...(injury ? { injury } : {}) });
  function value(players: Player[]): Map<string, ValuedPlayer> {
    const inputs = players.map(signalInputFromPlayer).filter((x): x is PlayerSignalInput => !!x);
    const tables: ProjectionTables = { ...emptyTables(), signals: computeAllSignals(inputs, { season: 2026, scoring: PPR, asOf: ASOF }) };
    return valuePlayers(L(), [...POOL, ...players], tables).players;
  }

  test("teammate out for the season: 2 games in the role already count in full; the same games without a cause ramp at 50%", () => {
    const out = value([TE(), WR({ status: "IR", detail: "Knee - out for season", week: 7 })]).get("te2")!;
    const alone = value([TE()]).get("te2")!;
    assert.match(item(out, "2025") ?? "", /role grew/, dump(out));
    assert.match(item(out, "2025 at new role") ?? "", /^[\d.]+ pts\/game: full trust \(role vacated for the season\)$/, dump(out));
    assert.match(item(alone, "2025 at new role") ?? "", /50% toward this year's role \(2 games in it\)$/, dump(alone));
    // Full trust: the prior enters at his current-role rate, so the model is that rate (the alone model sits below it).
    assert.ok(Math.abs(num(out, "2025 at new role") - num(out, "Our model")) <= 0.05, dump(out));
    assert.ok(num(alone, "Our model") < num(out, "Our model") - 0.3, `${item(alone, "Our model")} vs ${item(out, "Our model")}`);
    assert.ok(`2025 at new role: ${item(out, "2025 at new role")}`.length <= 90);
  });

  test("teammate due back (healthy): borrowed role, no known cause → no full trust", () => {
    const back = value([TE(), WR()]).get("te2")!;
    assert.doesNotMatch(item(back, "2025 at new role") ?? "", /full trust/, dump(back));
  });
});
