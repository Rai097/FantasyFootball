// Fix 2026-10-30 (DESIGN "Fix: role-change prior at current volume", fix round 1): on a role change last season's
// prior enters at his current-role rate (usage × this season's finishing): neutral, neither its volume nor its
// efficiency counts a second time.
// Synthetic players only (generic ids).
import { test } from "node:test";
import assert from "node:assert/strict";
import { V4, emptyTables, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computePlayerSignals } from "./signals/index.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import { PPR } from "../data/fixtures/signals2026.js";
import type { Player, Position, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import type { PlayerGame, PlayerSignalInput, PriorSeason } from "./signals/types.js";

const ASOF = new Date("2026-10-26T00:00:00Z");
const wk = (week: number, a: Partial<StatLine>): WeekLine => ({
  season: 2026, week, team: "KC", actual: line(a), expected: line(a), opp: { targets: 6, carries: 0, airYards: 60 },
});
const L = () => league([team("a", [])], undefined, { currentWeek: 8, numTeams: 12, scoring: { ...PPR } });
function filler(pos: Position, n = 40): Player[] {
  return Array.from({ length: n }, (_, i) =>
    rawPlayer(`${pos}${i + 1}`, pos, {
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

/** Receiving-only games (no TDs: the TD regression stays out of the arithmetic). */
function input(id: string, gs: { a: Partial<StatLine>; e: Partial<StatLine> }[], prior: PriorSeason): PlayerSignalInput {
  return {
    id, name: id, pos: "WR", team: "KC", status: [],
    games: gs.map((g, i): PlayerGame => ({
      week: i + 1, gameId: `g${i + 1}`, team: "KC", targets: 8, carries: 0, airYards: 80, passAttempts: 0, actual: line(g.a), expected: line(g.e),
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
const repeat = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x);
/** Rate without the prior from the model and the prior that entered: cur = ((n + w) × model − w × prior) / n. */
const curOf = (model: number, n: number, w: number, prior: number) => ((n + w) * model - w * prior) / n;

/** The TD-regressed usage the role-change check used ("role grew: X vs …"). */
const usageOf = (v: ValuedPlayer) => Number(item(v, "2025")!.match(/role grew: ([\d.]+) vs/)![1]);
const finishing = (v: ValuedPlayer) => Number(item(v, "Finishing")?.match(/×([\d.]+)/)?.[1] ?? 1);

test("backup-turned-starter: rate = his current usage × finishing, not dragged to the backup prior", () => {
  // 2025: 16 games as a backup, 4.0 expected / 3.4 actual pts/game → prior 3.7.
  const prior: PriorSeason = { games: 16, expected: line({ rec: 32, recYd: 320 }), actual: line({ rec: 28, recYd: 260 }) };
  // 2026: 5 games as the lead, 16 expected / 14.8 actual pts/game.
  const v = run([input("lead", repeat(5, { a: { rec: 5.6, recYd: 92 }, e: { rec: 6, recYd: 100 } }), prior)]).get("lead")!;
  assert.ok(grew(v), item(v, "2025"));
  assert.equal(priorW(v), V4.priorK);
  const priorRate = num(v, "2025");
  assert.ok(Math.abs(priorRate - 3.7) <= 0.05, `prior ${priorRate}`);
  const cur = usageOf(v) * finishing(v);
  const model = num(v, "Our model");
  assert.ok(Math.abs(model - cur) <= 0.1, `model ${model} = current-role rate ${cur.toFixed(2)}`);
  assert.ok(Math.abs(num(v, "2025 at new role") - model) <= 0.05, item(v, "2025 at new role"));
  assert.match(item(v, "2025 at new role")!, /^[\d.]+ pts\/game: counted at this year's role and finishing$/);
  assert.ok(model >= 15, `model ${model}: near his 16 expected × ~0.95 finishing`);
  const before = (5 * cur + V4.priorK * priorRate) / (5 + V4.priorK);
  assert.ok(model - before >= 2.5, `old prior at the backup volume: ${before.toFixed(2)} → ${model}`);
});

test("role change: last season's efficiency never counts a second time (lucky, poor or 4-game priors are neutral)", () => {
  const e = line({ rec: 32, recYd: 320 }); // 4.0 expected pts/game
  const games = repeat(5, { a: { rec: 6, recYd: 100 }, e: { rec: 6, recYd: 100 } }); // 16 pts/game, finishing 1.0
  const out = run([
    input("hot", games, { games: 16, expected: e, actual: line({ rec: 96, recYd: 960 }) }), // 12 actual: 3.0 per expected point
    input("cold", games, { games: 16, expected: e, actual: line({}) }), // 0 actual
    input("short", games, { games: 4, expected: line({ rec: 8, recYd: 80 }), actual: line({ rec: 10, recYd: 130 }) }), // 4-game, 1.5×
    input("plain", games, { games: 16, expected: e, actual: e }),
  ]);
  for (const id of ["hot", "cold", "short", "plain"]) {
    const v = out.get(id)!;
    assert.ok(grew(v), `${id}: ${item(v, "2025")}`);
    assert.ok(Math.abs(num(v, "Our model") - 16) <= 0.05, `${id}: model ${item(v, "Our model")}`);
    assert.ok(Math.abs(num(v, "2025 at new role") - 16) <= 0.05, `${id}: ${item(v, "2025 at new role")}`);
    assert.ok(Number.isFinite(v.ppg) && !/NaN|Infinity/.test(JSON.stringify(v.whyItems)));
    assert.ok(`2025 at new role: ${item(v, "2025 at new role")}`.length <= 90);
  }
});

test("no role change: a small-sample steady player and a one-game fill-in keep the raw prior and the priorKSmall boost", () => {
  const backup: PriorSeason = { games: 16, expected: line({ rec: 32, recYd: 320 }), actual: line({ rec: 32, recYd: 320 }) }; // 4.0
  const steady: PriorSeason = { games: 16, expected: line({ rec: 96, recYd: 1920 }), actual: line({ rec: 96, recYd: 1920 }) }; // 18.0
  const out = run([
    // 3 games at 17 pts/game after an 18-ppg 2025: usage held → prior weight 8 − 3 = 5 at the raw 18.0.
    input("held", repeat(3, { a: { rec: 7, recYd: 100 }, e: { rec: 7, recYd: 100 } }), steady),
    // 2 games: a 4-pt game then one fill-in start at 16 → only 1 game above the bar, not a role change (8 − 2 = 6).
    input("fill", [{ a: { rec: 2, recYd: 20 }, e: { rec: 2, recYd: 20 } }, { a: { rec: 6, recYd: 100 }, e: { rec: 6, recYd: 100 } }], backup),
  ]);
  for (const [id, n, rate] of [["held", 3, 18], ["fill", 2, 4]] as const) {
    const v = out.get(id)!;
    assert.equal(grew(v), false, item(v, "2025"));
    assert.equal(item(v, "2025 at new role"), undefined);
    assert.equal(num(v, "2025"), rate);
    assert.equal(priorW(v), V4.priorKSmall - n);
    // The model is the plain blend with the raw prior: cur recovered with the raw prior lands on a sane usage rate.
    const model = num(v, "Our model");
    const cur = curOf(model, n, V4.priorKSmall - n, rate);
    assert.ok(cur > 0 && cur < 20, `${id}: model ${model}, implied current rate ${cur.toFixed(2)}`);
  }
  // held: 17 pts/game current (usage = production), so model ≈ (3 × 17 + 5 × 18) / 8.
  assert.ok(Math.abs(num(out.get("held")!, "Our model") - (3 * 17 + 5 * 18) / 8) <= 0.15, item(out.get("held")!, "Our model"));
});
