import { test } from "node:test";
import assert from "node:assert/strict";
import { findBreakouts, howItems, isPathStatus, lastVsEarlier, normalizer, roleMetrics, situationOf, suggestAsk, thesisOf } from "./breakouts.js";
import { DepthReducer, buildDepthChart } from "../data/depthCharts.js";
import { analyzeTeams } from "./analysis.js";
import { HALF_PPR } from "./scoring.js";
import { detailProblems, league, line, summaryProblems, team, vp } from "./testkit.js";
import type { ValuedPlayer, WeekLine } from "./types.js";

const wk = (week: number, exp: number, act: number, opp?: WeekLine["opp"]): WeekLine => ({
  season: 2026, week, team: "KC",
  // rushing yards only: 0.1 pt/yd, so 10 yds = 1 pt
  expected: line({ rushYd: exp * 10 }), actual: line({ rushYd: act * 10 }), opp,
});

/** RB with per-week snap shares and expected / actual points. */
function rb(id: string, snaps: number[], exp: number[], act: number[], extra: Partial<ValuedPlayer> = {}): ValuedPlayer {
  const snapShare: Record<number, number> = {};
  snaps.forEach((s, i) => (snapShare[i + 1] = s));
  const weeks = exp.map((e, i) => wk(i + 1, e, act[i], { targets: 2, carries: 5 + i, airYards: 10 }));
  const ppgExp26 = exp.reduce((a, b) => a + b, 0) / exp.length;
  const ppg26 = act.reduce((a, b) => a + b, 0) / act.length;
  return vp(id, "RB", ppg26, 3, { snapShare, weeks, games: weeks.length, ppg26, ppgExp26, ...extra });
}

test("trend, level and gap math", () => {
  assert.ok(Math.abs(lastVsEarlier([0.2, 0.4, 0.6]) - 0.3) < 1e-9);
  assert.equal(lastVsEarlier([0.5]), 0);
  const p = rb("a", [0.22, 0.38, 0.51], [6, 9, 14], [4, 6, 8]);
  const m = roleMetrics(p, HALF_PPR);
  assert.equal(m.roleNow, 0.51);
  assert.equal(m.roleTrend, 0.21); // 0.51 − mean(0.22, 0.38)
  assert.equal(m.oppTrend, 6.5); // 14 − mean(6, 9)
  assert.equal(m.oppLevel, 11.5); // mean(9, 14)
  assert.equal(m.gap, 3.67); // 29/3 − 18/3
  assert.deepEqual(m.weeks, [1, 2, 3]);
  assert.deepEqual(m.snaps, [0.22, 0.38, 0.51]);
  assert.deepEqual(m.touches, [7, 8, 9]); // RB: carries + targets
  // one week: no trends
  const one = roleMetrics(rb("b", [0.4], [5], [5]), HALF_PPR);
  assert.equal(one.roleTrend, 0);
  assert.equal(one.oppTrend, 0);
});

test("normalizer clips to the pool and handles a flat pool", () => {
  const n = normalizer([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(n(0), 0);
  assert.equal(n(10), 1);
  assert.equal(n(5), 0.5);
  assert.equal(n(99), 1);
  assert.equal(normalizer([2, 2, 2])(2), 0);
});

test("injury statuses that open a path", () => {
  for (const s of ["Questionable", "Doubtful", "Out", "Q", "IR"]) assert.ok(isPathStatus(s), s);
  for (const s of [undefined, "", "Probable", "DNP"]) assert.ok(!isPathStatus(s), String(s));
});

test("situation: handcuff behind an injured RB1 gets the full bonus", () => {
  const starter = rb("star", [0.8, 0.8, 0.78], [15, 15, 15], [15, 15, 15], { name: "Kyren Williams", injury: { status: "Questionable", detail: "Knee", week: 3 }, ecrPos: 8 });
  const back = rb("back", [0.22, 0.38, 0.51], [6, 9, 14], [4, 6, 8], { name: "Backup" });
  const depth = { byPlayer: new Map([["star", { depth: 1 }], ["back", { depth: 2 }]]), byTeamPos: new Map([["KC|RB", ["star", "back"]]]) };
  const m = roleMetrics(back, HALF_PPR);
  const s = situationOf(back, [starter, back], depth, m);
  assert.equal(s.depthLabel, "RB2");
  assert.equal(s.ahead.length, 1);
  assert.equal(s.ahead[0].status, "Questionable");
  assert.ok(s.tags.includes("handcuff"));
  assert.ok(s.tags.includes("starter hurt"));
  assert.equal(s.bonus, 1);
  assert.equal(s.cite?.name, "Kyren Williams");
});

test("situation: committee (two RBs ≥ 40%) is a half bonus; slipping starter is a full one", () => {
  const a = rb("a", [0.55, 0.55, 0.5], [10, 10, 10], [10, 10, 10]);
  const b = rb("b", [0.4, 0.42, 0.45], [8, 8, 9], [8, 8, 8]);
  // no depth chart: order by latest snaps → a is RB1, b RB2
  const s = situationOf(b, [a, b], null, roleMetrics(b, HALF_PPR));
  assert.equal(s.depthLabel, "RB2");
  assert.ok(s.tags.includes("committee"));
  assert.ok(!s.tags.includes("handcuff")); // a is at 50% and not ECR top-24
  assert.equal(s.bonus, 0.5);

  const slipping = rb("s", [0.85, 0.8, 0.52], [14, 13, 9], [14, 12, 8]);
  const s2 = situationOf(b, [slipping, b], null, roleMetrics(b, HALF_PPR));
  assert.ok(s2.tags.includes("starter slipping")); // 0.52 − 0.825 ≤ −0.15
  assert.equal(s2.bonus, 1);
});

test("situation: WR3 rising and TE1 in waiting", () => {
  const wr = (id: string, snaps: number[]) => ({ ...rb(id, snaps, [5, 5, 5], [5, 5, 5]), pos: "WR" as const });
  const w1 = wr("w1", [0.9, 0.9, 0.9]);
  const w2 = wr("w2", [0.85, 0.85, 0.85]);
  const w3 = wr("w3", [0.4, 0.5, 0.7]);
  const depth = { byPlayer: new Map(), byTeamPos: new Map([["KC|WR", ["w1", "w2", "w3"]]]) };
  const s = situationOf(w3, [w1, w2, w3], depth, roleMetrics(w3, HALF_PPR));
  assert.equal(s.depthLabel, "WR3");
  assert.ok(s.tags.includes("WR3 rising"));
  assert.equal(s.bonus, 0.5);

  const te = (id: string, snaps: number[]) => ({ ...rb(id, snaps, [5, 5, 5], [5, 5, 5]), pos: "TE" as const });
  const t1 = te("t1", [0.9, 0.88, 0.86]);
  const t2 = te("t2", [0.2, 0.3, 0.45]);
  const s2 = situationOf(t2, [t1, t2], null, roleMetrics(t2, HALF_PPR));
  assert.equal(s2.depthLabel, "TE2");
  assert.ok(s2.tags.includes("TE1 in waiting"));
});

test("ask: cheapest single bench player at ≥ 90% of value, else two", () => {
  const bench = [vp("x", "WR", 5, 3), vp("y", "RB", 6, 9.5), vp("z", "RB", 7, 12), vp("k", "K", 8, 20)];
  assert.equal(suggestAsk(bench, 10), "Offer y (value 9.5)");
  assert.equal(suggestAsk(bench, 14), "Offer x + z (value 3.0 + 12.0)");
  assert.match(suggestAsk(bench, 40), /No bench offer/);
});

test("depth-chart reducer keeps only the newest snapshot's offensive rows", () => {
  const r = new DepthReducer();
  r.push("dt,team,player_name,espn_id,gsis_id,pos_grp_id,pos_grp,pos_id,pos_name,pos_abb,pos_slot,pos_rank");
  r.push("2026-09-20T00:00:00Z,LA,Old Guy,1,00-1,21,3WR 1TE,9,Running Back,RB,11,1");
  r.push("2026-09-29T00:00:00Z,LA,Kyren Williams,2,00-2,21,3WR 1TE,9,Running Back,RB,11,1");
  r.push("2026-09-29T00:00:00Z,LA,Blake Corum,3,00-3,21,3WR 1TE,9,Running Back,RB,11,2");
  r.push("2026-09-29T00:00:00Z,LA,Some LB,4,00-4,16,Base 4-3 D,26,Weakside Linebacker,WLB,5,1");
  r.push("2026-09-29T00:00:00Z,LA,Puka Nacua,5,00-5,21,3WR 1TE,1,Wide Receiver,WR,1,1");
  r.push("2026-09-29T00:00:00Z,LA,Davante Adams,6,00-6,21,3WR 1TE,1,Wide Receiver,WR,2,1");
  r.push("2026-09-29T00:00:00Z,LA,WR Four,7,00-7,21,3WR 1TE,1,Wide Receiver,WR,1,2");
  assert.equal(r.rows.length, 5);
  const d = buildDepthChart(r.rows, 2026, 4, r.asOf);
  assert.deepEqual(d.byTeamPos.get("LAR|RB"), ["00-2", "00-3"]);
  assert.deepEqual(d.byTeamPos.get("LAR|WR"), ["00-5", "00-6", "00-7"]);
  assert.equal(d.byPlayer.get("00-3")?.depth, 2);
  assert.equal(d.byPlayer.get("00-3")?.week, 4);
});

test("findBreakouts: excludes my roster, established starters, QBs and long-term injuries; scores and theses", () => {
  const starters = [vp("s1", "QB", 20, 20), vp("s2", "RB", 15, 20), vp("s3", "RB", 14, 20), vp("s4", "WR", 15, 20), vp("s5", "WR", 14, 20), vp("s6", "TE", 10, 10), vp("s7", "WR", 13, 15)];
  const mineP = [...starters, vp("myRB", "RB", 10, 8), vp("myBN", "WR", 4, 6)];
  const star = rb("star", [0.85, 0.85, 0.86], [18, 18, 18], [18, 18, 18], { name: "Star RB", injury: { status: "Out", detail: "Ankle", week: 3 } });
  const back = rb("back", [0.2, 0.35, 0.55], [5, 8, 13], [3, 5, 7], { name: "Rising Back" });
  const flat = rb("flat", [0.5, 0.5, 0.5], [8, 8, 8], [8, 8, 8], { name: "Flat Guy", team: "BUF" });
  const hurt = rb("hurt", [0.3, 0.4, 0.6], [5, 8, 13], [3, 5, 7], { name: "Hurt Guy", team: "DAL", injury: { status: "Out", detail: "ACL", week: 3 } });
  const qb = { ...rb("qb", [1, 1, 1], [10, 14, 20], [8, 9, 10]), pos: "QB" as const };
  const ps = [...mineP, star, back, flat, hurt, qb];
  const players = new Map(ps.map((p) => [p.id, p]));
  const L = league([team("me", mineP), team("o", [back])], undefined, { numTeams: 12 });
  const teams = analyzeTeams(L, players, { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 });
  const r = findBreakouts({ league: L, players, teams, myTeamId: "me" });
  const ids = r.targets.map((t) => t.player.id);
  assert.ok(ids.includes("back") && ids.includes("flat"));
  for (const x of ["myRB", "myBN", "star", "hurt", "qb"]) assert.ok(!ids.includes(x), x);
  const t = r.targets[0];
  assert.equal(t.player.id, "back");
  assert.deepEqual(t.where, { type: "roster", teamId: "o", teamName: "Team o" });
  assert.equal(t.components.situation, 1);
  assert.match(t.thesis, /^RB2 behind Star RB \(Out, ankle\); snaps 20%→35%→55%;/);
  assert.match(t.ask ?? "", /^Offer myBN \(value 6\.0\)/); // 6 ≥ 0.9 × 3
  assert.equal(t.summary, "RB2 behind Star RB (Out): 55% snaps (+28 pts), 10.5 expected pts/g lately. Offer myBN (value 6.0).");
  for (const x of r.targets) {
    assert.deepEqual(summaryProblems(x.summary), [], x.summary);
    assert.deepEqual(detailProblems(x.details), [], x.player.id);
  }
  assert.ok(t.details.some((d) => d.label === "Ahead of him" && d.value === "Star RB (Out, ankle)"));
  assert.ok(t.details.some((d) => d.label === "Snaps by week" && d.value === "20% → 35% → 55%"));
  assert.ok(t.details.some((d) => d.label === "Suggested offer" && /^Offer myBN/.test(d.value)));
  const c = t.components.parts;
  assert.equal(t.score, Math.round(1000 * (c.roleTrend + c.oppTrend + c.oppLevel + c.gap + c.situation)) / 10);
  assert.equal(t.tier, "rising"); // 55% snaps / 10.5 exp pts last 2 weeks
  // cheap-only filter (our value 3 < 12 for both; nothing rises above 12 here)
  assert.equal(findBreakouts({ league: L, players, teams, myTeamId: "me", cheapOnly: true }).targets.length, r.targets.length);
  assert.ok(r.targets.find((x) => x.player.id === "flat")!.score < t.score);
  assert.equal(findBreakouts({ league: L, players, teams, myTeamId: "me", pos: "WR" }).targets.length, 0);
});

test("tiers: rising starters (≥ 7 exp pts or ≥ 50% snaps) come before deep stashes", () => {
  const rise = rb("rise", [0.3, 0.35, 0.45], [5, 7, 9], [4, 5, 6], { team: "BUF" }); // exp last 2 = 8 → rising
  const stash = rb("stash", [0.1, 0.25, 0.4], [1, 2, 6], [0, 1, 2], { team: "DAL" }); // 4.0 exp, 40% → stash
  const ps = [rise, stash];
  const players = new Map(ps.map((p) => [p.id, p]));
  const L = league([team("me", []), team("o", [])], undefined, { numTeams: 12 });
  const teams = analyzeTeams(L, players, { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 });
  const r = findBreakouts({ league: L, players, teams, myTeamId: "me" });
  assert.deepEqual(r.targets.map((t) => [t.player.id, t.tier]), [["rise", "rising"], ["stash", "stash"]]);
});

test("a starter who left early (< 15% after ≥ 50%) is tagged, counts 0.5, and still ranks ahead", () => {
  const starter = rb("st", [0.8, 0.82, 0.05], [14, 14, 1], [14, 14, 1], { name: "Big Starter" });
  const back = rb("bk", [0.2, 0.18, 0.7], [3, 3, 12], [2, 2, 8], { name: "Backup" });
  const s = situationOf(back, [starter, back], null, roleMetrics(back, HALF_PPR));
  assert.equal(s.depthLabel, "RB2"); // starter keeps his usual 81% role for ordering
  assert.ok(s.tags.includes("left early / injury?"));
  assert.ok(!s.tags.some((t) => t.includes("slipping")));
  assert.equal(s.bonus, 0.5);
  assert.match(thesisOf(back, roleMetrics(back, HALF_PPR), s, { value: 1 }), /Big Starter \(5% snaps last week: left early \/ injury\?\)/);
});

test("snaps overrule a depth chart that lists a clear part-timer ahead", () => {
  const te = (id: string, snaps: number[]) => ({ ...rb(id, snaps, [4, 4, 6], [4, 4, 5]), pos: "TE" as const, name: id });
  const t1 = te("T1", [0.6, 0.3, 0.3]);
  const t2 = te("T2", [0.3, 0.3, 0.2]);
  const t3 = te("T3", [0.2, 0.2, 0.15]);
  // Fix 2026-10-28: snaps overrule the chart only when he out-snaps the player ahead in 2 of his last 3 games.
  const me = te("ME", [0.2, 0.7, 0.71]);
  const depth = { byPlayer: new Map(), byTeamPos: new Map([["KC|TE", ["T1", "T2", "T3", "ME"]]]) };
  const m = roleMetrics(me, HALF_PPR);
  const s = situationOf(me, [t1, t2, t3, me], depth, m);
  assert.equal(s.depthLabel, "TE1");
  assert.equal(s.chartSays, "TE4");
  assert.equal(s.ahead.length, 0);
  assert.match(thesisOf(me, m, s, { value: 1 }), /^TE1 by snaps \(depth chart says TE4\)/);
  // a chart that agrees with snaps is kept
  const s2 = situationOf(t2, [t1, t2, t3, me], { byPlayer: new Map(), byTeamPos: new Map([["KC|TE", ["T1", "T2"]]]) }, roleMetrics(t2, HALF_PPR));
  assert.equal(s2.depthLabel, "TE2");
  assert.equal(s2.chartSays, undefined);
});

test("one fill-in game never overrules the depth chart (fix 2026-10-28): the chart order stands", () => {
  const te = (id: string, snaps: number[]) => ({ ...rb(id, snaps, [4, 4, 6], [4, 4, 5]), pos: "TE" as const, name: id });
  const t1 = te("T1", [0.6, 0.55, 0.3]);
  const me = te("ME", [0.2, 0.26, 0.71]);
  const s = situationOf(me, [t1, me], { byPlayer: new Map(), byTeamPos: new Map([["KC|TE", ["T1", "ME"]]]) }, roleMetrics(me, HALF_PPR));
  assert.equal(s.depthLabel, "TE2");
  assert.equal(s.chartSays, undefined);
  // The starter ahead was out (no snaps) or left early in the games he out-snapped him: those games do not count.
  const out = te("T1b", [0.6, 0.6]);
  const me2 = te("ME2", [0.2, 0.8, 0.8]);
  const s2 = situationOf(me2, [out, me2], { byPlayer: new Map(), byTeamPos: new Map([["KC|TE", ["T1b", "ME2"]]]) }, roleMetrics(me2, HALF_PPR));
  assert.equal(s2.depthLabel, "TE2");
});

test("how-it's-scored items: one rule each, cheap rule follows the price source", () => {
  assert.deepEqual(detailProblems(howItems(120, 20, null, true)), []);
  assert.ok(howItems(120, 20, null, false).some((d) => d.label === "Cheap" && /Our value/.test(d.value)));
  assert.ok(howItems(120, 20, null, true).some((d) => d.label === "Depth chart" && /Unavailable/.test(d.value)));
});

test("Targets tags use the app-wide labels: luck buy-low / sell-high, market gap, rising usage", () => {
  const starters = [vp("s1", "QB", 20, 20), vp("s2", "RB", 15, 20), vp("s3", "RB", 14, 20), vp("s4", "WR", 15, 20), vp("s5", "WR", 14, 20), vp("s6", "TE", 10, 10), vp("s7", "WR", 13, 15)];
  const back = rb("back", [0.2, 0.35, 0.55], [5, 8, 13], [3, 5, 7], { name: "Rising Back", label: "buy-low", luck: 2.4, riser: true, edge: 9, marketRank: 80 });
  const flat = rb("flat", [0.5, 0.5, 0.5], [8, 8, 8], [8, 8, 8], { name: "Flat Guy", team: "BUF", label: "sell-high", luck: -2.6, edge: 9, marketRank: 90, marketEstimated: true });
  const ps = [...starters, back, flat];
  const players = new Map(ps.map((p) => [p.id, p]));
  const L = league([team("me", starters), team("o", [back])], undefined, { numTeams: 12 });
  const teams = analyzeTeams(L, players, { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 });
  const r = findBreakouts({ league: L, players, teams, myTeamId: "me" });
  const tags = (id: string) => r.targets.find((t) => t.player.id === id)!.tags;
  assert.ok(tags("back").includes("buy-low") && tags("back").includes("market undervalues") && tags("back").includes("opportunity rising"), tags("back").join());
  assert.ok(!tags("back").includes("usage > output"), "the old season-gap tag is gone");
  assert.ok(tags("flat").includes("sell-high"));
  assert.ok(!tags("flat").includes("market undervalues"), "an estimated market value has no real edge");
});

test("fix 2026-10-28: a one-game jump and a borrowed role are watch (stash tier), with the role facts in the details", () => {
  // Spike: quiet backup, one big game.
  const spike = rb("spike", [0.3, 0.3, 0.3, 0.6], [2, 2, 2, 12], [2, 2, 2, 10], { team: "BUF" });
  // Borrowed: the lead back (12+ touches) missed weeks 3–4 while the backup's touches and points jumped.
  const touch = (t: number[], team: string) => t.map((c, i) => wk(i + 1, c * 0.8, c * 0.8, { targets: 0, carries: c, airYards: 0 })).map((w) => ({ ...w, team }));
  const lead = vp("lead", "RB", 14, 30, { team: "DAL", name: "Lead RB", weeks: touch([15, 16], "DAL"), snapShare: { 1: 0.7, 2: 0.7 }, games: 2 });
  const borrowed = vp("borrowed", "RB", 6, 3, { team: "DAL", weeks: touch([4, 4, 14, 15], "DAL"), snapShare: { 1: 0.3, 2: 0.3, 3: 0.7, 4: 0.72 }, games: 4 });
  const steady = rb("steady", [0.5, 0.52, 0.55, 0.6], [5, 6.5, 8, 9], [5, 6, 7, 8], { team: "NYJ" });
  const ps = [spike, lead, borrowed, steady];
  const players = new Map(ps.map((p) => [p.id, p]));
  const L = league([team("me", []), team("o", [lead])], undefined, { numTeams: 12 });
  const teams = analyzeTeams(L, players, { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 });
  const r = findBreakouts({ league: L, players, teams, myTeamId: "me" });
  const by = (id: string) => r.targets.find((t) => t.player.id === id)!;
  assert.equal(by("spike").role.spike, true);
  assert.equal(by("spike").tier, "stash", "one big game is not a rising starter");
  assert.ok(by("spike").tags.includes("one-game jump"));
  assert.ok(by("spike").details.some((d) => d.label === "Not a starter yet" && /One-game jump/.test(d.value)));
  assert.deepEqual(by("borrowed").role.vacated, { weeks: [3, 4], by: ["Lead RB"], back: true });
  assert.equal(by("borrowed").tier, "stash");
  assert.ok(by("borrowed").details.some((d) => d.label === "Borrowed role" && /wk 3, 4 while Lead RB was out/.test(d.value)));
  // A gradual climb over 3 games is a sustained rise, not a spike.
  assert.equal(by("steady").role.spike, false);
  assert.equal(by("steady").role.sustained, true);
  assert.equal(by("steady").tier, "rising");
  for (const t of r.targets) assert.deepEqual(detailProblems(t.details), [], t.player.id);
});

test("fix round 1: a borrowed role whose teammate has no return week is his role: no 'borrowed role' tag or watch", () => {
  const touch = (t: number[], team: string) => t.map((c, i) => wk(i + 1, c * 0.8, c * 0.8, { targets: 0, carries: c, airYards: 0 })).map((w) => ({ ...w, team }));
  const unknownReturn = { week: null, confidence: "unknown" as const, reasons: [], absent: true, practiceUp: false };
  const lead = vp("lead", "RB", 14, 30, { team: "DAL", name: "Lead RB", weeks: touch([15, 16], "DAL"), snapShare: { 1: 0.7, 2: 0.7 }, games: 2, ret: unknownReturn });
  const heir = vp("heir", "RB", 6, 3, { team: "DAL", weeks: touch([4, 4, 14, 15], "DAL"), snapShare: { 1: 0.3, 2: 0.3, 3: 0.7, 4: 0.72 }, games: 4 });
  const players = new Map([lead, heir].map((p) => [p.id, p]));
  const L = league([team("me", []), team("o", [lead])], undefined, { numTeams: 12 });
  const r = findBreakouts({ league: L, players, teams: analyzeTeams(L, players, { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 }), myTeamId: "me" });
  const t = r.targets.find((x) => x.player.id === "heir")!;
  assert.equal(t.role.vacated?.back, false);
  assert.ok(!t.tags.includes("borrowed role"), t.tags.join(", "));
  assert.ok(t.details.some((d) => d.label === "Borrowed role" && /the role is his/.test(d.value)));
});
