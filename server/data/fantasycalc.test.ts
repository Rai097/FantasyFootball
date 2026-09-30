import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildMarketMap, fantasyCalcUrl, parseFantasyCalc, pprBucket } from "./fantasycalc.js";
import type { Player } from "../model/types.js";

const FIXTURE = fs.readFileSync(new URL("./fixtures/fantasycalc-sample.json", import.meta.url), "utf8");
const pl = (id: string, name: string, pos: Player["pos"], sleeper?: string): Player => ({ id, name, pos, team: "KC", ids: sleeper ? { sleeper } : {}, snapShare: {}, weeks: [], prior: null });

test("FantasyCalc URL is parameterised; ppr rounds to 0 / 0.5 / 1", () => {
  assert.equal(fantasyCalcUrl({ numQbs: 1, numTeams: 12, ppr: 0.5 }), "https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=1&numTeams=12&ppr=0.5");
  assert.equal(fantasyCalcUrl({ numQbs: 2, numTeams: 10, ppr: 1, dynasty: true }), "https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=10&ppr=1");
  assert.equal(pprBucket(0), 0);
  assert.equal(pprBucket(0.2), 0);
  assert.equal(pprBucket(0.5), 0.5);
  assert.equal(pprBucket(0.75), 1);
  assert.equal(pprBucket(1), 1);
});

test("parse the fixture: rows with player, value, ranks, trend", () => {
  const rows = parseFantasyCalc(FIXTURE);
  assert.ok(rows.length >= 60);
  assert.equal(rows[0].overallRank, 1);
  assert.equal(typeof rows[0].player.sleeperId, "string");
  assert.throws(() => parseFantasyCalc("{}"), /expected an array/);
  assert.throws(() => parseFantasyCalc("[]"), /no player values/);
});

test("match by Sleeper id first, then normalised name + position; #1 scales to 100", () => {
  const rows = parseFantasyCalc(FIXTURE);
  const [first, second, third] = rows;
  const players = [
    pl("p1", "Somebody Else", first.player.position as Player["pos"], String(first.player.sleeperId)), // id match wins over name
    pl("p2", `${second.player.name} Jr.`, second.player.position as Player["pos"]), // name match (suffix ignored)
    pl("p3", third.player.name, "K"), // wrong position: no match
  ];
  const m = buildMarketMap(rows, players);
  assert.equal(m.get("p1")?.value, 100);
  assert.equal(m.get("p1")?.overallRank, 1);
  assert.equal(m.get("p1")?.raw, first.value);
  const v2 = m.get("p2")!;
  assert.ok(Math.abs(v2.value - Math.round((second.value / first.value) * 1000) / 10) < 1e-9);
  assert.equal(v2.posRank, second.positionRank);
  assert.equal(v2.trend30, second.trend30Day);
  assert.equal(m.has("p3"), false);
});
