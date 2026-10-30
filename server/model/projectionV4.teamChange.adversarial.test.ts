// Adversarial tests for DESIGN "Fix: team-change prior and TD baseline (2026-10-30)".
// Synthetic players only (generic ids; team codes are NFL abbreviations, no real players).
import { test } from "node:test";
import assert from "node:assert/strict";
import { V4, emptyTables, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computePlayerSignals } from "./signals/index.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import { PPR } from "../data/fixtures/signals2026.js";
import { buildPrior, parseEpRows } from "../data/signalTables.js";
import type { Player, Position, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import type { PlayerGame, PlayerSignalInput, PriorSeason, SkillPos } from "./signals/types.js";

const ASOF = new Date("2026-10-26T00:00:00Z");
const wk = (week: number, a: Partial<StatLine>, tm = "KC"): WeekLine => ({
  season: 2026, week, team: tm, actual: line(a), expected: line(a), opp: { targets: 6, carries: 0, airYards: 60 },
});
const L = () => league([team("a", [])], undefined, { currentWeek: 8, numTeams: 12, scoring: { ...PPR } });
function filler(pos: Position, n = 40): Player[] {
  return Array.from({ length: n }, (_, i) =>
    rawPlayer(`${pos}${i + 1}`, pos, {
      ecrPos: i + 1,
      weeks: Array.from({ length: 6 }, (_, w) => wk(w + 1, { recYd: 120 - i * 2.5, rec: 6 - i * 0.1, recTd: w % 3 === 0 ? 1 : 0, passYd: pos === "QB" ? 280 - i * 3 : 0, passTd: pos === "QB" && w % 2 === 0 ? 2 : 0 })),
      prior: { games: 16, line: line({ recYd: (120 - i * 2.5) * 16, rec: (6 - i * 0.1) * 16, passYd: pos === "QB" ? (280 - i * 3) * 16 : 0 }) },
    }),
  );
}
const POOL = [...filler("QB", 30), ...filler("RB"), ...filler("WR"), ...filler("TE", 30)];
const item = (v: ValuedPlayer, label: string) => v.whyItems?.find((d) => d.label === label)?.value;
const priorW = (v: ValuedPlayer) => Number(item(v, "2025")!.match(/counts as ([\d.]+) games/)![1]);
const repeat = <T>(n: number, x: T): T[] => Array.from({ length: n }, () => x);

type G = { a: Partial<StatLine>; e: Partial<StatLine>; team?: string; margin?: number };
function input(id: string, gs: G[], prior: PriorSeason, pos: SkillPos = "WR"): PlayerSignalInput {
  return {
    id, name: id, pos, team: "KC", status: [],
    games: gs.map((g, i): PlayerGame => ({
      week: i + 1, gameId: `g${i + 1}`, team: g.team ?? "KC", targets: pos === "QB" ? 0 : 8, carries: 0, airYards: pos === "QB" ? 0 : 80,
      passAttempts: pos === "QB" ? 34 : 0, actual: line(g.a), expected: line(g.e), ...(g.margin !== undefined ? { teamMargin: g.margin } : {}),
    })),
    prior,
  };
}
function run(inputs: PlayerSignalInput[], teamOf: Record<string, string> = {}): Map<string, ValuedPlayer> {
  const tables: ProjectionTables = {
    ...emptyTables(),
    signals: new Map(inputs.map((i) => [i.id, computePlayerSignals(i, { season: 2026, scoring: PPR, asOf: ASOF })])),
  };
  const players = inputs.map((i) =>
    rawPlayer(i.id, i.pos as Position, { team: teamOf[i.id] ?? "KC", weeks: i.games.map((g) => wk(g.week, {}, g.team)) }),
  );
  return valuePlayers(L(), [...POOL, ...players], tables).players;
}
const tenPpg = (games: number, lastTeam?: string): PriorSeason => ({
  games, expected: line({ rec: 4 * games, recYd: 60 * games }), actual: line({ rec: 4 * games, recYd: 60 * games }),
  opps: { passAtt: 0, carries: 0, targets: 7 * games }, ...(lastTeam !== undefined ? { lastTeam } : {}),
});
// 14 pts/g against 10.0 last season: under the role-change bar (15), so only the team-change path can neutralise.
const J: G = { a: { rec: 6, recYd: 80 }, e: { rec: 6, recYd: 80 } };
const on = (tm: string, g: G = J): G => ({ ...g, team: tm });

// DEFECT 1 (real data: a WR on ARI in 2025 and 2026 weeks 1-4, HOU weeks 5-6). DESIGN: "A team change needs 4
// unflagged games on the new team". The gate counts every unflagged 2026 game, including the ones on his 2025 team.
test("traded mid-2026 away from his 2025 team: games on the OLD team do not count toward the 4-game gate", () => {
  const out = run(
    [
      input("tradedLate", [on("BUF"), on("BUF"), on("BUF"), on("BUF"), on("KC")], tenPpg(16, "BUF")),
      input("tradedTwo", [on("BUF"), on("BUF"), on("BUF"), on("KC"), on("KC")], tenPpg(16, "BUF")),
    ],
  );
  for (const id of ["tradedLate", "tradedTwo"]) {
    const v = out.get(id)!;
    assert.equal(item(v, "2025 on another team"), undefined, `${id}: ${item(v, "2025 on another team")}`);
    assert.equal(priorW(v), V4.priorKSmall - 5, `${id}: ${item(v, "2025")}`);
  }
});

// DEFECT 2: DESIGN "FA or unknown = not changed". ep_weekly rows with a blank / NA posteam are normalised to "FA"
// by parseEpRows (normTeam), and buildPrior stores "FA" as lastTeam (it is truthy), so the model reads a team change.
test("blank or NA posteam in 2025 rows: never a team change (same as an unknown team)", () => {
  const hdr = "season,posteam,week,game_id,player_id,full_name,position,rec_attempt,receptions,rec_yards_gained,receptions_exp,rec_yards_gained_exp";
  const rows = (id: string, tm: string) => Array.from({ length: 16 }, (_, i) => `2025,${tm},${i + 1},g${i + 1},${id},${id},WR,7,4,60,4,60`);
  const prior = buildPrior(parseEpRows([hdr, ...rows("blank", ""), ...rows("na", "NA")].join("\n")));
  const out = run([input("blank", repeat(5, J), prior.get("blank")!), input("na", repeat(5, J), prior.get("na")!), input("unknown", repeat(5, J), tenPpg(16))]);
  for (const id of ["blank", "na"]) {
    const v = out.get(id)!;
    assert.equal(item(v, "2025 on another team"), undefined, `${id}: ${item(v, "2025 on another team")}`);
    assert.equal(item(v, "Our model"), item(out.get("unknown")!, "Our model"));
  }
  // Data layer: "FA" is not a 2025 team (the model fix alone would leave the tag wrong for any other reader).
  for (const id of ["blank", "na"]) assert.notEqual(prior.get(id)!.lastTeam, "FA", `${id}: lastTeam ${prior.get(id)!.lastTeam}`);
});

// ---- Probes where the fix is expected to hold ----

test("probe: nflverse 'LA' (2025) vs current 'LAR', 'JAC'→JAX, 'WSH'→WAS, 'OAK'→LV: not a team change", () => {
  const hdr = "season,posteam,week,game_id,player_id,full_name,position,rec_attempt,receptions,rec_yards_gained,receptions_exp,rec_yards_gained_exp";
  const pairs = [["la", "LA", "LAR"], ["jac", "JAC", "JAX"], ["wsh", "WSH", "WAS"], ["oak", "OAK", "LV"]] as const;
  const csv = [hdr, ...pairs.flatMap(([id, tm]) => Array.from({ length: 16 }, (_, i) => `2025,${tm},${i + 1},g${i + 1},${id},${id},WR,7,4,60,4,60`))].join("\n");
  const prior = buildPrior(parseEpRows(csv));
  const out = run(pairs.map(([id, , cur]) => input(id, repeat(5, on(cur)), prior.get(id)!)), Object.fromEntries(pairs.map(([id, , cur]) => [id, cur])));
  for (const [id] of pairs) {
    const v = out.get(id)!;
    assert.equal(item(v, "2025 on another team"), undefined, id);
    assert.equal(priorW(v), V4.priorKSmall - 5, id);
  }
});

test("probe: current team FA is never a team change", () => {
  const v = run([input("fa", repeat(5, on("BUF")), tenPpg(16, "BUF"))], { fa: "FA" }).get("fa")!;
  assert.equal(item(v, "2025 on another team"), undefined);
});

test("probe: flagged (blowout) games do not count toward the 4-game gate", () => {
  const gs = [J, J, J, { ...J, margin: 30 }, { ...J, margin: -28 }];
  const v = run([input("blow", gs, tenPpg(16, "BUF"))]).get("blow")!;
  assert.equal(item(v, "2025 on another team"), undefined, item(v, "2025"));
  assert.notEqual(priorW(v), V4.priorK);
});

test("probe: mid-2025 trade — lastTeam is the later team regardless of row order; traded back = not changed", () => {
  const hdr = "season,posteam,week,game_id,player_id,full_name,position,rec_attempt,receptions,rec_yards_gained,receptions_exp,rec_yards_gained_exp";
  const r = (w: number, tm: string) => `2025,${tm},${w},g${w},x,x,WR,7,4,60,4,60`;
  const prior = buildPrior(parseEpRows([hdr, r(15, "KC"), r(3, "BUF"), r(10, "KC"), r(1, "BUF"), r(9, "BUF"), r(17, "KC"), r(5, "BUF")].join("\n")));
  assert.equal(prior.get("x")!.lastTeam, "KC");
  const v = run([input("x", repeat(5, J), prior.get("x")!)]).get("x")!;
  assert.equal(item(v, "2025 on another team"), undefined);
});

test("probe: QB team change — neutral prior, QB position TD baseline, why-line ≤ 90 chars", () => {
  const qbPrior: PriorSeason = {
    games: 16, expected: line({ passYd: 240 * 16, passTd: 1.5 * 16 }), actual: line({ passYd: 240 * 16, passTd: 2.5 * 16 }),
    opps: { passAtt: 34 * 16, carries: 0, targets: 0 }, lastTeam: "BUF",
  };
  const g: G = { a: { passYd: 260, passTd: 1.6 }, e: { passYd: 260, passTd: 1.6 } };
  const v = run([input("qb", repeat(6, g), qbPrior, "QB")]).get("qb")!;
  const ln = item(v, "2025 on another team");
  assert.ok(ln, item(v, "2025"));
  assert.ok(`2025 on another team: ${ln}`.length <= 90, ln);
  assert.match(item(v, "Touchdowns") ?? "", /\(QB average /, item(v, "Touchdowns"));
  assert.equal(priorW(v), V4.priorK);
});

test("probe: same team, 16-game 2025 with an extreme TD rate: still his own rate (unchanged rule)", () => {
  const prior: PriorSeason = { ...tenPpg(16, "KC"), actual: line({ rec: 64, recYd: 960, recTd: 32 }) };
  const g: G = { a: { rec: 6, recYd: 80, recTd: 0.5 }, e: { rec: 6, recYd: 80, recTd: 0.5 } };
  const v = run([input("hot", repeat(6, g), prior)]).get("hot")!;
  assert.match(item(v, "Touchdowns") ?? "", /\(last season /, item(v, "Touchdowns"));
});

test("probe: team changer whose 2025 has no opportunity data: position baseline, no crash", () => {
  const prior: PriorSeason = { ...tenPpg(16, "BUF"), actual: line({ rec: 64, recYd: 960, recTd: 8 }) };
  delete prior.opps;
  const g: G = { a: { rec: 6, recYd: 80, recTd: 0.5 }, e: { rec: 6, recYd: 80, recTd: 0.5 } };
  const v = run([input("noOpp", repeat(5, g), prior)]).get("noOpp")!;
  assert.match(item(v, "Touchdowns") ?? "", /\(WR average /, item(v, "Touchdowns"));
  assert.ok(Number.isFinite(Number(item(v, "Our model")!.match(/^[\d.]+/)![0])), item(v, "Our model"));
});
