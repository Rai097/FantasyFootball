// ADVERSARIAL tests (tester, not developer) for Model v4 release (c) in trades v3: an out player given or received is
// valued on his return (ret.tradeValue), the finder still never suggests injured / riser / noise-level trades, and an
// out player never makes an absurd trade look good.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateTradeV3, findTradesV3 } from "./tradesV3.js";
import type { TradeContext } from "./tradeKit.js";
import { analyzeTeams } from "./analysis.js";
import { attachMarket } from "./market.js";
import { detailProblems, league, summaryProblems, team, vp } from "./testkit.js";
import type { League, ReturnInfo, ValuedPlayer } from "./types.js";
import type { MarketValue } from "../data/fantasycalc.js";

const G = { remainingGames: 14 };
const REPL = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
const UNK = (tradeValue: number, healthyRate = 18): ReturnInfo => ({
  week: null, confidence: "unknown", reasons: [], absent: true, practiceUp: false, healthyRate, returnValue: tradeValue * 1.3, playoffPts: 27, tradeValue,
});
const irStar = (id: string, tradeValue: number) => vp(id, "WR", 0, 0, { remainingGames: 0, injury: { status: "IR", week: 8 }, ret: UNK(tradeValue) });

function rosters() {
  const mine = [
    vp("mQB", "QB", 22, 12, { ...G, posRank: 4 }), vp("mQB2", "QB", 18, 4, { ...G, posRank: 11 }),
    vp("mRB1", "RB", 20, 60, G), vp("mRB2", "RB", 15, 30, G), vp("mRB3", "RB", 13.5, 22, G), vp("mRB4", "RB", 12, 14, G),
    vp("mWR1", "WR", 10, 8, G), vp("mWR2", "WR", 9, 5, G), vp("mTE", "TE", 8, 5, G), vp("mBN", "WR", 5, 0.5, G),
    vp("mK", "K", 8, 1, G), vp("mDEF", "DEF", 7, 1, G), irStar("mIR", 70),
  ];
  const theirs = [
    vp("tQB", "QB", 13, 2, { ...G, posRank: 24 }),
    vp("tRB1", "RB", 9, 4, G), vp("tRB2", "RB", 7, 3.5, G), vp("tWR1", "WR", 19, 55, G), vp("tWR2", "WR", 15, 28, G), vp("tWR3", "WR", 14, 22, G),
    vp("tWR4", "WR", 12.5, 14, G), vp("tWR5", "WR", 11, 9, G), vp("tTE", "TE", 8, 5, G), vp("tBN", "TE", 4, 0.4, G),
    vp("tK", "K", 8, 1, G), vp("tDEF", "DEF", 7, 1, G), irStar("tIR", 70),
  ];
  const NFL = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG", "PHI", "PIT"];
  [...mine, ...theirs].forEach((p, i) => (p.team = NFL[i % NFL.length]));
  return { mine, theirs };
}
function ctxFor(l: League, ps: ValuedPlayer[]): TradeContext {
  const players = new Map(ps.map((p) => [p.id, p]));
  return { league: l, players, teams: analyzeTeams(l, players, REPL), replacement: REPL };
}
function make() {
  const { mine, theirs } = rosters();
  return ctxFor(league([team("me", mine), team("them", theirs)], undefined, { currentWeek: 8 }), [...mine, ...theirs]);
}

test("evaluate: a healthy starter for an IR star with 'return unconfirmed' is a plain Decline, never Accept / lean", () => {
  const c = make();
  for (const give of [["mRB2"], ["mRB1"], ["mRB2", "mWR1"]]) {
    const ev = evaluateTradeV3(c, "me", "them", give, ["tIR"]);
    assert.ok(!/^Accept|lean/.test(ev.verdict), `${give.join("+")} for tIR → ${ev.verdict} (my Δ ${ev.packages && (ev as any).me?.scoreDelta})`);
    assert.ok(ev.details!.some((d) => d.label === "Injured, you get"), "card says the player is injured");
    assert.deepEqual(detailProblems(ev.details!), []);
  }
});

test("evaluate: an out player I GIVE is valued on his return estimate (true value given = tradeValue), not 0", () => {
  const c = make();
  const ev = evaluateTradeV3(c, "me", "them", ["mIR"], ["tWR5"]);
  assert.ok(Math.abs(ev.packages!.trueGive - 70) < 1e-9, `trueGive ${ev.packages!.trueGive}`);
  assert.ok(ev.details!.some((d) => d.label === "Injured, you give" && /return unconfirmed, a bet on his recovery \(valued 70\.0/.test(d.value)), JSON.stringify(ev.details));
  assert.ok(ev.summary!.startsWith("mIR (injured, return unconfirmed) for tWR5: "), ev.summary);
  // Selling him for a bench WR does not make my lineup worse now (he scores 0), but I hand over 70 of true value.
  assert.ok(!/^Accept/.test(ev.verdict), ev.verdict);
});

test("finder (owner 2026-10-26): a return-unconfirmed piece with trade value may appear, always carded as a bet on his recovery; out for the season never; riser / gain < 1.0 still hold", () => {
  const c = make();
  c.players.get("mRB3")!.riser = true;
  const r = findTradesV3(c, "me", { valueSource: "model", limit: 50 });
  const all = [...r.trades, ...r.smallerEdges, ...r.nearMisses];
  assert.ok(all.length > 0, "baseline finds trades");
  assert.ok(all.some((t) => [...t.me.gives, ...t.them.gives].some((p) => p.id === "mIR" || p.id === "tIR")), "an unconfirmed piece with trade value is actually offered");
  for (const t of all) {
    assert.ok(!t.me.gives.some((p) => p.id === "mRB3"), `${t.key} sells the riser`);
    assert.ok(t.me.scoreDelta === undefined || t.me.scoreDelta >= 1.0 - 1e-9, `${t.key}: gain ${t.me.scoreDelta}`);
    for (const p of [...t.me.gives, ...t.them.gives].filter((x) => x.id === "mIR" || x.id === "tIR")) {
      assert.ok(t.details!.some((d) => /^Injured, you (give|get)$/.test(d.label) && d.value.startsWith(`${p.id}: return unconfirmed, a bet on his recovery`)), `${t.key}: card for ${p.id}`);
      assert.ok(t.summary!.includes(`${p.id} (injured, return unconfirmed)`), t.summary);
    }
    assert.deepEqual(summaryProblems(t.summary!), [], t.key);
  }
  // Out for the season: never a piece in any list.
  const so = make();
  for (const id of ["mIR", "tIR"]) so.players.get(id)!.ret = { ...so.players.get(id)!.ret!, seasonOver: true };
  const r2 = findTradesV3(so, "me", { valueSource: "model", limit: 50 });
  for (const t of [...r2.trades, ...r2.smallerEdges, ...r2.nearMisses]) {
    const ids = [...t.me.gives, ...t.them.gives].map((p) => p.id);
    assert.ok(!ids.includes("mIR") && !ids.includes("tIR"), `${t.key} moves a player out for the season`);
  }
});

test("market edge: a 'return unconfirmed' player is never pitched as 'market undervalues' (the market prices the injury, we halve it too)", () => {
  const c = make();
  // FantasyCalc lists the IR star low (it prices the injury); our trade value 70 ranks him near the top.
  const mv = (value: number, rank: number) => ({ value, raw: value, overallRank: rank, posRank: rank, trend30: 0 }) as MarketValue;
  const order = [...c.players.values()].filter((p) => p.pos !== "K" && p.pos !== "DEF").sort((a, b) => b.value - a.value);
  const values = new Map(order.map((p, i) => [p.id, mv(Math.max(1, p.value), i + 1)]));
  values.set("tIR", mv(12, order.length - 3));
  attachMarket(c.players, values);
  const ev = evaluateTradeV3(c, "me", "them", ["mRB2"], ["tIR"]);
  const tag = ev.tags.find((t) => /market undervalues: tIR/.test(t));
  assert.equal(tag, undefined, `tag "${tag}" on a player whose return is unconfirmed (edge ${c.players.get("tIR")!.edge})`);
});
