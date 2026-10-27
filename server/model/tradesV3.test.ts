import { test } from "node:test";
import assert from "node:assert/strict";
import {
  V3,
  acceptCurve,
  acceptanceV4,
  lineupCurve,
  lineupLabel,
  marketLabel,
  benchUpgradeFilter,
  benchUpgradeOk,
  coverLost,
  qbItems,
  bestQbRank,
  dropCost,
  evaluateTradeV3,
  findTradesV3,
  ineligibleReason,
  judge3,
  listsInMode,
  modeBarText,
  modeGain,
  packageValue,
  qbTradeable,
  spareQb,
  teamV3,
} from "./tradesV3.js";
import type { TradeContext } from "./tradeKit.js";
import { FLEX_SLOTS } from "./lineup.js";
import { analyzeTeams } from "./analysis.js";
import { attachMarket } from "./market.js";
import { rosterParts } from "./rosterScore.js";
import { perceptionOf } from "./perception.js";
import { detailProblems, league, summaryProblems, team, vp } from "./testkit.js";
import type { League, ValuedPlayer } from "./types.js";
import type { MarketValue } from "../data/fantasycalc.js";

const G = { remainingGames: 14 };
const REPL = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
const S = league([]).settings;

// ---------------------------------------------------------------- package math

test("package value: best + 0.85·second + 0.70·third (order-free, 4th adds nothing)", () => {
  assert.equal(packageValue([30]), 30);
  assert.ok(Math.abs(packageValue([10, 30]) - (30 + 0.85 * 10)) < 1e-9);
  assert.ok(Math.abs(packageValue([5, 20, 10]) - (20 + 8.5 + 3.5)) < 1e-9);
  assert.ok(Math.abs(packageValue([5, 20, 10, 9]) - packageValue([20, 10, 9])) < 1e-9);
  assert.equal(packageValue([]), 0);
});

test("drop cost: each cut player's value, at least 3", () => {
  assert.equal(dropCost([]), 0);
  assert.equal(dropCost([0.4]), 3);
  assert.equal(dropCost([7.5]), 7.5);
  assert.equal(dropCost([1, 5]), 8);
});

test("labels split: lineup impact (our projections, per week) and market value (FantasyCalc) replace the fairness band", () => {
  assert.equal(lineupLabel(0.3, 0.1, -0.2), "Lineup impact: good for you (playoffs +0.3/wk, season +0.1/wk; them −0.2/wk season)");
  assert.equal(lineupLabel(-1, 0.5, 2), "Lineup impact: bad for you (playoffs −1.0/wk, season +0.5/wk; them +2.0/wk season)");
  assert.equal(lineupLabel(0.02, 0, 0), "Lineup impact: neutral for you (playoffs +0.0/wk, season +0.0/wk; them +0.0/wk season)");
  // The verdict follows the playoff number (what the finder ranks on), not the rest-of-season one.
  assert.match(lineupLabel(1.3, 0, -0.3), /^Lineup impact: good for you \(playoffs \+1\.3\/wk, season \+0\.0\/wk; them −0\.3\/wk season\)$/);
  assert.match(lineupLabel(-0.8, 1.2, 0), /^Lineup impact: bad for you/);
  assert.ok(lineupLabel(-12.3, -10.4, 11.5).length < 120);
  assert.equal(marketLabel(1.16), "Market value: they get +16%");
  assert.equal(marketLabel(0.92), "Market value: they get −8%");
});

test("acceptance v4: their perceived lineup dominates (80%), market 20%; spike, extra players, best player, fixes, cap", () => {
  assert.ok(Math.abs(acceptCurve(5) - 0.65) < 1e-9);
  assert.ok(Math.abs(lineupCurve(1) - 0.7) < 1e-9);
  assert.equal(lineupCurve(0), 0.5);
  const none = { perceivedPerWeek: 0, perceivedLoss: false, marketEdgePct: 0, spikes: 0, extraGiven: 0, losesTheirTop: false, fixesWorst: false };
  assert.equal(acceptanceV4(none), 0.5);
  assert.ok(Math.abs(acceptanceV4({ ...none, perceivedPerWeek: 1 }) - (0.8 * 0.7 + 0.2 * 0.5)) < 1e-9);
  // A big market edge cannot carry a deal their lineup does not like.
  assert.ok(acceptanceV4({ ...none, perceivedPerWeek: -0.1, marketEdgePct: 40 }) < acceptanceV4({ ...none, perceivedPerWeek: 1, marketEdgePct: 0 }));
  assert.ok(Math.abs(acceptanceV4({ ...none, spikes: 1 }) - 0.5 * 0.7) < 1e-9);
  assert.ok(Math.abs(acceptanceV4({ ...none, extraGiven: 2 }) - 0.5 * 0.85 * 0.85) < 1e-9);
  assert.ok(Math.abs(acceptanceV4({ ...none, losesTheirTop: true }) - 0.4) < 1e-9);
  assert.ok(Math.abs(acceptanceV4({ ...none, fixesWorst: true }) - 0.55) < 1e-9);
  assert.equal(acceptanceV4({ ...none, perceivedPerWeek: 10, marketEdgePct: 60, fixesWorst: true }), V3.accCap);
  assert.equal(acceptanceV4({ ...none, extraGiven: -1 }), 0.5, "receiving more players is not a bonus");
  // A perceived loss is never ≥ 0.25, whatever the market says.
  for (const m of [0, 30, 100]) assert.ok(acceptanceV4({ ...none, perceivedPerWeek: -0.05, perceivedLoss: true, marketEdgePct: m, fixesWorst: true }) <= V3.perceivedLossCap);
});

// ---------------------------------------------------------------- eligibility

test("eligibility: K/DEF, waiver level, no games left", () => {
  const ok = vp("ok", "WR", 12, 10, G);
  assert.equal(ineligibleReason(ok, S), "");
  assert.match(ineligibleReason(vp("k", "K", 8, 5, G), S), /K \/ DEF/);
  assert.match(ineligibleReason(vp("d", "DEF", 8, 5, G), S), /K \/ DEF/);
  assert.match(ineligibleReason(vp("w", "WR", 6, 1, G), S), /waiver/);
  // Market ≥ 3 keeps a low-true-value player eligible, and vice versa.
  assert.equal(ineligibleReason(vp("m", "WR", 6, 1, { ...G, market: 4 }), S), "");
  assert.equal(ineligibleReason(vp("t", "WR", 6, 4, { ...G, market: 1 }), S), "");
  assert.match(ineligibleReason(vp("mw", "WR", 6, 1, { ...G, market: 2 }), S), /waiver/);
  assert.match(ineligibleReason(vp("none", "WR", 12, 10, { remainingGames: 0 }), S), /no games left/);
});

// Owner 2026-10-26: injured players are pieces (both directions) with a few weeks left; never out for the season.
// S: weeks 4..17, no bye.
const backIn = (id: string, week: number, extra: Partial<ValuedPlayer> = {}) =>
  vp(id, "WR", 12, 10, { remainingGames: 17 - week + 1, injury: { status: "IR-R", week: 4 }, ret: { week, confidence: "medium", reasons: [], absent: true, practiceUp: false }, ...extra });
const unconfirmed = (id: string, tradeValue: number | undefined, extra: Partial<ValuedPlayer> = {}) =>
  vp(id, "WR", 0, 0, { remainingGames: 0, injury: { status: "IR", week: 4 }, ret: { week: null, confidence: "unknown", reasons: [], absent: true, practiceUp: false, ...(tradeValue !== undefined ? { tradeValue } : {}) }, ...extra });

test("injured pieces: back with ≥ 3 games left is eligible; the IR slot is not a reason; 2 games left is not", () => {
  assert.equal(V3.minGamesBack, 3);
  assert.equal(ineligibleReason(backIn("b6", 6), S), "", "back in 2 weeks");
  assert.equal(ineligibleReason(backIn("b15", 15), S), "", "weeks 15, 16, 17 = 3 games");
  assert.match(ineligibleReason(backIn("b16", 16), S), /back ~wk 16: only 2 games left/);
  // A bye inside the window counts as no game.
  assert.match(ineligibleReason(backIn("b15bye", 15, { bye: 16 }), S), /only 2 games left/);
  // Late-season week: back next week with 3 games → yes.
  const late = league([], undefined, { currentWeek: 14 }).settings;
  assert.equal(ineligibleReason(backIn("b15late", 15), late), "");
});

test("injured pieces: return unconfirmed + trade value > 0 is eligible (a bet on his recovery); no value or too late is not", () => {
  assert.equal(ineligibleReason(unconfirmed("u", 40), S), "", "waiver check uses his trade value, not value 0");
  assert.match(ineligibleReason(unconfirmed("u0", undefined, { market: 5 }), S), /return unconfirmed, no trade value/);
  assert.match(ineligibleReason(unconfirmed("u1", 1), S), /waiver/, "trade value below waiver level");
  // The value assumes he is back at current week + 4: late in the season that leaves < 3 games.
  assert.match(ineligibleReason(unconfirmed("ulate", 40), league([], undefined, { currentWeek: 13 }).settings), /under 3 games left after wk 17/);
  // The IR minimum pushes the assumed return later.
  assert.match(ineligibleReason(unconfirmed("umin", 40, { ret: { week: null, confidence: "unknown", reasons: [], absent: true, practiceUp: false, tradeValue: 40, earliestWeek: 16 } }), S), /after wk 16/);
});

test("injured pieces: out for the season is never a piece, whatever the market says", () => {
  const so = unconfirmed("so", undefined, { market: 30, ret: { week: null, confidence: "unknown", reasons: [], absent: true, practiceUp: false, seasonOver: true } });
  assert.equal(ineligibleReason(so, S), "out for the season");
  // No return estimate attached (older fixtures / sources): the injury detail is the signal.
  assert.equal(ineligibleReason(vp("so2", "WR", 12, 10, { ...G, market: 30, injury: { status: "IR", detail: "Knee - out for season", week: 4 } }), S), "out for the season");
});

test("QB rule: only a spare top-14 QB, only to a team whose best QB ranks worse than 18", () => {
  const qb = (id: string, rank: number, ppg: number) => vp(id, "QB", ppg, 10, { ...G, posRank: rank });
  const two = [qb("a", 5, 22), qb("b", 12, 18)];
  const needy = [qb("x", 22, 14)];
  const fine = [qb("y", 10, 19)];
  assert.equal(spareQb(two)?.id, "b", "the second (non-starting) QB");
  assert.equal(spareQb([qb("a", 5, 22), qb("c", 16, 17)]), null, "second QB outside top 14");
  assert.equal(spareQb([qb("a", 5, 22)]), null);
  assert.equal(bestQbRank(needy), 22);
  assert.equal(qbTradeable(two, needy)?.id, "b");
  assert.equal(qbTradeable(two, fine), null, "partner already has a top-18 QB");
  assert.equal(qbTradeable(needy, two), null);
  assert.equal(bestQbRank([]), 99);
  // Market position rank wins when market values exist.
  const m = [vp("m1", "QB", 22, 10, { ...G, posRank: 3, market: 20, marketPosRank: 4 }), vp("m2", "QB", 18, 5, { ...G, posRank: 9, market: 3, marketPosRank: 20 })];
  assert.equal(spareQb(m), null, "second QB is QB20 by market");
});

// ---------------------------------------------------------------- judged packages

// Me: RB-rich (a stud), WR-poor. Partner: WR-rich, RB-poor, weak QB. Values double as market values.
const mine = [
  vp("mQB", "QB", 22, 12, { ...G, posRank: 4 }), vp("mQB2", "QB", 18, 4, { ...G, posRank: 11 }),
  vp("mRB1", "RB", 20, 60, G), vp("mRB2", "RB", 15, 30, G), vp("mRB3", "RB", 13.5, 22, G), vp("mRB4", "RB", 12, 14, G),
  vp("mWR1", "WR", 10, 8, G), vp("mWR2", "WR", 9, 5, G), vp("mTE", "TE", 8, 5, G), vp("mBN", "WR", 5, 0.5, G),
  vp("mK", "K", 8, 1, G), vp("mDEF", "DEF", 7, 1, G),
];
const theirs = [
  vp("tQB", "QB", 13, 2, { ...G, posRank: 24 }),
  vp("tRB1", "RB", 9, 4, G), vp("tRB2", "RB", 7, 3.5, G), vp("tWR1", "WR", 19, 55, G), vp("tWR2", "WR", 15, 28, G), vp("tWR3", "WR", 14, 22, G),
  vp("tWR4", "WR", 12.5, 14, G), vp("tWR5", "WR", 11, 9, G), vp("tTE", "TE", 8, 5, G), vp("tBN", "TE", 4, 0.4, G),
  vp("tK", "K", 8, 1, G), vp("tDEF", "DEF", 7, 1, G),
];
// Distinct NFL teams so same-team overlap (v3.1 A) only applies where a test sets it up.
const NFL = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG"];
[...mine, ...theirs].forEach((p, i) => (p.team = NFL[i % NFL.length]));
function ctxFor(l: League, ps: ValuedPlayer[]): TradeContext {
  const players = new Map(ps.map((p) => [p.id, p]));
  return { league: l, players, teams: analyzeTeams(l, players, REPL), replacement: REPL };
}
const ctx = ctxFor(league([team("me", mine), team("them", theirs)]), [...mine, ...theirs]);
const P = (id: string) => ctx.players.get(id)!;
const J = () => judge3(ctx, teamV3(ctx, "me"), teamV3(ctx, "them"), "balanced");

test("consolidation premium: whoever receives the best player in a non-1-for-1 deal gives ≥ 110%", () => {
  // I get their best WR (55) for two RBs: they must receive ≥ 1.10 × 55 net of their drop cost.
  const low = J()([P("mRB2"), P("mRB3")], [P("tWR1")]); // 30 + 0.85·22 = 48.7 − drop ≥ 3 → < 60.5
  assert.equal(low.bestToMe, true);
  assert.equal(low.premiumOk, false);
  assert.match(low.theirFail, /consolidation premium/);
  assert.equal(low.partnerOk, false);
  const high = J()([P("mRB1"), P("mRB4")], [P("tWR1")]); // mRB1 (60) is the best player: he goes to them
  assert.equal(high.bestToMe, false);
  // I give the best player for less than 110% of him back: my side fails.
  const sellStud = J()([P("mRB1")], [P("tWR2"), P("tWR3")]); // 28 + 0.85·22 = 46.7 − my drop < 66
  assert.equal(sellStud.bestToMe, false);
  assert.equal(sellStud.premiumOk, false);
  assert.match(sellStud.myFail, /best player/);
  // 1-for-1 deals carry no premium.
  assert.equal(J()([P("mRB2")], [P("tWR2")]).premiumOk, true);
});

test("consolidation premium: my side is judged on our true values, never the market (Model v4)", () => {
  // The market rates the player I give (mRB1) far above both pieces I get; our true values say I get much more.
  const withMarket = (p: ValuedPlayer, market: number): ValuedPlayer => ({ ...p, market });
  const give = withMarket(P("mRB1"), 90);
  const get = [withMarket(P("tWR1"), 20), withMarket(P("tWR2"), 15)];
  const j = J()([give], get);
  assert.equal(j.bestToMe, false, "market: I give the best player");
  assert.ok(j.trueGet > 1.1 * j.trueGive, "true values: I get well over 110%");
  assert.doesNotMatch(j.myFail, /best player/);
  // Our true values still guard me: selling the true best player for less than 110% of him fails my side.
  const cheap = J()([withMarket(P("mRB1"), 10)], [withMarket(P("tWR2"), 80), withMarket(P("tWR3"), 80)]);
  assert.match(cheap.myFail, /best player/);
});

test("drop cost: the side receiving more players nets the player it must cut (≥ 3)", () => {
  const j = J()([P("mRB3"), P("mRB4")], [P("tWR3")]);
  assert.equal(j.theirDrops.length, 1);
  const expected = packageValue([22, 14]) - dropCost(j.theirDrops.map((p) => p.value));
  assert.ok(Math.abs(j.fairness - expected / 22) < 1e-9, `${j.fairness} vs ${expected / 22}`);
  assert.ok(Math.abs(j.theirMarketChange - (expected - 22)) < 1e-9);
});

test("finder: no K/DEF/backup QBs/waiver-level pieces; pitch, band, summary, details and value source on every trade", () => {
  const r = findTradesV3(ctx, "me", { valueSource: "model", limit: 50 });
  const all = [...r.trades, ...r.smallerEdges, ...r.nearMisses];
  assert.ok(all.length > 0, "finds something");
  assert.equal(r.valueSource, "model");
  assert.equal(r.partners?.length, 1);
  assert.equal(r.partners?.[0].teamId, "them");
  for (const t of all) {
    for (const p of [...t.me.gives, ...t.them.gives]) {
      assert.ok(p.pos !== "K" && p.pos !== "DEF", t.key);
      assert.ok(p.id !== "mBN" && p.id !== "tBN", `${t.key}: waiver-level piece`);
      // Their QB24 needs a QB, and my QB2 is QB11: only mQB2 may move.
      if (p.pos === "QB") assert.equal(p.id, "mQB2", t.key);
    }
    assert.ok(t.pitch && t.pitch.length > 20, t.key);
    assert.match(t.lineupLabel!, /^Lineup impact: (good|bad|neutral) for you \(/, t.key);
    // Card label and row summary quote the same playoff-lineup number (the verdict follows it).
    const playoff = t.summary.match(/playoff lineup ([+−]\d+\.\d)\/wk/)?.[1];
    assert.ok(playoff && t.lineupLabel!.includes(`(playoffs ${playoff}/wk`), `${t.key}: "${t.summary}" vs "${t.lineupLabel}"`);
    assert.match(t.marketLabel!, /^Market value: they get [+−]\d+%$/, t.key);
    assert.match(t.yahooView!.label, /^What Yahoo (likely )?shows them: you [+−]\d+\.\d, them [+−]\d+\.\d pts/, t.key);
    assert.doesNotMatch(t.pitch!, /market/i, `${t.key}: pitch never argues market value`);
    assert.deepEqual(summaryProblems(t.summary), [], t.summary);
    assert.ok(t.details && t.details.length > 0, t.key);
    assert.deepEqual(detailProblems(t.details!), [], t.key);
    assert.ok(t.details!.some((d) => d.label === "Playoff byes" || /^Playoff bye/.test(d.label)), `${t.key}: playoff-bye fact`);
    assert.equal((t as { why?: unknown }).why, undefined, `${t.key}: no prose why on v3 trades`);
  }
  assert.deepEqual(summaryProblems(r.summary), [], r.summary);
  assert.deepEqual(detailProblems(r.summaryDetails ?? []), []);
  for (const p of r.partners ?? []) {
    assert.deepEqual(summaryProblems(p.summary), [], p.summary);
    assert.ok(p.details.length > 0);
    assert.deepEqual(detailProblems(p.details), []);
  }
  for (const t of r.trades) {
    assert.ok((t.me.scoreDelta ?? 0) >= V3.clearDelta - 0.05, t.key);
    assert.ok(t.acceptance >= V3.minAcceptance, t.key);
    assert.ok((t.packages?.myTrueChange ?? 0) >= 0, t.key);
    assert.ok(t.yahooView!.them >= 0, `${t.key}: never a perceived loss for them on the main list`);
  }
  for (const t of r.nearMisses) assert.match(t.reason!, /^(They'd likely refuse|Partner unlikely|Marginal)/);
  // ≤ 2 per partner, ≤ 2 per player I give.
  assert.ok(r.trades.length <= V3.perPartner);
  const giveCount = new Map<string, number>();
  for (const t of r.trades) for (const p of t.me.gives) giveCount.set(p.id, (giveCount.get(p.id) ?? 0) + 1);
  for (const [id, n] of giveCount) assert.ok(n <= V3.perGive, id);
});

test("evaluate: verdict, labels and acceptance; flags pieces outside the rules", () => {
  const ev = evaluateTradeV3(ctx, "me", "them", ["mRB3"], ["tWR3"]);
  assert.ok(ev.lineupLabel && ev.marketLabel && ev.yahooView);
  assert.ok(ev.acceptance > 0 && ev.acceptance <= V3.accCap);
  assert.equal(typeof ev.verdict, "string");
  const k = evaluateTradeV3(ctx, "me", "them", ["mK"], ["tWR5"]);
  assert.ok(k.details!.some((d) => d.label === "Outside the rules" && /^mK: /.test(d.value)), JSON.stringify(k.details));
  assert.equal(k.details![0].label, "Verdict");
  assert.deepEqual(detailProblems(k.details!), []);
  const qb = evaluateTradeV3(ctx, "me", "them", ["mQB"], ["tWR3"]);
  assert.ok(qb.details!.some((d) => d.value === "mQB: QB rule"), JSON.stringify(qb.details));
  assert.equal(qb.verdict, "Decline — QB rule");
});

test("market attachment: quantile-mapped true value, edge, missing-but-ranked players", () => {
  const ps = [vp("a", "RB", 20, 100, G), vp("b", "WR", 18, 40, G), vp("c", "WR", 10, 10, G), vp("d", "TE", 8, 2, G), vp("k", "K", 8, 5, G)];
  const players = new Map(ps.map((p) => [p.id, p]));
  const mk = (value: number, rank: number) => ({ value, raw: value, overallRank: rank, posRank: rank, trend30: 0 });
  attachMarket(players, new Map([["a", mk(100, 1)], ["c", mk(60, 2)], ["d", mk(5, 3)]]));
  const g = (id: string) => players.get(id)!;
  assert.equal(g("a").trueMarket, 100);
  assert.equal(g("b").marketEstimated, true, "b is ranked inside the list but missing from it");
  assert.equal(g("b").market, g("b").trueMarket);
  assert.equal(g("b").edge, 0);
  assert.equal(g("c").market, 60);
  assert.ok((g("c").edge ?? 0) < 0, "we rank c below the market");
  assert.equal(g("k").market, undefined);
  attachMarket(players, null);
  assert.equal(g("a").market, undefined);
  assert.equal(g("a").edge, undefined);
});

test("bench-upgrade rule: both players market ≥ 3 AND value ≥ 3, received player a real asset, my season +0.8", () => {
  const a = vp("a", "WR", 9, 4, { ...G, market: 5 });
  const b = vp("b", "WR", 10, 6, { ...G, market: 6 });
  assert.equal(benchUpgradeOk(a, b, 1), true);
  assert.equal(benchUpgradeOk(a, b, 0.5), false);
  assert.equal(benchUpgradeOk(vp("z", "RB", 5, 0, { ...G, market: 12 }), b, 2), false, "our value 0 (the Kamara case)");
  assert.equal(benchUpgradeOk(a, vp("q", "QB", 15, 0.2, { ...G, market: 12 }), 2), false, "our value 0.2");
  assert.equal(benchUpgradeOk(a, vp("s", "WR", 8, 4, { ...G, market: 4 }), 2), false, "received player not a real asset");
  assert.equal(benchUpgradeOk(a, vp("s", "WR", 8, 4, { ...G, market: 9 }), 2), true);
});

test("bench-upgrade filter applies eligibility and the QB rule", () => {
  const ok = benchUpgradeFilter(ctx, "me");
  // Their QB24 is not a spare (one QB); my QB2 may only go to them because they need a QB.
  assert.equal(ok(P("mRB4"), P("tQB"), 2, "them"), false);
  assert.equal(ok(P("mK"), P("tWR4"), 2, "them"), false);
  assert.equal(ok(P("mRB4"), P("tWR4"), 2, "them"), true);
  assert.equal(ok(P("mQB"), P("tWR4"), 2, "them"), false, "my starting QB never moves");
  const items = qbItems(teamV3(ctx, "me"), teamV3(ctx, "them"), [P("mQB2")], [P("tWR5")]);
  assert.equal(items![0].label, "QB rule");
  assert.match(items![0].value, /^mQB2 allowed/);
});

// ---------------------------------------------------------------- v3.1

test("v3.1 A: a received pass-catcher from my WR's NFL team counts ×0.85 and is tagged", () => {
  const base = J()([P("mRB3")], [P("tWR3")]);
  const saved = P("tWR3").team;
  P("tWR3").team = P("mWR1").team; // same NFL team as my starting WR
  try {
    const shared = judge3(ctx, teamV3(ctx, "me"), teamV3(ctx, "them"), "balanced")([P("mRB3")], [P("tWR3")]);
    assert.ok(shared.myDelta < base.myDelta, `${shared.myDelta} vs ${base.myDelta}`);
    assert.ok(shared.tags31.some((t) => /shares targets with mWR1/.test(t)), shared.tags31.join());
  } finally {
    P("tWR3").team = saved;
  }
});

test("v3.1 B: a starting slot losing ≥ 3 ppg counts ×1.5 and is tagged; thin + injured adds −1.0", () => {
  const j = J()([P("mTE")], [P("tWR3")]); // my only TE (8 ppg) leaves: TE slot → empty
  assert.ok(j.slotPenalty >= 0.5 * 8 - 1e-9, `penalty ${j.slotPenalty}`);
  assert.ok(j.tags31.some((t) => /^downgrades TE by 8\.0$/.test(t)), j.tags31.join());
  // Thin: get an injured TE back for my only TE.
  const saved = P("tTE").injury;
  P("tTE").injury = { status: "Questionable", week: 4 };
  try {
    const k = judge3(ctx, teamV3(ctx, "me"), teamV3(ctx, "them"), "balanced")([P("mTE"), P("mRB4")], [P("tTE"), P("tWR5")]);
    if (k.tags31.some((t) => t.startsWith("downgrades TE"))) assert.ok(k.tags31.includes("thin at TE"), k.tags31.join());
  } finally {
    P("tTE").injury = saved;
  }
});

test("v3.1 D: giving a riser costs ×1.15 in my true value and he is never tagged sell-high", () => {
  const plain = J()([P("mRB3")], [P("tWR3")]);
  P("mRB3").riser = true;
  P("mRB3").edge = -12;
  try {
    const j = J()([P("mRB3")], [P("tWR3")]);
    assert.ok(Math.abs(j.trueGive - plain.trueGive * 1.15) < 1e-9);
    assert.ok(j.items31.some((d) => d.label === "Riser you give" && /^mRB3/.test(d.value)));
    const ev = evaluateTradeV3(ctx, "me", "them", ["mRB3"], ["tWR3"]);
    assert.ok(ev.tags.includes("riser: mRB3"), ev.tags.join());
    assert.ok(!ev.tags.some((t) => t.startsWith("sell-high") || t.startsWith("market overvalues")), ev.tags.join());
  } finally {
    delete P("mRB3").riser;
    delete P("mRB3").edge;
  }
});

test("label tags: buy-low / sell-high come from luck, the market gap is 'market undervalues / overvalues'", () => {
  const setP = (id: string, o: Partial<ValuedPlayer>) => Object.assign(P(id), o);
  setP("tWR3", { label: "buy-low", luck: 2.6, edge: 9 });
  setP("mRB3", { label: "sell-high", luck: -3.2, edge: -10 });
  try {
    const tags = evaluateTradeV3(ctx, "me", "them", ["mRB3"], ["tWR3"]).tags;
    assert.ok(tags.includes("buy-low: tWR3 (due +2.6 pts/g)"), tags.join(" | "));
    assert.ok(tags.includes("sell-high: mRB3 (TD luck −3.2 pts/g)"), tags.join(" | "));
    assert.ok(tags.includes("market undervalues: tWR3 (+9.0)"), tags.join(" | "));
    assert.ok(tags.includes("market overvalues: mRB3 (−10.0)"), tags.join(" | "));
    // A big market gap alone is not a buy-low (that word now means luck).
    setP("tWR3", { label: undefined });
    assert.ok(!evaluateTradeV3(ctx, "me", "them", ["mRB3"], ["tWR3"]).tags.some((t) => t.startsWith("buy-low")));
  } finally {
    for (const id of ["tWR3", "mRB3"]) for (const k of ["label", "luck", "edge"] as const) delete P(id)[k];
  }
});

test("IR slot: teamV3 never starts a healthy IR-slotted player and scores the roster without him", () => {
  const c = ctxFor(league([team("me", mine, { irPlayerIds: ["mWR1"] }), team("them", theirs)]), [...mine, ...theirs]);
  const me = teamV3(c, "me");
  assert.ok(!me.base.lineup.some((l) => l.player?.id === "mWR1"));
  assert.ok(!me.starters.has("mWR1") && !me.starterList.some((p) => p.id === "mWR1"));
  // Owner 2026-10-26: the IR slot alone is not a reason — he is offered when he passes eligibility.
  assert.equal(ineligibleReason(P("mWR1"), c.league.settings), "");
  assert.ok(me.pieces.some((p) => p.id === "mWR1"), "an eligible IR-slot player is a piece");
  const without = rosterParts(c.league.settings, mine.filter((p) => p.id !== "mWR1"), REPL).parts;
  assert.equal(me.parts.now, without.now);
  assert.equal(me.parts.depth, without.depth);
  assert.ok(me.parts.now < teamV3(ctx, "me").parts.now);
});

test("finder never suggests selling a riser or a noise-level gain (any list); buying a TD-luck spike is tagged", () => {
  const before = findTradesV3(ctx, "me", { valueSource: "model", limit: 50 });
  const listed = (r: typeof before) => [...r.trades, ...r.smallerEdges, ...r.nearMisses];
  assert.ok(listed(before).length > 0, "baseline finds trades");
  for (const t of listed(before)) assert.ok(t.me.scoreDelta === undefined || t.me.scoreDelta >= 1.0 - 1e-9, `${t.key}: gain ${t.me.scoreDelta} below the noise bar`);
  const giver = listed(before)[0].me.gives[0].id;
  P(giver).riser = true;
  try {
    const after = findTradesV3(ctx, "me", { valueSource: "model", limit: 50 });
    for (const t of listed(after)) assert.ok(!t.me.gives.some((p) => p.id === giver), `${t.key} sells riser ${giver}`);
  } finally {
    delete P(giver).riser;
  }
  const got = listed(before)[0].them.gives[0];
  const savedLabel = P(got.id).label;
  const savedLuck = P(got.id).luck;
  P(got.id).label = "sell-high";
  P(got.id).luck = -3.1;
  try {
    const t = listed(findTradesV3(ctx, "me", { valueSource: "model", limit: 50 })).find((x) => x.them.gives.some((p) => p.id === got.id));
    if (t) assert.ok(t.tags.some((g) => g.startsWith(`TD luck: ${got.name}`)), t.tags.join());
  } finally {
    P(got.id).label = savedLabel;
    P(got.id).luck = savedLuck;
  }
});

test("release (c): an injured star with an unconfirmed return is worth his return estimate in trades, and the card says so", () => {
  // Their WR on IR: 0 every week (value 0) but a healthy role worth 30 on the return estimate.
  const star = vp("tIR", "WR", 0, 0, {
    remainingGames: 0,
    injury: { status: "IR", week: 8 },
    ret: { week: null, confidence: "unknown", reasons: [], absent: true, practiceUp: false, healthyRate: 18, returnValue: 40, playoffPts: 27, tradeValue: 30 },
  });
  const back = vp("tBK", "WR", 12, 16, { ret: { week: 10, confidence: "medium", reasons: [], absent: true, practiceUp: false, healthyRate: 14, playoffPts: 42 } });
  const roster = [...theirs, star, back];
  const c = ctxFor(league([team("me", mine), team("them", roster)]), [...mine, ...roster]);
  const ev = evaluateTradeV3(c, "me", "them", ["mRB3"], ["tIR"]);
  assert.ok(Math.abs(ev.packages!.trueGet - 30) < 1e-9, `true value of what I get = his trade value, got ${ev.packages!.trueGet}`);
  assert.ok(ev.details!.some((d) => d.label === "Injured, you get" && /tIR: return unconfirmed, a bet on his recovery \(valued 30\.0/.test(d.value)), JSON.stringify(ev.details));
  const ev2 = evaluateTradeV3(c, "me", "them", ["mRB3"], ["tBK"]);
  assert.ok(ev2.details!.some((d) => d.label === "Injured, you get" && /back ~wk 10 \(medium\)/.test(d.value)));
  assert.deepEqual(detailProblems(ev.details!), []);
  // Market attachment ranks him by the same trade value (no spurious "market overvalues" edge from a 0).
  const ps = [vp("a", "WR", 20, 100, G), star, vp("c", "WR", 10, 10, G)];
  const mv = (value: number, rank: number) => ({ value, raw: value, overallRank: rank, posRank: rank, trend30: 0 }) as MarketValue;
  attachMarket(new Map(ps.map((p) => [p.id, p])), new Map([["a", mv(90, 1)], ["tIR", mv(40, 2)], ["c", mv(8, 3)]]));
  assert.ok(star.trueMarket! > 0, `trueMarket ${star.trueMarket}`);
  // His value is a placeholder, not a market opinion: no edge (Values shows "—", no market tag) and no value pitch.
  assert.equal(star.edge, undefined);
  assert.notEqual(ps[2].edge, undefined, "a healthy player keeps his edge");
  assert.match(ev.pitch!, /tIR's return is unconfirmed, so this is a bet on his recovery/);
  assert.doesNotMatch(ev.pitch!, /by market|fair by/);
  assert.ok(!ev.tags.some((t) => /market (under|over)values: tIR/.test(t)), JSON.stringify(ev.tags));
});

// ---------------------------------------------------------------- v4: their view (release (d))

/** A fresh context on copies of the fixture rosters (perceptions are cached per player object). */
function freshCtx(edit: (p: ValuedPlayer) => void = () => {}) {
  const m = mine.map((p) => ({ ...p }));
  const t = theirs.map((p) => ({ ...p }));
  [...m, ...t].forEach(edit);
  const c = ctxFor(league([team("me", m), team("them", t)]), [...m, ...t]);
  return { c, P: (id: string) => c.players.get(id)!, J: () => judge3(c, teamV3(c, "me"), teamV3(c, "them"), "balanced") };
}

test("v4: a deal our projections like for them but Yahoo shows as a loss → acceptance ≤ 0.25, a near miss, never the main list", () => {
  // Captured Yahoo projections: they rate my RB3 at ~1.5/game and their WR3 at ~15/game.
  const yahoo: Record<string, number> = { mRB3: 20, tWR3: 210 };
  const f = freshCtx((p) => {
    if (yahoo[p.id] !== undefined) p.yahooProj = yahoo[p.id];
  });
  const j = f.J()([f.P("mRB3")], [f.P("tWR3")]);
  assert.equal(j.perceivedSource, "yahoo");
  assert.ok(j.theirPerceived < 0, `perceived ${j.theirPerceived}`);
  assert.equal(j.perceivedLoss, true);
  assert.ok(j.acceptance <= V3.perceivedLossCap, `acceptance ${j.acceptance}`);
  assert.equal(j.partnerOk, false);
  assert.match(j.theirFail, /^Yahoo shows them −\d+\.\d pts rest of season$/);
  const r = findTradesV3(f.c, "me", { valueSource: "model", limit: 50 });
  for (const t of [...r.trades, ...r.smallerEdges]) {
    assert.ok(t.yahooView!.them >= 0, `${t.key}: perceived loss on a main list`);
    assert.ok(t.acceptance > V3.perceivedLossCap, t.key);
  }
  for (const t of r.nearMisses) if (t.yahooView!.them < 0) assert.ok(t.acceptance <= V3.perceivedLossCap, t.key);
  const ev = evaluateTradeV3(f.c, "me", "them", ["mRB3"], ["tWR3"]);
  assert.match(ev.yahooView!.label, /^What Yahoo shows them: you [+−]\d+\.\d, them −\d+\.\d pts$/);
  assert.ok(ev.details!.some((d) => d.label === "What Yahoo shows"), "captured: no estimate wording");
  // Not captured: the card says it is an estimate.
  const est = evaluateTradeV3(ctx, "me", "them", ["mRB3"], ["tWR3"]);
  assert.equal(est.yahooView!.source, "estimate");
  assert.match(est.yahooView!.label, /\(estimate\)$/);
  assert.ok(est.details!.some((d) => d.label === "Their view from" && /not captured yet/.test(d.value)));
});

test("v4: asking for a receiver right after his 2-TD game lowers acceptance (recency bias + spike) and is tagged", () => {
  const base = freshCtx();
  const calm = base.J()([base.P("mRB3")], [base.P("tWR3")]);
  // Week 3 (current week 4): 8 catches, 150 yards, 2 TDs = 31 half-PPR points vs his 14/game.
  const spiked = freshCtx((p) => {
    if (p.id === "tWR3") p.weeks = [{ season: 2026, week: 3, team: p.team, actual: { passYd: 0, passTd: 0, passInt: 0, rushYd: 0, rushTd: 0, rec: 8, recYd: 150, recTd: 2, twoPt: 0, fumLost: 0 }, expected: { passYd: 0, passTd: 0, passInt: 0, rushYd: 0, rushTd: 0, rec: 0, recYd: 0, recTd: 0, twoPt: 0, fumLost: 0 } }];
  });
  const j = spiked.J()([spiked.P("mRB3")], [spiked.P("tWR3")]);
  assert.deepEqual(j.spikes.map((p) => p.id), ["tWR3"]);
  assert.ok(j.acceptance < calm.acceptance, `spike ${j.acceptance} vs calm ${calm.acceptance}`);
  const t = evaluateTradeV3(spiked.c, "me", "them", ["mRB3"], ["tWR3"]);
  assert.ok(t.tags.includes("just spiked: tWR3"), t.tags.join());
  assert.ok(t.details!.some((d) => d.label === "Just spiked" && /^tWR3: 31\.0 pts last game/.test(d.value)), JSON.stringify(t.details));
});

test("v4: giving my best bench RB while a starting RB has a bye ahead, or my only QB backup, flags lost cover", () => {
  const f = freshCtx((p) => {
    if (p.id === "mRB1") p.bye = 9;
    if (p.id === "tRB1") p.ppg = 12.5;
  });
  const my = teamV3(f.c, "me");
  const items = coverLost(f.c.league.settings, my, [f.P("mRB4")], [f.P("tWR5")]);
  assert.deepEqual(items.map((d) => d.label), ["Bye cover lost"]);
  assert.match(items[0].value, /^mRB4 covers mRB1's week 9 bye/);
  // Getting an RB back who covers the week as well (12.5 vs 12.0) keeps the cover.
  assert.deepEqual(coverLost(f.c.league.settings, my, [f.P("mRB4")], [f.P("tRB1")]), []);
  const qb = coverLost(f.c.league.settings, my, [f.P("mQB2")], [f.P("tWR5")]);
  assert.deepEqual(qb.map((d) => [d.label, d.value]), [["Playoff cover lost", "mQB2 is your only QB backup"]]);
  const t = evaluateTradeV3(f.c, "me", "them", ["mRB4"], ["tWR5"]);
  assert.ok(t.tags.includes("loses bye cover"), t.tags.join());
  assert.ok(t.details!.some((d) => d.label === "Bye cover lost"));
});

test("v4: pitches give reasons that matter to them — never a market-value claim — on every list and on evaluate", () => {
  const r = findTradesV3(ctx, "me", { valueSource: "model", limit: 50 });
  const all = [...r.trades, ...r.smallerEdges, ...r.nearMisses, evaluateTradeV3(ctx, "me", "them", ["mRB3"], ["tWR3"])];
  assert.ok(all.length > 1);
  for (const t of all) {
    assert.doesNotMatch(t.pitch!, /market|by value|you win on value/i, t.pitch);
    assert.match(t.pitch!, /^My .+ for your .+: .+\.$/, t.pitch);
  }
  assert.ok(r.summaryDetails!.some((d) => d.label === "Their view" && /not captured yet/.test(d.value)));
});

test("lazy judge (finder search) skips team strength only for candidates no list takes; otherwise identical", () => {
  const eager = J();
  const lazy = judge3(ctx, teamV3(ctx, "me"), teamV3(ctx, "them"), "balanced", { lazy: true });
  const ids = (xs: string[]) => xs.map(P);
  const deals: [string[], string[]][] = [
    [["mRB3"], ["tWR3"]], [["mRB2", "mRB3"], ["tWR1"]], [["mRB1"], ["tWR2", "tWR3"]], [["mRB1", "mRB4"], ["tWR1"]], [["mRB4"], ["tWR5"]], [["mTE"], ["tTE"]],
  ];
  let computed = 0;
  for (const [g, r] of deals) {
    const e = eager(ids(g), ids(r));
    const l = lazy(ids(g), ids(r));
    assert.ok(Number.isFinite(e.strengthDelta), "eager always computes the playoff-lineup change");
    if (Number.isNaN(l.strengthDelta)) {
      // Unlisted: both sides fail, or my side fails with no real gain for me / partner fails on a lopsided market.
      assert.ok(!(e.myOk && e.partnerOk), `${g}>${r}: a passing deal must be simulated`);
      assert.ok(!(e.myOk && e.fairness >= 0.85), `${g}>${r}: a "refuse" near miss must be simulated`);
    } else {
      computed++;
      assert.equal(l.strengthDelta, e.strengthDelta);
      assert.equal(l.score, e.score);
    }
  }
  assert.ok(computed > 0);
});

// ---------------------------------------------------------------- injured trade pieces (owner 2026-10-26)

/** A WR back in week `week` (current week 4, weeks 4..17): our weekly points are 0 before, ppg after. */
const injuredWr = (id: string, week: number, ppg: number, value: number, name = id): ValuedPlayer => {
  const p = backIn(id, week, { ppg, value, name, weekly: Array.from({ length: 14 }, (_, i) => (4 + i < week ? 0 : ppg)), weeklyFrom: 4 });
  return p;
};
function injuredCtx(o: { myIr?: boolean; theirIrWeek?: number } = {}) {
  const m = mine.map((p) => ({ ...p }));
  const t = theirs.map((p) => ({ ...p }));
  const mIRB = injuredWr("mIRB", 6, 13, 12);
  const tIRB = injuredWr("tIRB", o.theirIrWeek ?? 6, 14, 15);
  mIRB.team = "PHI";
  tIRB.team = "PIT";
  const meTeam = o.myIr ? team("me", [...m, mIRB], { irPlayerIds: ["mIRB"] }) : team("me", m);
  return ctxFor(league([meTeam, team("them", [...t, tIRB], { irPlayerIds: ["tIRB"] })]), [...m, ...t, mIRB, tIRB]);
}

test("injured pieces: back in 2 weeks is a piece on both rosters (IR slot too); cards say 'back ~wk 6' and the row summary carries the marker", () => {
  const c = injuredCtx({ myIr: true });
  assert.ok(teamV3(c, "me").pieces.some((p) => p.id === "mIRB"), "my IR-slot player, back in 2 weeks");
  assert.ok(teamV3(c, "them").pieces.some((p) => p.id === "tIRB"), "their IR-slot player, back in 2 weeks");
  const buy = evaluateTradeV3(c, "me", "them", ["mWR2"], ["tIRB"]);
  assert.ok(buy.details!.some((d) => d.label === "Injured, you get" && /^tIRB: back ~wk 6 \(medium\), valued from his return/.test(d.value)), JSON.stringify(buy.details));
  assert.ok(buy.summary!.startsWith("mWR2 for tIRB (injured, back ~wk 6): "), buy.summary);
  assert.ok(!buy.details!.some((d) => d.label === "Outside the rules"), "inside the rules");
  const sell = evaluateTradeV3(c, "me", "them", ["mIRB"], ["tWR5"]);
  assert.ok(sell.details!.some((d) => d.label === "Injured, you give" && /^mIRB: back ~wk 6/.test(d.value)));
  assert.ok(sell.summary!.startsWith("mIRB (injured, back ~wk 6) for tWR5: "), sell.summary);
  assert.deepEqual(detailProblems(sell.details!), []);
});

test("injured pieces: back with only 2 games left is not a piece; evaluate flags him outside the rules", () => {
  const c = injuredCtx({ theirIrWeek: 16 });
  assert.ok(!teamV3(c, "them").pieces.some((p) => p.id === "tIRB"));
  const ev = evaluateTradeV3(c, "me", "them", ["mWR2"], ["tIRB"]);
  assert.ok(ev.details!.some((d) => d.label === "Outside the rules" && /tIRB: back ~wk 16: only 2 games left/.test(d.value)), JSON.stringify(ev.details));
});

test("injured pieces: roster spots — an incoming IR player fills my free IR slot (no cut); my IR full → a cut; my IR player traded away → a cut", () => {
  // Free IR slot: tIRB + tWR5 for mRB4 needs no cut; the partner frees an IR spot and a bench spot for one player.
  const free = injuredCtx();
  const jf = judge3(free, teamV3(free, "me"), teamV3(free, "them"), "balanced")([free.players.get("mRB4")!], [free.players.get("tIRB")!, free.players.get("tWR5")!]);
  assert.deepEqual(jf.myDrops, []);
  assert.deepEqual(jf.theirDrops, []);
  const evf = evaluateTradeV3(free, "me", "them", ["mRB4"], ["tIRB", "tWR5"]);
  assert.ok(!evf.details!.some((d) => d.label === "You cut"), "no cut with a free IR slot");
  assert.ok(!evf.tags.includes("adds depth (you drop a bench player)"));
  // My IR slot is full (mIRB): tIRB takes a bench spot → I cut my lowest-value bench player, on the card too.
  const full = injuredCtx({ myIr: true });
  const ju = judge3(full, teamV3(full, "me"), teamV3(full, "them"), "balanced")([full.players.get("mRB4")!], [full.players.get("tIRB")!, full.players.get("tWR5")!]);
  assert.deepEqual(ju.myDrops.map((p) => p.id), ["mBN"]);
  const evu = evaluateTradeV3(full, "me", "them", ["mRB4"], ["tIRB", "tWR5"]);
  assert.ok(evu.details!.some((d) => d.label === "You cut" && d.value === "mBN"), JSON.stringify(evu.details));
  // 1-for-1, I give my IR-slot player for a healthy one: my active roster grows → one cut; the partner (IR full) too
  // gives an active player for an IR-eligible one with no IR room: no change for them.
  const jg = judge3(full, teamV3(full, "me"), teamV3(full, "them"), "balanced")([full.players.get("mIRB")!], [full.players.get("tWR5")!]);
  assert.deepEqual(jg.myDrops.map((p) => p.id), ["mBN"]);
  assert.deepEqual(jg.theirDrops, []);
  const evg = evaluateTradeV3(full, "me", "them", ["mIRB"], ["tWR5"]);
  assert.ok(evg.details!.some((d) => d.label === "You cut" && d.value === "mBN"));
  assert.ok(evg.packages!.myTrueChange < jg.trueGet - jg.trueGive + 1e-9, "the cut's value is charged to my side");
});

test("injured pieces: the partner's perceived view counts only his weeks back (fix round 1), so he is worth less to them than a healthy twin", () => {
  const c = injuredCtx({ myIr: true });
  const S4 = c.league.settings;
  const inj = c.players.get("mIRB")!;
  // Good enough to start for them once back (their WRs: 19, 15, 14 start).
  inj.ppg = 25;
  inj.weekly = inj.weekly!.map((v) => (v > 0 ? 25 : 0));
  assert.deepEqual(perceptionOf(inj, S4).weekly.slice(0, 3).map((v) => v > 0), [false, false, true]);
  const twin: ValuedPlayer = { ...inj, id: "mTWIN", name: "mTWIN", ret: undefined, injury: undefined, weekly: Array(14).fill(inj.ppg), remainingGames: 14 };
  const ct = ctxFor(league([team("me", [...mine.map((p) => ({ ...p })), twin]), team("them", theirs.map((p) => ({ ...p })))]), [...mine, ...theirs, twin]);
  const jInj = judge3(c, teamV3(c, "me"), teamV3(c, "them"), "balanced")([inj], [c.players.get("tWR5")!]);
  const jTwin = judge3(ct, teamV3(ct, "me"), teamV3(ct, "them"), "balanced")([twin], [ct.players.get("tWR5")!]);
  assert.ok(jInj.theirPerceived < jTwin.theirPerceived, `injured ${jInj.theirPerceived} vs healthy ${jTwin.theirPerceived}`);
});

test("injured pieces: row summary with markers stays ≤ 255 chars on a 3-for-1 with two injured long-named players", () => {
  const c = injuredCtx({ myIr: true });
  c.players.get("mIRB")!.name = "Christopherson Longfellow-Whitaker Jr.";
  c.players.get("tIRB")!.name = "Bartholomew Montgomery-Fitzgerald III";
  c.players.get("mRB3")!.name = "Maximilian Alexander Featherstonehaugh";
  const ev = evaluateTradeV3(c, "me", "them", ["mIRB", "mRB3", "mRB4"], ["tIRB"]);
  assert.match(ev.summary!, /Christopherson Longfellow-Whitaker Jr\. \(injured, back ~wk 6\)/);
  assert.deepEqual(summaryProblems(ev.summary!), [], ev.summary);
});

test("search covers every partner (no early stop after the top 8 by complementarity)", () => {
  const partners = Array.from({ length: 10 }, (_, k) => theirs.map((p) => ({ ...p, id: `${p.id}_${k}`, name: `${p.name}_${k}` })));
  const c = ctxFor(league([team("me", mine), ...partners.map((ps, k) => team(`p${k}`, ps))]), [...mine, ...partners.flat()]);
  const one = findTradesV3(c, "me", { valueSource: "model", partnerId: "p9" });
  const all = findTradesV3(c, "me", { valueSource: "model" });
  assert.ok(one.trades.length > 0, "identical partners each offer clear trades");
  assert.equal(all.simulated, 10 * one.simulated, "all 10 partners judged");
});

test("cover lost: a same-position player starting at FLEX counts as cover (only claim 'only backup' when true)", () => {
  // TEs: tTop 16 at TE, mTE 14 at FLEX (beats mRB3 13.5), mTE3 5 on the bench.
  const m = mine.map((p) => ({ ...p, ...(p.id === "mTE" ? { ppg: 14, effPpg: 14 } : {}) }));
  m.push({ ...m.find((p) => p.id === "mTE")!, id: "mTEtop", name: "mTEtop", ppg: 16, effPpg: 16, team: "SEA" }, { ...m.find((p) => p.id === "mTE")!, id: "mTE3", name: "mTE3", ppg: 5, effPpg: 5, value: 1, team: "TB" });
  const t = theirs.map((p) => ({ ...p }));
  const c = ctxFor(league([team("me", m), team("them", t)]), [...m, ...t]);
  const my = teamV3(c, "me");
  const slotOf = (id: string) => my.base.lineup.find((l) => l.player?.id === id)?.slot;
  assert.equal(slotOf("mTEtop"), "TE");
  assert.ok(slotOf("mTE") && slotOf("mTE") !== "TE", `fixture: mTE starts at a flex slot (${slotOf("mTE")})`);
  const P = (id: string) => c.players.get(id)!;
  // Giving the bench TE: the FLEX TE still covers the TE slot.
  assert.deepEqual(coverLost(c.league.settings, my, [P("mTE3")], [P("tWR5")]).filter((d) => d.label === "Playoff cover lost"), []);
  // Giving the bench TE and the FLEX TE: now nobody covers.
  const both = coverLost(c.league.settings, my, [P("mTE3"), P("mTE")], [P("tWR5")]).filter((d) => d.label === "Playoff cover lost");
  assert.equal(both.length, 1);
  assert.match(both[0].value, /is your only TE backup$/);
  // A bye of the TE starter: the FLEX TE covers it, so giving the bench TE loses no bye cover.
  const mb = m.map((p) => (p.id === "mTEtop" ? { ...p, bye: 9 } : p));
  const byeCtx = ctxFor(league([team("me", mb), team("them", t)]), [...mb, ...t]);
  const myB = teamV3(byeCtx, "me");
  assert.deepEqual(coverLost(byeCtx.league.settings, myB, [byeCtx.players.get("mTE3")!], [byeCtx.players.get("tWR5")!]).filter((d) => d.label === "Bye cover lost"), []);
  // The FLEX TE's own bye: any bench W/R/T fills the FLEX (mRB3 13.5 > mTE3 5), so the bench TE is not that cover either.
  const mf = m.map((p) => (p.id === "mTE" ? { ...p, bye: 9 } : p));
  const flexCtx = ctxFor(league([team("me", mf), team("them", t)]), [...mf, ...t]);
  const myF = teamV3(flexCtx, "me");
  assert.ok(FLEX_SLOTS.includes(myF.base.lineup.find((l) => l.player?.id === "mTE")!.slot), "fixture: mTE still at FLEX");
  assert.deepEqual(coverLost(flexCtx.league.settings, myF, [flexCtx.players.get("mTE3")!], [flexCtx.players.get("tWR5")!]).filter((d) => d.label === "Bye cover lost"), []);
  const rb = coverLost(flexCtx.league.settings, myF, [flexCtx.players.get("mRB3")!], [flexCtx.players.get("tBN")!]).filter((d) => d.label === "Bye cover lost");
  assert.ok(rb.some((d) => /^mRB3 covers mTE's week 9 bye/.test(d.value)), JSON.stringify(rb));
});

// ---------------------------------------------------------------- mode-aware listing (fix 2026-10-27)

test("the main list follows the mode: Playoffs gates on playoff strength, Balanced / Win now on the mode's team score with a playoff floor", () => {
  // Helps now, not in the playoffs (e.g. injured-now players who return before the playoffs, sold for one healthy one).
  const nowOnly = { myDelta: 2.4, strengthDelta: -0.3 };
  assert.equal(listsInMode(nowOnly, "now"), true);
  assert.equal(listsInMode(nowOnly, "balanced"), true);
  assert.equal(listsInMode(nowOnly, "playoffs"), false, "never in Playoffs mode");
  // Playoff strength −0.8: past Balanced's −0.5 floor, inside Win now's −1.0.
  const deeper = { myDelta: 2.4, strengthDelta: -0.8 };
  assert.deepEqual([listsInMode(deeper, "now"), listsInMode(deeper, "balanced"), listsInMode(deeper, "playoffs")], [true, false, false]);
  // Wrecks the playoffs: listed in no mode, however big the gain now.
  const wreck = { myDelta: 6, strengthDelta: -1.1 };
  assert.deepEqual([listsInMode(wreck, "now"), listsInMode(wreck, "balanced"), listsInMode(wreck, "playoffs")], [false, false, false]);
  // Playoff gain only: Playoffs lists it, the other modes need their own score ≥ minMyGain.
  const playoffOnly = { myDelta: 0.6, strengthDelta: 1.5 };
  assert.deepEqual([listsInMode(playoffOnly, "now"), listsInMode(playoffOnly, "balanced"), listsInMode(playoffOnly, "playoffs")], [false, false, true]);
  // Exactly at the bars.
  assert.equal(listsInMode({ myDelta: V3.minMyGain, strengthDelta: V3.playoffFloor.balanced! }, "balanced"), true);
  assert.equal(listsInMode({ myDelta: V3.minMyGain, strengthDelta: V3.playoffFloor.now! }, "now"), true);
  assert.equal(listsInMode({ myDelta: 0, strengthDelta: V3.minMyGain }, "playoffs"), true);
  // The gain each mode lists and ranks on.
  assert.equal(modeGain(nowOnly, "playoffs"), -0.3);
  assert.equal(modeGain(nowOnly, "balanced"), 2.4);
  assert.equal(modeGain(nowOnly, "now"), 2.4);
});

test("marginal near misses use the same per-mode measure: a real gain (> 0) in the mode, the same playoff floor", () => {
  assert.equal(listsInMode({ myDelta: 0.3, strengthDelta: 0.2 }, "balanced", true), true);
  assert.equal(listsInMode({ myDelta: 0.3, strengthDelta: -0.6 }, "balanced", true), false, "Balanced floor −0.5");
  assert.equal(listsInMode({ myDelta: 0.3, strengthDelta: -0.6 }, "now", true), true);
  assert.equal(listsInMode({ myDelta: 3, strengthDelta: 0 }, "playoffs", true), false, "Playoffs: needs playoff strength > 0");
  assert.equal(listsInMode({ myDelta: -1, strengthDelta: 0.2 }, "playoffs", true), true);
  assert.equal(listsInMode({ myDelta: 0, strengthDelta: 2 }, "now", true), false);
  // Noise-level gain: +0.04 shows as +0.0 on the card, so it is no marginal near miss (fix round 1).
  assert.equal(listsInMode({ myDelta: 0.04, strengthDelta: 0.5 }, "balanced", true), false);
  assert.equal(listsInMode({ myDelta: 0.05, strengthDelta: 0.5 }, "balanced", true), true);
});

test("evaluate's mode bar bullet says why a deal clears or fails the mode's listing bar", () => {
  assert.equal(modeBarText({ myDelta: 2.4, strengthDelta: -0.3 }, "now"), "clears: team score +2.4, playoff strength −0.3");
  assert.equal(modeBarText({ myDelta: 2.4, strengthDelta: -0.3 }, "playoffs"), "fails: playoff strength −0.3 (needs +1.0)");
  assert.equal(modeBarText({ myDelta: 2.4, strengthDelta: -0.8 }, "balanced"), "fails: playoff strength −0.8 (floor −0.5)");
  assert.equal(modeBarText({ myDelta: 0.4, strengthDelta: 1.2 }, "balanced"), "fails: team score +0.4 (needs +1.0)");
  assert.equal(modeBarText({ myDelta: 0.4, strengthDelta: 1.2 }, "playoffs"), "clears: playoff strength +1.2");
});
