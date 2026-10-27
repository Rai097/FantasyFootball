// One playoff engine (fix 2026-10-27, docs/DESIGN.md "Fix: one playoff engine + small-sample prior"): the roster
// score's playoffs part and team strength's lineup are the same lineups, and a trade card shows one number for the
// playoff lineup (plus the team-strength total, labelled as such). Real demo league (demo/42, cached public data, floors
// attached: the v3.1 floor factor used to shrink only the roster score's weekly lineups).
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { evaluateTradeV3, teamV3 } from "./tradesV3.js";
import { analyzeLeague, analyzeTeams } from "./analysis.js";
import { attachFloor, floorFactor, overlapFactor } from "./signals.js";
import { teamStrength } from "./teamStrength.js";
import { activeRoster, rosterParts } from "./rosterScore.js";
import { rosterExcess } from "./tradeKit.js";
import type { League } from "./types.js";
import type { TradeContext } from "./tradeKit.js";

const num = (s: string) => Number(s.replace("−", "-").match(/^[+-]?\d+(\.\d+)?/)![0]);

describe("one playoff engine on demo/42", { timeout: 300_000 }, () => {
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

  test("rosterParts' playoffs part = teamStrength's lineup on the same active roster (every team)", () => {
    const S = lg.settings;
    let floored = 0;
    for (const t of lg.teams) {
      const me = teamV3(ctx, t.id);
      floored += me.roster.filter((p) => Math.abs(floorFactor(p) - 1) > 0.01).length;
      const po = rosterParts(S, activeRoster(me.roster, me.irIds), ctx.replacement).parts.playoffs;
      const ts = teamStrength(S, me.roster, me.irIds);
      if (!ts.weeks.length) continue;
      // ts.lineup is rounded to 0.1: 0.05 is the exact bound (+ float epsilon).
      assert.ok(Math.abs(po - ts.lineup) <= 0.05 + 1e-9, `${t.name}: roster score playoffs ${po.toFixed(2)} vs team strength lineup ${ts.lineup}`);
    }
    assert.ok(floored > 0, "fixture: some players carry a floor factor ≠ 1 (the old cause of the gap)");
  });

  test("a trade card shows one playoff-lineup number: summary, lineup label and bullet = the rosterParts / teamStrength delta", () => {
    const S = lg.settings;
    const me = teamV3(ctx, lg.teams[0].id);
    let checked = 0;
    for (const partner of lg.teams.slice(1)) {
      const them = teamV3(ctx, partner.id);
      const give = me.roster.filter((p) => p.pos !== "QB" && p.pos !== "K" && p.pos !== "DEF" && !me.irIds.has(p.id));
      const get = them.roster.filter((p) => p.pos !== "QB" && p.pos !== "K" && p.pos !== "DEF" && !them.irIds.has(p.id));
      for (const g of give.slice(0, 4)) {
        for (const x of get.slice(0, 4)) {
          // 1-for-1, no cuts, no overlap discount: the card's roster is exactly `after`.
          if (rosterExcess(S.slots, me.irIds, [g], [x], them.irIds) > 0) continue;
          const core = me.core.filter((p) => p !== g);
          if (overlapFactor(x, core, me.starterList.filter((p) => p !== g)).f !== 1) continue;
          const after = me.roster.filter((p) => p !== g).concat(x);
          const ts0 = teamStrength(S, me.roster, me.irIds);
          const ts1 = teamStrength(S, after, me.irIds);
          const rp0 = rosterParts(S, activeRoster(me.roster, me.irIds), ctx.replacement).parts.playoffs;
          const rp1 = rosterParts(S, activeRoster(after, me.irIds), ctx.replacement).parts.playoffs;
          if (Math.abs(rp1 - rp0) < 0.5) continue;
          const ev = evaluateTradeV3(ctx, me.team.id, them.team.id, [g.id], [x.id], "playoffs");
          const rows = ev.details ?? [];
          const lineupRow = rows.find((d) => d.label === "Playoff lineup");
          const strengthRow = rows.find((d) => d.label === "Playoff strength");
          assert.ok(lineupRow && strengthRow, `${ev.key}: both bullets`);
          assert.equal(rows.filter((d) => d.label === "Playoffs").length, 0, "no second playoff-lineup bullet");
          const shown = num(lineupRow!.value);
          assert.equal(shown, Math.round((rp1 - rp0) * 10) / 10, `${ev.key}: bullet = rosterParts delta`);
          assert.ok(Math.abs(shown - (ts1.lineup - ts0.lineup)) <= 0.11, `${ev.key}: bullet ${shown} vs team strength lineup Δ ${(ts1.lineup - ts0.lineup).toFixed(1)}`);
          assert.ok(Math.abs(num(strengthRow!.value) - (ts1.total - ts0.total)) <= 0.051, `${ev.key}: strength bullet = team strength total Δ`);
          assert.match(strengthRow!.value, /lineup \+ 0\.25 × bench cover/);
          const s = lineupRow!.value.split(" ")[0];
          assert.ok(ev.summary.includes(`playoff lineup ${s}/wk`), `${ev.key}: summary "${ev.summary}" leads with ${s}`);
          assert.ok(ev.lineupLabel!.includes(`playoffs ${s}/wk`), `${ev.key}: label "${ev.lineupLabel}"`);
          if (++checked >= 6) return;
        }
      }
    }
    assert.ok(checked >= 3, `fixture: ${checked} trades checked`);
  });
});
