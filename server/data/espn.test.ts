// ESPN injuries feed loader (DESIGN "Season-over injuries (2026-10-31)"): parse, validate, match, cache failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { cacheFileOf, fetchCachedMeta } from "./cache.js";
import { ESPN_MIN_ENTRIES, ESPN_MIN_TEAMS, ESPN_TIMEOUT_MS, ESPN_TTL_HOURS, attachEspnInjuries, parseEspnInjuries, validateEspnBody } from "./espn.js";
import type { SleeperIndex } from "./sleeper.js";
import { normName } from "./names.js";
import { sources } from "./sources.js";
import type { Player } from "../model/types.js";

/** One feed entry in ESPN's real shape (trimmed): athlete links carry the ESPN id. Names are invented. */
function entry(o: { espnId?: string; name: string; pos: string; team: string; status: string; returnDate?: string; type?: string; detail?: string; headshotOnly?: boolean }) {
  const athlete: Record<string, unknown> = {
    displayName: o.name,
    position: { abbreviation: o.pos },
    team: { abbreviation: o.team },
  };
  if (o.espnId && !o.headshotOnly) athlete.links = [{ rel: ["playercard"], href: `https://www.espn.com/nfl/player/_/id/${o.espnId}/x-y` }];
  if (o.espnId && o.headshotOnly) athlete.headshot = { href: `https://a.espncdn.com/i/headshots/nfl/players/full/${o.espnId}.png` };
  const details: Record<string, unknown> = {};
  if (o.returnDate) details.returnDate = o.returnDate;
  if (o.type) details.type = o.type;
  if (o.detail) details.detail = o.detail;
  return { id: "1", status: o.status, date: "2026-10-30T17:12Z", athlete, ...(Object.keys(details).length ? { details } : {}) };
}
const FEED = {
  timestamp: "2026-10-31T23:50:35Z",
  season: { year: 2026 },
  injuries: [
    {
      displayName: "Washington Commanders",
      injuries: [
        entry({ espnId: "9100001", name: "Wes Torn", pos: "WR", team: "WSH", status: "Injured Reserve", returnDate: "2027-02-15", type: "Knee", detail: "Surgery" }),
        entry({ espnId: "9100002", name: "Lou Guard", pos: "G", team: "WSH", status: "Out", returnDate: "2026-11-08" }),
        entry({ name: "Kip Kicker", pos: "PK", team: "WSH", status: "Questionable", returnDate: "2026-11-01" }),
      ],
    },
    {
      displayName: "Los Angeles Rams",
      injuries: [
        entry({ espnId: "9100003", name: "Ham String", pos: "WR", team: "LAR", status: "Injured Reserve", returnDate: "2026-11-25", type: "Hamstring", detail: "Surgery", headshotOnly: true }),
        entry({ espnId: "9100004", name: "Al Fine", pos: "RB", team: "LAR", status: "Active" }),
      ],
    },
  ],
};
const BODY = JSON.stringify(FEED);

test("ESPN loader config: the injuries feed, at most once a day, bounded fetch", () => {
  assert.equal(sources.espnInjuries, "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries");
  assert.equal(ESPN_TTL_HOURS, 24);
  assert.ok(ESPN_TIMEOUT_MS > 0 && ESPN_TIMEOUT_MS <= 120_000);
});

test("parse: fantasy positions only, team / position spellings normalised, ESPN id from links or headshot, return date kept", () => {
  const { total, entries } = parseEspnInjuries(BODY);
  assert.equal(total, 5);
  assert.deepEqual(entries.map((e) => e.name), ["Wes Torn", "Kip Kicker", "Ham String", "Al Fine"], "the guard is skipped");
  const torn = entries[0];
  assert.deepEqual(torn, { espnId: "9100001", name: "Wes Torn", team: "WAS", pos: "WR", injury: { status: "Injured Reserve", returnDate: "2027-02-15", type: "Knee", detail: "Surgery" } });
  assert.equal(entries[1].pos, "K", "PK → K");
  assert.equal(entries[1].espnId, undefined, "no link: no id, matched by name");
  assert.equal(entries[2].espnId, "9100003", "headshot URL fallback");
  assert.deepEqual(entries[3].injury, { status: "Active" }, "no details: no date (unknown, never invented)");
  assert.throws(() => parseEspnInjuries("[]"), /expected \{ injuries/);
  assert.throws(() => parseEspnInjuries('{"injuries":[]}'), /no injury entries/);
});

test("validator rejects a broken or truncated body (never written over the good copy)", () => {
  assert.throws(() => validateEspnBody("not json"));
  assert.throws(() => validateEspnBody("{}"), /expected \{ injuries/);
  assert.throws(() => validateEspnBody(BODY), /only 2 teams/);
  const big = { injuries: Array.from({ length: ESPN_MIN_TEAMS }, (_, t) => ({ injuries: Array.from({ length: Math.ceil(ESPN_MIN_ENTRIES / ESPN_MIN_TEAMS) }, () => entry({ name: `P${t}`, pos: "WR", team: "KC", status: "Active" })) })) };
  assert.doesNotThrow(() => validateEspnBody(JSON.stringify(big)));
  const thin = { injuries: Array.from({ length: ESPN_MIN_TEAMS }, () => ({ injuries: [] })) };
  assert.throws(() => validateEspnBody(JSON.stringify(thin)), /only 0 injury entries/);
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

test("match with the shared matcher: ESPN id first, then name + position + team when unique; others stay unknown", () => {
  const torn = pl("00-1", "Wesley Torn", "WR", "WAS", { espn: "9100001" }); // name differs: matched by id
  const kicker = pl("00-2", "Kip Kicker", "K", "WAS");
  const ham = pl("00-3", "Ham String", "WR", "LAR"); // no ESPN id on our side: name + team
  const fine = pl("00-4", "Al Fine", "RB", "NYJ"); // other team: no match
  const ix = index([torn, kicker, ham, fine]);
  const { entries } = parseEspnInjuries(BODY);
  assert.equal(attachEspnInjuries(entries, ix), 3);
  assert.equal(torn.espnInjury?.returnDate, "2027-02-15");
  assert.equal(kicker.espnInjury?.status, "Questionable");
  assert.equal(ham.espnInjury?.returnDate, "2026-11-25");
  assert.equal(fine.espnInjury, undefined, "team differs: unmatched, never a guess");
  // Twin names on one team: ambiguous → unmatched.
  const t1 = pl("00-5", "Ham String", "WR", "LAR");
  const ix2 = index([t1, pl("00-6", "Ham String", "WR", "LAR")]);
  assert.equal(attachEspnInjuries(entries.filter((e) => e.name === "Ham String").map((e) => ({ ...e, espnId: undefined })), ix2), 0);
  assert.equal(t1.espnInjury, undefined);
});

async function serve(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/apis/espn-test-${process.pid}-${Math.random().toString(36).slice(2)}/injuries`,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
    hits: () => hits,
  };
}

async function seedStale(url: string, body: string, ageH: number) {
  const file = cacheFileOf(url);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, body);
  const t = (Date.now() - ageH * 36e5) / 1000;
  await fsp.utimes(file, t, t);
  return file;
}

test("a failed refresh keeps the previous copy: a hung server times out, a broken body is rejected; a fresh copy needs no request", async () => {
  // 1. Hung server (never answers): the timeout aborts, the old copy is served untouched.
  const hung = await serve(() => undefined);
  const f1 = await seedStale(hung.url, BODY, 30);
  try {
    const t0 = Date.now();
    const r = await fetchCachedMeta(hung.url, ESPN_TTL_HOURS, { validate: validateEspnBody, timeoutMs: 300 });
    assert.equal(r.source, "stale");
    assert.equal(r.body, BODY);
    assert.ok(Date.now() - t0 < 5000, "bounded by the timeout");
    assert.match(r.error ?? "", /abort|timeout/i);
    assert.equal(fs.readFileSync(f1, "utf8"), BODY);
  } finally {
    await hung.close();
    await fsp.rm(f1, { force: true });
  }
  // 2. A 200 with a truncated feed: rejected by the validator, never written.
  const bad = await serve((_q, res) => (res.writeHead(200, { "content-type": "application/json" }), res.end('{"injuries":[]}')));
  const f2 = await seedStale(bad.url, BODY, 30);
  try {
    const r = await fetchCachedMeta(bad.url, ESPN_TTL_HOURS, { validate: validateEspnBody, timeoutMs: 5000 });
    assert.equal(r.source, "stale");
    assert.equal(fs.readFileSync(f2, "utf8"), BODY, "file unchanged");
    await fsp.rm(f2, { force: true });
    await assert.rejects(fetchCachedMeta(bad.url, ESPN_TTL_HOURS, { validate: validateEspnBody }), /only 0 teams/);
    assert.equal(fs.existsSync(f2), false, "a rejected body is never written");
  } finally {
    await bad.close();
    await fsp.rm(f2, { force: true });
  }
  // 3. Fresh copy (< 24 h): no request at all.
  const ok = await serve((_q, res) => (res.writeHead(200), res.end(BODY)));
  const f3 = await seedStale(ok.url, BODY, 23);
  try {
    assert.equal((await fetchCachedMeta(ok.url, ESPN_TTL_HOURS, { validate: validateEspnBody })).source, "cache");
    assert.equal(ok.hits(), 0, "once a day: no request inside the TTL");
  } finally {
    await ok.close();
    await fsp.rm(f3, { force: true });
  }
});
