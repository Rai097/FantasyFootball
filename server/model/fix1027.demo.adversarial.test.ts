// Adversarial checks of the 2026-10-27 fix round on the demo league (demo/42, cached public data, floors attached):
// every listed trade's card tells one consistent story (playoff lineup, lineup label, playoff strength, signs, tones),
// no number is NaN, a riser is never given, and the finder stays inside its time budget.
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { V3, findTradesV3 } from "./tradesV3.js";
import { analyzeLeague, analyzeTeams } from "./analysis.js";
import { attachFloor } from "./signals.js";
import { TRADE_MODES } from "./rosterScore.js";
import type { League } from "./types.js";
import type { TradeContext } from "./tradeKit.js";

const num = (s: string) => Number(s.replace("−", "-").match(/^[+-]?\d+(\.\d+)?/)![0]);

describe("fix 2026-10-27 on demo/42: trade cards", { timeout: 600_000 }, () => {
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

  test("every listed trade (all teams, all modes): label verdict / tones follow the lineup sign, strength ≥ minMyGain, no NaN, no riser given", () => {
    let listed = 0;
    let depthOnly = 0;
    let slowest = 0;
    for (const t of lg.teams) {
      for (const mode of TRADE_MODES) {
        const t0 = performance.now();
        const r = findTradesV3(ctx, t.id, { mode });
        slowest = Math.max(slowest, performance.now() - t0);
        for (const tr of [...r.trades, ...r.smallerEdges]) {
          listed++;
          const d = tr.details ?? [];
          const lu = d.find((x) => x.label === "Playoff lineup");
          const st = d.find((x) => x.label === "Playoff strength");
          assert.ok(lu && st, `${tr.key}: both bullets`);
          assert.equal(d.filter((x) => x.label === "Playoffs").length, 0, `${tr.key}: no duplicate Playoffs bullet`);
          const lv = num(lu!.value);
          const sv = num(st!.value);
          assert.ok(sv >= V3.minMyGain - 1e-9, `${tr.key}: listed with playoff strength ${sv}`);
          // The label verdict and the bullet tone follow the lineup number's sign (a depth-only gain may list as neutral).
          const verdict = lv > 0.05 ? "good for you" : lv < -0.05 ? "bad for you" : "neutral for you";
          assert.ok((tr.lineupLabel ?? "").includes(verdict), `${tr.key}: lineup ${lv} vs "${tr.lineupLabel}"`);
          assert.equal(lu!.tone, lv > 0.05 ? "pos" : lv < -0.05 ? "neg" : undefined, `${tr.key}: lineup tone`);
          if (lv <= 0.05) depthOnly++;
          assert.equal(st!.tone, "pos", `${tr.key}: strength tone`);
          assert.ok(tr.summary.includes(`playoff lineup ${lu!.value.split(" ")[0]}/wk`), `${tr.key}: ${tr.summary}`);
          for (const x of d) assert.ok(!/NaN|Infinity|undefined/.test(x.value), `${tr.key} ${x.label}: ${x.value}`);
          for (const p of tr.me.gives) assert.ok(!p.riser, `${tr.key}: sells riser ${p.name}`);
        }
      }
    }
    assert.ok(listed >= 20, `fixture: ${listed} listed trades`);
    // Empirical on demo/42 (not a design invariant): no listed trade leans on bench cover alone.
    assert.equal(depthOnly, 0, `${depthOnly} listed trades with a playoff lineup ≤ +0.05/wk`);
    // The route budget is 1 s per trades2 call (auth/v4-api timing test); one finder call must stay well inside it.
    assert.ok(slowest < 1000, `slowest findTradesV3 call ${slowest.toFixed(0)} ms`);
  });
});
