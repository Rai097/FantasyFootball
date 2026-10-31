// Adversarial tests for "Fix: returning starters and season-ending injuries (2026-10-31)" (DESIGN): a teammate with
// no game for the team this season, a bigger 2025 role on the same team and an injury listing vacates the fill-in's
// role; PUP is never season-ending. Synthetic players only (generic ids; the repo is public).
// Defects found were `todo` tests; fix round 1 (2026-10-31) fixed them and dropped the `todo` so they guard the fix.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { vacatedGames, type VacPlayer } from "./signals/vacated.js";
import { emptyTables, signalInputFromPlayer, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computeAllSignals } from "./signals/index.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import { PPR } from "../data/fixtures/signals2026.js";
import type { Player, Position, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import type { PlayerSignalInput, PriorSeason, RosterInfo, StatusWeek } from "./signals/types.js";

// ---------------------------------------------------------------- pure rule (vacatedGames)

type Row = { week: number; report?: string; practice?: string };
/** RB with `touches` per week (null = no game) for `tm` (default AAA). */
const rb = (id: string, touches: (number | null)[], extra: Partial<VacPlayer> = {}, tm = "AAA"): VacPlayer => ({
  id,
  name: id,
  pos: "RB",
  team: "AAA",
  games: touches.flatMap((t, i) => (t === null ? [] : [{ week: i + 1, team: tm, targets: 0, carries: t, snapShare: 0.6 }])),
  ...extra,
});
const prior = (perGame: number, lastTeam: string | undefined, games = 16) => ({ games, opps: { carries: perGame * games, targets: 0 }, lastTeam });
// Out every week (an injured player not on IR is on the report each week; fix round 1: evidence is week-scoped).
const OUT: Row[] = [1, 2, 3, 4, 5, 6, 7].map((week) => ({ week, report: "Out", practice: "Did Not Participate In Practice" }));
const outAt = (week: number): Row[] => [{ week, report: "Out" }];
// The fill-in: a 6-touch backup last season elsewhere, 3 touches in week 1, then the lead role.
const fillIn = (extra: Partial<VacPlayer> = {}) => rb("rb2", [3, 20, 8, 22, 21, 18, 22], { prior: prior(6, "BBB"), ...extra });
// The starter: no game this season, 13 touches a game for THIS team last season.
const starter = (extra: Partial<VacPlayer> = {}) => rb("rb1", [], { prior: prior(13, "AAA"), status: OUT, ...extra });
const weeksOf = (m: Map<string, Map<number, unknown>>, id: string) => [...(m.get(id)?.keys() ?? [])].sort((a, b) => a - b);

describe("adversarial: who counts as a teammate out since before the season", () => {
  test("a 2025 starter who left the team (now on another team) never vacates a role here, even listed injured", () => {
    assert.equal(vacatedGames([fillIn(), starter({ team: "CCC" })]).size, 0);
    assert.equal(vacatedGames([fillIn(), starter({ team: "FA" })]).size, 0);
  });
  // nflverse roster rows for released / retired / traded players keep the team that let him go (real 2026 roster:
  // 442 CUT, 23 RET rows, every one with a team), and signalTables adds such a player when he has an injury row.
  for (const st of ["CUT", "RET", "TRD"]) {
    test(`roster status ${st} with the old team (no longer on it) never vacates a role`, () => {
      const m = vacatedGames([fillIn(), starter({ roster: { status: st } })]);
      assert.deepEqual(weeksOf(m, "rb2"), [], `${st}: flagged weeks ${weeksOf(m, "rb2")}`);
    });
  }
  test("a healthy scratch with only a Full-participation practice row is not hurt (no vacated role)", () => {
    const healthy = starter({ status: [{ week: 6, practice: "Full Participation in Practice" }] as Row[], roster: { status: "ACT" } });
    assert.deepEqual(weeksOf(vacatedGames([fillIn(), healthy]), "rb2"), []);
  });
  test("a teammate who played for ANOTHER team before that week was not out since before the season", () => {
    // 2025 here, signed elsewhere and played weeks 1-4 there, back on this team from week 5 (listed hurt week 5).
    const t = rb("rb1", [15, 15, 15, 15], { prior: prior(13, "AAA"), status: outAt(5) }, "CCC");
    const m = vacatedGames([fillIn(), t]);
    assert.deepEqual(weeksOf(m, "rb2").filter((w) => w <= 4), [], `weeks he was playing elsewhere: ${weeksOf(m, "rb2")}`);
  });
  test("a reserve list (RES) is evidence; a starter on IR all season (no rows) still vacates the role", () => {
    assert.deepEqual(weeksOf(vacatedGames([fillIn(), starter({ status: [], roster: { status: "RES" } })]), "rb2"), [2, 4, 5, 6, 7]);
  });
  test("a starter whose 2025 role was on another team (signed this year) never vacates", () => {
    assert.equal(vacatedGames([fillIn(), starter({ prior: prior(13, "CCC") })]).size, 0);
    assert.equal(vacatedGames([fillIn(), starter({ prior: prior(13, undefined) })]).size, 0, "lastTeam unknown");
  });
});

describe("adversarial: fill-in shapes", () => {
  test("a rookie fill-in (no 2025 role) is unknown → never flagged (documented residual)", () => {
    assert.equal(vacatedGames([fillIn({ prior: undefined }), starter()]).size, 0);
  });
  test("two fill-ins for one starter: both borrow on their own jump weeks", () => {
    const a = rb("rb2", [4, 12, 12, 13], { prior: prior(4, "AAA") });
    const b = rb("rb3", [3, 11, 10, 12], { prior: prior(3, "AAA") });
    const m = vacatedGames([a, b, starter()]);
    assert.deepEqual(weeksOf(m, "rb2"), [2, 3, 4]);
    assert.deepEqual(weeksOf(m, "rb3"), [2, 3, 4]);
    assert.equal(m.get("rb2")!.get(2)![0].id, "rb1");
  });
  test("week 1 is flaggable now (baseline = his 2025 usage, not earlier games)", () => {
    const m = vacatedGames([rb("rb2", [20], { prior: prior(6, "BBB") }), starter()]);
    assert.deepEqual(weeksOf(m, "rb2"), [1]);
  });
  test("a fill-in traded in mid-season: only his games for this team can be borrowed", () => {
    const p: VacPlayer = { ...fillIn(), games: [1, 2, 3, 4, 5, 6].map((w) => ({ week: w, team: w <= 3 ? "BBB" : "AAA", targets: 0, carries: 20, snapShare: 0.6 })) };
    assert.deepEqual(weeksOf(vacatedGames([p, starter()]), "rb2"), [4, 5, 6]);
  });
  test("a fill-in whose 2025 usage was 0 over ≥ 4 games: any 2-touch game is a 'jump' (documented: harmless?)", () => {
    const m = vacatedGames([rb("rb2", [2, 1, 2], { prior: prior(0, "AAA", 5) }), starter()]);
    // jumped(u, 0) = u ≥ max(0, 2): a 2-touch game borrows the starter's role.
    assert.deepEqual(weeksOf(m, "rb2"), [1, 3]);
  });
});

describe("adversarial: the starter comes back", () => {
  test("starter plays week 4, then is out again from week 5: listed hurt weeks 1-3 → weeks 2-3 and 5-7 borrow, week 4 not", () => {
    const fill = rb("rb2", [3, 20, 21, 7, 20, 22, 21], { prior: prior(6, "BBB") });
    const s = rb("rb1", [null, null, null, 16], { prior: prior(13, "AAA"), status: outAt(5) });
    // Fix round 1: nothing says he was hurt weeks 1-3 (the week-5 Out is after his week-4 game, another absence):
    // unknown → weeks 2-3 are his own role, so they lift his baseline (≈ 12.8) and weeks 5-7 are no jump either.
    assert.deepEqual(weeksOf(vacatedGames([fill, s]), "rb2"), []);
    // Listed Out in weeks 1-3 → those weeks borrow too.
    const s2 = { ...s, status: [...outAt(1), ...outAt(2), ...outAt(3), ...outAt(5)] };
    assert.deepEqual(weeksOf(vacatedGames([fill, s2]), "rb2"), [2, 3, 5, 6, 7]);
  });
  test("starter back for good from week 5: nothing after his return is borrowed", () => {
    const fill = rb("rb2", [3, 20, 21, 22, 12, 11, 12], { prior: prior(6, "BBB") });
    const s = rb("rb1", [null, null, null, null, 16, 15, 17], { prior: prior(13, "AAA"), status: outAt(4) });
    assert.deepEqual(weeksOf(vacatedGames([fill, s]), "rb2"), [2, 3, 4]);
  });
});

describe("adversarial: odd inputs never throw and never flag", () => {
  test("NaN / missing fields", () => {
    const odd: VacPlayer[] = [
      fillIn(),
      starter({ prior: { games: Number.NaN, opps: { carries: 200, targets: 0 }, lastTeam: "AAA" } }),
      rb("rb3", [], { prior: { games: 16, opps: { carries: Number.NaN, targets: 0 }, lastTeam: "AAA" }, status: OUT }),
      rb("rb4", [], { prior: { games: 16, lastTeam: "AAA" }, status: [{ week: Number.NaN }] }),
      { ...rb("rb5", [], { prior: prior(13, "AAA"), status: OUT }), team: "" },
    ];
    const m = vacatedGames(odd);
    assert.deepEqual(weeksOf(m, "rb2"), []);
  });
  test("an empty input and a lone starter", () => {
    assert.equal(vacatedGames([]).size, 0);
    assert.equal(vacatedGames([starter()]).size, 0);
  });
  test("performance: 32 teams × 25 pass catchers/RBs with no-game teammates stays fast", () => {
    const ps: VacPlayer[] = [];
    for (let t = 0; t < 32; t++) {
      const tm = `T${t}`;
      for (let i = 0; i < 25; i++) {
        const noGames = i % 5 === 0;
        ps.push({
          id: `${tm}-${i}`,
          name: `${tm}-${i}`,
          pos: i % 2 ? "WR" : "RB",
          team: tm,
          games: noGames ? [] : Array.from({ length: 17 }, (_, w) => ({ week: w + 1, team: tm, targets: (i * 7 + w) % 11, carries: (i * 3 + w) % 9, snapShare: 0.5 })),
          prior: { games: 16, opps: { carries: 100 + i * 10, targets: 40 + i * 5 }, lastTeam: tm },
          status: noGames ? OUT : [],
        });
      }
    }
    const t0 = performance.now();
    vacatedGames(ps);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
  });
});

// ---------------------------------------------------------------- projection v4 (downstream of the rule)

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
const fullPrior = (perGame: number, lastTeam: string): PriorSeason => ({
  games: 16,
  actual: rbLine(perGame * 16),
  expected: rbLine(perGame * 16),
  opps: { passAtt: 0, carries: perGame * 16, targets: 0 },
  lastTeam,
});
const FILL = (): Player => rawPlayer("rb2", "RB", { team: "AAA", weeks: [3, 20, 8, 22, 21, 18, 22].map((c, i) => wk(i + 1, c)) });
interface Setup {
  player?: Partial<Player>;
  status?: StatusWeek[];
  roster?: RosterInfo;
  weeks?: WeekLine[];
}
function value(s: Setup | null): Map<string, ValuedPlayer> {
  const players = [FILL(), ...(s ? [rawPlayer("rb1", "RB", { team: "AAA", weeks: s.weeks ?? [], ...s.player })] : [])];
  const inputs = players
    .map((p): PlayerSignalInput | null => {
      const x = signalInputFromPlayer(p);
      if (!x) return null;
      if (p.id === "rb2") return { ...x, prior: fullPrior(6, "BBB") };
      return { ...x, prior: fullPrior(14, "AAA"), status: s?.status ?? [], ...(s?.roster ? { roster: s.roster } : {}) };
    })
    .filter((x): x is PlayerSignalInput => !!x);
  const tables: ProjectionTables = { ...emptyTables(), signals: computeAllSignals(inputs, { season: 2026, scoring: PPR, asOf: ASOF }) };
  return valuePlayers(L(), [...POOL, ...players], tables).players;
}
const item = (v: ValuedPlayer, label: string) => v.whyItems?.find((d) => d.label === label)?.value;

describe("adversarial projection: the fill-in keeps the role unless the starter is back or due back", () => {
  test("starter on IR all season with no body part and no practice (RES R01, return unconfirmed): fill-in ≈ no starter", () => {
    const ir = value({ player: { injury: { status: "IR", week: 8 } }, roster: { status: "RES", statusCode: "R01" } });
    const alone = value(null).get("rb2")!;
    const v = ir.get("rb2")!;
    assert.equal(ir.get("rb1")!.ret?.week ?? null, null, "return unconfirmed");
    assert.ok(Math.abs(v.ppg - alone.ppg) < 0.3, `${v.ppg} vs no starter ${alone.ppg}`);
  });
  test("starter out for the season on IR with a non-ACL tear (patellar tendon): fill-in keeps the role", () => {
    const pt = value({ player: { injury: { status: "IR", week: 8 }, sleeperInjury: { status: "IR", bodyPart: "Knee - Patellar Tendon", rosterStatus: "Inactive" } }, roster: { status: "RES", statusCode: "R01" } });
    const alone = value(null).get("rb2")!;
    assert.ok(Math.abs(pt.get("rb2")!.ppg - alone.ppg) < 0.3, `${pt.get("rb2")!.ppg} vs ${alone.ppg}`);
  });
  test("healthy scratch (ACT, no injury, one Full-participation row): the fill-in's role is NOT discounted", () => {
    const hs = value({ roster: { status: "ACT" }, status: [{ week: 6, practice: "Full Participation in Practice" }] });
    const alone = value(null).get("rb2")!;
    const v = hs.get("rb2")!;
    assert.equal(item(v, "Borrowed role"), undefined, `borrowed: ${item(v, "Borrowed role")}`);
    assert.ok(Math.abs(v.ppg - alone.ppg) < 0.3, `${v.ppg} vs no starter ${alone.ppg}`);
  });
  test("starter back in week 4, hurt again from week 5 with no return week: the role is the fill-in's (no 40% discount)", () => {
    const again = value({
      weeks: [wk(4, 16)],
      player: { injury: { status: "IR", week: 8 } },
      roster: { status: "RES", statusCode: "R01" },
      status: [5, 6, 7].map((week) => ({ week, report: "Out" })),
    });
    const v = again.get("rb2")!;
    assert.match(item(v, "Borrowed role") ?? "", /counts in full/, `${item(v, "Borrowed role")}`);
  });
});
