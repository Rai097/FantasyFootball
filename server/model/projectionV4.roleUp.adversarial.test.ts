// ADVERSARIAL tests (tester, not developer) for the 2026-10-27 role-change prior (projectionV4.ts isRoleUp /
// priorWeight): thresholds, flagged-heavy samples, role drops, TD spikes, zero priors, QB, K/DEF and rookies.
// Synthetic players only (generic ids).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { V4, emptyTables, isRoleUp, priorWeight, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computePlayerSignals } from "./signals/index.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import { PPR } from "../data/fixtures/signals2026.js";
import type { Player, Position, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import type { PlayerGame, PlayerSignalInput, SkillPos } from "./signals/types.js";

const ASOF = new Date("2026-10-26T00:00:00Z");
const wk = (week: number, a: Partial<StatLine>, e: Partial<StatLine> = a, opp = { targets: 6, carries: 0, airYards: 60 }): WeekLine => ({
  season: 2026, week, team: "KC", actual: line(a), expected: line(e), opp,
});
const games = (n: number, a: Partial<StatLine>, opp?: WeekLine["opp"]) => Array.from({ length: n }, (_, i) => wk(i + 1, a, a, opp));
const L = () => league([team("a", [])], undefined, { currentWeek: 8, numTeams: 12, scoring: { ...PPR } });
function filler(pos: Position, n = 40): Player[] {
  return Array.from({ length: n }, (_, i) =>
    rawPlayer(`${pos}${i + 1}`, pos, {
      ecrPos: i + 1,
      weeks: games(6, { recYd: 120 - i * 2.5, rec: 6 - i * 0.1, rushYd: pos === "RB" ? 80 - i : 0, passYd: pos === "QB" ? 280 - i * 3 : 0 }),
      prior: { games: 16, line: line({ recYd: (120 - i * 2.5) * 16, rec: (6 - i * 0.1) * 16, passYd: pos === "QB" ? (280 - i * 3) * 16 : 0 }) },
    }),
  );
}
const POOL = [...filler("QB", 30), ...filler("RB"), ...filler("WR"), ...filler("TE", 30)];
/** A 16-game 2025 at 4 PPR pts/game (2 catches, 20 yards). */
const BACKUP_PRIOR = { games: 16, line: line({ rec: 32, recYd: 320 }) };
const item = (v: ValuedPlayer, label: string) => v.whyItems?.find((d) => d.label === label)?.value;
const one = (p: Player, tables: ProjectionTables = emptyTables()) => valuePlayers(L(), [...POOL, p], tables).players.get(p.id)!;
const priorW = (v: ValuedPlayer) => Number(item(v, "2025")!.match(/counts as ([\d.]+) games/)![1]);
const grew = (v: ValuedPlayer) => /role grew/.test(item(v, "2025") ?? "");

function input(id: string, pos: SkillPos, gs: Partial<PlayerGame>[], extra: Partial<PlayerSignalInput> = {}): PlayerSignalInput {
  return {
    id, name: id, pos, team: "KC", status: [],
    games: gs.map((g, i) => ({
      week: i + 1, gameId: `g${i + 1}`, team: "KC", targets: 7, carries: 0, airYards: 70, passAttempts: 0,
      actual: line({ rec: 5, recYd: 60 }), expected: line({ rec: 5, recYd: 60 }), ...g,
    })),
    ...extra,
  };
}
const sigTables = (...inputs: PlayerSignalInput[]): ProjectionTables => ({
  ...emptyTables(),
  signals: new Map(inputs.map((i) => [i.id, computePlayerSignals(i, { season: 2026, scoring: PPR, asOf: ASOF })])),
});

describe("role-change prior (adversarial)", () => {
  test("isRoleUp / priorWeight units: exactly 1.5× qualifies, below does not, < roleUpMinGames never; roleUp → priorK only", () => {
    // Fix round 1: the bar also needs +V4.roleUpMinGain (3) growth, so the ratio binds from an 8-ppg prior on.
    // Fix round 1: the third argument is his unflagged games' expected pts (oldest first), the last 2 must clear the bar.
    const two = (x: number) => [x, x];
    assert.equal(isRoleUp(12, 8, two(12)), true, "exactly 1.5×");
    assert.equal(isRoleUp(11.999, 8, two(12)), false);
    assert.equal(isRoleUp(100, 8, [100]), false, "one unflagged game is never a role");
    assert.equal(isRoleUp(NaN, 4, two(20)), false, "NaN usage is not a role change");
    assert.equal(isRoleUp(10, NaN, two(20)), false, "NaN prior is not a role change");
    // 6.6 × 1.5 = 9.9 in floats is 9.899999…; the boundary must hold for non-representable priors too.
    assert.equal(isRoleUp(1.5 * 6.6, 6.6, two(1.5 * 6.6)), true);
    // Absolute floor: a 4-ppg prior needs 7 (not 6); a 0-ppg prior is never a ratio jump.
    assert.equal(isRoleUp(6.5, 4, two(6.5)), false, "+2.5 is under roleUpMinGain");
    assert.equal(isRoleUp(7, 4, two(7)), true);
    assert.equal(isRoleUp(20, 0, two(20)), false, "no 2025 usage to compare");
    // Each of the last two unflagged games must clear the bar (the rate alone would).
    assert.equal(isRoleUp(12, 4, [4, 4, 4, 16]), false, "one fill-in start after backup games");
    assert.equal(isRoleUp(12, 4, [4, 16, 16]), true, "two straight starts");
    assert.equal(priorWeight(3, true), V4.priorK);
    assert.equal(priorWeight(3, false), V4.priorKSmall - 3);
    assert.equal(priorWeight(10, false), V4.priorK);
  });

  test("exactly 1.5× through valuePlayers: 12.0 vs 8.0 expected/g is a role change; 11.99 keeps the boost", () => {
    const P8 = { games: 16, line: line({ rec: 64, recYd: 640 }) };
    const at = one(rawPlayer("at", "WR", { weeks: games(3, { rec: 4, recYd: 80 }), prior: P8 }));
    assert.match(item(at, "2025")!, /counts as 2 games \(role grew: 12\.0 vs 8\.0 expected\/g\)$/);
    const under = one(rawPlayer("under", "WR", { weeks: games(3, { rec: 4, recYd: 79.9 }), prior: P8 }));
    assert.equal(grew(under), false);
    assert.equal(priorW(under), V4.priorKSmall - 3);
  });

  test("a role DROP keeps the small-sample boost (18 → 10 pts/game over 3 games: counts as 5)", () => {
    const v = one(rawPlayer("drop", "WR", { weeks: games(3, { rec: 4, recYd: 60 }), prior: { games: 16, line: line({ rec: 96, recYd: 1920 }) } }));
    assert.equal(grew(v), false);
    assert.equal(priorW(v), V4.priorKSmall - 3);
  });

  test("flagged-heavy: 1 unflagged + 5 blowout games is no role change (boost kept); 2 unflagged + 5 flagged is", () => {
    const prior = { games: 16, actual: line({ rec: 32, recYd: 320 }), expected: line({ rec: 32, recYd: 320 }) };
    const blow = { teamMargin: 35 };
    const mk = (id: string, gs: Partial<PlayerGame>[]) =>
      one(rawPlayer(id, "WR", { weeks: games(gs.length, { rec: 5, recYd: 60 }), prior: BACKUP_PRIOR }), sigTables(input(id, "WR", gs, { prior })));
    const v1 = mk("flag1", [blow, blow, blow, blow, blow, {}]);
    assert.match(item(v1, "Odd games")!, /^5 count 25%/);
    assert.equal(grew(v1), false, item(v1, "2025"));
    // sample = 1 + 0.25 × 5 = 2.25 → max(2, 8 − 2.25) = 5.75
    assert.equal(priorW(v1), 5.8);
    const v2 = mk("flag2", [blow, blow, blow, blow, blow, {}, {}]);
    assert.equal(grew(v2), true, item(v2, "2025"));
    assert.equal(priorW(v2), V4.priorK);
  });

  test("a TD spike on unchanged usage is not a role change (TD part regressed before the ratio)", () => {
    // Same 2 catches / 20 yards as the 4-ppg 2025, plus 0.6 expected receiving TDs a game: raw expected 7.6/g ≥ 6.
    const v = one(rawPlayer("tdspike", "WR", { weeks: games(3, { rec: 2, recYd: 20, recTd: 0.6 }, { targets: 3, carries: 0, airYards: 20 }), prior: BACKUP_PRIOR }));
    assert.ok(item(v, "Touchdowns"), "TD regression applied");
    assert.equal(grew(v), false, item(v, "2025"));
    assert.equal(priorW(v), V4.priorKSmall - 3);
  });

  test("backup QB turned starter (2.4 → 10 pts/game, 3 starts): role change, finite rate", () => {
    const v = one(rawPlayer("qbUp", "QB", { weeks: games(3, { passYd: 250 }, { targets: 0, carries: 0, airYards: 0 }), prior: { games: 6, line: line({ passYd: 360 }) } }));
    assert.equal(grew(v), true, item(v, "2025"));
    assert.equal(priorW(v), V4.priorK);
    assert.ok(Number.isFinite(v.ppg) && v.ppg > 0);
  });

  test("K / DEF and rookies (no prior, or a prior under priorMinGames games) never get a role change or a 2025 line", () => {
    const k = one(rawPlayer("kx", "K", { ecrPos: 3, prior: { games: 16, line: line({}) } }));
    assert.equal(item(k, "2025"), undefined);
    const rook = one(rawPlayer("rookx", "WR", { weeks: games(4, { rec: 6, recYd: 100 }) }));
    assert.equal(item(rook, "2025"), undefined);
    const short = one(rawPlayer("shortx", "WR", { weeks: games(4, { rec: 6, recYd: 100 }), prior: { games: V4.priorMinGames - 1, line: line({ rec: 3, recYd: 30 }) } }));
    assert.equal(item(short, "2025"), undefined);
  });

  test("zero prior expected pts: no division, no NaN; the model stays finite", () => {
    const v = one(rawPlayer("zeroP", "WR", { weeks: games(3, { rec: 1, recYd: 10 }), prior: { games: 10, line: line({}) } }));
    assert.ok(Number.isFinite(v.ppg) && v.ppg >= 0);
    assert.ok(!/NaN|Infinity/.test(item(v, "2025")!));
  });

  // DEFECT (low): with a 0.0 pts/game 2025 the ratio test `x ≥ 1.5 × 0` is always true, so a player with zero usage in
  // BOTH seasons is told "role grew: 0.0 vs 0.0 expected/g" (no absolute floor on the growth).
  test("DEFECT low (fixed): zero usage both seasons (10-game 0-pt 2025, three 0-pt games) must not say 'role grew: 0.0 vs 0.0'", () => {
    const v = one(rawPlayer("zeroBoth", "WR", { weeks: games(3, {}), prior: { games: 10, line: line({}) } }));
    assert.equal(grew(v), false, item(v, "2025"));
  });

  // DEFECT (medium): the design says "one fill-in start keeps the boost", but the gate counts ALL unflagged games and
  // compares the recency-weighted rate (half-life 2 games). A backup with 3 games at 4 pts/g and ONE fill-in start at
  // 16 reads 8.7 expected/g ≥ 1.5 × 4 → "role grew", prior 2 games instead of 4: model 7.1 instead of ~6.4 pts/g.
  // (1 backup game + 1 start: 11.0 vs 4.0, also "role grew".) The developer's test only covers a 1-game season.
  test("DEFECT medium (fixed): 3 backup games (4 pts/g) + one fill-in start (16) keeps the small-sample boost (counts as 4 games)", () => {
    const weeks = [1, 2, 3].map((w) => wk(w, { rec: 2, recYd: 20 })).concat([wk(4, { rec: 6, recYd: 100 })]);
    const v = one(rawPlayer("fillin", "WR", { weeks, prior: BACKUP_PRIOR }));
    assert.equal(grew(v), false, item(v, "2025"));
    assert.equal(priorW(v), V4.priorKSmall - 4);
  });
});
