// Adversarial tests for the 2026-10-27 fix round (docs/DESIGN.md "Fix: one playoff engine + small-sample prior"):
// one playoff engine (rosterParts vs teamStrength), small-sample prior weight, FLEX starters as cover, expected-TD
// regression. Tests marked `todo` reproduce a finding (they fail today without failing the suite); see the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { V4, valuePlayers } from "./projectionV4.js";
import { teamStrength } from "./teamStrength.js";
import { activeRoster, rosterParts } from "./rosterScore.js";
import { coverLost, type TeamV3 } from "./tradesV3.js";
import { optimalLineup } from "./lineup.js";
import { league, line, rawPlayer, team, vp } from "./testkit.js";
import type { Player, Position, SlotKind, StatLine, ValuedPlayer, WeekLine } from "./types.js";

// ---------------------------------------------------------------- fixtures

/** The owner's lineup: QB, 2 WR, RB, TE, 2 W/R/T, K, DEF, 6 BN, 2 IR (CLAUDE.md). */
const OWNER: SlotKind[] = ["QB", "WR", "WR", "RB", "TE", "FLEX", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR", "IR"];
const S8 = league([], OWNER, { currentWeek: 8 }).settings; // weeks 8..17, playoffs 15..17

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random roster for S8: weekly points with byes (some in the playoffs), floors, IR-slot players and unconfirmed returns. */
function randomRoster(seed: number): { roster: ValuedPlayer[]; ir: Set<string> } {
  const r = rng(seed);
  const n = 10;
  const POS: Position[] = ["QB", "QB", "RB", "RB", "RB", "RB", "WR", "WR", "WR", "WR", "WR", "TE", "TE", "K", "DEF"];
  const roster: ValuedPlayer[] = [];
  const ir = new Set<string>();
  POS.forEach((pos, k) => {
    const id = `p${seed}_${k}`;
    const ppg = Math.round((3 + r() * 20) * 10) / 10;
    const bye = r() < 0.25 ? 15 + Math.floor(r() * 3) : 5 + Math.floor(r() * 10); // a quarter bye in a playoff week
    const weekly = Array.from({ length: n }, (_, i) => (8 + i === bye ? 0 : Math.round(ppg * (0.7 + r() * 0.6) * 10) / 10));
    const extra: Partial<ValuedPlayer> = { weekly, weeklyFrom: 8, bye, floor: r() < 0.7 ? Math.round(ppg * r() * 10) / 10 : undefined, effPpg: ppg * (0.6 + r() * 0.4) };
    const kind = r();
    if (pos !== "K" && pos !== "DEF" && kind < 0.2) {
      // Unconfirmed return: 0 in his base weeks, healthy rate from current week + 4.
      const healthy = ppg + 4;
      Object.assign(extra, {
        remainingGames: 0,
        weekly: Array(n).fill(0),
        ret: { week: null, confidence: "unknown", reasons: [], absent: true, practiceUp: false, healthyRate: healthy, tradeValue: 20, backWeekly: weekly.map((v, i) => (i < 4 ? 0 : v > 0 ? healthy : 0)) },
      });
      if (r() < 0.5) ir.add(id);
    } else if (pos !== "K" && pos !== "DEF" && kind < 0.32) {
      // Confirmed return in week 10..16, in the IR slot half the time.
      const wk = 10 + Math.floor(r() * 7);
      Object.assign(extra, { weekly: weekly.map((v, i) => (8 + i < wk ? 0 : v)), ret: { week: wk, confidence: "medium", reasons: [], absent: true, practiceUp: false } });
      if (r() < 0.5) ir.add(id);
    } else if (pos !== "K" && pos !== "DEF" && kind < 0.36) {
      // IR slot, no return estimate (never plays for this team).
      ir.add(id);
    }
    roster.push(vp(id, pos, ppg, ppg, extra));
  });
  return { roster, ir };
}

// ---------------------------------------------------------------- 1. one playoff engine

test("one engine: rosterParts' playoffs = teamStrength's lineup on 200 random owner-slot rosters (IR slot, unconfirmed returns, playoff byes, floors)", () => {
  let mixed = 0;
  let fixedPath = 0;
  let irPlayers = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const { roster, ir } = randomRoster(seed);
    const unc = roster.filter((p) => p.ret && p.ret.week === null).length;
    if (unc) mixed++;
    if (unc > 2) fixedPath++;
    irPlayers += ir.size;
    const po = rosterParts(S8, activeRoster(roster, ir), {}).parts.playoffs;
    const ts = teamStrength(S8, roster, ir);
    assert.ok(Number.isFinite(po) && Number.isFinite(ts.total), `seed ${seed}: finite`);
    assert.ok(Math.abs(po - ts.lineup) <= 0.05 + 1e-9, `seed ${seed}: roster score playoffs ${po.toFixed(3)} vs team strength lineup ${ts.lineup}`);
  }
  assert.ok(mixed > 50 && fixedPath > 0 && irPlayers > 50, `fixture coverage: ${mixed} with returns, ${fixedPath} with > 2, ${irPlayers} IR`);
});

test("one engine: with roster cuts (the trade path) the playoffs part = teamStrength on the roster minus the drops", () => {
  for (let seed = 300; seed < 400; seed++) {
    const { roster, ir } = randomRoster(seed);
    const { parts, drops } = rosterParts(S8, activeRoster(roster, ir), {}, { count: 2, keep: (p) => ir.has(p.id) });
    const dropIds = new Set(drops.map((p) => p.id));
    const ts = teamStrength(S8, roster.filter((p) => !dropIds.has(p.id)), ir);
    assert.ok(Math.abs(parts.playoffs - ts.lineup) <= 0.05 + 1e-9, `seed ${seed}: ${parts.playoffs.toFixed(3)} vs ${ts.lineup}`);
  }
});

test("one engine: the floor factor stays out of every weekly column (season too), only 'now' and depth use it", () => {
  const P = (id: string, pos: Position, ppg: number, floor?: number) => vp(id, pos, ppg, ppg, { weekly: Array(10).fill(ppg), weeklyFrom: 8, floor, effPpg: ppg });
  const steady = [P("qb", "QB", 20, 18), P("rb", "RB", 15, 12), P("wr", "WR", 14, 10), P("wr2", "WR", 12, 2), P("te", "TE", 9, 1)];
  const noFloor = steady.map((p) => ({ ...p, floor: undefined }));
  const a = rosterParts(S8, steady, {}).parts;
  const b = rosterParts(S8, noFloor, {}).parts;
  assert.equal(a.playoffs, b.playoffs);
  assert.equal(a.season, b.season);
  assert.ok(a.now < b.now, "now still discounts volatile players");
});

// ---------------------------------------------------------------- 2./4. projection v4: prior weight, TD regression

const wk = (week: number, actual: Partial<StatLine>, expected: Partial<StatLine>, opp = { targets: 0, carries: 0, airYards: 0 }): WeekLine => ({
  season: 2026, week, team: "KC", actual: line(actual), expected: line(expected), opp,
});
const games = (n: number, actual: Partial<StatLine>, expected: Partial<StatLine> = actual, opp?: WeekLine["opp"]) =>
  Array.from({ length: n }, (_, i) => wk(i + 1, actual, expected, opp));
const PPR = { passYd: 0.04, passTd: 4, passInt: -1, rushYd: 0.1, rushTd: 6, rec: 1, recYd: 0.1, recTd: 6, twoPt: 2, fumLost: -2, teRec: 0 };
const L = () => league([team("a", [])], undefined, { currentWeek: 8, numTeams: 12, scoring: PPR });
/** Filler pool with touchdowns (so the position TD means are realistic, not 0). */
function filler(pos: Position, n: number, tdPerGame: number): Player[] {
  return Array.from({ length: n }, (_, i) => {
    const td = Math.max(0, tdPerGame * (1.6 - (i * 1.2) / n));
    const a: Partial<StatLine> = pos === "QB" ? { passYd: 260 - i * 3, passTd: td } : pos === "RB" ? { rushYd: 80 - i, rushTd: td, rec: 2 } : { rec: 6 - i * 0.1, recYd: 80 - i * 1.5, recTd: td };
    return rawPlayer(`${pos}${i + 1}`, pos, {
      ecrPos: i + 1,
      weeks: games(6, a, a, { targets: pos === "QB" ? 0 : 6, carries: pos === "RB" ? 14 : 0, airYards: 50 }),
      prior: { games: 16, line: line(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, (v as number) * 16]))) },
    });
  });
}
const POOL = [...filler("QB", 32, 1.6), ...filler("RB", 40, 0.45), ...filler("WR", 40, 0.35), ...filler("TE", 30, 0.25)];
const whyOf = (val: ReturnType<typeof valuePlayers>, id: string, label: string) => val.players.get(id)!.whyItems!.find((d) => d.label === label)?.value;
const modelOf = (val: ReturnType<typeof valuePlayers>, id: string) => Number(whyOf(val, id, "Our model")!.match(/^[\d.]+/)![0]);
const noNaN = (val: ReturnType<typeof valuePlayers>, id: string) => {
  const v = val.players.get(id)!;
  for (const k of ["ppg", "value", "effPpg"] as const) assert.ok(v[k] === undefined || Number.isFinite(v[k]), `${id}.${k} = ${v[k]}`);
  for (const d of v.whyItems ?? []) assert.ok(!/NaN|Infinity|undefined/.test(d.value), `${id} ${d.label}: ${d.value}`);
  for (const x of v.weekly ?? []) assert.ok(Number.isFinite(x), `${id} weekly ${x}`);
};
/** Run valuePlayers with V4 overrides (restored afterwards). */
function withV4<T>(over: Partial<Record<keyof typeof V4, number>>, f: () => T): T {
  const saved = { ...V4 };
  Object.assign(V4, over);
  try {
    return f();
  } finally {
    Object.assign(V4, saved);
  }
}

test("TD regression: a prior with 0 touchdowns is a valid baseline (finite, pulls toward 0, says 'last season 0.00')", () => {
  const p = rawPlayer("zeroTd", "RB", { weeks: games(7, { rushYd: 70, rushTd: 1 }, { rushYd: 70, rushTd: 1 }, { targets: 0, carries: 16, airYards: 0 }), prior: { games: 16, line: line({ rushYd: 70 * 16 }) } });
  const val = valuePlayers(L(), [...POOL, p]);
  noNaN(val, "zeroTd");
  assert.equal(whyOf(val, "zeroTd", "Touchdowns"), `1.00 expected/g regressed to ${(7 / 15).toFixed(2)} (last season 0.00)`);
});

test("TD regression: a prior under priorMinGames (or 0 games) is not a baseline; the position mean is, with no NaN", () => {
  for (const g of [0, 1, V4.priorMinGames - 1]) {
    const p = rawPlayer(`short${g}`, "RB", { weeks: games(7, { rushYd: 70, rushTd: 1 }, { rushYd: 70, rushTd: 1 }, { targets: 0, carries: 16, airYards: 0 }), prior: { games: g, line: line(g ? { rushYd: 50 * g, rushTd: 3 * g } : {}) } });
    const val = valuePlayers(L(), [...POOL, p]);
    noNaN(val, p.id);
    assert.match(whyOf(val, p.id, "Touchdowns") ?? "", /\(RB average \d\.\d\d\)$/, `${g}-game prior`);
    assert.equal(whyOf(val, p.id, "2025"), undefined, `${g}-game prior: no prior blend`);
  }
});

test("TD regression: the missing-expected path (TD-heavy actual points, no usage data) is not regressed and stays finite", () => {
  const p = rawPlayer("ghostTd", "WR", { weeks: games(5, { rec: 3, recYd: 40, recTd: 2 }, {}, { targets: 4, carries: 0, airYards: 30 }) });
  const val = valuePlayers(L(), [...POOL, p]);
  noNaN(val, "ghostTd");
  assert.ok(whyOf(val, "ghostTd", "Usage data"), "fixture: on the actual-points fallback");
  assert.equal(whyOf(val, "ghostTd", "Touchdowns"), undefined);
  assert.ok(modelOf(val, "ghostTd") > 15, `rate from actual points (19/g): ${modelOf(val, "ghostTd")}`);
});

test("TD regression on a QB: passing TDs regress in the league's pass-TD points (4), not 6", () => {
  const a = { passYd: 250, passTd: 3 };
  const qb = rawPlayer("qbTd", "QB", { weeks: games(7, a, a), prior: { games: 16, line: line({ passYd: 250 * 16, passTd: 1.5 * 16 }) } });
  const on = valuePlayers(L(), [...POOL, qb]);
  const off = withV4({ tdK: 0 }, () => valuePlayers(L(), [...POOL, qb]));
  noNaN(on, "qbTd");
  const reg = (7 * 3 + V4.tdK * 1.5) / (7 + V4.tdK);
  assert.equal(whyOf(on, "qbTd", "Touchdowns"), `3.00 expected/g regressed to ${reg.toFixed(2)} (last season 1.50)`);
  // cur drops by 4 × (3 − reg); the prior blend keeps 7 / (7 + priorK) of it.
  const want = (4 * (3 - reg) * 7) / (7 + V4.priorK);
  const got = modelOf(off, "qbTd") - modelOf(on, "qbTd");
  assert.ok(Math.abs(got - want) <= 0.11, `QB model drop ${got.toFixed(2)} vs ${want.toFixed(2)}`);
});

test("small-sample prior and TD regression compose without double counting beyond the documented formulas (3-game RB)", () => {
  const a = { rushYd: 70, rushTd: 1 };
  const p = rawPlayer("comp", "RB", { weeks: games(3, a, a, { targets: 0, carries: 16, airYards: 0 }), prior: { games: 16, line: line({ rushYd: 70 * 16, rushTd: 0.25 * 16 }) } });
  const val = valuePlayers(L(), [...POOL, p]);
  noNaN(val, "comp");
  const tdReg = (3 * 1 + V4.tdK * 0.25) / (3 + V4.tdK);
  const cur = 7 + 6 * tdReg; // non-TD 7 + regressed TD points
  const prior = 7 + 6 * 0.25;
  const w = Math.max(V4.priorK, V4.priorKSmall - 3);
  assert.match(whyOf(val, "comp", "2025")!, new RegExp(`counts as ${w} games`));
  assert.ok(Math.abs(modelOf(val, "comp") - (3 * cur + w * prior) / (3 + w)) <= 0.06, `model ${modelOf(val, "comp")}`);
  // Effective weight on this season's own TD rate: 3/11 × 3/8 ≈ 10% (documented here; see report).
});

test("FINDING prior weight exceeds the prior's own games: a 4-game 2025 counts as 5 games next to 3 games this season", { todo: "finding: cap priorWeight at the prior's games" }, () => {
  const p = rawPlayer("soph", "WR", {
    weeks: games(3, { rec: 7, recYd: 80 }, { rec: 7, recYd: 80 }, { targets: 9, carries: 0, airYards: 90 }),
    prior: { games: 4, line: line({ rec: 2 * 4, recYd: 20 * 4 }) },
  });
  const val = valuePlayers(L(), [...POOL, p]);
  const n = Number(whyOf(val, "soph", "2025")!.match(/counts as ([\d.]+) games/)![1]);
  assert.ok(n <= 4, `a 4-game prior counts as ${n} pseudo-games`);
});

test("FINDING TD regression lifts a 1-game backup QB to a starter's TD rate while his non-TD part stays a backup's", { todo: "finding: regress TD per opportunity, or with the same shrink on the non-TD part" }, () => {
  const b = rawPlayer("bkQb", "QB", { weeks: games(1, { passYd: 90, passTd: 0 }, { passYd: 90, passTd: 0.1 }) });
  const on = valuePlayers(L(), [...POOL, b]);
  const off = withV4({ tdK: 0 }, () => valuePlayers(L(), [...POOL, b]));
  const lift = modelOf(on, "bkQb") - modelOf(off, "bkQb");
  assert.ok(lift <= 2, `1-game backup QB (90 yds, 0.1 xTD) lifted +${lift.toFixed(1)} pts/g by the QB TD mean: ${whyOf(on, "bkQb", "Touchdowns")}`);
});

// ---------------------------------------------------------------- 3. cover lost with two FLEX slots, K / DEF

const S = league([], OWNER, { currentWeek: 8 }).settings;
/** A TeamV3 with just what coverLost reads (lineup from optimalLineup on the owner's slots). */
function myTeam(roster: ValuedPlayer[], irIds: Set<string> = new Set()): TeamV3 {
  const base = optimalLineup(S.slots, roster, { irIds });
  const starterList = base.lineup.map((l) => l.player).filter((p): p is ValuedPlayer => !!p);
  return { roster, base, irIds, starters: new Set(starterList.map((p) => p.id)), starterList } as unknown as TeamV3;
}
const Pl = (id: string, pos: Position, ppg: number, bye = 5) => vp(id, pos, ppg, ppg, { bye, remainingGames: 10 });
const core = () => [Pl("qb", "QB", 20), Pl("wr1", "WR", 16), Pl("wr2", "WR", 15), Pl("rb1", "RB", 14), Pl("k", "K", 8), Pl("def", "DEF", 7)];
const labelsOf = (items: { label: string; value: string }[], label: string) => items.filter((d) => d.label === label).map((d) => d.value);

test("cover, two FLEX: TE starter's bye with a TE at FLEX → the cover is the best bench W/R/T; giving it is flagged", () => {
  const roster = [...core(), Pl("te1", "TE", 13, 15), Pl("te2", "TE", 12.5), Pl("wr3", "WR", 12), Pl("wrB", "WR", 10), Pl("teB", "TE", 4), Pl("rbB", "RB", 6)];
  const my = myTeam(roster);
  const slot = (id: string) => my.base.lineup.find((l) => l.player?.id === id)?.slot;
  assert.equal(slot("te1"), "TE");
  assert.equal(slot("te2"), "FLEX");
  assert.equal(slot("wr3"), "FLEX");
  const get = [Pl("x", "WR", 5)];
  assert.deepEqual(labelsOf(coverLost(S, my, [roster.find((p) => p.id === "wrB")!], get), "Bye cover lost"), ["wrB covers te1's week 15 bye (10.0 pts)"]);
  // The bench TE is not that cover (and the FLEX TE is a TE backup): nothing.
  assert.deepEqual(coverLost(S, my, [roster.find((p) => p.id === "teB")!], get), []);
  // Both other TEs given: now "only TE backup" is true.
  assert.equal(labelsOf(coverLost(S, my, roster.filter((p) => p.id === "teB" || p.id === "te2"), get), "Playoff cover lost").length, 1);
});

test("cover, two FLEX: the FLEX TE on bye the same week as the TE starter is no cover → the bench TE is", () => {
  const roster = [...core(), Pl("te1", "TE", 13, 15), Pl("te2", "TE", 12.5, 15), Pl("wr3", "WR", 12), Pl("wrB", "WR", 10), Pl("teB", "TE", 4), Pl("rbB", "RB", 6)];
  const my = myTeam(roster);
  const items = labelsOf(coverLost(S, my, [roster.find((p) => p.id === "teB")!], [Pl("x", "WR", 5)]), "Bye cover lost");
  assert.ok(items.some((v) => /^teB covers te1's week 15 bye/.test(v)), JSON.stringify(items));
});

test("cover: K / DEF starters' byes and backups never produce cover items (streamed), and nothing throws", () => {
  const roster = [...core().map((p) => (p.pos === "K" ? { ...p, bye: 15 } : p)), Pl("te1", "TE", 13), Pl("k2", "K", 7), Pl("def2", "DEF", 6), Pl("wrB", "WR", 10)];
  const my = myTeam(roster);
  assert.deepEqual(coverLost(S, my, roster.filter((p) => p.id === "k2" || p.id === "def2"), [Pl("x", "WR", 5)]), []);
});

test("FINDING cover: giving the FLEX TE who covers the TE starter's playoff bye is not flagged (only a 4-pt TE is left)", { todo: "finding: the FLEX mate given away is a lost bye cover" }, () => {
  const roster = [...core(), Pl("te1", "TE", 13, 15), Pl("te2", "TE", 12.5), Pl("wr3", "WR", 12), Pl("wrB", "WR", 10), Pl("teB", "TE", 4), Pl("rbB", "RB", 6)];
  const my = myTeam(roster);
  const items = coverLost(S, my, [roster.find((p) => p.id === "te2")!], [Pl("x", "WR", 5)]);
  assert.ok(items.some((d) => d.label === "Bye cover lost" && /te1's week 15 bye/.test(d.value)), JSON.stringify(items));
});
