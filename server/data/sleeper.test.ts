import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { cacheFileOf, fetchCachedMeta } from "./cache.js";
import { attachSleeperInjuries, parseSleeperPlayers, validateSleeperBody, SLEEPER_MIN_PLAYERS, SLEEPER_TTL_HOURS, type SleeperIndex } from "./sleeper.js";
import { seasonEndingWhy } from "../model/returns.js";
import { normName } from "./names.js";
import { sources } from "./sources.js";
import type { Player } from "../model/types.js";

const FIXTURE = fs.readFileSync(new URL("./fixtures/sleeper-sample.json", import.meta.url), "utf8");

test("Sleeper loader config: the documented endpoint, at most once a day", () => {
  assert.equal(sources.sleeperPlayers, "https://api.sleeper.app/v1/players/nfl");
  assert.equal(SLEEPER_TTL_HOURS, 24);
});

test("parse the fixture: injured fantasy-position players with status, body part, notes, roster status", () => {
  const { total, injured } = parseSleeperPlayers(FIXTURE);
  assert.equal(total, 10);
  // 10 players: 1 healthy WR and 1 injured linebacker are skipped.
  assert.equal(injured.length, 8);
  const acl = injured.find((e) => e.sleeperId === "9001")!;
  assert.deepEqual(acl.injury, { status: "IR", bodyPart: "Knee - ACL", notes: "Surgery", rosterStatus: "Inactive" });
  assert.equal(acl.team, "MIA");
  assert.equal(acl.pos, "RB");
  assert.equal(injured.find((e) => e.sleeperId === "9006")!.gsis, "00-0099999", "padded gsis id is trimmed");
  assert.equal(injured.find((e) => e.sleeperId === "9008")!.team, "FA", "no team → FA");
  // The rule on the fixture: ACL, Achilles, ACL + MCL are season-ending; Active PUP, PCL, hamstring, shoulder are not.
  const over = injured.filter((e) => seasonEndingWhy(e.injury)).map((e) => e.sleeperId);
  assert.deepEqual(over, ["9001", "9002", "9003"]);
  assert.throws(() => parseSleeperPlayers("[]"), /expected an object/);
  assert.throws(() => parseSleeperPlayers("{}"), /no players/);
});

test("validator rejects a broken or truncated body (never written over the good copy)", () => {
  assert.throws(() => validateSleeperBody("not json"));
  assert.throws(() => validateSleeperBody("[]"), /expected an object/);
  assert.throws(() => validateSleeperBody(FIXTURE), /only 10 players/);
  const big = Object.fromEntries(Array.from({ length: SLEEPER_MIN_PLAYERS }, (_, i) => [String(i), { player_id: String(i) }]));
  assert.doesNotThrow(() => validateSleeperBody(JSON.stringify(big)));
});

const pl = (id: string, name: string, pos: Player["pos"], team: string, ids: Player["ids"] = {}): Player => ({ id, name, pos, team, ids, snapShare: {}, weeks: [], prior: null });

function index(players: Player[]): SleeperIndex {
  const ix: SleeperIndex = { players: new Map(), bySleeper: new Map(), byYahoo: new Map(), byName: new Map() };
  for (const p of players) {
    ix.players.set(p.id, p);
    if (p.ids.sleeper) ix.bySleeper.set(p.ids.sleeper, p.id);
    if (p.ids.yahoo) ix.byYahoo.set(p.ids.yahoo, p.id);
    const k = `${normName(p.name)}|${p.pos}`;
    ix.byName.set(k, [...(ix.byName.get(k) ?? []), p.id]);
  }
  return ix;
}

test("match by Sleeper id, then GSIS id, then name + position + team (unique); others stay unknown", () => {
  const { injured } = parseSleeperPlayers(FIXTURE);
  const bySleeper = pl("p1", "Somebody Else", "RB", "MIA", { sleeper: "9001" });
  const byGsis = pl("00-0099999", "Another Name", "RB", "KC");
  const byName = pl("p3", "Sample Player5", "WR", "TB");
  const wrongTeam = pl("p4", "Sample Player7", "WR", "DAL");
  const twin1 = pl("p5", "Sample Player2", "WR", "NYG");
  const twin2 = pl("p6", "Sample Player2", "WR", "NYG");
  const healthy = pl("p7", "Sample Player9", "WR", "JAX");
  const ps = [bySleeper, byGsis, byName, wrongTeam, twin1, twin2, healthy];
  const matched = attachSleeperInjuries(injured, index(ps));
  assert.equal(matched, 3);
  assert.equal(bySleeper.sleeperInjury?.bodyPart, "Knee - ACL");
  assert.equal(byGsis.sleeperInjury?.bodyPart, "Hamstring");
  assert.deepEqual(byName.sleeperInjury, { status: "IR", bodyPart: "Knee - PCL", notes: "Sprain", rosterStatus: "Inactive" });
  assert.equal(wrongTeam.sleeperInjury, undefined, "same name on another team: no match");
  assert.equal(twin1.sleeperInjury, undefined, "ambiguous name: no match, never a guess");
  assert.equal(twin2.sleeperInjury, undefined);
  assert.equal(healthy.sleeperInjury, undefined, "healthy on Sleeper: no listing");
});

/** A local server answering every request with `body` (status 200 / 500). */
async function serve(status: number, body: string): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1/players/nfl-test-${process.pid}-${status}`, close: () => new Promise((r) => server.close(() => r())), hits: () => hits };
}

async function seedStale(url: string, body: string, ageH: number) {
  const file = cacheFileOf(url);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, body);
  const t = (Date.now() - ageH * 36e5) / 1000;
  await fsp.utimes(file, t, t);
  return file;
}

test("a failed refresh keeps the previous cache: a server error or an invalid body serves the old copy, untouched", async () => {
  const good = FIXTURE;
  // 1. Server error.
  const s500 = await serve(500, "oops");
  const f1 = await seedStale(s500.url, good, 30);
  try {
    const r = await fetchCachedMeta(s500.url, SLEEPER_TTL_HOURS);
    assert.equal(r.source, "stale");
    assert.equal(r.body, good);
    assert.ok(r.ageH > 29 && r.ageH < 31);
    assert.match(r.error ?? "", /500/);
    assert.equal(fs.readFileSync(f1, "utf8"), good);
  } finally {
    await s500.close();
    await fsp.rm(f1, { force: true });
  }
  // 2. A 200 with a broken body: the validator rejects it, the good copy is served and never overwritten.
  const sBad = await serve(200, "{}");
  const f2 = await seedStale(sBad.url, good, 30);
  try {
    const r = await fetchCachedMeta(sBad.url, SLEEPER_TTL_HOURS, { validate: validateSleeperBody });
    assert.equal(r.source, "stale");
    assert.equal(r.body, good);
    assert.equal(fs.readFileSync(f2, "utf8"), good, "file unchanged");
    assert.equal(sBad.hits(), 1);
    // No old copy: the error surfaces (the loader turns it into "unknown", never an empty listing).
    await fsp.rm(f2, { force: true });
    await assert.rejects(fetchCachedMeta(sBad.url, SLEEPER_TTL_HOURS, { validate: validateSleeperBody }), /expected an object|only 0 players/);
    assert.equal(fs.existsSync(f2), false, "a rejected body is never written");
  } finally {
    await sBad.close();
    await fsp.rm(f2, { force: true });
  }
  // 3. A fresh copy (< 24 h) is served without any request.
  const sOk = await serve(200, good);
  const f3 = await seedStale(sOk.url, good, 23);
  try {
    const r = await fetchCachedMeta(sOk.url, SLEEPER_TTL_HOURS);
    assert.equal(r.source, "cache");
    assert.equal(sOk.hits(), 0, "once a day: no request inside the TTL");
  } finally {
    await sOk.close();
    await fsp.rm(f3, { force: true });
  }
});
