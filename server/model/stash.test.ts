import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyTables, signalInputFromPlayer, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computePlayerSignals } from "./signals/index.js";
import { ASOF, PPR } from "../data/fixtures/signals2026.js";
import { detailProblems, league, line, rawPlayer, team } from "./testkit.js";
import { stashWatch } from "./stash.js";
import type { Player, Position, StatLine, WeekLine } from "./types.js";
import type { RosterInfo, StatusWeek } from "./signals/types.js";

const wk = (week: number, actual: Partial<StatLine>): WeekLine => ({
  season: 2026, week, team: "KC", actual: line(actual), expected: line(actual), opp: { targets: 0, carries: 0, airYards: 0 },
});
const games = (weeks: number[], actual: Partial<StatLine>) => weeks.map((w) => wk(w, actual));
const L = () => league([team("a", ["owned"])], undefined, { currentWeek: 8, numTeams: 12 });
function filler(pos: Position, n = 45): Player[] {
  return Array.from({ length: n }, (_, i) =>
    rawPlayer(`${pos}${i + 1}`, pos, { ecrPos: i + 1, weeks: games([1, 2, 3, 4, 5, 6, 7], { recYd: 110 - i * 2.2, rec: 6 - i * 0.1, rushYd: pos === "RB" ? 70 - i : 0, passYd: pos === "QB" ? 280 - i * 3 : 0 }) }),
  );
}
const POOL = [...filler("QB", 30), ...filler("RB"), ...filler("WR"), ...filler("TE", 30)];
const FULL = "Full Participation in Practice";

function setup() {
  // Strong role (≈ 20 pts/g) before an IR stint from week 4; practising fully this week (designated to return).
  const star = rawPlayer("star", "WR", { ecrPos: 60, weeks: games([1, 2, 3], { rec: 8, recYd: 110, recTd: 0.3 }) });
  // Same role, on the reserve list without a practice signal: return unconfirmed.
  const quiet = rawPlayer("quiet", "WR", { ecrPos: 70, weeks: games([1, 2, 3], { rec: 8, recYd: 110, recTd: 0.3 }) });
  // Low role on IR: below the flex floor.
  const scrub = rawPlayer("scrub", "WR", { ecrPos: 90, weeks: games([1, 2, 3], { rec: 1, recYd: 8 }) });
  // Healthy free agent with a low role: not a stash at all.
  const healthy = rawPlayer("healthy", "WR", { ecrPos: 80, weeks: games([1, 2, 3, 4, 5, 6, 7], { rec: 3, recYd: 30 }) });
  // A strong returner who is already rostered in the league.
  const owned = rawPlayer("owned", "WR", { ecrPos: 50, weeks: games([1, 2, 3], { rec: 8, recYd: 110, recTd: 0.3 }) });
  const sig = (p: Player, roster: RosterInfo, status: StatusWeek[] = []) =>
    [p.id, computePlayerSignals({ ...signalInputFromPlayer(p)!, roster, status }, { season: 2026, scoring: PPR, asOf: ASOF })] as const;
  const tables: ProjectionTables = {
    ...emptyTables(),
    signals: new Map([
      sig(star, { status: "RES", statusCode: "R48" }, [{ week: 7, practice: "Limited Participation in Practice", report: "Out" }, { week: 8, practice: FULL, report: "Questionable" }]),
      sig(quiet, { status: "RES", statusCode: "R01" }),
      sig(scrub, { status: "RES", statusCode: "R01" }),
      sig(owned, { status: "RES", statusCode: "R48" }, [{ week: 8, practice: FULL, report: "Questionable" }]),
    ]),
  };
  const val = valuePlayers(L(), [...POOL, star, quiet, scrub, healthy, owned], tables);
  return val;
}

test("stash watch: a returner with a strong pre-absence role outranks the unconfirmed one; healthy / low-role / rostered players are out", () => {
  const val = setup();
  const star = val.players.get("star")!;
  assert.equal(star.ret!.week, 8, "full practice, not ruled out, IR minimum served → next game");
  assert.equal(star.ret!.practiceUp, true);
  const rows = stashWatch({
    players: val.players.values(),
    rostered: new Set(["owned"]),
    availability: new Map([["star", "fa"], ["quiet", "waivers"]]),
    flexLevel: val.flexLevel,
    regularSeasonEnd: 14,
    finalWeek: 17,
  });
  assert.deepEqual(rows.map((r) => r.id), ["star", "quiet"]);
  const [s, q] = rows;
  assert.equal(s.call, "add");
  assert.equal(s.callText, "Add now while free");
  assert.equal(s.flag, "practice upgrade: about to become a waiver fight");
  assert.match(s.summary, /^star · WR · KC · back ~wk 8 \(high\) · playoff value \d+\.\d$/);
  assert.equal(q.call, "claim-cheap");
  assert.equal(q.callText, "On waivers — claim only if priority is cheap");
  assert.equal(q.backWeek, null);
  assert.match(q.summary, /return unconfirmed/);
  assert.ok(s.playoffPts > q.playoffPts, "unconfirmed return counts × 0.5");
  for (const r of rows) {
    assert.ok(r.summary.length <= 255);
    assert.deepEqual(detailProblems(r.details), [], r.id);
    for (const n of [r.playoffPts, r.healthyRate, r.stashScore]) assert.ok(Number.isFinite(n), `${r.id}: ${n}`);
    assert.ok(JSON.stringify(r).length < 2500, `${r.id}: ${JSON.stringify(r).length} bytes`);
  }
  // Unknown availability → "check"; at most `limit` rows.
  const unknown = stashWatch({ players: val.players.values(), rostered: new Set(), availability: new Map(), flexLevel: val.flexLevel, regularSeasonEnd: 14, finalWeek: 17, limit: 1 });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].call, "check");
});

test("stash watch: 0 snaps in his team's last 2 games (no injury listed) with a flex-level role is a candidate, return unconfirmed", () => {
  const ghost = rawPlayer("ghost", "RB", { ecrPos: 40, weeks: games([1, 2, 3, 4, 5], { rushYd: 95, rec: 4, recYd: 30, rushTd: 0.5 }) });
  const val = valuePlayers(L(), [...POOL, ghost]);
  const g = val.players.get("ghost")!;
  assert.equal(g.ret!.absent, false);
  assert.ok(g.weekly![0] > 0, "not absent: lineups still project him");
  const rows = stashWatch({ players: val.players.values(), rostered: new Set(), availability: new Map([["ghost", "fa"]]), flexLevel: val.flexLevel, regularSeasonEnd: 14, finalWeek: 17 });
  const row = rows.find((r) => r.id === "ghost")!;
  assert.ok(row, rows.map((r) => r.id).join(","));
  assert.ok(row.details.some((d) => d.label === "Snaps" && /last 2 games/.test(d.value)));
});
