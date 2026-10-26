import { test } from "node:test";
import assert from "node:assert/strict";
import { capRows, claimThreshold, makeSummary, rankWaivers, snapTrendOf, thesisItems } from "./waivers.js";
import { analyzeTeams } from "./analysis.js";
import { detailProblems, league, summaryProblems, team, vp } from "./testkit.js";
import type { TradeContext } from "./trades.js";
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

function ctxFor(ps: ValuedPlayer[], irIds: string[] = []): TradeContext {
  const L = league([team("me", mine, { irPlayerIds: irIds }), team("o", other)], undefined, { numTeams: 12 });
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
  const ctx = ctxFor([...mine, ...other], ["IRGUY"]);
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
  const ctx = ctxFor([...mine, ...other], ["IRGUY"]);
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
