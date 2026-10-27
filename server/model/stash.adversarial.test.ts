// ADVERSARIAL tests (tester, not developer) for Model v4 release (c): projection v4 around a return (0 before,
// × 0.85 first game back, full after, bye, playoffs, playoffPts consistency) and Stash watch (server/model/stash.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyTables, signalInputFromPlayer, valuePlayers, type ProjectionTables } from "./projectionV4.js";
import { computePlayerSignals } from "./signals/index.js";
import { ASOF, PPR } from "../data/fixtures/signals2026.js";
import { detailProblems, league, line, rawPlayer, team, vp } from "./testkit.js";
import { STASH_WATCH, stashWatch, type StashInput } from "./stash.js";
import type { Availability, Player, Position, ReturnInfo, StatLine, ValuedPlayer, WeekLine } from "./types.js";
import type { RosterInfo, StatusWeek } from "./signals/types.js";

const FULL = "Full Participation in Practice";
const wk = (week: number, actual: Partial<StatLine>): WeekLine => ({
  season: 2026, week, team: "KC", actual: line(actual), expected: line(actual), opp: { targets: 0, carries: 0, airYards: 0 },
});
const games = (weeks: number[], actual: Partial<StatLine>) => weeks.map((w) => wk(w, actual));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
function filler(pos: Position, n: number, upTo: number): Player[] {
  return Array.from({ length: n }, (_, i) =>
    rawPlayer(`${pos}${i + 1}`, pos, { ecrPos: i + 1, weeks: games(range(1, upTo), { recYd: 110 - i * 2.2, rec: 6 - i * 0.1, rushYd: pos === "RB" ? 70 - i : 0, passYd: pos === "QB" ? 280 - i * 3 : 0 }) }),
  );
}
const pool = (upTo: number) => [...filler("QB", 30, upTo), ...filler("RB", 45, upTo), ...filler("WR", 45, upTo), ...filler("TE", 30, upTo)];
const sigOf = (p: Player, roster: RosterInfo, status: StatusWeek[] = []) =>
  [p.id, computePlayerSignals({ ...signalInputFromPlayer(p)!, roster, status }, { season: 2026, scoring: PPR, asOf: ASOF })] as const;
function run(cw: number, extra: Player[], sigs: (readonly [string, ReturnType<typeof computePlayerSignals>])[]) {
  const tables: ProjectionTables = { ...emptyTables(), signals: new Map(sigs) };
  return valuePlayers(league([team("a", [])], undefined, { currentWeek: cw, numTeams: 12 }), [...pool(cw - 1), ...extra], tables);
}
const wkIdx = (p: ValuedPlayer, w: number) => w - (p.weeklyFrom ?? 0);
const STRONG = { rec: 8, recYd: 110, recTd: 0.3 };

test("a vet on IR all season, unranked by the experts, practising fully (designated to return): projected > 0 after his return week", () => {
  // No 2026 game, a strong 2025 (16 games), no ECR rank (rankings drop injured players), R48 + full practice now.
  const vet = rawPlayer("vet", "WR", { prior: { games: 16, line: line({ rec: 16 * 7, recYd: 16 * 95, recTd: 16 * 0.5 }) } });
  const val = run(8, [vet], [sigOf(vet, { status: "RES", statusCode: "R48" }, [{ week: 7, practice: "Limited Participation in Practice", report: "Out" }, { week: 8, practice: FULL, report: "Questionable" }])]);
  const v = val.players.get("vet")!;
  assert.ok(v.ret && v.ret.week !== null, `return estimate ${JSON.stringify(v.ret?.week)}`);
  assert.ok((v.ret!.healthyRate ?? 0) > 10, `healthy rate ${v.ret!.healthyRate}`);
  const after = v.weekly!.slice(wkIdx(v, v.ret!.week! + 1));
  assert.ok(after.some((x) => x > 0), `back ~wk ${v.ret!.week}, healthy ${v.ret!.healthyRate} pts/g, Stash playoff pts ${v.ret!.playoffPts}, yet projected weekly after his return = [${after.join(", ")}] (playoffPts ${v.playoffPts}, value ${v.value})`);
});

test("known return: Stash / hold 'playoff pts' (healthy rate) and the projection's playoffPts describe the same weeks — measure the gap", () => {
  // A strong WR hurt after week 3, ECR rank already dropped to WR60 (it prices the absence), full practice now.
  const star = rawPlayer("star", "WR", { ecrPos: 60, weeks: games([1, 2, 3], STRONG) });
  const val = run(8, [star], [sigOf(star, { status: "RES", statusCode: "R48" }, [{ week: 7, practice: "Limited Participation in Practice", report: "Out" }, { week: 8, practice: FULL, report: "Questionable" }])]);
  const s = val.players.get("star")!;
  assert.equal(s.ret!.week, 8);
  const gap = Math.abs(s.ret!.playoffPts! - (s.playoffPts ?? 0)) / Math.max(1, s.ret!.playoffPts!);
  // DESIGN un-anchors the healthy rate ("anchoring would count the injury twice") — the projection still anchors, so
  // the same player shows two playoff numbers. Tolerance 10%.
  assert.ok(gap <= 0.1, `My Team hold / Stash shows ${s.ret!.playoffPts} playoff pts, Values / lineups use ${s.playoffPts} (${(gap * 100).toFixed(0)}% apart)`);
});

test("return in the playoffs (IR floor to week 17): 0 through week 16, × 0.85 in week 17, playoffPts = that one game", () => {
  const p = rawPlayer("late", "WR", { ecrPos: 20, weeks: games(range(1, 12), STRONG) });
  const twin = rawPlayer("twin", "WR", { ecrPos: 20, weeks: games(range(1, 12), STRONG) });
  // Placed on IR after week 12 (current week 13, missed 0) → 4 games to miss (13–16) → eligible week 17.
  const val = run(13, [p, twin], [sigOf(p, { status: "RES", statusCode: "R01" }, [{ week: 13, practice: FULL }]), sigOf(twin, { status: "ACT" })]);
  const v = val.players.get("late")!;
  const h = val.players.get("twin")!;
  assert.equal(v.ret!.week, 17, JSON.stringify(v.ret));
  assert.deepEqual(v.weekly!.slice(0, 4), [0, 0, 0, 0]);
  // Fix round 2: an absent player with a sample skips the ECR anchor, so week 17 = 0.85 × his own healthy rate
  // (the twin keeps the anchor); the twin stays as the sanity bound.
  assert.ok(Math.abs(v.weekly![wkIdx(v, 17)] - 0.85 * v.ret!.healthyRate!) < 0.06, `wk 17 ${v.weekly![wkIdx(v, 17)]} vs 0.85 × ${v.ret!.healthyRate}`);
  assert.ok(Math.abs(v.ret!.healthyRate! - h.weekly![wkIdx(h, 17)]) < 0.15 * h.weekly![wkIdx(h, 17)], "healthy rate near the healthy twin's");
  assert.ok(Math.abs((v.playoffPts ?? 0) - v.weekly![wkIdx(v, 17)]) < 0.051);
  assert.ok(v.ret!.week! <= 17 && v.ret!.week! >= 13);
});

test("one-game Out with a bye right after: the bye is 0, the game after it is full (no ramp after a one-game absence)", () => {
  const p = rawPlayer("o", "RB", { ecrPos: 10, bye: 9, injury: { status: "O", detail: "Ankle", week: 8 }, weeks: games(range(1, 7), { rushYd: 80, rec: 3, recYd: 20 }) });
  const twin = rawPlayer("t", "RB", { ecrPos: 10, bye: 9, weeks: games(range(1, 7), { rushYd: 80, rec: 3, recYd: 20 }) });
  const val = run(8, [p, twin], []);
  const v = val.players.get("o")!;
  const h = val.players.get("t")!;
  assert.equal(v.ret!.week, 10, "week 9 is his bye: back week 10");
  assert.equal(v.weekly![0], 0);
  assert.equal(v.weekly![1], 0);
  assert.equal(v.weekly![2], h.weekly![2], "full in week 10");
});

test("unknown return: 0 in every week (lineups / value), returnValue only for stash; no NaN anywhere in ret", () => {
  const p = rawPlayer("ir", "WR", { ecrPos: 25, injury: { status: "IR", week: 8 }, weeks: games([1, 2, 3], STRONG) });
  const val = run(8, [p], [sigOf(p, { status: "RES", statusCode: "R01" })]);
  const v = val.players.get("ir")!;
  assert.equal(v.ret!.week, null);
  assert.ok(v.weekly!.every((x) => x === 0));
  assert.equal(v.value, 0);
  assert.equal(v.remainingGames, 0);
  assert.ok(v.ret!.returnValue! > 0);
  for (const x of val.players.values()) {
    if (!x.ret) continue;
    for (const k of ["healthyRate", "returnValue", "playoffPts", "stashScore", "tradeValue"] as const) {
      const n = x.ret[k];
      if (n !== undefined) assert.ok(Number.isFinite(n) && n >= 0, `${x.id}.ret.${k}=${n}`);
    }
    if (x.ret.week !== null) assert.ok(x.ret.week >= 8 && x.ret.week <= 17, `${x.id}: week ${x.ret.week}`);
  }
});

// ---------------------------------------------------------------- stashWatch on hand-built ValuedPlayers

const RET = (o: Partial<ReturnInfo> = {}): ReturnInfo => ({
  week: 11, confidence: "medium", reasons: [{ label: "Read", value: "limited practice: back next game" }], absent: true, practiceUp: false,
  healthyRate: 12, healthySource: "season", playoffPts: 30, stashScore: 25, ...o,
});
const inj = (id: string, pos: Position, o: Partial<ReturnInfo> = {}, extra: Partial<ValuedPlayer> = {}) => vp(id, pos, 0, 0, { ret: RET(o), injury: { status: "IR", week: 8 }, ...extra });
const FLEX = { QB: 19, RB: 10, WR: 8.6, TE: 8 };
const input = (players: ValuedPlayer[], o: Partial<StashInput> = {}): StashInput => ({
  players, rostered: new Set(), availability: new Map(players.map((p) => [p.id, "fa" as Availability])), flexLevel: FLEX, regularSeasonEnd: 14, finalWeek: 17, ...o,
});

test("stash: at most 10 rows, ranked by stash score; the flex floor is inclusive, just below is out; K / DEF / no NFL team / no score are out", () => {
  const many = range(1, 15).map((i) => inj(`w${i}`, "WR", { stashScore: i, healthyRate: 9 + i / 10 }));
  const rows = stashWatch(input(many));
  assert.equal(rows.length, STASH_WATCH.limit);
  assert.deepEqual(rows.map((r) => r.id), range(6, 15).reverse().map((i) => `w${i}`));
  const edge = [inj("at", "WR", { healthyRate: 8.6 }), inj("below", "WR", { healthyRate: 8.59 }), inj("k", "K"), inj("d", "DEF"), inj("fa", "WR", {}, { team: "FA" }), inj("zero", "WR", { stashScore: 0 }), inj("noRate", "WR", { healthyRate: undefined })];
  assert.deepEqual(stashWatch(input(edge)).map((r) => r.id), ["at"]);
});

test("stash: 'Add now while free' only for a free agent; waivers → claim-cheap (FAAB: bid); unknown → check", () => {
  const ps = [inj("a", "WR"), inj("b", "WR"), inj("c", "WR")];
  const rows = stashWatch(input(ps, { availability: new Map<string, Availability>([["a", "fa"], ["b", "waivers"]]) }));
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.a.call, "add");
  assert.equal(by.b.call, "claim-cheap");
  assert.equal(by.c.call, "check");
  assert.equal(by.c.availability, "unknown");
  for (const r of rows) if (r.call !== "add") assert.doesNotMatch(r.callText + JSON.stringify(r.details), /Add now|free today/, r.id);
  const faab = stashWatch(input([inj("b", "WR")], { availability: new Map([["b", "waivers"]]), usesFaab: true }));
  assert.match(faab[0].callText, /bid/);
  assert.doesNotMatch(faab[0].callText, /priority/);
});

test("stash: practice flag iff ret.practiceUp; rows ≤ 255 even with a huge name; every detail ≤ 90 with no ';' / '·' chain", () => {
  const long = "X".repeat(300);
  const reasons = [
    { label: "IR minimum", value: "4 games: missed 1, eligible from wk 12" },
    { label: "Missed", value: "all 7 of his team's games this season" },
    { label: "Practice", value: "wk 8: did not practice → limited, game status Questionable", tone: "pos" as const },
  ];
  const rows = stashWatch(input([inj("up", "RB", { practiceUp: true, reasons }), inj("flat", "RB", { reasons }, { name: long }), inj("u", "TE", { week: null, confidence: "unknown", earliestWeek: 12, reasons: [{ label: "Return", value: "on a reserve list, not practising: return unconfirmed", tone: "warn" }] })]));
  for (const r of rows) {
    assert.equal(!!r.flag, r.id === "up", `${r.id}: flag ${r.flag}`);
    assert.ok(r.summary.length <= 255, `${r.id}: ${r.summary.length}`);
    assert.deepEqual(detailProblems(r.details), [], r.id);
    assert.ok(!r.details.some((d) => d.label === "Return" && /on a reserve list/.test(d.value)), `${r.id}: the estimator's own Return bullet is replaced, not repeated`);
  }
  const u = rows.find((r) => r.id === "u")!;
  assert.ok(u.details.some((d) => d.label === "Return" && /unconfirmed, wk 12 at the earliest/.test(d.value)));
  assert.match(u.summary, /return unconfirmed/);
});

test("stash: a strong-role returner outranks a healthy low-role player with no snaps (both unrostered)", () => {
  const star = inj("star", "WR", { healthyRate: 18, stashScore: 40, playoffPts: 45 });
  // Not listed, 0 snaps the last 2 games, but his healthy role is below the WR flex level: never a stash.
  const scrub = vp("scrub", "WR", 6, 2, { ret: RET({ week: null, confidence: "unknown", absent: false, healthyRate: 6, stashScore: 5, playoffPts: 4 }) });
  // Same 0-snap rule at flex level ranks below the star.
  const mid = vp("mid", "WR", 9, 5, { ret: RET({ week: null, confidence: "unknown", absent: false, healthyRate: 9, stashScore: 8, playoffPts: 9 }) });
  assert.deepEqual(stashWatch(input([scrub, mid, star])).map((r) => r.id), ["star", "mid"]);
});

test("caller omits the unmatched list: a rostered player the import name matcher failed on shows, but only as 'check'", () => {
  // `rostered` comes from team.playerIds only; an unmatched roster line is a name in team.unmatched (api.ts passes it).
  const l = league([team("a", ["owner1"], { unmatched: ["Star Receiver"] })]);
  const rostered = new Set(l.teams.flatMap((t) => t.playerIds));
  const star = inj("star", "WR", { healthyRate: 18, stashScore: 40 }, { name: "Star Receiver" });
  // The import's free-agent list never holds a rostered player, so his availability is unknown → "check".
  const rows = stashWatch(input([star], { rostered, availability: new Map() }));
  assert.equal(rows.length, 1, "he is listed in Stash watch although someone rosters him");
  assert.equal(rows[0].call, "check", "severity bound: never 'Add now while free', only 'Status unknown — add only if he is a free agent'");
  // If the league source DID list him (stale FA capture), he would be an outright "Add now while free".
  const stale = stashWatch(input([star], { rostered, availability: new Map([["star", "fa"]]) }));
  assert.equal(stale[0].call, "add");
});

test("a rostered-but-unmatched player (team.unmatched) must not appear in Stash watch", () => {
  const l = league([team("a", ["owner1"], { unmatched: ["Star Receiver"] })]);
  const rostered = new Set(l.teams.flatMap((t) => t.playerIds));
  const unmatched = l.teams.flatMap((t) => t.unmatched);
  const star = inj("star", "WR", { healthyRate: 18, stashScore: 40 }, { name: "Star Receiver" });
  assert.deepEqual(stashWatch(input([star], { rostered, unmatched, availability: new Map() })).map((r) => r.id), []);
  // Import / Yahoo spellings "Name (POS, TEAM)" / "Name (POS)": name + position must both match; "?" = name only.
  const by = (u: string[]) => stashWatch(input([star], { rostered, unmatched: u, availability: new Map() })).map((r) => r.id);
  assert.deepEqual(by(["Star Receiver Jr. (WR, NYJ)"]), []);
  assert.deepEqual(by(["star receiver (?)"]), []);
  assert.deepEqual(by(["Star Receiver (RB)"]), ["star"], "same name, other position: a different player");
});
