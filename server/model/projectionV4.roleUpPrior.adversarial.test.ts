// ADVERSARIAL tests (tester, not developer) for DESIGN "Fix: role-change prior at current volume (2026-10-30)"
// (projectionV4.ts roleUpPrior / makeBase): on a role change last season's prior enters at this season's usage ×
// last season's points per expected point, clamped to V4.roleUpPriorEffClamp. Probes: the clamp against the model's own
// per-position finishing caps (EFF_CAPS), short (injury-shortened) priors, vacated-only growth, borrowed role + role
// change (modelFull), flagged games, the actual-points fallback, a sub-priorMinGames prior, TD-heavy runs, QB / TE paths
// and the why-bullet. Synthetic players only (generic ids); the QB numbers mirror a real 2026 row (see the test).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { V4, emptyTables, signalInputFromPlayer, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computeAllSignals, computePlayerSignals } from "./signals/index.js";
import { EFF_CAPS } from "./signals/efficiency.js";
import { VACATED } from "./signals/vacated.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import { PPR } from "../data/fixtures/signals2026.js";
import type { Player, Position, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import type { PlayerGame, PlayerSignalInput, PriorSeason, SkillPos } from "./signals/types.js";

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
const priorW = (v: ValuedPlayer) => Number(item(v, "2025")!.match(/counts as ([\d.]+) games/)![1]);
const grew = (v: ValuedPlayer) => /role grew/.test(item(v, "2025") ?? "");
/** The TD-regressed usage the role-change check used ("role grew: X vs Y expected/g" → X). */
const usageOf = (v: ValuedPlayer) => Number(item(v, "2025")!.match(/role grew: ([\d.]+) vs/)![1]);
const dump = (v: ValuedPlayer) => v.whyItems?.map((d) => `${d.label}: ${d.value}`).join(" | ");

type G = { a: Partial<StatLine>; e?: Partial<StatLine>; targets?: number; carries?: number; passAttempts?: number; teamMargin?: number };
function input(id: string, pos: SkillPos, gs: G[], prior: PriorSeason | undefined): PlayerSignalInput {
  return {
    id, name: id, pos, team: "KC", status: [],
    games: gs.map((g, i): PlayerGame => ({
      week: i + 1, gameId: `g${i + 1}`, team: "KC", targets: g.targets ?? 8, carries: g.carries ?? 0, airYards: 80, passAttempts: g.passAttempts ?? 0,
      actual: line(g.a), expected: line(g.e ?? g.a), ...(g.teamMargin !== undefined ? { teamMargin: g.teamMargin } : {}),
    })),
    ...(prior ? { prior } : {}),
  };
}
/** Value synthetic signal inputs next to the filler pool (signals per player, no vacated stamping). */
function run(inputs: PlayerSignalInput[]): Map<string, ValuedPlayer> {
  const tables: ProjectionTables = {
    ...emptyTables(),
    signals: new Map(inputs.map((i) => [i.id, computePlayerSignals(i, { season: 2026, scoring: PPR, asOf: ASOF })])),
  };
  const players = inputs.map((i) => rawPlayer(i.id, i.pos, { team: "KC", weeks: i.games.map((g) => wk(g.week, {}, "KC")) }));
  return valuePlayers(L(), [...POOL, ...players], tables).players;
}
const repeat = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x);

describe("role-change prior at current volume (adversarial)", () => {
  // ------------------------------------------------------------------ the clamp vs the model's finishing caps
  // Real 2026 row (cache 2026-10-30, every isRoleUp player scanned): a QB with a 4-game 2025 at 8.2 expected / 12.8
  // actual pts/game (prior 10.5, 1.28 points per expected point) and 17.2 expected pts/game now (finishing ×1.04)
  // enters at 17.2 × 1.28 = 22.1 — above anything this season's QB finishing can reach (cap 1.2 → 20.6). Another QB
  // with a 4-game 2025 (5.8 exp / 3.7 act → 0.82) enters below the QB floor 0.85. The prior efficiency is not shrunk by
  // its sample (4 games count like 16) and the clamp [0.7, 1.3] is looser than EFF_CAPS for QB (and WR on the low side).
  test("QB with a lucky 4-game 2025: the prior at the new role stays within the QB finishing cap (EFF_CAPS.QB)", () => {
    // 2025: 4 games, 205 pass yd expected (8.2) vs 320 actual (12.8) → prior 10.5, ratio 1.28.
    const prior: PriorSeason = { games: 4, expected: line({ passYd: 205 * 4 }), actual: line({ passYd: 320 * 4 }) };
    // 2026: 6 games at 17.2 expected (300 pass yd + 52 rush yd), finishing ≈ ×1.04.
    const g: G = { e: { passYd: 300, rushYd: 52 }, a: { passYd: 312, rushYd: 54 }, targets: 0, carries: 6 };
    const v = run([input("qbx", "QB", repeat(6, g), prior)]).get("qbx")!;
    assert.ok(grew(v), dump(v));
    const usage = usageOf(v);
    const used = num(v, "2025 at new role");
    const [, hi] = EFF_CAPS.QB;
    const bad: string[] = [];
    if (used > usage * hi + 0.05)
      bad.push(`QB prior at the new role ${used} = ${(used / usage).toFixed(2)} pts per expected point on ${usage} usage; QB finishing cap is ${hi} (max ${(usage * hi).toFixed(1)})`);
    // ...and the model is not lifted above his current-role rate (usage × this season's finishing) by last season's 4 games.
    const cur = usage * Number(item(v, "Finishing")!.match(/×([\d.]+)/)![1]);
    if (num(v, "Our model") > cur + 0.5) bad.push(`model ${num(v, "Our model")} vs current-role rate ${cur.toFixed(2)} (+0.5 allowed)`);
    assert.deepEqual(bad, [], dump(v));
  });

  test("QB with an unlucky 4-game 2025 / WR with a very poor 2025: the prior's efficiency is not below the position floor", () => {
    // QB: 5.8 expected (145 pass yd) vs 3.7 actual (92.5) → ratio 0.82 < EFF_CAPS.QB[0] 0.85.
    const qPrior: PriorSeason = { games: 4, expected: line({ passYd: 145 * 4 }), actual: line({ passYd: 92.5 * 4 }) };
    const qGame: G = { e: { passYd: 270, rushYd: 20 }, a: { passYd: 270, rushYd: 20 }, targets: 0, carries: 3 }; // 12.8
    // WR: 4.0 expected vs 0.8 actual → prior 2.4, ratio 0.6 → clamp 0.7 < EFF_CAPS.WR[0] 0.8.
    const wPrior: PriorSeason = { games: 16, expected: line({ rec: 32, recYd: 320 }), actual: line({ rec: 8, recYd: 48 }) };
    const wGame: G = { a: { rec: 6, recYd: 100 } }; // 16.0
    const out = run([input("qby", "QB", repeat(5, qGame), qPrior), input("wry", "WR", repeat(5, wGame), wPrior)]);
    const bad: string[] = [];
    for (const [id, pos] of [["qby", "QB"], ["wry", "WR"]] as const) {
      const v = out.get(id)!;
      assert.ok(grew(v), `${id}: ${dump(v)}`);
      const ratio = num(v, "2025 at new role") / usageOf(v);
      if (ratio < EFF_CAPS[pos][0] - 0.01) bad.push(`${id}: prior enters at ${ratio.toFixed(2)} pts per expected point, ${pos} finishing floor ${EFF_CAPS[pos][0]}`);
    }
    assert.deepEqual(bad, []);
  });

  // ------------------------------------------------------------------ probes expected to hold
  test("role grew only in borrowed (vacated) games while the teammate is back: no role change, raw prior, no new-role bullet", () => {
    // Pass catchers on one team: the starter WR plays wk 1–6 but leaves early (< 15% snaps) in wk 5–6; the backup has
    // 2 targets wk 1–4 and 10 in wk 5–6 (borrowed). The starter is still playing → the borrowed role is temporary.
    const rec = (week: number, t: number, tm = "AAA"): WeekLine => ({
      season: 2026, week, team: tm, actual: line({ rec: t * 0.7, recYd: t * 8 }), expected: line({ rec: t * 0.7, recYd: t * 8 }), opp: { targets: t, carries: 0, airYards: t * 8 },
    });
    const prior = { games: 16, line: line({ rec: 16 * 1.4, recYd: 16 * 16 }) }; // 3.0 pts/game backup
    const backup = rawPlayer("bk", "WR", { team: "AAA", weeks: [1, 2, 3, 4].map((w) => rec(w, 2)).concat([rec(5, 10), rec(6, 10)]), prior });
    const starter = rawPlayer("st", "WR", {
      team: "AAA",
      weeks: [1, 2, 3, 4, 5, 6].map((w) => rec(w, w >= 5 ? 0 : 9)),
      snapShare: { 1: 0.9, 2: 0.9, 3: 0.9, 4: 0.9, 5: 0.05, 6: 0.05 },
    });
    const players = [backup, starter];
    const inputs = players.map(signalInputFromPlayer).filter((x): x is PlayerSignalInput => !!x);
    const tables: ProjectionTables = { ...emptyTables(), signals: computeAllSignals(inputs, { season: 2026, scoring: PPR, asOf: ASOF }) };
    const sig = tables.signals.get("bk")!;
    assert.deepEqual(sig.vacated?.weeks, [5, 6], "fixture: wk 5–6 are borrowed");
    const v = valuePlayers(L(), [...POOL, ...players], tables).players.get("bk")!;
    assert.equal(grew(v), false, dump(v));
    assert.equal(item(v, "2025 at new role"), undefined, dump(v));
  });

  test("borrowed role + a real role change: model and full-rate model share one prior; full ≥ settled, factor ≤ maxFactor", () => {
    // TE backup (2025: 3.0 pts/game) became a starter wk 1–4 (12 targets), then wk 5–6 the WR1 left early and he got
    // 16 targets (borrowed on top of his new role). Last 2 non-borrowed unflagged games (wk 3–4) clear the bar.
    const rec = (week: number, t: number, tm = "AAA"): WeekLine => ({
      season: 2026, week, team: tm, actual: line({ rec: t * 0.7, recYd: t * 8 }), expected: line({ rec: t * 0.7, recYd: t * 8 }), opp: { targets: t, carries: 0, airYards: t * 8 },
    });
    const prior = { games: 16, line: line({ rec: 16 * 1.4, recYd: 16 * 16 }) };
    const te = rawPlayer("te", "TE", { team: "AAA", weeks: [1, 2, 3, 4].map((w) => rec(w, 6)).concat([rec(5, 14), rec(6, 14)]), prior });
    const wr1 = rawPlayer("w1", "WR", {
      team: "AAA",
      weeks: [1, 2, 3, 4, 5, 6].map((w) => rec(w, w >= 5 ? 0 : 12)),
      snapShare: { 1: 0.9, 2: 0.9, 3: 0.9, 4: 0.9, 5: 0.05, 6: 0.05 },
    });
    const players = [te, wr1];
    const inputs = players.map(signalInputFromPlayer).filter((x): x is PlayerSignalInput => !!x);
    const tables: ProjectionTables = { ...emptyTables(), signals: computeAllSignals(inputs, { season: 2026, scoring: PPR, asOf: ASOF }) };
    const v = valuePlayers(L(), [...POOL, ...players], tables).players.get("te")!;
    assert.ok(Number.isFinite(v.ppg) && !/NaN|Infinity/.test(JSON.stringify(v.whyItems)), dump(v));
    if (tables.signals.get("te")!.vacated) {
      const f = item(v, "While he is out")?.match(/×([\d.]+)/);
      if (f) assert.ok(Number(f[1]) >= 1 && Number(f[1]) <= VACATED.maxFactor, dump(v));
    }
    assert.ok(grew(v), `fixture: wk 3–4 (own role) clear the bar: ${dump(v)}`);
    assert.match(item(v, "Borrowed role") ?? "", /wk 5, 6/, dump(v));
    // Settled usage (borrowed games at 40%) × efficiency 1.0: the prior enters at the settled usage, not the borrowed one.
    assert.ok(Math.abs(num(v, "2025 at new role") - usageOf(v)) <= 0.1, dump(v));
  });

  test("flagged games: 3 flagged backup games + 2 unflagged starter games → role change, sample 2.75, priorW 2, bullet shown", () => {
    // Flagged = left early / blowout / backup QB (context.ts): the 3 backup games are blowouts (margin 30).
    const prior: PriorSeason = { games: 16, expected: line({ rec: 32, recYd: 320 }), actual: line({ rec: 32, recYd: 320 }) }; // 4.0
    const gs: G[] = [...repeat(3, { a: { rec: 2, recYd: 20 }, teamMargin: 30 }), ...repeat(2, { a: { rec: 6, recYd: 100 } })];
    const v = run([input("fl", "WR", gs, prior)]).get("fl")!;
    assert.match(item(v, "Odd games") ?? "", /^3 count 25%/, dump(v));
    assert.ok(grew(v), dump(v));
    assert.equal(priorW(v), V4.priorK);
    const used = num(v, "2025 at new role");
    assert.ok(Math.abs(used - usageOf(v) * 1) <= 0.05, `efficiency 1.0 prior enters at usage: ${used} vs ${usageOf(v)}`);
  });

  test("actual-points fallback (missing usage data) and a prior under priorMinGames: no new-role bullet, finite model", () => {
    const prior: PriorSeason = { games: 16, expected: line({ rec: 32, recYd: 320 }), actual: line({ rec: 32, recYd: 320 }) };
    // Ghost games: expected 0, actual 16 → missingExp; never a role change.
    const ghost: G = { a: { rec: 6, recYd: 100 }, e: {} };
    // Prior with 3 games: no 2025 bullet at all.
    const short: PriorSeason = { games: V4.priorMinGames - 1, expected: line({ rec: 6, recYd: 60 }), actual: line({ rec: 6, recYd: 60 }) };
    const out = run([input("gh", "WR", repeat(4, ghost), prior), input("sh", "WR", repeat(4, { a: { rec: 6, recYd: 100 } }), short)]);
    const gh = out.get("gh")!;
    assert.match(item(gh, "Usage data") ?? "", /missing/, dump(gh));
    assert.equal(grew(gh), false, dump(gh));
    assert.equal(item(gh, "2025 at new role"), undefined);
    const sh = out.get("sh")!;
    assert.equal(item(sh, "2025"), undefined, dump(sh));
    assert.equal(item(sh, "2025 at new role"), undefined);
    for (const v of [gh, sh]) assert.ok(Number.isFinite(v.ppg));
  });

  test("TD-heavy 2-game run: the prior enters at the TD-regressed usage (the 'role grew' number), never the raw TD spike", () => {
    // 2025 backup 4.0 pts/game with 0 TDs. 2026: 2 games of 3 catches / 30 yd + 1 expected receiving TD (12 expected).
    const prior: PriorSeason = { games: 16, expected: line({ rec: 32, recYd: 320 }), actual: line({ rec: 32, recYd: 320 }), opps: { targets: 64, carries: 0, passAtt: 0 } };
    const td: G = { a: { rec: 3, recYd: 30, recTd: 1 }, targets: 5 };
    const v = run([input("tdx", "WR", repeat(2, td), prior)]).get("tdx")!;
    // Regressed usage 7.2 (1.00 expected TD/g → 0.20) still clears the 7.0 bar: a role change at the regressed usage.
    assert.ok(grew(v), dump(v));
    const used = num(v, "2025 at new role");
    const usage = usageOf(v);
    assert.ok(usage < 12, `usage is TD-regressed: ${usage}`);
    assert.ok(Math.abs(used - usage) <= 0.1, `efficiency 1.0 prior at the regressed usage: ${used} vs ${usage}: ${dump(v)}`);
  });

  test("TE path and the why-bullet: plain, ≤ 90 characters with QB-sized numbers, shown only on a role change", () => {
    const prior: PriorSeason = { games: 16, expected: line({ rec: 64, recYd: 640 }), actual: line({ rec: 64, recYd: 700 }) }; // 8 / 8.4
    const out = run([
      input("tex", "TE", repeat(5, { a: { rec: 7, recYd: 90 } }), prior), // 16 → grew
      input("qbz", "QB", repeat(6, { e: { passYd: 500, rushYd: 90 }, a: { passYd: 500, rushYd: 90 }, targets: 0, carries: 8 }), { games: 8, expected: line({ passYd: 8 * 250 }), actual: line({ passYd: 8 * 250 }) }), // 29 vs 10
      input("tes", "TE", repeat(5, { a: { rec: 4, recYd: 40 } }), prior), // 8 → steady
    ]);
    for (const id of ["tex", "qbz"]) {
      const v = out.get(id)!;
      assert.ok(grew(v), `${id}: ${dump(v)}`);
      const b = item(v, "2025 at new role")!;
      assert.match(b, /^\d+\.\d pts\/game: last year's efficiency at this year's usage$/);
      assert.ok(`2025 at new role: ${b}`.length <= 90, b);
      assert.ok(item(v, "2025")!.length <= 90, item(v, "2025"));
    }
    assert.equal(item(out.get("tes")!, "2025 at new role"), undefined);
  });
});
