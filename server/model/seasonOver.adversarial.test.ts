// Adversarial tests for the season-over call (DESIGN "Season-over injuries (2026-10-31)"): the owner's mark against
// stale automatic sources, K / DEF marks, cross-league isolation and ESPN date edges. Known defects are `todo`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyTables, signalInputFromPlayer, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computePlayerSignals } from "./signals/index.js";
import { ASOF, PPR } from "../data/fixtures/signals2026.js";
import { league, line, rawPlayer, team } from "./testkit.js";
import { espnSeasonOverWhy } from "./returns.js";
import type { League, Player, Position, StatLine, WeekLine } from "./types.js";
import type { RosterInfo } from "./signals/types.js";

const END = "2027-01-04"; // the real 2026 week-17 end (games.csv)
const wk = (week: number, actual: Partial<StatLine>): WeekLine => ({
  season: 2026, week, team: "KC", actual: line(actual), expected: line(actual), opp: { targets: 0, carries: 0, airYards: 0 },
});
const games = (weeks: number[], actual: Partial<StatLine>) => weeks.map((w) => wk(w, actual));
const L = (marks?: Record<string, boolean>, id = "test"): League => {
  const l = league([team("a", ["owned"])], undefined, { currentWeek: 8, numTeams: 12 });
  l.id = id;
  if (marks) l.seasonMarks = marks;
  return l;
};
function filler(pos: Position, n = 45): Player[] {
  return Array.from({ length: n }, (_, i) =>
    rawPlayer(`${pos}${i + 1}`, pos, { ecrPos: i + 1, weeks: games([1, 2, 3, 4, 5, 6, 7], { recYd: 110 - i * 2.2, rec: 6 - i * 0.1, rushYd: pos === "RB" ? 70 - i : 0, passYd: pos === "QB" ? 280 - i * 3 : 0 }) }),
  );
}
const POOL = [...filler("QB", 30), ...filler("RB"), ...filler("WR"), ...filler("TE", 30)];
const ROLE = { rec: 8, recYd: 110, recTd: 0.3 };
const ACT: RosterInfo = { status: "ACT", statusCode: "A01" };

/** A healthy WR who played every week (1-7) on the active roster; `stale` is whatever a lagging feed still says. */
function healthy(stale: Partial<Player> = {}): Player {
  return rawPlayer("star", "WR", { ecrPos: 12, weeks: games([1, 2, 3, 4, 5, 6, 7], ROLE), ...stale });
}
function value(p: Player, marks?: Record<string, boolean>) {
  const sig = [p.id, computePlayerSignals({ ...signalInputFromPlayer(p)!, roster: ACT, status: [] }, { season: 2026, scoring: PPR, asOf: ASOF })] as const;
  const tables: ProjectionTables = { ...emptyTables(), signals: new Map([sig]), weekEnds: new Map([[17, END]]) };
  return valuePlayers(L(marks), [...POOL, p], tables).players.get(p.id)!;
}

test("baseline: a stale ESPN 'IR, back Feb 2027' entry on an active, playing WR zeroes him (the automatic call)", () => {
  const clean = value(healthy());
  const stale = value(healthy({ espnInjury: { status: "Injured Reserve", returnDate: "2027-02-15" } }));
  assert.ok(clean.value > 0);
  assert.equal(stale.seasonStatus?.source, "espn");
  assert.equal(stale.value, 0);
});

test(
  "owner 'Not out' on an ACTIVE, playing player whose only flag is a stale ESPN entry restores his full value",
  () => {
    const clean = value(healthy());
    const marked = value(healthy({ espnInjury: { status: "Injured Reserve", returnDate: "2027-02-15" } }), { star: false });
    assert.equal(marked.seasonStatus?.over, false);
    assert.equal(marked.ret?.absent, undefined, JSON.stringify(marked.ret));
    assert.equal(marked.value, clean.value, `not out: ${marked.value} vs healthy ${clean.value}`);
  },
);

test(
  "owner 'Not out' on an ACTIVE, playing player with a stale Sleeper ACL listing restores his full value",
  () => {
    const clean = value(healthy());
    const marked = value(healthy({ sleeperInjury: { status: "IR", bodyPart: "Knee - ACL", rosterStatus: "Inactive" } }), { star: false });
    assert.equal(marked.seasonStatus?.over, false);
    assert.equal(marked.value, clean.value, `not out: ${marked.value} vs healthy ${clean.value}`);
  },
);

test("owner 'Out for season' on a K and a DEF zeroes them too", () => {
  const k = rawPlayer("K:x", "K", { ecrPos: 3 });
  const d = rawPlayer("DEF:KC", "DEF", { ecrPos: 2 });
  const pool = [...POOL, ...Array.from({ length: 20 }, (_, i) => rawPlayer(`K${i}`, "K", { ecrPos: i + 4 })), ...Array.from({ length: 20 }, (_, i) => rawPlayer(`DEF${i}`, "DEF", { ecrPos: i + 4 })), k, d];
  const base = valuePlayers(L(), pool, emptyTables());
  assert.ok(base.players.get("K:x")!.value > 0 && base.players.get("DEF:KC")!.value > 0, "K / DEF have value before");
  const v = valuePlayers(L({ "K:x": true, "DEF:KC": true }), pool, emptyTables());
  for (const id of ["K:x", "DEF:KC"]) {
    const p = v.players.get(id)!;
    assert.equal(p.seasonStatus?.source, "owner", id);
    assert.equal(p.value, 0, `${id} value ${p.value}`);
    assert.ok(p.weekly!.every((x) => x === 0), `${id} weekly ${p.weekly}`);
  }
});

test("marks never leak: one league's mark does not touch the same Player objects valued for another league", () => {
  const p = healthy();
  const sig = [p.id, computePlayerSignals({ ...signalInputFromPlayer(p)!, roster: ACT, status: [] }, { season: 2026, scoring: PPR, asOf: ASOF })] as const;
  const tables: ProjectionTables = { ...emptyTables(), signals: new Map([sig]), weekEnds: new Map([[17, END]]) };
  const pool = [...POOL, p];
  const a = valuePlayers(L({ star: true }, "A"), pool, tables).players.get("star")!;
  const b = valuePlayers(L(undefined, "B"), pool, tables).players.get("star")!;
  assert.equal(a.value, 0);
  assert.ok(b.value > 0);
  assert.equal(b.seasonStatus, undefined);
  assert.equal((p as Player & { seasonStatus?: unknown }).seasonStatus, undefined, "the shared db Player is never mutated");
});

test("marks with prototype-looking keys on League.seasonMarks are inert", () => {
  const marks = JSON.parse('{"__proto__": {"star": true}, "constructor": true}') as Record<string, boolean>;
  const p = value(healthy(), marks);
  assert.equal(p.seasonStatus, undefined);
  assert.ok(p.value > 0);
});

test("ESPN date edges: final game day itself, the day after, Questionable with a far date, a lower-case status", () => {
  const e = (returnDate: string, status = "Injured Reserve") => ({ status, returnDate });
  assert.equal(espnSeasonOverWhy(e("2027-01-04"), END), null, "back on the final game day");
  assert.ok(espnSeasonOverWhy(e("2027-01-05"), END));
  assert.equal(espnSeasonOverWhy(e("2026-12-28"), END), null, "back inside the playoffs (the real Pacheco case)");
  assert.equal(espnSeasonOverWhy(e("2027-02-15", "Questionable"), END), null);
  assert.ok(espnSeasonOverWhy(e("2027-02-15", "injured reserve"), END));
  assert.equal(espnSeasonOverWhy(e("2025-02-15"), END), null, "a past date is not season over");
  assert.equal(espnSeasonOverWhy(e(""), END), null);
  assert.equal(espnSeasonOverWhy(e("2027-02-15"), "garbage"), null, "an unparsable final-week end never decides");
});

test(
  "ESPN date edges: an impossible calendar day ('2027-02-30', '2027-01-00') is a bad date, never a decision",
  () => {
    assert.equal(espnSeasonOverWhy({ status: "Injured Reserve", returnDate: "2027-02-30" }, END), null);
    assert.equal(espnSeasonOverWhy({ status: "Injured Reserve", returnDate: "2027-01-00" }, "2026-12-28"), null);
  },
);

test("owner 'Not out' with BOTH a stale ESPN IR / 2027 entry and a stale Sleeper ACL listing: healthy value, no absence (decision 2026-10-31)", () => {
  const clean = value(healthy());
  const stale = { espnInjury: { status: "Injured Reserve", returnDate: "2027-02-15" }, sleeperInjury: { status: "IR", bodyPart: "Knee - ACL", rosterStatus: "Inactive" } };
  assert.equal(value(healthy(stale)).value, 0, "automatic call: out for the season");
  const marked = value(healthy(stale), { star: false });
  assert.equal(marked.seasonStatus?.over, false);
  assert.equal(marked.seasonStatus?.auto?.source, "sleeper");
  assert.equal(marked.ret?.absent, undefined, JSON.stringify(marked.ret));
  assert.deepEqual(marked.weekly, clean.weekly);
  assert.equal(marked.value, clean.value);
});

test("ESPN dates: a leap day is a real day; an impossible final-week end never decides", () => {
  assert.ok(espnSeasonOverWhy({ status: "Injured Reserve", returnDate: "2028-02-29" }, END));
  assert.equal(espnSeasonOverWhy({ status: "Injured Reserve", returnDate: "2027-02-29" }, END), null);
  assert.equal(espnSeasonOverWhy({ status: "Injured Reserve", returnDate: "2027-02-15" }, "2027-01-32"), null);
});
