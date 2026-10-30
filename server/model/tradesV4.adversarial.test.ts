// Adversarial tests for Trades v4 (Model v4 release (d)) on the real demo league (demo/42, cached public data):
// invariants that must hold whatever the week's data.
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { V3, evaluateTradeV3, findTradesV3, teamV3 } from "./tradesV3.js";
import { findBenchUpgrades } from "./benchUpgrades.js";
import { attachPerception } from "./perception.js";
import { analyzeLeague, analyzeTeams } from "./analysis.js";
import { attachMarket, marketQuery } from "./market.js";
import { attachFloor } from "./signals.js";
import { teamStrength } from "./teamStrength.js";
import { effPpg } from "./lineup.js";
import type { League, Trade } from "./types.js";
import type { TradeContext } from "./tradeKit.js";

describe("Trades v4 on demo/42", { timeout: 600_000 }, () => {
  let ctx: TradeContext;
  let lg: League;
  const lists = new Map<string, { main: Trade[]; edges: Trade[]; near: Trade[]; bench: Trade[] }>();

  before(async () => {
    const { getPlayerDb } = await import("../data/players.js");
    const { getNflState } = await import("../data/nfl.js");
    const { buildDemoLeague } = await import("../providers/demo.js");
    const { getProjectionTables } = await import("../data/signalTables.js");
    const { getMarketData } = await import("../data/fantasycalc.js");
    const { getPriorWeeks } = await import("../data/priorWeeks.js");
    const db = await getPlayerDb();
    const st = await getNflState();
    lg = buildDemoLeague({ season: db.season, currentWeek: st.currentWeek, players: db.players.values(), builtAt: db.builtAt }, 42);
    const tables = await getProjectionTables(db.season, lg.settings.scoring);
    const c = analyzeLeague(lg, db.players.values(), tables, "balanced");
    const md = await getMarketData(marketQuery(lg.settings));
    attachMarket(c.players, md.source === "fantasycalc" && md.values.size ? md.values : null);
    attachFloor(c.players, await getPriorWeeks(db.season - 1), lg.settings.scoring);
    c.teams = analyzeTeams(lg, c.players, c.replacement);
    attachPerception(c.players.values(), lg.settings, tables.schedule);
    ctx = c;
    for (const t of lg.teams) {
      const r = findTradesV3(ctx, t.id, { valueSource: md.source === "fantasycalc" ? "fantasycalc" : "model" });
      lists.set(t.id, { main: r.trades, edges: r.smallerEdges, near: r.nearMisses, bench: findBenchUpgrades(ctx, t.id) });
    }
  });

  test("riser sold only for a clear gain (fix 2026-10-30): finder lists need mode gain ≥ 2 × minMyGain; bench upgrades never", () => {
    for (const [team, l] of lists) {
      for (const t of [...l.main, ...l.edges, ...l.near])
        if (t.me.gives.some((p) => ctx.players.get(p.id)?.riser)) assert.ok((t.me.scoreDelta ?? 0) >= V3.riserSellMult * V3.minMyGain - 1e-9, `team ${team}: ${t.key} sells a riser for ${t.me.scoreDelta}`);
      for (const t of l.bench) for (const p of t.me.gives) assert.ok(!ctx.players.get(p.id)?.riser, `team ${team}: ${t.key} sells riser ${p.name}`);
    }
  });

  test("no market-value claim in any pitch or row summary, on every list", () => {
    for (const [team, l] of lists)
      for (const t of [...l.main, ...l.edges, ...l.near, ...l.bench]) {
        assert.doesNotMatch(t.pitch ?? "", /market|on value|fair by/i, `team ${team}: ${t.key} pitch "${t.pitch}"`);
        assert.doesNotMatch(t.summary ?? "", /market|fairness/i, `team ${team}: ${t.key} summary "${t.summary}"`);
      }
  });

  test("a perceived loss for them never reaches the main list or smaller edges", () => {
    for (const [team, l] of lists)
      for (const t of [...l.main, ...l.edges]) assert.ok((t.yahooView?.them ?? 0) >= 0, `team ${team}: ${t.key} them ${t.yahooView?.them}`);
  });

  test("bench upgrades never suggest a swap the partner's Yahoo view shows as a loss (capped at 25% acceptance)", () => {
    // findBenchUpgrades gates the partner on market fairness only (BENCH.minFairness) and sorts by my delta, so a swap
    // Yahoo shows them as −x pts (acceptance capped at 0.25) is still suggested as an upgrade.
    const bad: string[] = [];
    for (const [team, l] of lists) for (const t of l.bench) if ((t.yahooView?.them ?? 0) < 0) bad.push(`team ${team}: ${t.summary}`);
    assert.deepEqual(bad, []);
  });

  test("marginal near misses come back (my side fails its bar) and each still has a real gain in the mode (> 0)", () => {
    // Fix round 1: strengthDelta was forced to 0 when my side failed, so no "marginal" near miss could pass the gate.
    let marginal = 0;
    for (const [team, l] of lists)
      for (const t of l.near)
        if (t.tags.includes("marginal")) {
          marginal++;
          // Balanced mode (mode-aware listing, fix 2026-10-27): the gain is the mode's team score (> 0 for a marginal
          // near miss; ≥ +0.0 once rounded) and the playoff strength (its own bullet) may fall at most V3.playoffFloor.balanced.
          const val = (label: string) => Number(t.details?.find((d) => d.label === label)?.value.match(/^([+−]\d+\.\d)/)?.[1].replace("−", "-"));
          assert.ok(val("Your team score") >= 0, `team ${team}: ${t.key} marginal with team score ${val("Your team score")}`);
          assert.ok(val("Playoff strength") >= V3.playoffFloor.balanced!, `team ${team}: ${t.key} marginal with playoff strength ${val("Playoff strength")}`);
        }
    assert.ok(marginal > 0, "some marginal near misses on demo/42");
  });

  test("evaluate: a trade that fails my side still reports my real playoff-lineup change, never a fabricated +0.0", () => {
    // judge3 skips team strength when my side fails (strengthDelta = 0). The evaluate card then says "playoff lineup
    // +0.0/wk" for a lopsided loss — and the finder's near-miss class "marginal" (my side fails) can never pass the
    // strengthDelta ≥ 1.0 gate (demo/42 week 8: 37 marginal near misses before release (d), 0 after).
    const S = lg.settings;
    const me = teamV3(ctx, lg.teams[0].id);
    const them = teamV3(ctx, lg.teams[1].id);
    const myBest = [...me.starterList].filter((p) => p.pos !== "K" && p.pos !== "DEF" && p.pos !== "QB").sort((a, b) => effPpg(b) - effPpg(a))[0];
    const theirWorst = them.roster.filter((p) => !them.starters.has(p.id) && p.pos !== "K" && p.pos !== "DEF" && p.pos !== "QB").sort((a, b) => effPpg(a) - effPpg(b))[0];
    const after = me.roster.filter((p) => p.id !== myBest.id).concat(theirWorst);
    const real = teamStrength(S, after, me.irIds).total - teamStrength(S, me.roster, me.irIds).total;
    assert.ok(real < -1, `fixture: giving ${myBest.name} for ${theirWorst.name} costs my playoff lineup (${real.toFixed(1)})`);
    const ev = evaluateTradeV3(ctx, me.team.id, them.team.id, [myBest.id], [theirWorst.id]);
    assert.match(ev.verdict, /decline/i);
    const row = ev.details?.find((d) => d.label === "Playoff lineup");
    assert.ok(row, "Playoff lineup bullet");
    const shown = Number(row!.value.replace("−", "-").match(/^[+-]?\d+(\.\d+)?/)?.[0]);
    assert.ok(shown < -0.5, `evaluate shows "${row!.value}" and summary "${ev.summary}" for a ${real.toFixed(1)} pts/wk loss`);
  });
});
