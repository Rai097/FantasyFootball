// ADVERSARIAL tests (tester, not developer) for Waivers v3 rows (docs/DESIGN.md "Waivers v3"): summary ≤ 255 chars,
// 1–2 sentences, no junk; details ≤ 90 chars, one idea each; K/DEF never spend priority; injured never a sight-unseen
// waiver claim; free agents never told they cost priority; FAAB leagues talk bids, not priority. Pure unit fixtures
// plus a synthetic league built from the reconstructed Yahoo player-list fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rankWaivers, toWaiverRow, type FreeAgentInput } from "./waivers.js";
import { analyzeTeams } from "./analysis.js";
import { detailProblems, league, summaryProblems, team, vp } from "./testkit.js";
import type { TradeContext } from "./tradeKit.js";
import type { ValuedPlayer, WaiverBreakout, WaiverTarget } from "./types.js";
import { parsePlayersHtml } from "../../web/src/import/yahooHtml.js";

const txt = (t: WaiverTarget) => [t.summary, ...t.details.map((d) => `${d.label}: ${d.value}`)].join("\n");
const REPL = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
const mine = () => [
  vp("QB", "QB", 18, 10), vp("RB1", "RB", 14, 30), vp("RB2", "RB", 13, 26), vp("WR1", "WR", 12, 20), vp("WR2", "WR", 3, 0),
  vp("TE", "TE", 8, 5), vp("FLX", "RB", 9, 4), vp("K", "K", 8, 2), vp("DEF", "DEF", 7, 3),
  vp("BN1", "RB", 4, 0.4), vp("BN2", "WR", 2, 0.1), vp("BN3", "TE", 1, 0), vp("BN4", "QB", 1.5, 0), vp("IRGUY", "RB", 0, 0, { remainingGames: 0 }),
];

function ctxFor(over: Record<string, unknown> = {}, faabLeft?: number): TradeContext {
  const m = mine();
  const L = league([team("me", m, { irPlayerIds: ["IRGUY"], ...(faabLeft !== undefined ? { faabRemaining: faabLeft } : {}) }), team("o", [vp("oQB", "QB", 17, 8)])], undefined, { numTeams: 12, ...over });
  const players = new Map([...m, vp("oQB", "QB", 17, 8)].map((p) => [p.id, p]));
  return { league: L, players, teams: analyzeTeams(L, players, REPL) };
}

/** Junk a reader should never see in a row. */
const JUNK = /\bundefined\b|\bNaN\b|\bnull\b|\bInfinity\b|\[object/;
/** In the one-line summary a zero change is never sold as an upgrade ("+0.0 ppg", "+0.0 value"). */
const SUMMARY_JUNK = /[+−-]0\.0 (ppg|value)\b/;
function hygiene(rows: WaiverTarget[], where: string) {
  for (const t of rows) {
    assert.deepEqual(summaryProblems(t.summary), [], `${where} ${t.name}: ${t.summary}`);
    assert.deepEqual(detailProblems(t.details), [], `${where} ${t.name}`);
    assert.doesNotMatch(txt(t), JUNK, `${where} ${t.name}: junk in\n${txt(t)}`);
    assert.doesNotMatch(t.summary, SUMMARY_JUNK, `${where} ${t.name}: zero change in summary: ${t.summary}`);
    assert.ok(!t.summary.includes(`${t.id} `) || t.id === t.name, `${where}: raw id in summary`);
  }
}

// ------------------------------------------------------------------ FAAB
test("FAAB league: rows on waivers talk about bids, never about waiver priority", () => {
  const ctx = ctxFor({ usesFaab: true, faabBudget: 100 }, 80);
  const fas: FreeAgentInput[] = [
    { player: vp("FA_BIG", "WR", 10, 12), onWaivers: true }, // claim
    { player: vp("FA_SMALL", "WR", 3.6, 0.2), onWaivers: true }, // modest upgrade → optional
    { player: vp("FA_K", "K", 11, 6), onWaivers: true }, // kicker on waivers
    { player: vp("FA_DEF", "DEF", 10, 6), onWaivers: true },
  ];
  const r = rankWaivers(ctx, "me", fas);
  for (const t of r.freeAgents) assert.doesNotMatch(txt(t), /priority/i, `${t.name} (${t.recommendation}) in a FAAB league:\n${txt(t)}`);
  assert.match(txt(r.freeAgents.find((t) => t.id === "FA_BIG")!), /Bid about \$\d+/);
});

test("FAAB league: the 'How calls work' rules and advice line do not describe a rolling priority list", () => {
  const r = rankWaivers(ctxFor({ usesFaab: true, faabBudget: 100 }, 80), "me", [{ player: vp("FA_BIG", "WR", 10, 12), onWaivers: true }]);
  const rules = r.rules.map((d) => `${d.label}: ${d.value}`).join("\n");
  assert.doesNotMatch(rules, /priority/i, `FAAB rules mention priority:\n${rules}`);
  assert.doesNotMatch(r.advice, /priority/i);
});

// ------------------------------------------------------------------ K / DEF
test("K / DEF never spend priority: on waivers (known or unknown) they are never claim/stash and never cost priority", () => {
  const ctx = ctxFor();
  const fas: FreeAgentInput[] = [
    { player: vp("K_W", "K", 14, 9), onWaivers: true },
    { player: vp("DEF_W", "DEF", 13, 9), onWaivers: true },
    { player: vp("K_U", "K", 14, 9), onWaivers: true, availability: "unknown" },
    { player: vp("DEF_U", "DEF", 13, 9, { injury: { status: "Q", week: 4 } }), onWaivers: true, availability: "unknown" },
  ];
  const breakouts = new Map<string, WaiverBreakout>(fas.map((f) => [f.player.id, { tier: "rising", score: 90, situation: 1, oppLevel: 20, thesis: "x" }]));
  for (const myPriority of [1, 6, 12, undefined]) {
    const r = rankWaivers(ctx, "me", fas, { myPriority, breakouts });
    for (const t of r.freeAgents) {
      assert.ok(!["claim", "stash", "optional"].includes(t.recommendation), `${t.name} @#${myPriority}: ${t.recommendation}`);
      assert.doesNotMatch(txt(t), /uses your #|Costs your waiver priority|drop to #/, `${t.name}: ${txt(t)}`);
    }
  }
});

test("K streaming free agent: never called an 'upgrade' with a zero or negative ppg change", () => {
  const ctx = ctxFor();
  const fas: FreeAgentInput[] = [
    { player: vp("K_SAME", "K", 8.03, 6), onWaivers: false }, // +0.03 ppg, more value
    { player: vp("K_WORSE", "K", 7.6, 6), onWaivers: false }, // −0.4 ppg, more value (e.g. more games left)
  ];
  const r = rankWaivers(ctx, "me", fas, { myPriority: 3 });
  for (const t of r.freeAgents) {
    const m = /upgrade: ([+−-]\d+\.\d) ppg/.exec(t.summary);
    if (m) assert.ok(Number(m[1].replace("−", "-")) > 0, `${t.name}: "${t.summary}" (${t.recommendation})`);
    assert.doesNotMatch(t.summary, JUNK, `${t.name}: ${t.summary}`);
  }
});

// ------------------------------------------------------------------ injuries
const INJURIES: { status: string; detail?: string }[] = [
  { status: "Q" }, { status: "Questionable" }, { status: "D" }, { status: "Doubtful" }, { status: "O" }, { status: "Out" },
  { status: "Out", detail: "IR" }, // how yahoo-parse maps Yahoo's "IR" tag
  { status: "Out", detail: "ACL" }, { status: "IR" }, { status: "PUP" }, { status: "PUP-R" }, { status: "SUSP" },
  { status: "Out", detail: "Suspended" }, { status: "NA" }, { status: "DNP" }, { status: " dnp " },
];
test("injured / DNP players on waivers in a rolling-list league are never a 'claim' (every status Yahoo / nflverse produce)", () => {
  const ctx = ctxFor();
  const fas: FreeAgentInput[] = INJURIES.map((inj, i) => ({ player: vp(`INJ${i}`, "WR", 10, 12, { name: `Hurt ${inj.status}${inj.detail ? ` (${inj.detail})` : ""}`, injury: { ...inj, week: 4 } }), onWaivers: true }));
  const r = rankWaivers(ctx, "me", fas, { myPriority: 3 });
  const bad = r.freeAgents.filter((t) => t.recommendation === "claim").map((t) => t.name);
  assert.deepEqual(bad, [], `still a waiver claim while injured: ${bad.join(", ")}`);
  hygiene(r.freeAgents, "injured");
});

test("injured stash summary never prints 'he is undefined' or a raw blank status", () => {
  const ctx = ctxFor();
  const r = rankWaivers(ctx, "me", [{ player: vp("INJ", "WR", 10, 12, { injury: { status: "DNP", week: 4 } }), onWaivers: true }], { myPriority: 3 });
  const t = r.freeAgents[0];
  assert.equal(t.recommendation, "stash");
  assert.doesNotMatch(t.summary, /he is \.|he is undefined|he is\s*$/);
});

// ------------------------------------------------------------------ free agents never cost priority
test("free agents (onWaivers=false) never say a claim costs priority, never 'wait', across priorities and calls", () => {
  const ctx = ctxFor();
  const fas: FreeAgentInput[] = [
    vp("F_BIG", "WR", 10, 12), vp("F_SMALL", "WR", 3.6, 0.2), vp("F_Q", "WR", 10, 12, { injury: { status: "Q", week: 4 } }),
    vp("F_DNP", "RB", 10, 12, { injury: { status: "DNP", week: 4 } }), vp("F_MEH", "TE", 0.5, 0), vp("F_K", "K", 11, 6), vp("F_DEF", "DEF", 10, 6),
    ...[5, 4, 3, 2, 1].map((v, i) => vp(`F_TE${i}`, "TE", 6 + i * 0.1, v)),
  ].map((p) => ({ player: p, onWaivers: false, availability: "fa" as const }));
  const breakouts = new Map<string, WaiverBreakout>([["F_MEH", { tier: "stash", score: 60, situation: 0.5, oppLevel: 6, thesis: "WR3 behind X; snaps 40%→62%" }]]);
  for (const myPriority of [1, 7, 12, undefined]) {
    const r = rankWaivers(ctx, "me", fas, { myPriority, breakouts });
    for (const t of r.freeAgents) {
      assert.notEqual(t.recommendation, "wait", `${t.name}: free agents never 'wait'`);
      assert.doesNotMatch(txt(t), /uses your #|drop to #|Costs your waiver priority|Not worth priority|before spending priority|clears waivers|after waivers clear/, `${t.name} @#${myPriority}:\n${txt(t)}`);
      assert.equal(t.availability, "fa");
    }
    hygiene(r.freeAgents, `FA @#${myPriority}`);
  }
});

// ------------------------------------------------------------------ text hygiene on hostile names / numbers
test("hostile names and odd numbers: summaries stay ≤255 / 1–2 sentences; details ≤90; no NaN / undefined", () => {
  const ctx = ctxFor();
  const longName = "Christopher Bartholomew Montgomery-Fitzwilliam Alexander St. John III Jr.".slice(0, 80);
  const fas: FreeAgentInput[] = [
    { player: vp("N1", "WR", 10, 12, { name: longName }), onWaivers: true },
    { player: vp("N2", "WR", 9, 11, { name: "Ja'Marr Chase" }), onWaivers: false },
    { player: vp("N3", "WR", 8.5, 10, { name: "Amon-Ra St. Brown" }), onWaivers: true },
    { player: vp("N4", "RB", 8, 9, { name: "Marvin Harrison Jr." }), onWaivers: true },
    { player: vp("N5", "RB", 7, 2, { name: "A.J. Dillon", injury: { status: "Q", detail: "x".repeat(200), week: 4 } }), onWaivers: false },
    { player: vp("N6", "TE", 6.5, 1, { name: "Zoë Ñúñez", games: 0, trend: NaN }), onWaivers: true },
    { player: vp("N7", "WR", 0, 0, { name: "Zero Guy", ppg: 0, value: 0 }), onWaivers: true },
  ];
  const breakouts = new Map<string, WaiverBreakout>([
    ["N6", { tier: "rising", score: 70, situation: 1, oppLevel: 9, thesis: `${"Long depth chart note ".repeat(10)}; snaps 10%→20%→35%→50%→62%→71%; 9.1 expected vs 6.0 actual ppg; value ~0.` }],
    ["N7", { tier: "stash", score: NaN, situation: NaN, oppLevel: NaN, thesis: "" }],
  ]);
  const r = rankWaivers(ctx, "me", fas, { myPriority: 4, breakouts });
  hygiene(r.freeAgents, "hostile");
  assert.ok(r.advice.length <= 255);
  assert.doesNotMatch(r.advice, JUNK);
});

// ------------------------------------------------------------------ synthetic league from the fixture import
test("synthetic league from the reconstructed Yahoo player-list fixture: availability flows to rows; text rules hold", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../providers/fixtures");
  const parsed = parsePlayersHtml(readFileSync(path.join(dir, "yahoo-web-players.html"), "utf8"));
  assert.equal(parsed.players.length, 6);
  const ppgOf: Record<string, number> = { QB: 16, RB: 9, WR: 10, TE: 7, K: 9, DEF: 8 };
  const fas: FreeAgentInput[] = parsed.players.map((p, i) => ({
    player: vp(p.yahooId ?? `def-${p.team}`, p.pos as ValuedPlayer["pos"], ppgOf[p.pos], 5 + i, {
      name: p.name,
      team: p.team ?? "FA",
      ...(p.status ? { injury: { status: p.status, week: 4 } } : {}),
    }),
    onWaivers: p.availability !== "FA",
    availability: p.availability === "FA" ? "fa" : p.availability === "W" ? "waivers" : "unknown",
  }));
  for (const [faab, prio] of [[false, 2], [false, 12], [false, undefined], [true, undefined]] as const) {
    const ctx = ctxFor(faab ? { usesFaab: true, faabBudget: 100 } : {}, faab ? 50 : undefined);
    const r = rankWaivers(ctx, "me", fas, { myPriority: prio });
    hygiene(r.freeAgents, `fixture faab=${faab} prio=${prio}`);
    assert.equal(r.faStatusKnown, true);
    const by = Object.fromEntries(r.freeAgents.map((t) => [t.name, t]));
    assert.equal(by["Free Runner"].availability, "fa");
    assert.equal(by["Waiver Wideout"].availability, "waivers");
    assert.equal(by["Carolina"].availability, "fa");
    assert.equal(by["Long Kicker"].availability, "waivers");
    assert.notEqual(by["Long Kicker"].recommendation, "claim");
    if (!faab) assert.notEqual(by["Dated Tightend"].recommendation, "claim", "questionable TE on waivers is never a sight-unseen claim");
    for (const t of r.freeAgents) {
      const row = toWaiverRow(t);
      assert.ok(JSON.stringify(row).length < 2500, `${t.name}: slim row ${JSON.stringify(row).length} bytes`);
      assert.equal((row as unknown as Record<string, unknown>).weeks, undefined);
    }
  }
});
