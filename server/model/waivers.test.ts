import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { capRows, claimThreshold, gapLines, KDEF_STREAM, makeSummary, rankWaivers, snapTrendOf, thesisItems, toWaiverRow, weakPositions } from "./waivers.js";
import { analyzeTeams } from "./analysis.js";
import { detailProblems, league, summaryProblems, team, vp } from "./testkit.js";
import type { TradeContext } from "./tradeKit.js";
import type { ValuedPlayer, WaiverTarget } from "./types.js";

/** Everything the user can read for a row: the summary plus every details line. */
const txt = (t: WaiverTarget) => [t.summary, ...t.details.map((d) => `${d.label}: ${d.value}`)].join("\n");

const REPL = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
// 13 active slots (9 starters + 4 BN) + IRGUY → full roster, so every add needs a drop.
const mine = [
  vp("QB", "QB", 18, 10), vp("RB1", "RB", 14, 30), vp("RB2", "RB", 13, 26), vp("WR1", "WR", 12, 20), vp("WR2", "WR", 3, 0),
  vp("TE", "TE", 8, 5), vp("FLX", "RB", 9, 4), vp("K", "K", 8, 2), vp("DEF", "DEF", 7, 3),
  vp("BN1", "RB", 4, 0.4), vp("BN2", "WR", 2, 0.1), vp("BN3", "TE", 1, 0), vp("BN4", "QB", 1.5, 0), vp("IRGUY", "RB", 0, 0, { remainingGames: 0 }),
];
const other = [vp("oQB", "QB", 17, 8)];

/** My roster without a bench RB / WR / TE cover (bench = QBs): role claims there are not "trade chip only". */
const mineNoCover = mine.map((p) => (p.id === "BN1" || p.id === "BN2" || p.id === "BN3" ? { ...p, pos: "QB" as const } : p));

function ctxFor(ps: ValuedPlayer[], irIds: string[] = [], roster: ValuedPlayer[] = mine): TradeContext {
  const L = league([team("me", roster, { irPlayerIds: irIds }), team("o", other)], undefined, { numTeams: 12 });
  const players = new Map(ps.map((p) => [p.id, p]));
  return { league: L, players, teams: analyzeTeams(L, players, REPL) };
}

test("claim threshold scales with rolling-list priority", () => {
  assert.equal(claimThreshold(1, 12), 2.5);
  assert.equal(claimThreshold(12, 12), 1.0);
  assert.equal(claimThreshold(undefined, 12), 2.0);
});

test("claim for a big lineup gain; wait for a marginal waiver player below the 5th-best FA", () => {
  const ctx = ctxFor([...mine, ...other], ["IRGUY"]);
  const bigWr = vp("FA_WR", "WR", 10, 12);
  const fas = [bigWr, ...[9, 8, 7, 6, 5].map((v, i) => vp(`FA_TE${i}`, "TE", 6 + i * 0.1, v)), vp("FA_TE_low", "TE", 8.3, 1)];
  const r = rankWaivers(ctx, "me", fas.map((p) => ({ player: p, onWaivers: true })), { myPriority: 3 });
  const big = r.freeAgents.find((t) => t.id === "FA_WR")!;
  assert.equal(big.recommendation, "claim");
  assert.equal(big.gain, 7); // replaces the 3-ppg WR2
  assert.equal(big.drop?.id, "BN3"); // lowest value, never the IR player
  assert.match(txt(big), /uses your #3 priority \(you drop to #12\)/);
  const low = r.freeAgents.find((t) => t.id === "FA_TE_low")!;
  assert.equal(low.recommendation, "wait", txt(low));
  assert.match(r.advice, /#3 of 12/);
});

test("pass when not an upgrade; free agents cost no priority", () => {
  const ctx = ctxFor([...mine, ...other]);
  const meh = vp("FA_meh", "WR", 0.5, 0);
  const good = vp("FA_good", "RB", 12, 8);
  const r = rankWaivers(ctx, "me", [{ player: meh, onWaivers: true }, { player: good, onWaivers: false }], { myPriority: 1 });
  assert.equal(r.freeAgents.find((t) => t.id === "FA_meh")!.recommendation, "pass");
  const g = r.freeAgents.find((t) => t.id === "FA_good")!;
  assert.equal(g.recommendation, "claim");
  assert.match(txt(g), /add now, no priority cost/);
  assert.ok(r.freeAgents[0].rankScore >= r.freeAgents[1].rankScore);
});

test("never drops the only K / DEF; K streaming swaps the kicker", () => {
  const ctx = ctxFor([...mine, ...other]);
  const k = vp("FA_K", "K", 9.5, 4);
  const r = rankWaivers(ctx, "me", [{ player: k, onWaivers: false }]);
  assert.equal(r.freeAgents[0].drop?.id, "K");
  assert.equal(r.freeAgents[0].gain, 1.5);
  for (const t of rankWaivers(ctx, "me", [{ player: vp("FA_RB", "RB", 3, 0.2), onWaivers: false }]).freeAgents) {
    assert.ok(t.drop?.pos !== "K" && t.drop?.pos !== "DEF");
  }
});

test("snap trend = last week minus earlier average", () => {
  assert.equal(snapTrendOf({ snapShare: { 1: 0.5, 2: 0.6, 3: 0.8 } }), 0.25);
  assert.equal(snapTrendOf({ snapShare: { 1: 0.5 } }), 0);
});

test("claim/optional rows first; value-0 ties broken on vorp, not raw ppg", () => {
  const ctx = { ...ctxFor([...mine, ...other]), replacement: REPL };
  const zeroQb = vp("FA_QB0", "QB", 14, 0); // 14 ppg but QB repl 15 → vorp −1
  const zeroTe = vp("FA_TE0", "TE", 5.5, 0); // repl 6 → vorp −0.5
  const good = vp("FA_RB_ok", "RB", 9.5, 5); // bench upgrade → optional
  const r = rankWaivers(ctx, "me", [zeroQb, zeroTe, good].map((p) => ({ player: p, onWaivers: true })), { myPriority: 6 });
  assert.deepEqual(r.freeAgents.map((t) => t.recommendation), ["optional", "pass", "pass"]);
  assert.deepEqual(r.freeAgents.map((t) => t.id), ["FA_RB_ok", "FA_TE0", "FA_QB0"]);
});

test("wait rule compares ppg when the 5th-best FA has value 0", () => {
  const ctx = ctxFor([...mine, ...other]);
  // Six value-0 WRs that each start over my 3-ppg WR2 (gain 1.0–1.5, below the 1.8 claim threshold).
  const rbs = [4.5, 4.4, 4.3, 4.2, 4.1, 4.0].map((ppg, i) => vp(`R${i}`, "WR", ppg, 0, { vorp: 0 }));
  const r = rankWaivers(ctx, "me", rbs.map((p) => ({ player: p, onWaivers: true })), { myPriority: 6 });
  const rec = (id: string) => r.freeAgents.find((t) => t.id === id)!;
  assert.equal(rec("R5").recommendation, "wait", txt(rec("R5")));
  assert.match(txt(rec("R5")), /4\.1 ppg/);
  assert.notEqual(rec("R0").recommendation, "wait");
});

test("K / DEF never consume waiver priority", () => {
  const ctx = ctxFor([...mine, ...other]);
  const bigK = vp("FA_K", "K", 13, 10); // +5 ppg over my kicker: would be a claim for a skill player
  const onW = rankWaivers(ctx, "me", [{ player: bigK, onWaivers: true }], { myPriority: 1 }).freeAgents[0];
  assert.equal(onW.recommendation, "pass", txt(onW));
  const free = rankWaivers(ctx, "me", [{ player: bigK, onWaivers: false }], { myPriority: 1 }).freeAgents[0];
  assert.equal(free.recommendation, "optional", txt(free));
  const worse = rankWaivers(ctx, "me", [{ player: vp("FA_K2", "K", 7, 0), onWaivers: false }]).freeAgents[0];
  assert.equal(worse.recommendation, "pass");
});

test("breakout signals: rising + open path = future-starter claim; rising role without a path = stash; stash sorts above pass", () => {
  const ctx = ctxFor([...mineNoCover, ...other], ["IRGUY"], mineNoCover);
  // All three are below my bench on today's projection (no lineup or value gain).
  const future = vp("FA_FUT", "RB", 3.5, 0);
  const riser = vp("FA_RISE", "WR", 1.5, 0);
  const plain = vp("FA_PLAIN", "WR", 1.8, 0);
  const breakouts = new Map([
    ["FA_FUT", { tier: "rising" as const, score: 70, situation: 1, oppLevel: 11, thesis: "RB2 behind an injured starter." }],
    ["FA_RISE", { tier: "stash" as const, score: 55, situation: 0, oppLevel: 5, thesis: "Snaps up 20 points." }],
    // Blocking TE: strong score and an open path but almost no expected points: not even a stash.
    ["FA_PLAIN", { tier: "rising" as const, score: 64, situation: 1, oppLevel: 3.7, thesis: "Inline blocker." }],
  ]);
  const r = rankWaivers(ctx, "me", [future, riser, plain].map((p) => ({ player: p, onWaivers: true })), { myPriority: 3, breakouts });
  const by = (id: string) => r.freeAgents.find((t) => t.id === id)!;
  assert.equal(by("FA_FUT").recommendation, "claim", txt(by("FA_FUT")));
  assert.match(txt(by("FA_FUT")), /Future starter/);
  assert.match(txt(by("FA_FUT")), /RB2 behind an injured starter/);
  assert.equal(by("FA_FUT").breakout?.score, 70);
  assert.equal(by("FA_RISE").recommendation, "stash", txt(by("FA_RISE")));
  assert.equal(by("FA_PLAIN").recommendation, "pass");
  assert.deepEqual(r.freeAgents.map((t) => t.id), ["FA_FUT", "FA_RISE", "FA_PLAIN"]);
  assert.match(r.advice, /1 to stash/);
});

test("future starter needs score, path and flex-level expected points; the bar is per position", () => {
  const ctx = ctxFor([...mineNoCover, ...other], ["IRGUY"], mineNoCover);
  const sig = (oppLevel: number, score = 70, situation = 0.5) => ({ tier: "rising" as const, score, situation, oppLevel, thesis: "" });
  const cases: [string, "RB" | "WR" | "TE", ReturnType<typeof sig>, string][] = [
    ["rb_ok", "RB", sig(10), "claim"],
    ["rb_low_opp", "RB", sig(9.9), "stash"],
    ["te_ok", "TE", sig(8), "claim"],
    ["wr_no_path", "WR", sig(12, 70, 0), "stash"],
    ["wr_low_score", "WR", sig(12, 54), "stash"],
  ];
  const r = rankWaivers(
    ctx,
    "me",
    cases.map(([id, pos]) => ({ player: vp(id, pos, 1, 0), onWaivers: true })),
    { myPriority: 3, breakouts: new Map(cases.map(([id, , b]) => [id, b])) },
  );
  for (const [id, , , want] of cases) assert.equal(r.freeAgents.find((t) => t.id === id)!.recommendation, want, id);
});

test("an injured would-be claim on waivers becomes a stash (no priority spent sight unseen); as a free agent it stays a claim", () => {
  const ctx = ctxFor([...mine, ...other], ["IRGUY"]);
  const q = vp("FA_Q", "WR", 10, 12, { injury: { status: "Q", week: 4 } });
  const onW = rankWaivers(ctx, "me", [{ player: q, onWaivers: true }], { myPriority: 3 }).freeAgents[0];
  assert.equal(onW.recommendation, "stash", txt(onW));
  assert.match(txt(onW), /Confirm his status before spending priority/);
  const dnp = vp("FA_DNP", "WR", 10, 12, { injury: { status: "DNP", week: 4 } });
  assert.equal(rankWaivers(ctx, "me", [{ player: dnp, onWaivers: true }], { myPriority: 3 }).freeAgents[0].recommendation, "stash");
  const free = rankWaivers(ctx, "me", [{ player: q, onWaivers: false }], { myPriority: 3 }).freeAgents[0];
  assert.equal(free.recommendation, "claim");
  assert.match(txt(free), /no priority cost/);
});

test("every summary is 1–2 sentences ≤ 255 chars; every details item is one short idea", () => {
  const ctx = { ...ctxFor([...mine, ...other], ["IRGUY"]), replacement: REPL };
  const longName = "Christopher Reginald Montgomery-Smithfield Jr.";
  const fas = [
    vp("FA_WR", "WR", 10, 12, { name: longName }), vp("FA_Q", "WR", 10, 12, { injury: { status: "Q", week: 4, detail: "Hamstring strain, limited in practice all week" } }),
    vp("FA_K", "K", 13, 10), vp("FA_DEF", "DEF", 9, 4), vp("FA_meh", "WR", 0.5, 0), vp("A.J._X", "WR", 4.4, 0, { name: "A.J. St. Brown Jr." }),
    vp("FA_FUT", "RB", 3.5, 0), vp("FA_RISE", "WR", 1.5, 0), vp("FA_TE", "TE", 6.5, 3),
  ];
  const thesis = "WR3 by snaps (depth chart says WR4) behind Somebody Long-Name (Q, hamstring); snaps 31%→45%→62%; targets 3→5→8; 9.1 expected vs 6.0 actual ppg; value ~0 (waiver-level).";
  const breakouts = new Map([
    ["FA_FUT", { tier: "rising" as const, score: 70, situation: 1, oppLevel: 11, thesis }],
    ["FA_RISE", { tier: "stash" as const, score: 55, situation: 0, oppLevel: 5, thesis }],
  ]);
  for (const [faab, priority] of [[false, 3], [false, 12], [false, undefined], [true, undefined]] as const) {
    const c = faab ? { ...ctx, league: { ...ctx.league, settings: { ...ctx.league.settings, usesFaab: true, faabBudget: 100 } } } : ctx;
    for (const onWaivers of [true, false]) {
      const r = rankWaivers(c, "me", fas.map((p) => ({ player: p, onWaivers })), { myPriority: priority, breakouts });
      assert.deepEqual(summaryProblems(r.advice), [], r.advice);
      assert.deepEqual(detailProblems(r.rules), []);
      for (const t of r.freeAgents) {
        assert.deepEqual(summaryProblems(t.summary), [], `${t.id}: ${t.summary}`);
        assert.deepEqual(detailProblems(t.details), [], t.id);
      }
    }
  }
});

test("thesis splits into one item per fact (no ';' chain) and drops the price", () => {
  const items = thesisItems("RB2 behind X (Q); snaps 40%→62%; touch opps 8→12; 9.1 expected vs 6.0 actual ppg; value ~0 (waiver-level).");
  assert.deepEqual(items, [
    { label: "Depth chart", value: "RB2 behind X (Q)" },
    { label: "Snaps by week", value: "40% → 62%" },
    { label: "Touches by week", value: "8 → 12" },
    { label: "Production", value: "6.0 actual vs 9.1 expected ppg" },
  ]);
});

test("summary leads with the fact; free agents say no priority cost and sort with waiver players by call", () => {
  const ctx = ctxFor([...mine, ...other], ["IRGUY"]);
  const freeClaim = vp("FA_free", "WR", 10, 12);
  const wOptional = vp("FA_wopt", "RB", 9.5, 5);
  const r = rankWaivers(ctx, "me", [{ player: wOptional, onWaivers: true }, { player: freeClaim, onWaivers: false }], { myPriority: 3 });
  assert.deepEqual(r.freeAgents.map((t) => t.id), ["FA_free", "FA_wopt"]);
  const f = r.freeAgents[0];
  assert.equal(f.availability, "fa");
  assert.match(f.summary, /^Starts at WR2 over WR2 \(\+7\.0 ppg\)\. Free agent: add now, no priority cost\.$/);
  assert.equal(r.freeAgents[1].availability, "waivers");
  assert.match(r.advice, /^You hold waiver priority #3 of 12\. /);
  assert.match(r.advice, /1 free to add now \(FA_free\)/);
  assert.equal(r.faStatusKnown, true);
});

test("unknown availability (old import) is treated as on waivers and flagged", () => {
  const ctx = ctxFor([...mine, ...other], ["IRGUY"]);
  const r = rankWaivers(ctx, "me", [{ player: vp("FA_x", "WR", 10, 12), onWaivers: true, availability: "unknown" }], { myPriority: 3 });
  assert.equal(r.faStatusKnown, false);
  assert.equal(r.freeAgents[0].availability, "unknown");
  assert.equal(r.freeAgents[0].onWaivers, true);
  assert.match(r.freeAgents[0].summary, /uses your #3 priority/);
});

test("makeSummary: no double period after a name ending in Jr.; drops the action sentence when too long", () => {
  assert.equal(makeSummary("Worth more than Harold Fannin Jr..", "Claim him."), "Worth more than Harold Fannin Jr. Claim him.");
  const lead = `${"x".repeat(200)}.`;
  assert.equal(makeSummary(lead, "y".repeat(80)), lead);
});

test("capRows: the best rows overall plus the best few of every position, in order", () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `wr${i}`, pos: "WR" as const })),
    { id: "k0", pos: "K" as const },
    { id: "k1", pos: "K" as const },
    { id: "def0", pos: "DEF" as const },
  ];
  assert.deepEqual(capRows(rows, 4, 1).map((r) => r.id), ["wr0", "wr1", "wr2", "wr3", "k0", "def0"]);
  assert.equal(capRows(rows, 20, 1).length, rows.length);
});

test("long-term injured (IR, Out (ACL)): never a claim; out for the season → pass; FAAB free agents never say priority", () => {
  const ctx = ctxFor([...mine, ...other], ["IRGUY"]);
  const fas = [
    vp("IR_BACK", "WR", 10, 12, { injury: { status: "IR", week: 4 } }),
    vp("ACL_DONE", "WR", 10, 12, { injury: { status: "Out", detail: "ACL", week: 4 }, remainingGames: 0 }),
  ];
  const r = rankWaivers(ctx, "me", fas.map((p) => ({ player: p, onWaivers: true })), { myPriority: 3 });
  const by = Object.fromEntries(r.freeAgents.map((t) => [t.id, t]));
  assert.equal(by.IR_BACK.recommendation, "stash");
  assert.match(by.IR_BACK.summary, /confirm/i);
  assert.equal(by.ACL_DONE.recommendation, "pass");
  assert.match(by.ACL_DONE.summary, /out for the season/i);
  const faab = league([team("me", mine, { irPlayerIds: ["IRGUY"], faabRemaining: 50 }), team("o", other)], undefined, { numTeams: 12, usesFaab: true, faabBudget: 100 });
  const players = new Map([...mine, ...other].map((p) => [p.id, p]));
  const f = rankWaivers({ league: faab, players, teams: analyzeTeams(faab, players, REPL) }, "me", [{ player: vp("FREE", "WR", 10, 12), onWaivers: false }]);
  assert.doesNotMatch(txt(f.freeAgents[0]), /priority/i);
});

test("IR slot: a healthy IR-slotted starter never counts in the base lineup, so an add is scored against his backup", () => {
  const fa = vp("FA_WR", "WR", 10, 12);
  const gainWith = (ir: string[]) =>
    rankWaivers(ctxFor([...mine, ...other], ir), "me", [{ player: fa, onWaivers: false }], { myPriority: 3 }).freeAgents.find((t) => t.id === "FA_WR")!.gain;
  assert.equal(gainWith(["IRGUY"]), 7, "WR1 starts: the add replaces the 3-ppg WR2");
  assert.equal(gainWith(["IRGUY", "WR1"]), 8, "WR1 on IR: the add replaces the 2-ppg bench WR who filled in");
});

test("waiver details explain luck (+ = due for more) and rising usage", () => {
  const ctx = ctxFor([...mine, ...other]);
  const due = vp("FA_due", "WR", 10, 12, { luck: 2.4, label: "buy-low", riser: true });
  const lucky = vp("FA_lucky", "WR", 9, 10, { luck: -2.8, label: "sell-high" });
  const r = rankWaivers(ctx, "me", [due, lucky].map((p) => ({ player: p, onWaivers: true })), { myPriority: 3 });
  const d = r.freeAgents.find((t) => t.id === "FA_due")!;
  assert.ok(d.details.some((x) => x.label === "Luck" && /buy-low/.test(x.value) && x.tone === "pos"), txt(d));
  assert.ok(d.details.some((x) => x.label === "Opportunity" && /Rising/.test(x.value)));
  const l = r.freeAgents.find((t) => t.id === "FA_lucky")!;
  assert.ok(l.details.some((x) => x.label === "Luck" && /sell-high/.test(x.value)), txt(l));
  assert.deepEqual(detailProblems(d.details), []);
});

// ------------------------------------------------------------------ import v6: K / DEF streaming on Yahoo's week projections
/** My roster with this week's Yahoo projection on my K (7.5) and DEF (4.0); null = not captured. */
function streamCtx(myK: number | null = 7.5, myDef: number | null = 4.0) {
  const roster = mine.map((p) =>
    p.id === "K" ? { ...p, ...(myK !== null ? { yahooProjWeekly: myK } : {}) } : p.id === "DEF" ? { ...p, ...(myDef !== null ? { yahooProjWeekly: myDef } : {}) } : p,
  );
  const L = league([team("me", roster, { irPlayerIds: ["IRGUY"] }), team("o", other)], undefined, { numTeams: 12 });
  const players = new Map([...roster, ...other].map((p) => [p.id, p]));
  return { league: L, players, teams: analyzeTeams(L, players, REPL) } as TradeContext;
}
const DEFS = () => [
  // Lower season numbers than my DEF (ppg 7): on season numbers alone each would be "pass".
  vp("D_best", "DEF", 6, 1, { yahooProjWeekly: 7.1, weekOpponent: "@ NYJ" }),
  vp("D_ok", "DEF", 6.5, 1, { yahooProjWeekly: 5.2 }),
  vp("D_small", "DEF", 6.8, 1, { yahooProjWeekly: 4.6 }),
  vp("D_wv", "DEF", 6, 1, { yahooProjWeekly: 9.0 }),
  vp("D_none", "DEF", 6.9, 1),
];
const run = (ctx: TradeContext, fas: ValuedPlayer[], waivers: string[] = ["D_wv"]) =>
  rankWaivers(ctx, "me", fas.map((p) => ({ player: p, onWaivers: waivers.includes(p.id) })), { myPriority: 3, limit: 50, perPosition: 10 });
const byId = (r: ReturnType<typeof rankWaivers>, id: string) => r.freeAgents.find((t) => t.id === id)!;

test("K/DEF streaming: both have Yahoo's week projection → gain = their difference; the best free DEF is named", () => {
  const r = run(streamCtx(), [...DEFS(), vp("K_free", "K", 6, 1, { yahooProjWeekly: 8.9 })]);
  const best = byId(r, "D_best");
  assert.equal(best.recommendation, "optional");
  assert.equal(best.gain, 3.1);
  assert.deepEqual(best.weekStream, { proj: 7.1, mine: 4, gain: 3.1, best: true, opponent: "@ NYJ" });
  assert.equal(best.summary, "Best DEF stream this week (@ NYJ): Yahoo proj 7.1 vs your 4.0. Free agent, add any time.");
  assert.ok(best.details.some((d) => d.label === "This week (Yahoo)" && d.value === "proj 7.1 vs your 4.0 (+3.1)"));
  assert.ok(best.details.some((d) => d.label === "Lineup" && d.value === "Starts at DEF this week over yours"));
  const ok = byId(r, "D_ok");
  assert.equal(ok.recommendation, "optional", "+1.2 ≥ the 1.0 minimum");
  assert.equal(ok.weekStream!.best, false);
  assert.match(ok.summary, /^Streaming DEF this week: Yahoo proj 5\.2 vs your 4\.0\./);
  const small = byId(r, "D_small");
  assert.equal(small.recommendation, "pass", `+0.6 < ${KDEF_STREAM.minGain}`);
  assert.equal(small.summary, "Not a streaming upgrade this week: Yahoo proj 4.6 vs your 4.0.");
  // A bigger projection on waivers is never worth priority (and is never the named pick).
  const wv = byId(r, "D_wv");
  assert.equal(wv.recommendation, "pass");
  assert.equal(wv.weekStream!.best, false);
  assert.match(wv.summary, /^DEF on waivers \(Yahoo proj 9\.0 vs your 4\.0\): not worth your priority\./);
  // The kicker: +1.4 over my 7.5, free → named too.
  assert.equal(byId(r, "K_free").weekStream!.best, true);
  assert.equal(byId(r, "K_free").recommendation, "optional");
  // Named in the advice line and the rules; sorted above the smaller stream.
  assert.match(r.advice, /stream D_best \(DEF\), K_free \(K\) this week/);
  assert.ok(r.rules.some((x) => x.label === "Best DEF this week" && x.value === "D_best: Yahoo proj 7.1 vs your 4.0"));
  assert.ok(r.freeAgents.indexOf(best) < r.freeAgents.indexOf(ok));
  for (const t of r.freeAgents) {
    assert.deepEqual(summaryProblems(t.summary), [], t.summary);
    assert.deepEqual(detailProblems(t.details), [], t.id);
  }
  // The slim row carries the week numbers for the tab.
  const row = toWaiverRow(best);
  assert.deepEqual(row.weekStream, best.weekStream);
  assert.equal(row.yahooProjWeekly, 7.1);
  assert.equal(toWaiverRow(byId(r, "D_none")).yahooProjWeekly, undefined);
});

test("K/DEF streaming: a missing projection (his or mine) keeps the season-number call, labelled 'no weekly projection'", () => {
  const r = run(streamCtx(), DEFS());
  const none = byId(r, "D_none");
  assert.equal(none.weekStream, undefined);
  assert.equal(none.recommendation, "pass");
  assert.equal(none.summary, "Not an upgrade on your current DEF (no weekly projection).");
  assert.ok(none.details.some((d) => d.label === "This week (Yahoo)" && /^No weekly projection: re-import/.test(d.value)));
  // My DEF without a week projection: nobody is compared on it, nobody is named; rows say mine is missing.
  const r2 = run(streamCtx(7.5, null), DEFS());
  for (const t of r2.freeAgents.filter((x) => x.pos === "DEF")) {
    assert.equal(t.weekStream, undefined, t.id);
    assert.equal(t.recommendation, "pass", `${t.id}: season numbers say no upgrade`);
  }
  assert.ok(byId(r2, "D_best").details.some((d) => d.value === "No weekly projection for your DEF"));
  assert.ok(!r2.rules.some((x) => x.label === "Best DEF this week"));
  assert.doesNotMatch(r2.advice, /stream/);
});

test("K/DEF streaming: never a claim — unknown availability counts as on waivers and is never the named pick", () => {
  const ctx = streamCtx();
  const d = vp("D_unk", "DEF", 6, 1, { yahooProjWeekly: 12 });
  const r = rankWaivers(ctx, "me", [{ player: d, onWaivers: true, availability: "unknown" }], { myPriority: 12 });
  const t = byId(r, "D_unk");
  assert.equal(t.recommendation, "pass");
  assert.equal(t.weekStream!.best, false);
  assert.ok(!r.freeAgents.some((x) => (x.pos === "K" || x.pos === "DEF") && x.recommendation === "claim"));
});

test("Waivers tab: K/DEF rows show this week's projection with a why tooltip ('—' when not captured)", () => {
  const src = readFileSync(new URL("../../web/src/tabs/WaiversTab.tsx", import.meta.url), "utf8");
  assert.match(src, /function WeekProj\(/);
  assert.match(src, /title=\{proj === undefined \? TIPS\.noWeek : TIPS\.week\}/);
  assert.match(src, /<WeekProj p=\{p\} \/>/);
  assert.match(src, /week: "Yahoo's projected points for him this week/);
});

test("K/DEF streaming: with no DEF of mine the gain is his whole projection and the text says so", () => {
  const roster = mine.filter((p) => p.id !== "DEF");
  const L = league([team("me", roster, { irPlayerIds: ["IRGUY"] }), team("o", other)], undefined, { numTeams: 12 });
  const players = new Map([...roster, ...other].map((p) => [p.id, p]));
  const ctx = { league: L, players, teams: analyzeTeams(L, players, REPL) } as TradeContext;
  const r = run(ctx, [vp("D_best", "DEF", 6, 1, { yahooProjWeekly: 7.1 })], []);
  const t = byId(r, "D_best");
  assert.deepEqual(t.weekStream, { proj: 7.1, mine: null, gain: 7.1, best: true });
  assert.match(t.summary, /^Best DEF stream this week: Yahoo proj 7\.1 vs no DEF of yours\./);
  assert.ok(t.details.some((d) => d.label === "Lineup" && d.value === "Starts at DEF this week"), "never 'Bench depth' next to a weekly gain");
});

// ---- Fix 2026-10-28: vacated role, spikes, depth and roster need (DESIGN "Fix: vacated role, spikes, depth and roster need")
const role = (r: Partial<import("./types.js").RoleCheck> = {}) => ({ sustained: true, spike: false, ...r });
const fut = (r?: Partial<import("./types.js").RoleCheck>) => ({ tier: "rising" as const, score: 78, situation: 0.5, oppLevel: 11, thesis: "", ...(r ? { role: role(r) } : {}) });

test("future starter gate: a one-game jump, a borrowed role or a TE2 is 'watch' (stash), never a claim; a real role still claims", () => {
  const ctx = ctxFor([...mineNoCover, ...other], ["IRGUY"], mineNoCover);
  const cases: [string, ReturnType<typeof fut>, string, RegExp][] = [
    ["spike", fut({ sustained: false, spike: true }), "stash", /^Watch, not a claim: one strong game, not a role yet \(breakout score 78\)\./],
    ["borrowed", fut({ sustained: false, vacated: { weeks: [7], by: ["Lead WR"], back: true } }), "stash", /usage rose while Lead WR was out/],
    ["te2", fut({ chartRank: 2, chartEffective: 2, belowStarter: true }), "stash", /listed TE2 on the depth chart/],
    ["share", fut({ healthyShare: 0.05, offense: { ppg: 60, rank: 31, of: 32 } }), "stash", /5.0% target share with the starters healthy on a low-scoring offense/],
    ["real", fut({ chartRank: 1, chartEffective: 1, belowStarter: false, healthyShare: 0.2 }), "claim", /^Rising role: 11\.0 expected pts\/g/],
    ["unchecked", fut(), "claim", /^Rising role/],
  ];
  const r = rankWaivers(ctx, "me", cases.map(([id]) => ({ player: vp(id, "TE", 1, 0), onWaivers: true })), { myPriority: 3, breakouts: new Map(cases.map(([id, b]) => [id, b])) });
  for (const [id, , want, re] of cases) {
    const t = r.freeAgents.find((x) => x.id === id)!;
    assert.equal(t.recommendation, want, `${id}: ${txt(t)}`);
    assert.match(t.summary, re, id);
    assert.deepEqual(summaryProblems(t.summary), [], id);
    assert.deepEqual(detailProblems(t.details), [], id);
  }
  // The role facts are in the details (depth rank, share, offense), unknown ones say so.
  const te2 = r.freeAgents.find((x) => x.id === "te2")!;
  assert.ok(te2.details.some((d) => d.label === "Depth chart rank" && d.value === "TE2"), txt(te2));
  assert.ok(r.freeAgents.find((x) => x.id === "spike")!.details.some((d) => d.label === "Offense" && d.value === "Unknown"));
});

test("roster need: a role claim / stash at a position I start and cover at least as well is 'trade chip only' (pass)", () => {
  const ctx = ctxFor([...mine, ...other], ["IRGUY"]); // RB1, RB2, FLX (RB) start; BN1 (RB, 4.0 ppg) covers
  const r = rankWaivers(ctx, "me", [{ player: vp("FA_RB", "RB", 3.5, 0), onWaivers: true }, { player: vp("FA_RB_HI", "RB", 4.5, 0), onWaivers: true }], {
    myPriority: 3,
    breakouts: new Map([["FA_RB", fut()], ["FA_RB_HI", fut()]]),
  });
  const low = r.freeAgents.find((x) => x.id === "FA_RB")!;
  assert.equal(low.recommendation, "pass", txt(low));
  assert.equal(low.summary, "Trade chip only: you start 3 RBs and BN1 covers (4.0 vs his 3.5 ppg).");
  assert.match(txt(low), /Rule: Roster need: 3 RB starters \+ BN1 as cover \(4\.0 ppg\)/);
  // Projects above my cover: he still fills a need (better cover), the call stands.
  assert.equal(r.freeAgents.find((x) => x.id === "FA_RB_HI")!.recommendation, "claim");
  // A stash at a covered position is a trade chip too.
  const s = rankWaivers(ctx, "me", [{ player: vp("FA_ST", "RB", 1, 0), onWaivers: true }], { breakouts: new Map([["FA_ST", { tier: "stash" as const, score: 55, situation: 0, oppLevel: 5, thesis: "" }]]) }).freeAgents[0];
  assert.equal(s.recommendation, "pass", txt(s));
});

test("roster need counts FLEX starters: two TEs starting (one at FLEX) + a bench TE cover → a 4th TE is a trade chip", () => {
  const roster = mine.map((p) => (p.id === "FLX" ? { ...p, pos: "TE" as const } : p.id === "BN3" ? { ...p, ppg: 5 } : p));
  const ctx = ctxFor([...roster, ...other], ["IRGUY"], roster);
  const t = rankWaivers(ctx, "me", [{ player: vp("FA_TE", "TE", 4, 0), onWaivers: false }], { breakouts: new Map([["FA_TE", fut()]]) }).freeAgents[0];
  assert.equal(t.recommendation, "pass", txt(t));
  assert.match(t.summary, /^Trade chip only: you start 2 TEs and BN3 covers/);
});

test("bench-only upgrade at a covered position names the real reason: a better cover than mine", () => {
  const ctx = ctxFor([...mine, ...other], ["IRGUY"]);
  const t = rankWaivers(ctx, "me", [{ player: vp("FA_TE", "TE", 6, 4), onWaivers: false }]).freeAgents[0];
  assert.equal(t.recommendation, "optional", txt(t));
  assert.match(t.summary, /^Better TE cover than BN3 \(6\.0 vs 1\.0 ppg\), dropping BN3\./);
});

test("VALUE / GAIN not meaningful for the call → a note (UI shows '—' + tooltip), never a bare 0.0", () => {
  const ctx = ctxFor([...mineNoCover, ...other], ["IRGUY"], mineNoCover);
  const r = rankWaivers(ctx, "me", [{ player: vp("FUT", "RB", 1, 0), onWaivers: true }, { player: vp("BIG", "WR", 10, 12), onWaivers: true }], { myPriority: 3, breakouts: new Map([["FUT", fut()]]) });
  const f = r.freeAgents.find((x) => x.id === "FUT")!;
  assert.equal(f.recommendation, "claim");
  assert.match(f.gainNote ?? "", /the call is about his role/);
  assert.match(f.valueNote ?? "", /Below replacement level/);
  const row = toWaiverRow(f);
  assert.equal(row.gainNote, f.gainNote);
  assert.equal(row.valueNote, f.valueNote);
  const big = r.freeAgents.find((x) => x.id === "BIG")!;
  assert.equal(big.gainNote, undefined, "a real lineup gain is shown");
  assert.equal(big.valueNote, undefined);
  const src = readFileSync(new URL("../../web/src/tabs/WaiversTab.tsx", import.meta.url), "utf8");
  assert.match(src, /title=\{p\.gainNote \?\? TIPS\.gain\}/);
  assert.match(src, /\{p\.gainNote \? "—" : signed\(p\.gain\)\}/);
  assert.match(src, /\{p\.valueNote \? "—" : f1\(p\.value\)\}/);
  assert.match(src, /gaps\?\.map/);
});

test("weak position line: no free agent beats my weakest starter there → one line, Yahoo week projection when both have one", () => {
  const groups = { QB: { rank: 3 }, RB: { rank: 8 }, WR: { rank: 2 }, TE: { rank: 1 } };
  assert.deepEqual(weakPositions({ needs: [], groups }, 12), ["RB"]);
  assert.deepEqual(weakPositions({ needs: ["WR", "K"], groups: { ...groups, RB: { rank: 5 } } }, 12), ["WR"]);
  assert.deepEqual(weakPositions(undefined, 12), []);
  const lineup = [
    { player: vp("RB1", "RB", 16, 20, { yahooProjWeekly: 15 }), label: "RB" },
    { player: vp("RBF", "RB", 12, 9, { yahooProjWeekly: 9.6 }), label: "W/R/T2" },
  ];
  const fa = vp("Spare Back", "RB", 5, 0, { name: "Spare Back", yahooProjWeekly: 7.3 });
  assert.deepEqual(gapLines(["RB"], lineup, [], [fa]), ["RB: no free agent beats yours (best: Spare Back 7.3 this week vs your W/R/T2 9.6). Look at trades."]);
  // A row that adds lineup points, or a better free agent: no line (the rows answer it).
  assert.deepEqual(gapLines(["RB"], lineup, [{ pos: "RB", gain: 0.4, recommendation: "optional" }], [fa]), []);
  assert.deepEqual(gapLines(["RB"], lineup, [], [{ ...fa, yahooProjWeekly: 10 }]), []);
  // No Yahoo projection on one side: our pts/game.
  assert.match(gapLines(["RB"], lineup, [], [{ ...fa, yahooProjWeekly: undefined }])[0], /best: Spare Back 5\.0 ppg vs your W\/R\/T2 12\.0/);
});
