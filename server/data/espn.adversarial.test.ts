// Adversarial tests for the ESPN injuries loader (DESIGN "Season-over injuries (2026-10-31)"): a body that trickles
// past the timeout, HTML / error pages, odd entries, and matcher collisions (suffixes, twins, team changes, repeats).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { cacheFileOf, fetchCachedMeta } from "./cache.js";
import { ESPN_MIN_ENTRIES, ESPN_MIN_TEAMS, ESPN_TTL_HOURS, attachEspnInjuries, parseEspnInjuries, validateEspnBody } from "./espn.js";
import type { SleeperIndex } from "./sleeper.js";
import { normName } from "./names.js";
import type { Player } from "../model/types.js";

function entry(o: { espnId?: string; name: string; pos: string; team: string; status: string; returnDate?: unknown }) {
  const athlete: Record<string, unknown> = { displayName: o.name, position: { abbreviation: o.pos }, team: { abbreviation: o.team } };
  if (o.espnId) athlete.links = [{ href: `https://www.espn.com/nfl/player/_/id/${o.espnId}/x` }];
  return { id: "645194", status: o.status, athlete, ...(o.returnDate !== undefined ? { details: { returnDate: o.returnDate } } : {}) };
}
/** A feed that passes the validator (≥ 20 teams, ≥ 100 entries) with `extra` entries on the first team. */
function feed(extra: unknown[]): string {
  const per = Math.ceil(ESPN_MIN_ENTRIES / ESPN_MIN_TEAMS);
  return JSON.stringify({
    injuries: Array.from({ length: ESPN_MIN_TEAMS }, (_, t) => ({
      injuries: [...(t === 0 ? extra : []), ...Array.from({ length: per }, (_, i) => entry({ name: `Filler ${t} ${i}`, pos: "WR", team: "KC", status: "Active" }))],
    })),
  });
}
const GOOD = feed([entry({ espnId: "1", name: "Wes Torn", pos: "WR", team: "WSH", status: "Injured Reserve", returnDate: "2027-02-15" })]);

async function serve(handler: http.RequestListener) {
  let hits = 0;
  const server = http.createServer((req, res) => (hits++, handler(req, res)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/espn-adv-${process.pid}-${Math.random().toString(36).slice(2)}/injuries`,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
    hits: () => hits,
  };
}
async function seed(url: string, body: string, ageH: number) {
  const file = cacheFileOf(url);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, body);
  const t = (Date.now() - ageH * 36e5) / 1000;
  await fsp.utimes(file, t, t);
  return file;
}

test("a body that trickles forever is cut by the timeout (headers arrived); the old copy is served untouched", async () => {
  const drip = await serve((_q, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"injuries":[');
    const t = setInterval(() => res.write(" "), 20);
    res.on("close", () => clearInterval(t));
  });
  const f = await seed(drip.url, GOOD, 30);
  try {
    const t0 = Date.now();
    const r = await fetchCachedMeta(drip.url, ESPN_TTL_HOURS, { validate: validateEspnBody, timeoutMs: 300 });
    assert.equal(r.source, "stale");
    assert.ok(Date.now() - t0 < 5000, `bounded: ${Date.now() - t0} ms`);
    assert.equal(fs.readFileSync(f, "utf8"), GOOD);
  } finally {
    await drip.close();
    await fsp.rm(f, { force: true });
  }
});

test("HTML error pages, 5xx, a 200 HTML page and an empty 200 never replace the good copy", async () => {
  const cases: http.RequestListener[] = [
    (_q, res) => (res.writeHead(503, { "content-type": "text/html" }), res.end("<html>down</html>")),
    (_q, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end("<!doctype html><html><body>Access denied</body></html>")),
    (_q, res) => (res.writeHead(200), res.end("")),
    (_q, res) => (res.writeHead(200), res.end("null")),
    (_q, res) => (res.writeHead(200), res.end('{"injuries":{"0":{}}}')),
    (_q, res) => (res.writeHead(302, { location: "/elsewhere" }), res.end()),
  ];
  for (const [i, h] of cases.entries()) {
    const s = await serve(h);
    const f = await seed(s.url, GOOD, 30);
    try {
      const r = await fetchCachedMeta(s.url, ESPN_TTL_HOURS, { validate: validateEspnBody, timeoutMs: 2000 });
      assert.equal(r.source, "stale", `case ${i}`);
      assert.equal(r.body, GOOD, `case ${i}`);
      assert.equal(fs.readFileSync(f, "utf8"), GOOD, `case ${i}: file untouched`);
    } finally {
      await s.close();
      await fsp.rm(f, { force: true });
    }
  }
});

test("odd entries are skipped or kept without a date, never invented: non-string dates, a datetime, missing athlete / status", () => {
  const body = feed([
    entry({ name: "Num Date", pos: "WR", team: "KC", status: "Injured Reserve", returnDate: 20270215 }),
    entry({ name: "Obj Date", pos: "WR", team: "KC", status: "Injured Reserve", returnDate: { d: "2027-02-15" } }),
    entry({ name: "Date Time", pos: "WR", team: "KC", status: "Injured Reserve", returnDate: "2027-02-15T08:00Z" }),
    entry({ name: "Bad Date", pos: "WR", team: "KC", status: "Injured Reserve", returnDate: "Feb 15" }),
    entry({ name: "No Status", pos: "WR", team: "KC", status: "" }),
    { status: "Out", athlete: null },
    { status: "Out" },
    "junk",
    null,
    entry({ name: "Off Line", pos: "OT", team: "KC", status: "Out", returnDate: "2027-02-15" }),
    entry({ name: "Def Team", pos: "DST", team: "KC", status: "Out", returnDate: "2027-02-15" }),
  ]);
  assert.doesNotThrow(() => validateEspnBody(body));
  const { entries } = parseEspnInjuries(body);
  const by = new Map(entries.map((e) => [e.name, e]));
  assert.equal(by.get("Num Date")?.injury.returnDate, undefined, "a number is not an ISO date");
  assert.equal(by.get("Obj Date")?.injury.returnDate, undefined);
  assert.equal(by.get("Date Time")?.injury.returnDate, "2027-02-15");
  assert.equal(by.get("Bad Date")?.injury.returnDate, undefined);
  assert.equal(by.has("No Status"), false);
  assert.equal(by.has("Off Line"), false, "linemen are not fantasy players");
  assert.equal(by.has("Def Team"), false, "no team-defense entries");
});

const pl = (id: string, name: string, pos: Player["pos"], team: string, ids: Player["ids"] = {}): Player => ({ id, name, pos, team, ids, snapShare: {}, weeks: [], prior: null });
function index(players: Player[]): SleeperIndex {
  const ix: SleeperIndex = { players: new Map(), bySleeper: new Map(), byYahoo: new Map(), byEspn: new Map(), byName: new Map() };
  for (const p of players) {
    ix.players.set(p.id, p);
    if (p.ids.espn) ix.byEspn!.set(p.ids.espn, p.id);
    const k = `${normName(p.name)}|${p.pos}`;
    ix.byName.set(k, [...(ix.byName.get(k) ?? []), p.id]);
  }
  return ix;
}

test("matcher collisions: suffixes match, same name on another position / team never does, the first listing of a player wins", () => {
  const all = pl("00-1", "Erick All", "TE", "CIN"); // ESPN "Erick All Jr."
  const tracy = pl("00-2", "Tyrone Tracy", "RB", "NYG"); // ESPN "Tyrone Tracy Jr."
  const twinWr = pl("00-3", "Josh Allen", "WR", "BUF"); // same name, other position than the ESPN QB
  const moved = pl("00-4", "Moved Guy", "WR", "NYJ"); // ESPN lists his new team, no ESPN id on our side
  const idWins = pl("00-5", "Different Name", "RB", "DAL", { espn: "777" });
  const ix = index([all, tracy, twinWr, moved, idWins]);
  const body = feed([
    entry({ name: "Erick All Jr.", pos: "TE", team: "CIN", status: "Injured Reserve", returnDate: "2027-02-15" }),
    entry({ name: "Tyrone Tracy Jr.", pos: "RB", team: "NYG", status: "Injured Reserve", returnDate: "2026-12-06" }),
    entry({ name: "Josh Allen", pos: "QB", team: "BUF", status: "Out", returnDate: "2027-02-15" }),
    entry({ name: "Moved Guy", pos: "WR", team: "MIA", status: "Injured Reserve", returnDate: "2027-02-15" }),
    entry({ espnId: "777", name: "Some Body", pos: "RB", team: "DAL", status: "Questionable", returnDate: "2026-11-08" }),
    entry({ espnId: "777", name: "Some Body", pos: "RB", team: "DAL", status: "Injured Reserve", returnDate: "2027-02-15" }),
  ]);
  attachEspnInjuries(parseEspnInjuries(body).entries, ix);
  assert.equal(all.espnInjury?.returnDate, "2027-02-15", "Jr. suffix stripped");
  assert.equal(tracy.espnInjury?.returnDate, "2026-12-06");
  assert.equal(twinWr.espnInjury, undefined, "the QB's listing never lands on the WR namesake");
  assert.equal(moved.espnInjury, undefined, "team differs, no id: unknown, never a guess");
  assert.equal(idWins.espnInjury?.status, "Questionable", "repeated listing: the first one is kept");
});
