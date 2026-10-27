// ADVERSARIAL tests (tester, not developer) for the 2026-10-27 mode-aware listing (tradesV3.ts modeGain / listsInMode /
// modeBarText): every list in every mode holds that mode's bar and floor, ranking follows the mode gain, evaluate's
// "<Mode> bar" bullet agrees with the gate, the help text names the same numbers. Synthetic league (generic ids,
// injured-now players sold for one healthy player) plus the demo league (demo/42, cached public data).
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { V3, evaluateTradeV3, findTradesV3, listsInMode, modeBarText, modeGain } from "./tradesV3.js";
import type { TradeContext } from "./tradeKit.js";
import { analyzeLeague, analyzeTeams } from "./analysis.js";
import { attachFloor } from "./signals.js";
import { TRADE_MODES, type TradeMode } from "./rosterScore.js";
import { league, team, vp } from "./testkit.js";
import type { League, Trade, ValuedPlayer } from "./types.js";

const num = (s: string) => Number(s.replace("−", "-").match(/^[+-]?\d+(\.\d+)?/)![0]);
const bullet = (t: Trade, label: string) => t.details!.find((d) => d.label === label)?.value;
const strengthOf = (t: Trade) => num(bullet(t, "Playoff strength")!);
const LABEL: Record<TradeMode, string> = { now: "Win now bar", balanced: "Balanced bar", playoffs: "Playoffs bar" };

/**
 * The listing gate, re-derived from the card: the mode's gain and floor. Both card numbers are rounded to 0.1 (the
 * playoff strength before the gate too), so a marginal near miss needs a rounded gain ≥ 0 (> 0 when it is playoff
 * strength, which the gate itself sees rounded).
 */
function holdsGate(t: Trade, mode: TradeMode, marginal: boolean): string {
  const strength = strengthOf(t);
  const team = t.me.scoreDelta!;
  const g = mode === "playoffs" ? strength : team;
  if (marginal ? !(mode === "playoffs" ? g > 0 : g >= 0) : g < V3.minMyGain - 1e-9) return `gain ${g} in ${mode}${marginal ? " (marginal)" : ""}`;
  const floor = V3.playoffFloor[mode];
  if (floor !== undefined && strength < floor - 1e-9) return `playoff strength ${strength} below the ${mode} floor ${floor}`;
  return "";
}
const isMarginal = (t: Trade) => t.tags.includes("marginal");

// ---------------------------------------------------------------- synthetic: injured-now players sold for one healthy one

const G = { remainingGames: 10 };
const REPL = { QB: 15, RB: 8, WR: 8, TE: 6, K: 7, DEF: 6 };
/** Absent now (week 8 of a 17-week season), back ~`week`: 0 until then, `ppg` after (effPpg = availability-averaged). */
const injured = (id: string, ppg: number, value: number, week: number): ValuedPlayer =>
  vp(id, "WR", ppg, value, {
    effPpg: (ppg * (17 - week + 1)) / 10,
    weekly: Array.from({ length: 10 }, (_, i) => (i + 8 < week ? 0 : ppg)),
    weeklyFrom: 8,
    remainingGames: 17 - week + 1,
    injury: { status: "O", week: 7 },
    ret: { week, confidence: "medium", reasons: [], absent: true, practiceUp: false },
  });
function injuredCtx(retWeek: number, aPpg: number, bPpg: number): TradeContext {
  const mine = [
    vp("mQB", "QB", 22, 12, { ...G, posRank: 4 }), vp("mRB1", "RB", 18, 40, G), vp("mRB2", "RB", 14, 25, G), vp("mRB3", "RB", 11, 12, G),
    vp("mWR1", "WR", 10, 8, G), vp("mWR2", "WR", 9, 5, G), vp("mWR3", "WR", 8, 4, G), vp("mTE", "TE", 9, 6, G),
    injured("mInjA", aPpg, 30, retWeek), injured("mInjB", bPpg, 26, retWeek), vp("mK", "K", 8, 1, G), vp("mDEF", "DEF", 7, 1, G),
  ];
  const theirs = [
    vp("tQB", "QB", 16, 3, { ...G, posRank: 20 }), vp("tRB1", "RB", 9, 4, G), vp("tRB2", "RB", 8, 3, G), vp("tWR1", "WR", 19, 50, G),
    vp("tWR2", "WR", 13, 18, G), vp("tWR3", "WR", 12, 14, G), vp("tWR4", "WR", 11, 9, G), vp("tTE", "TE", 8, 5, G), vp("tBN", "TE", 4, 0.4, G),
    vp("tK", "K", 8, 1, G), vp("tDEF", "DEF", 7, 1, G),
  ];
  const NFL = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG", "PHI", "PIT"];
  [...mine, ...theirs].forEach((p, i) => (p.team = NFL[i % NFL.length]));
  const l = league([team("me", mine), team("them", theirs)], undefined, { currentWeek: 8 });
  const players = new Map([...mine, ...theirs].map((p) => [p.id, p]));
  return { league: l, players, teams: analyzeTeams(l, players, REPL), replacement: REPL };
}
const VARIANTS: [number, number, number][] = [[10, 15, 14], [12, 15, 14], [14, 15, 14], [12, 20, 18], [14, 20, 18], [10, 12, 11]];

describe("mode gate: injured-now sale (synthetic)", () => {
  test("evaluate: the '<Mode> bar' bullet and its tone agree with listsInMode on the card's own numbers, in every mode", () => {
    let fails = 0;
    let clears = 0;
    for (const [rw, a, b] of VARIANTS)
      for (const mode of TRADE_MODES) {
        const ev = evaluateTradeV3(injuredCtx(rw, a, b), "me", "them", ["mInjA", "mInjB"], ["tWR1"], mode);
        const bar = ev.details!.find((d) => d.label === LABEL[mode]);
        assert.ok(bar, `${rw}/${a}/${b} ${mode}: bar bullet present`);
        const lists = listsInMode({ myDelta: ev.me.scoreDelta!, strengthDelta: strengthOf(ev) }, mode);
        assert.ok(mode === "playoffs" || Math.abs(ev.me.scoreDelta! - V3.minMyGain) > 1e-9, "fixture avoids the rounded bar");
        assert.equal(bar.value.startsWith("clears"), lists, `${rw}/${a}/${b} ${mode}: ${bar.value}`);
        assert.equal(bar.tone, lists ? "pos" : "warn");
        assert.equal(ev.details!.filter((d) => / bar$/.test(d.label)).length, 1, "one bar bullet");
        if (lists) clears++;
        else fails++;
      }
    assert.ok(clears > 0 && fails > 0, `fixture covers both outcomes (${clears} clear, ${fails} fail)`);
  });

  test("owner rule: helps now but not in the playoffs (playoff strength −0.1) clears Win now / Balanced, never Playoffs", () => {
    const c = injuredCtx(12, 15, 14);
    const ev = (mode: TradeMode) => evaluateTradeV3(c, "me", "them", ["mInjA", "mInjB"], ["tWR1"], mode);
    assert.ok(strengthOf(ev("playoffs")) < V3.minMyGain);
    assert.match(bullet(ev("playoffs"), "Playoffs bar")!, /^fails: playoff strength/);
    assert.match(bullet(ev("now"), "Win now bar")!, /^clears: team score/);
    assert.match(bullet(ev("balanced"), "Balanced bar")!, /^clears: team score/);
    // Past the Win now floor (−9.1): fails every mode, however big the gain now.
    const wreck = injuredCtx(14, 20, 18);
    for (const mode of TRADE_MODES) assert.match(bullet(evaluateTradeV3(wreck, "me", "them", ["mInjA", "mInjB"], ["tWR1"], mode), LABEL[mode])!, /^fails/);
  });

  test("finder: every list (trades, smaller edges, near misses) in every mode holds that mode's gain bar and playoff floor", () => {
    let seen = 0;
    for (const [rw, a, b] of VARIANTS) {
      const c = injuredCtx(rw, a, b);
      for (const mode of TRADE_MODES) {
        const r = findTradesV3(c, "me", { mode, valueSource: "model", limit: 50 });
        for (const t of [...r.trades, ...r.smallerEdges]) {
          assert.equal(holdsGate(t, mode, false), "", `${t.key} (${mode}, main/edges)`);
          seen++;
        }
        for (const t of r.nearMisses) {
          assert.equal(holdsGate(t, mode, isMarginal(t)), "", `${t.key} (${mode}, near miss)`);
          seen++;
        }
        // The owner's case: a deal selling an injured-now player never lists in Playoffs mode under the playoff bar.
        if (mode === "playoffs")
          for (const t of [...r.trades, ...r.smallerEdges, ...r.nearMisses.filter((x) => !isMarginal(x))])
            if (t.me.gives.some((p) => p.id.startsWith("mInj"))) assert.ok(strengthOf(t) >= V3.minMyGain - 1e-9, `${t.key}: ${strengthOf(t)}`);
      }
    }
    assert.ok(seen > 0, "fixture: the finder lists something");
  });

  // DEFECT (low): "clears" is only the gain bar + floor; the finder also needs both sides' bars, acceptance etc. A deal
  // the partner refuses (verdict Decline: consolidation premium) shows a green "Win now bar: clears: team score +9.9".
  test.todo("DEFECT low: a Decline verdict (partner refuses) is not paired with a green 'Win now bar: clears' bullet", () => {
    const ev = evaluateTradeV3(injuredCtx(12, 15, 14), "me", "them", ["mInjA", "mInjB"], ["tWR1"], "now");
    assert.match(ev.verdict, /Decline|won't accept/);
    const bar = ev.details!.find((d) => d.label === "Win now bar")!;
    assert.ok(!(bar.value.startsWith("clears") && bar.tone === "pos"), `${ev.verdict} + ${bar.value} (${bar.tone})`);
  });
});

// ---------------------------------------------------------------- unit edges

describe("mode gate units (adversarial)", () => {
  test("NaN gains (lazy candidates) never list in any mode, marginal or not", () => {
    for (const mode of TRADE_MODES)
      for (const marginal of [false, true]) {
        assert.equal(listsInMode({ myDelta: 5, strengthDelta: NaN }, mode, marginal), false, `${mode} NaN strength`);
        assert.equal(listsInMode({ myDelta: NaN, strengthDelta: 5 }, mode, marginal), mode === "playoffs", `${mode} NaN team score`);
      }
  });

  test("bars and floors are inclusive, just below fails; modeBarText says the same as listsInMode", () => {
    const cases: [TradeMode, number, number][] = [];
    for (const mode of TRADE_MODES)
      for (const g of [V3.minMyGain - 0.01, V3.minMyGain, V3.minMyGain + 3])
        for (const s of [-1.01, -1.0, -0.51, -0.5, 0, 0.99, 1.0, 2]) cases.push([mode, g, s]);
    for (const [mode, g, s] of cases) {
      const j = mode === "playoffs" ? { myDelta: 0, strengthDelta: s } : { myDelta: g, strengthDelta: s };
      const lists = listsInMode(j, mode);
      assert.equal(modeBarText(j, mode).startsWith("clears"), lists, `${mode} ${JSON.stringify(j)}: ${modeBarText(j, mode)}`);
      assert.equal(modeGain(j, mode), mode === "playoffs" ? s : g);
    }
  });

  // DEFECT (low): the bar text rounds the gain to 0.1 but the gate compares the exact team score, so a team score of
  // +0.96 reads "fails: team score +1.0 (needs +1.0)" — a contradiction on the card (Win now / Balanced; playoff
  // strength is already rounded before the gate, so Playoffs cannot show it).
  test("DEFECT low (fixed): Win now team score +0.96 must not read 'fails: team score +1.0 (needs +1.0)'", () => {
    const txt = modeBarText({ myDelta: 0.96, strengthDelta: 0 }, "now");
    assert.ok(!/\+1\.0 \(needs \+1\.0\)/.test(txt), txt);
    // Gate and text use the same 0.1-rounded gain: +0.96 shows +1.0 and clears; +0.94 shows +0.9 and fails.
    assert.equal(txt, "clears: team score +1.0, playoff strength +0.0");
    assert.equal(listsInMode({ myDelta: 0.96, strengthDelta: 0 }, "now"), true);
    assert.equal(listsInMode({ myDelta: 0.94, strengthDelta: 0 }, "now"), false);
    assert.equal(modeBarText({ myDelta: 0.94, strengthDelta: 0 }, "now"), "fails: team score +0.9 (needs +1.0)");
  });
});

// ---------------------------------------------------------------- help text (web/src/tabs/TradesTab.tsx)

test("'How they're ranked' names each mode's bar and floor with V3's numbers, and the order matches the Rank score bullet", () => {
  const src = readFileSync(new URL("../../web/src/tabs/TradesTab.tsx", import.meta.url), "utf8");
  const block = (mode: string) => src.match(new RegExp(`\\n  ${mode}: \\[([\\s\\S]*?)\\],\\n`))![1];
  assert.match(block("playoffs"), new RegExp(`Your playoff strength.*\\+${V3.minMyGain.toFixed(1)} pts/week or more`));
  assert.match(block("balanced"), new RegExp(`Your team score.*\\+${V3.minMyGain.toFixed(1)} or more`));
  assert.match(block("balanced"), new RegExp(`Not down more than ${Math.abs(V3.playoffFloor.balanced!).toFixed(1)} pts/week`));
  assert.match(block("now"), new RegExp(`Your team score.*\\+${V3.minMyGain.toFixed(1)} or more`));
  assert.match(block("now"), new RegExp(`Not down more than ${Math.abs(V3.playoffFloor.now!).toFixed(1)} pts/week`));
  assert.match(src, /\(your \$\{mode === "playoffs" \? "playoff strength" : "team score"\} gain \+ perception-gap bonus\) × acceptance/);
});

// ---------------------------------------------------------------- demo league audit

describe("mode gate on demo/42 (adversarial)", { timeout: 600_000 }, () => {
  let ctx: TradeContext;
  let lg: League;
  before(async () => {
    const { getPlayerDb } = await import("../data/players.js");
    const { getNflState } = await import("../data/nfl.js");
    const { buildDemoLeague } = await import("../providers/demo.js");
    const { getProjectionTables } = await import("../data/signalTables.js");
    const { getPriorWeeks } = await import("../data/priorWeeks.js");
    const db = await getPlayerDb();
    const st = await getNflState();
    lg = buildDemoLeague({ season: db.season, currentWeek: st.currentWeek, players: db.players.values(), builtAt: db.builtAt }, 42);
    const tables = await getProjectionTables(db.season, lg.settings.scoring);
    const c = analyzeLeague(lg, db.players.values(), tables, "playoffs");
    attachFloor(c.players, await getPriorWeeks(db.season - 1), lg.settings.scoring);
    c.teams = analyzeTeams(lg, c.players, c.replacement);
    ctx = c;
  });

  test("all teams × modes: smaller edges and near misses hold the gate; each list is ordered by rank score; rank score = (mode gain + gap bonus) × acceptance", () => {
    const counts = { trades: 0, edges: 0, near: 0 };
    const nowOnly: string[] = [];
    let slowest = 0;
    for (const t of lg.teams)
      for (const mode of TRADE_MODES) {
        const t0 = performance.now();
        const r = findTradesV3(ctx, t.id, { mode });
        slowest = Math.max(slowest, performance.now() - t0);
        for (const [name, list] of [["trades", r.trades], ["edges", r.smallerEdges]] as const) {
          let prev = Infinity;
          for (const tr of list) {
            assert.equal(holdsGate(tr, mode, false), "", `${tr.key} (${mode}, ${name})`);
            const rank = num(bullet(tr, "Rank score")!);
            assert.ok(rank <= prev + 1e-9, `${name} (${mode}, team ${t.id}): ${rank} after ${prev}`);
            prev = rank;
            assert.match(bullet(tr, "Rank score")!, new RegExp(`= \\(${mode === "playoffs" ? "playoff strength" : "team score"} \\+ gap bonus\\) × acceptance$`));
            const acc = num(bullet(tr, "Acceptance")!) / 100;
            const g = mode === "playoffs" ? strengthOf(tr) : tr.me.scoreDelta!;
            const bonus = rank / acc - g;
            assert.ok(bonus >= -0.2 && bonus <= V3.gapBonus * V3.gapCap + 0.2, `${tr.key} (${mode}): rank ${rank}, acc ${acc}, gain ${g} → bonus ${bonus.toFixed(2)}`);
            if (mode !== "playoffs" && strengthOf(tr) < V3.minMyGain) nowOnly.push(`${mode} ${tr.key}`);
            counts[name]++;
          }
        }
        for (const tr of r.nearMisses) {
          assert.equal(holdsGate(tr, mode, isMarginal(tr)), "", `${tr.key} (${mode}, near miss)`);
          counts.near++;
        }
      }
    assert.ok(counts.trades + counts.edges >= 20, `fixture: ${JSON.stringify(counts)}`);
    // The route budget is 1 s per trades call (auth/v4-api timing test).
    assert.ok(slowest < 1000, `slowest findTradesV3 call ${slowest.toFixed(0)} ms`);
    console.log(`# demo/42 mode gate: ${JSON.stringify(counts)}, ${nowOnly.length} Win now / Balanced deals under the playoff bar, slowest ${slowest.toFixed(0)} ms`);
  });

  // DEFECT (low): the marginal near-miss gate is the exact team score > 0, so Win now / Balanced near misses list a
  // noise-level gain the card shows as "Your team score +0.0" (demo/42, balanced: 11:00-0040730>00-0038797).
  test("DEFECT low (fixed): no Win now / Balanced near miss shows a team score of +0.0 (marginal gate on the exact value > 0)", () => {
    const zero: string[] = [];
    for (const t of lg.teams)
      for (const mode of ["now", "balanced"] as const)
        for (const tr of findTradesV3(ctx, t.id, { mode }).nearMisses) if (tr.me.scoreDelta! <= 0) zero.push(`${mode} ${tr.key}`);
    assert.deepEqual(zero, []);
  });

  test("evaluate on demo/42: for every listed deal in every mode, the bar bullet clears; in the other modes it agrees with listsInMode", () => {
    let checked = 0;
    for (const t of lg.teams.slice(0, 6))
      for (const mode of TRADE_MODES)
        for (const tr of findTradesV3(ctx, t.id, { mode }).trades.slice(0, 2))
          for (const m of TRADE_MODES) {
            const ev = evaluateTradeV3(ctx, t.id, tr.them.teamId, tr.me.gives.map((p) => p.id), tr.them.gives.map((p) => p.id), m);
            const bar = bullet(ev, LABEL[m])!;
            const lists = listsInMode({ myDelta: ev.me.scoreDelta!, strengthDelta: strengthOf(ev) }, m);
            // The card's team score is rounded to 0.1: at exactly +1.0 the exact value may sit either side of the bar.
            if (m !== "playoffs" && Math.abs(ev.me.scoreDelta! - V3.minMyGain) < 1e-9) continue;
            assert.equal(bar.startsWith("clears"), lists, `${tr.key} listed in ${mode}, evaluated in ${m}: ${bar}`);
            if (m === mode) assert.ok(lists, `${tr.key} (${mode}): listed but ${bar}`);
            checked++;
          }
    assert.ok(checked > 0);
  });
});
