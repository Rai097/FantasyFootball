// Integration test: boots the real server (child process, random port, Yahoo
// unconfigured) and exercises every endpoint of the HTTP contract on demo/42.
// The first run downloads the public data files into .cache/ (can take a while).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detailProblems, summaryProblems } from "./model/testkit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOOT_TIMEOUT_MS = 180_000;

let child: ChildProcess | undefined;
let workDir = "";
let base = "";
let log = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function req(method: string, url: string, body?: unknown): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(base + url, {
    method,
    redirect: "manual",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}
const get = (url: string) => req("GET", url);
const post = (url: string, body?: unknown) => req("POST", url, body);

/** Walk a JSON value and collect paths of non-finite numbers / NaN-strings. */
function badNumbers(v: unknown, p = "$", out: string[] = []): string[] {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) out.push(p);
  } else if (typeof v === "string") {
    if (/\bNaN\b|\bundefined\b|\bInfinity\b/.test(v)) out.push(`${p}="${v.slice(0, 80)}"`);
  } else if (Array.isArray(v)) v.forEach((x, i) => badNumbers(x, `${p}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) badNumbers(x, `${p}.${k}`, out);
  return out;
}
function assertClean(v: unknown, what: string) {
  const bad = badNumbers(v);
  assert.equal(bad.length, 0, `${what}: non-finite / NaN values at ${bad.slice(0, 5).join(", ")}`);
}

const NUMERIC_VP = ["ppg", "ppg26", "ppgExp26", "ppg25", "games", "vorp", "value", "posRank", "remainingGames", "trend"] as const;
function assertValuedPlayer(p: any, what: string) {
  assert.equal(typeof p.id, "string", `${what}: id`);
  assert.equal(typeof p.name, "string", `${what}: name`);
  assert.ok(["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.pos), `${what}: pos ${p.pos}`);
  for (const k of NUMERIC_VP) assert.ok(Number.isFinite(p[k]), `${what} (${p.name}): ${k}=${p[k]}`);
  assert.equal(typeof p.why, "string", `${what}: why`);
  assert.ok(p.why.length > 0, `${what}: empty why`);
}

before(
  async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    // Run from a scratch cwd so the test never reads the developer's .env or touches their
    // .data/ (Yahoo tokens, league caches); .cache/ is shared so data downloads once.
    fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-it-"));
    fs.symlinkSync(path.join(ROOT, ".cache"), path.join(workDir, ".cache"), "dir");
    child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(ROOT, "server/index.ts")], {
      cwd: workDir,
      // Empty Yahoo credentials: dotenv never overwrites variables that are already set.
      env: { ...process.env, PORT: String(port), NODE_ENV: "test", DISCORD_CLIENT_ID: "", YAHOO_CLIENT_ID: "", YAHOO_CLIENT_SECRET: "", YAHOO_REDIRECT_URI: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d) => (log += d));
    child.stderr!.on("data", (d) => (log += d));
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${log}`);
      try {
        const r = await get("/api/state");
        if (r.status === 200) break;
      } catch {
        /* not listening yet */
      }
      if (Date.now() > deadline) throw new Error(`server did not become ready:\n${log}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  },
  { timeout: BOOT_TIMEOUT_MS + 10_000 },
);

after(() => {
  child?.kill("SIGTERM");
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

const L = "/api/league/demo/42";

describe("server integration (demo/42)", { timeout: 300_000 }, () => {
  test("GET /api/state", async () => {
    const { status, json } = await get("/api/state");
    assert.equal(status, 200);
    for (const k of ["season", "currentWeek", "lastRegularWeek", "playerCount"]) assert.ok(Number.isFinite(json[k]), `state.${k}=${json[k]}`);
    assert.equal(typeof json.dbBuiltAt, "string");
    assert.ok(json.playerCount > 500, `playerCount ${json.playerCount}`);
    assert.equal(json.yahooConfigured, false);
    assert.equal(json.yahooConnected, false);
  });

  test("GET /api/players/search", async () => {
    const empty = await get("/api/players/search?q=");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, []);
    // Search for a name taken from the league itself so the test doesn't depend on a specific real player.
    const values = (await get(`${L}/values`)).json as any[];
    const top = values[0];
    const q = top.name.split(" ").slice(-1)[0];
    const { status, json } = await get(`/api/players/search?q=${encodeURIComponent(q)}`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(json) && json.length > 0, `no search hits for ${q}`);
    for (const p of json) {
      for (const k of ["id", "name", "pos", "team"]) assert.equal(typeof p[k], "string", `search.${k}`);
    }
    assert.ok(json.some((p: any) => p.id === top.id), `search "${q}" did not return ${top.name}`);
    assertClean(json, "search");
  });

  test("GET league", async () => {
    const { status, json } = await get(L);
    assert.equal(status, 200);
    assert.equal(json.provider, "demo");
    assert.equal(json.teams.length, 12);
    assert.equal(json.settings.numTeams, 12);
    assert.ok(json.myTeamId, "myTeamId");
    for (const t of json.teams) assert.ok(t.playerIds.length >= 15, `${t.name} roster ${t.playerIds.length}`);
    const all = json.teams.flatMap((t: any) => t.playerIds);
    assert.equal(new Set(all).size, all.length, "a player is on two rosters");
    assertClean(json, "league");
  });

  test("GET analysis: value bullets only for the request team's players, short and unchained", async () => {
    let size = 0;
    const teams = (await get(L)).json.teams.map((t: any) => t.id);
    for (const team of teams) {
      const text = await (await fetch(`${base}${L}/analysis?team=${team}`)).text();
      const json = JSON.parse(text);
      // My Team's bullets may only add a little to this big payload (the old one stripped every whyItems).
      size = Math.max(size, JSON.stringify(json).length - JSON.stringify(json, (k, v) => (k === "whyItems" ? undefined : v)).length);
      const me = json.teams.find((t: any) => t.team.id === team);
      const mine = new Set(me.team.playerIds);
      for (const p of [...me.lineup.map((l: any) => l.player).filter(Boolean), ...me.bench]) {
        assert.ok(Array.isArray(p.whyItems) && p.whyItems.length >= 3, `${team}: ${p.name} has value bullets`);
        assert.deepEqual(detailProblems(p.whyItems), [], `${team}: ${p.name}`);
      }
      for (const t of json.teams.filter((t: any) => t.team.id !== team))
        for (const p of t.bench) assert.equal(p.whyItems, undefined, `${p.name}: another team's bullets leaked into the payload`);
      for (const p of Object.values(json.players) as any[]) if (!mine.has(p.id)) assert.equal(p.whyItems, undefined, `${p.name}: not on the team`);
    }
    assert.ok(size > 0 && size < 40_000, `My Team bullets add ${size} bytes to /analysis`);
  });

  test("GET analysis: full lineups, sane numbers", async () => {
    const { status, json } = await get(`${L}/analysis`);
    assert.equal(status, 200);
    for (const k of ["league", "players", "teams", "replacement", "myTeamId"]) assert.ok(k in json, `analysis.${k}`);
    assertClean(json, "analysis");
    assert.deepEqual(json.notes, ["ECR ranks are PPR; points use league scoring."]);
    assert.ok(Object.values(json.players).every((p: any) => !/ECR ranks are PPR/.test(p.why)), "PPR note only in analysis.notes");
    const starting = json.league.settings.slots.filter((s: string) => s !== "BN" && s !== "IR");
    assert.equal(json.teams.length, 12);
    const ranks = new Set<number>();
    for (const t of json.teams) {
      assert.equal(t.lineup.length, starting.length, `${t.team.name} lineup length`);
      for (const l of t.lineup) {
        assert.ok(l.player, `${t.team.name}: empty ${l.slot} slot`);
        assert.ok(l.player.ppg > 0, `${t.team.name}: ${l.slot} ${l.player.name} has ppg ${l.player.ppg}`);
      }
      assert.ok(t.starterPpg > 50, `${t.team.name} starterPpg ${t.starterPpg}`);
      for (const g of ["QB", "RB", "WR", "TE", "FLEX", "K", "DEF"]) assert.ok(t.groups[g], `${t.team.name} group ${g}`);
      ranks.add(t.powerRank);
    }
    assert.equal(ranks.size, 12, "power ranks must be 1..12 unique");
    for (const [id, p] of Object.entries<any>(json.players)) {
      assert.equal(p.id, id);
      assertValuedPlayer(p, `players[${id}]`);
    }
    for (const pos of ["QB", "RB", "WR", "TE", "K", "DEF"]) assert.ok(Number.isFinite(json.replacement[pos]), `replacement.${pos}`);
  });

  test("GET analysis: projection v4 shape (weekly points, season / playoff totals, luck, value mode, playoff strength)", async () => {
    const { json } = await get(`${L}/analysis`);
    const S = json.league.settings;
    assert.ok(["playoffs", "balanced"].includes(json.valueMode), `valueMode ${json.valueMode}`);
    const nW = S.finalWeek - S.currentWeek + 1;
    let labelled = 0;
    let outChecked = 0;
    for (const p of Object.values<any>(json.players)) {
      assert.equal(p.weeklyFrom, S.currentWeek, `${p.name}: weeklyFrom`);
      assert.ok(Array.isArray(p.weekly) && p.weekly.length === nW && p.weekly.every((x: number) => Number.isFinite(x) && x >= 0), `${p.name}: weekly`);
      if (p.bye >= S.currentWeek && p.bye <= S.finalWeek) assert.equal(p.weekly[p.bye - S.currentWeek], 0, `${p.name}: bye week ${p.bye} must be 0`);
      for (const k of ["seasonPts", "playoffPts"]) assert.ok(Number.isFinite(p[k]) && p[k] >= 0, `${p.name}: ${k}=${p[k]}`);
      assert.equal(p.valueMode, json.valueMode);
      if (p.luck !== undefined) assert.ok(Number.isFinite(p.luck), `${p.name}: luck`);
      if (p.label !== undefined) {
        labelled++;
        assert.ok(p.label === "buy-low" ? p.luck >= 2 : p.label === "sell-high" && p.luck <= -2, `${p.name}: ${p.label} at luck ${p.luck}`);
      }
      if (/^(IR|PUP|NA)$/i.test(p.injury?.status ?? "")) assert.ok(p.weekly.every((x: number) => x === 0), `${p.name} (${p.injury.status}) projects 0`);
      if (/^(O|Out)$/i.test(p.injury?.status ?? "") && !/IR|ACL|Achilles|season|NA|return/i.test(p.injury?.detail ?? "")) {
        outChecked++;
        // Out = 0 for his next game: his first remaining week can never be positive (unit tests pin the exact week).
        assert.equal(p.weekly[0], 0, `${p.name} (Out): weekly ${p.weekly.slice(0, 3).join(",")}`);
      }
    }
    assert.ok(outChecked > 0, "the demo pool has Out players to check");
    assert.ok(labelled > 0, "some buy-low / sell-high labels on the demo league");
    for (const t of json.teams) {
      const ps = t.playoffStrength;
      assert.ok(ps && Number.isFinite(ps.total) && Number.isFinite(ps.lineup) && Number.isFinite(ps.depth), `${t.team.name}: playoffStrength`);
      assert.ok(ps.lineup > 50 && ps.total >= ps.lineup, `${t.team.name}: playoff lineup ${ps.lineup}, total ${ps.total}`);
      assert.deepEqual(ps.weeks, [15, 16, 17].filter((w) => w >= S.currentWeek && w <= S.finalWeek));
    }
  });

  test("GET values: sorted, top ≈ 100, slim rows (< 250 KB), Edge only when the market lists him, bullets on ?id=", async () => {
    const { status, json } = await get(`${L}/values`);
    assert.equal(status, 200);
    assert.ok(json.length > 200);
    const bytes = JSON.stringify(json).length;
    assert.ok(bytes < 250_000, `values payload ${bytes} bytes (rows carry only what the tab renders)`);
    assertClean(json, "values");
    assert.ok(json[0].value >= 99 && json[0].value <= 100.05, `top value ${json[0].value}`);
    for (let i = 1; i < json.length; i++) assert.ok(json[i - 1].value >= json[i].value, "values not sorted");
    // Market columns (FantasyCalc; absent when the market is unavailable).
    const withMarket = json.filter((p: any) => typeof p.market === "number");
    if (withMarket.length) {
      assert.ok(withMarket.some((p: any) => p.marketRank === 1 && p.market === 100), "market #1 = 100");
      for (const p of withMarket) assert.ok(p.market >= 0 && p.market <= 100, `${p.name} market ${p.market}`);
      for (const p of withMarket) {
        if (p.marketEstimated || p.marketRank === undefined) assert.equal(p.edge, undefined, `${p.name}: no edge without a real market value`);
        // Return unconfirmed (value 0, every week 0): his trade value is a placeholder, so no edge ("—").
        else if (p.edge === undefined) assert.equal(p.value, 0, `${p.name}: edge missing on a player with value ${p.value}`);
        else assert.ok(Number.isFinite(p.edge), `${p.name}: edge`);
      }
      assert.ok(withMarket.some((p: any) => Number.isFinite(p.edge)), "listed players carry an edge");
    }
    for (const p of json.slice(0, 300)) {
      for (const k of ["value", "ppg", "ppg26", "ppgExp26", "games", "posRank"]) assert.ok(Number.isFinite(p[k]), `${p.name}: ${k}=${p[k]}`);
      assert.equal(typeof p.rostered, "boolean");
      for (const k of ["weeks", "why", "whyItems", "prior", "snapShare", "ids"]) assert.equal(p[k], undefined, `${p.name}: ${k} must not be in the list`);
      assert.ok(p.value >= 0 && p.value <= 100.05, `${p.name} value ${p.value}`);
      assert.ok(p.ppg >= 0 && p.ppg < 40, `${p.name} ppg ${p.ppg}`);
      if (p.pos === "K" || p.pos === "DEF") assert.ok(p.value <= 15, `${p.pos} ${p.name} value ${p.value}`);
    }
    const rostered = json.filter((p: any) => p.rostered);
    assert.ok(rostered.length >= 12 * 15);
    // Luck column: + = due for more by his usage; unknown (no games) is absent, never 0-filled.
    assert.ok(json.some((p: any) => Number.isFinite(p.luck)), "luck on some rows");
    for (const p of json) {
      assert.equal(p.weekly, undefined, `${p.name}: weekly points stay out of the slim rows`);
      if (p.games === 0) assert.equal(p.luck, undefined, `${p.name}: no games with usage → no luck number`);
    }
    assert.ok(rostered.every((p: any) => typeof p.ownerTeamId === "string"));
    // The "?" bullets: one row with whyItems per tap; every item short and chain-free (all players of the demo league).
    const rows = await Promise.all(json.map((p: any) => get(`${L}/values?id=${encodeURIComponent(p.id)}`)));
    for (const [i, r] of rows.entries()) {
      assert.equal(r.status, 200);
      const one = r.json[0];
      assert.equal(one.id, json[i].id);
      assert.ok(Array.isArray(one.whyItems) && one.whyItems.length >= 3, `${one.name}: whyItems`);
      assert.deepEqual(detailProblems(one.whyItems), [], one.name);
      assert.ok(one.whyItems.some((d: any) => d.label === "Value"), `${one.name}: value line`);
    }
    assert.equal((await get(`${L}/values?id=nope`)).status, 404);
  });

  test("GET trades (v1) is gone: one valuation, one Trade Finder (trades2)", async () => {
    const r = await get(`${L}/trades`);
    assert.equal(r.status, 404);
  });

  test("GET trades2 with partner / wantPos / maxGive filters", async () => {
    const all = (await get(`${L}/trades2`)).json;
    const first = [...all.trades, ...all.smallerEdges][0];
    assert.ok(first, "the finder returns at least one trade");
    const partner = first.them.teamId;
    const byPartner = await get(`${L}/trades2?partner=${partner}`);
    assert.equal(byPartner.status, 200);
    for (const t of [...byPartner.json.trades, ...byPartner.json.smallerEdges, ...byPartner.json.nearMisses]) assert.equal(t.them.teamId, partner);
    for (const pos of ["RB", "WR"]) {
      const r = await get(`${L}/trades2?wantPos=${pos}`);
      assert.equal(r.status, 200);
      for (const t of [...r.json.trades, ...r.json.smallerEdges]) assert.ok(t.them.gives.some((p: any) => p.pos === pos), `${t.key}: no ${pos} received`);
    }
    const lower = await get(`${L}/trades2?wantPos=te&maxGive=1&maxGet=1`);
    assert.equal(lower.status, 200);
    for (const t of [...lower.json.trades, ...lower.json.smallerEdges]) {
      assert.ok(t.them.gives.some((p: any) => p.pos === "TE"));
      assert.equal(t.me.gives.length, 1);
      assert.equal(t.them.gives.length, 1);
    }
    const self = await get(`${L}/trades2?partner=${first.me.teamId}`);
    assert.equal(self.status, 400, "partner == team must be rejected");
    assert.equal(typeof self.json.error, "string");
  });

  test("QB rule holds in every v3 list (trades, smaller edges, near misses, bench upgrades) for 3 teams", async () => {
    const analysis = (await get(`${L}/analysis`)).json;
    const P = analysis.players;
    const rank = (p: any) => (typeof p.market === "number" ? (p.marketPosRank ?? 99) : p.posRank);
    const qbsOf = (teamId: string) =>
      analysis.teams
        .find((t: any) => t.team.id === teamId)
        .team.playerIds.map((id: string) => P[id])
        .filter((p: any) => p && p.pos === "QB" && p.remainingGames > 0 && p.ppg > 0);
    const bestRank = (teamId: string) => Math.min(99, ...qbsOf(teamId).map(rank));
    const ruleOk = (qb: any, from: string, to: string) => {
      const qbs = qbsOf(from).sort((a: any, b: any) => (b.effPpg ?? b.ppg) - (a.effPpg ?? a.ppg) || rank(a) - rank(b));
      return qbs.length >= 2 && rank(qbs[0]) <= 14 && rank(qbs[1]) <= 14 && qbs[1].id === qb.id && bestRank(to) > 18;
    };
    let checked = 0;
    for (const team of analysis.teams.slice(0, 3).map((t: any) => t.team.id)) {
      const r = (await get(`${L}/trades2?team=${team}`)).json;
      const bench = (await get(`${L}/bench-upgrades?team=${team}`)).json;
      for (const t of [...r.trades, ...r.smallerEdges, ...r.nearMisses, ...bench]) {
        checked++;
        const sides: [any[], string, string][] = [
          [t.me.gives, t.me.teamId, t.them.teamId],
          [t.them.gives, t.them.teamId, t.me.teamId],
        ];
        for (const [ps, from, to] of sides) {
          for (const p of ps) {
            assert.ok(p.pos !== "K" && p.pos !== "DEF", `${t.key}: ${p.pos}`);
            if (p.pos !== "QB") continue;
            assert.ok(ruleOk(p, from, to), `${t.key}: QB ${p.name} moves ${from}→${to} without the QB rule`);
            assert.ok((t.details ?? []).some((d: any) => d.label === "QB rule" && d.value.startsWith(`${p.name} allowed`)), `${t.key}: QB rule not logged`);
          }
        }
      }
      for (const t of bench) {
        for (const p of [...t.me.gives, ...t.them.gives]) assert.ok((p.market ?? p.value) >= 3 && p.value >= 3, `${t.key}: bench piece ${p.name} market ${p.market} value ${p.value}`);
        const g = t.them.gives[0];
        assert.ok((g.market ?? g.value) >= 8 || g.value >= 5, `${t.key}: received ${g.name} is not a real asset`);
        assert.ok(t.me.seasonDelta >= 0.75, `${t.key}: season ${t.me.seasonDelta}`);
      }
    }
    assert.ok(checked > 0);
  });

  test("POST trade/evaluate", async () => {
    const analysis = (await get(`${L}/analysis`)).json;
    const me = analysis.teams.find((t: any) => t.team.id === analysis.myTeamId);
    const partner = analysis.teams.find((t: any) => t.team.id !== analysis.myTeamId);
    const val = (id: string) => analysis.players[id]?.value ?? 0;
    const skill = (ids: string[]) => ids.filter((id) => !["K", "DEF"].includes(analysis.players[id]?.pos));
    // Lopsided: my best player for their least valuable skill player.
    const myBest = skill(me.team.playerIds).sort((a, b) => val(b) - val(a))[0];
    const theirWorst = skill(partner.team.playerIds).sort((a, b) => val(a) - val(b))[0];
    const lop = await post(`${L}/trade/evaluate`, { team: me.team.id, partner: partner.team.id, give: [myBest], get: [theirWorst] });
    assert.equal(lop.status, 200, JSON.stringify(lop.json));
    assertClean(lop.json, "evaluate");
    assert.ok(String(lop.json.verdict).startsWith("Decline"), lop.json.verdict);
    assert.equal(lop.json.details[0].label, "Verdict");
    assert.deepEqual(detailProblems(lop.json.details), []);
    assert.deepEqual(summaryProblems(lop.json.summary), [], lop.json.summary);

    // A v3 finder trade should evaluate to an accept verdict with its band and acceptance.
    const t = (await get(`${L}/trades2`)).json.trades[0];
    const ok = await post(`${L}/trade/evaluate`, {
      team: t.me.teamId,
      partner: t.them.teamId,
      give: t.me.gives.map((p: any) => p.id),
      get: t.them.gives.map((p: any) => p.id),
    });
    assert.equal(ok.status, 200);
    assert.match(ok.json.verdict, /^Accept/);
    assert.equal(ok.json.me.lineupDelta, t.me.lineupDelta);
    assert.equal(ok.json.band, t.band);
    assert.equal(ok.json.acceptance, t.acceptance);

    // Duplicate ids are counted once.
    const dup = await post(`${L}/trade/evaluate`, { team: me.team.id, partner: partner.team.id, give: [myBest, myBest], get: [theirWorst] });
    assert.equal(dup.status, 200);
    assert.equal(dup.json.me.gives.length, 1);
    assert.equal(dup.json.me.valueGiven, lop.json.me.valueGiven);

    // Errors.
    const notMine = await post(`${L}/trade/evaluate`, { team: me.team.id, partner: partner.team.id, give: [partner.team.playerIds[0]], get: [] });
    assert.equal(notMine.status, 400);
    assert.equal(typeof notMine.json.error, "string");
    const unknownGive = await post(`${L}/trade/evaluate`, { team: me.team.id, partner: partner.team.id, give: ["no-such-player"], get: [theirWorst] });
    assert.equal(unknownGive.status, 400);
    assert.equal(typeof unknownGive.json.error, "string");
    const unknownGet = await post(`${L}/trade/evaluate`, { team: me.team.id, partner: partner.team.id, give: [myBest], get: ["no-such-player"] });
    assert.equal(unknownGet.status, 400);
    const self = await post(`${L}/trade/evaluate`, { team: me.team.id, partner: me.team.id, give: [myBest], get: [] });
    assert.equal(self.status, 400);
    assert.equal(typeof self.json.error, "string");
    const noPartner = await post(`${L}/trade/evaluate`, { team: me.team.id, give: [myBest], get: [] });
    assert.equal(noPartner.status, 400);
    const empty = await post(`${L}/trade/evaluate`, { team: me.team.id, partner: partner.team.id, give: [], get: [] });
    assert.equal(empty.status, 400);
  });

  test("GET trades2 (v3: market packages) and bench-upgrades", async () => {
    const t0 = Date.now();
    const { status, json } = await get(`${L}/trades2`);
    const ms = Date.now() - t0;
    assert.equal(status, 200);
    assertClean(json, "trades2");
    assert.ok(Array.isArray(json.trades) && json.trades.length > 0 && json.trades.length <= 10, "trades: 1..10");
    assert.ok(Array.isArray(json.smallerEdges));
    assert.ok(Array.isArray(json.nearMisses) && json.nearMisses.length <= 10);
    assert.equal(json.mode, "balanced");
    assert.ok(["fantasycalc", "model"].includes(json.valueSource), `valueSource ${json.valueSource}`);
    assert.ok(Array.isArray(json.partners) && json.partners.length === 11);
    for (const p of json.partners) {
      assert.ok(typeof p.teamId === "string" && Number.isFinite(p.complementarity), p.teamId);
      assert.deepEqual(summaryProblems(p.summary), [], p.summary);
      assert.ok(Array.isArray(p.details) && p.details.length > 0, `${p.teamId}: partner details`);
      assert.deepEqual(detailProblems(p.details), [], p.teamId);
      assert.equal(p.pitch, undefined, "partner prose pitch replaced by summary + details");
    }
    assert.deepEqual(summaryProblems(json.summary), [], json.summary);
    assert.ok(json.summary.length > 20);
    assert.ok(Array.isArray(json.summaryDetails) && json.summaryDetails.length > 0);
    assert.deepEqual(detailProblems(json.summaryDetails), []);
    for (const t of [...json.trades, ...json.smallerEdges, ...json.nearMisses]) {
      assert.deepEqual(summaryProblems(t.summary), [], `${t.key}: ${t.summary}`);
      assert.ok(Array.isArray(t.details) && t.details.length >= 8, `${t.key}: details`);
      assert.deepEqual(detailProblems(t.details), [], t.key);
      assert.equal(t.why, undefined, `${t.key}: no prose why`);
      assert.equal(t.notes, undefined, `${t.key}: notes moved into details`);
      if (t.reason !== undefined) assert.deepEqual(summaryProblems(t.reason), [], t.reason);
      for (const p of [...t.me.gives, ...t.them.gives]) {
        assert.ok(Array.isArray(p.whyItems) && p.whyItems.length >= 3, `${t.key}: ${p.name} value bullets`);
        assert.deepEqual(detailProblems(p.whyItems), [], `${t.key}: ${p.name}`);
      }
    }
    assert.ok(ms < 15_000, `trades2 took ${ms}ms`);
    const perPartner = new Map<string, number>();
    for (const t of json.trades) {
      for (const k of ["scoreDelta", "nowDelta", "seasonDelta", "playoffDelta", "depthDelta"]) {
        assert.equal(typeof t.me[k], "number", `${t.key}: me.${k}`);
        assert.equal(typeof t.them[k], "number", `${t.key}: them.${k}`);
      }
      assert.ok(t.acceptance >= 0.4 && t.acceptance <= 0.95, `${t.key}: acceptance ${t.acceptance}`);
      assert.ok(t.me.scoreDelta >= 0.95, `${t.key}: me.scoreDelta ${t.me.scoreDelta}`);
      assert.ok(t.me.gives.length <= 3 && t.them.gives.length <= 2);
      for (const p of [...t.me.gives, ...t.them.gives]) {
        assert.ok(!["QB", "K", "DEF"].includes(p.pos), `${t.key}: ${p.pos} ${p.name}`);
        assert.ok((p.market ?? p.value) >= 3 || p.value >= 3, `${t.key}: waiver-level ${p.name}`);
      }
      assert.equal(typeof t.pitch, "string");
      assert.ok(t.pitch.length > 20, t.key);
      assert.doesNotMatch(t.pitch, /market/i, `${t.key}: pitch never argues market value`);
      assert.match(t.lineupLabel, /^Lineup impact: /, t.key);
      assert.match(t.marketLabel, /^Market value: they get /, t.key);
      assert.ok(t.yahooView && t.yahooView.them >= 0 && /^What Yahoo (likely )?shows them: /.test(t.yahooView.label), `${t.key}: yahooView`);
      assert.equal(t.band, undefined, `${t.key}: the market fairness band is replaced by the two labels`);
      perPartner.set(t.them.teamId, (perPartner.get(t.them.teamId) ?? 0) + 1);
    }
    for (const [id, n] of perPartner) assert.ok(n <= 2, `partner ${id}: ${n} trades`);
    for (const t of json.nearMisses) assert.equal(typeof t.reason, "string");
    for (const mode of ["now", "playoffs"]) {
      const r = await get(`${L}/trades2?mode=${mode}&maxGive=1&maxGet=1`);
      assert.equal(r.status, 200);
      assert.equal(r.json.mode, mode);
      for (const t of r.json.trades) assert.ok(t.me.gives.length === 1 && t.them.gives.length === 1);
    }
    const bad = await get(`${L}/trades2?partner=nope`);
    assert.equal(bad.status, 400);

    const b = await get(`${L}/bench-upgrades`);
    assert.equal(b.status, 200);
    assertClean(b.json, "bench-upgrades");
    assert.ok(Array.isArray(b.json) && b.json.length <= 15);
    for (const t of b.json) {
      assert.equal(t.me.gives.length, 1);
      assert.equal(t.them.gives.length, 1);
      assert.ok(t.fairness >= 0.9);
      assert.equal(t.why, undefined, `${t.key}: bench upgrades carry details, not prose`);
      assert.deepEqual(summaryProblems(t.summary), [], t.summary);
      assert.deepEqual(detailProblems(t.details), [], t.key);
      assert.ok((t.me.seasonDelta ?? 0) >= 0.75, `${t.key}: bench upgrade season ${t.me.seasonDelta}`);
      for (const p of [...t.me.gives, ...t.them.gives]) assert.ok((p.market ?? p.value) >= 3 && p.value >= 3, `${t.key}: worthless ${p.name}`);
    }
  });

  test("GET waivers", async () => {
    const { status, json } = await get(`${L}/waivers`);
    assert.equal(status, 200);
    const bytes = JSON.stringify(json).length;
    assert.ok(bytes < 150_000, `waivers payload ${bytes} bytes (keep it small: rows carry only what the tab renders)`);
    assertClean(json, "waivers");
    assert.equal(json.numTeams, 12);
    assert.deepEqual(summaryProblems(json.advice), [], json.advice);
    assert.ok(Array.isArray(json.rules) && json.rules.length > 0);
    assert.equal(json.faStatusKnown, true);
    assert.ok(json.freeAgents.length >= 10);
    assert.ok(json.freeAgents.some((w: any) => !w.onWaivers) && json.freeAgents.some((w: any) => w.onWaivers), "demo shows free agents and waiver players");
    const league = (await get(L)).json;
    const rostered = new Set(league.teams.flatMap((t: any) => t.playerIds));
    for (const w of json.freeAgents) {
      for (const k of ["ppg", "value", "gain", "benchGain", "rankScore"]) assert.ok(Number.isFinite(w[k]), `${w.name}: ${k}=${w[k]}`);
      assert.ok(["QB", "RB", "WR", "TE", "K", "DEF"].includes(w.pos) && typeof w.name === "string" && typeof w.team === "string");
      assert.equal(w.weeks, undefined, `${w.name}: weekly stat lines must not be in the waivers payload`);
      assert.ok(["claim", "optional", "stash", "wait", "pass"].includes(w.recommendation), `${w.name}: ${w.recommendation}`);
      if (w.recommendation === "stash" && !w.injury) assert.ok(w.breakout && w.breakout.score >= 50, `${w.name}: stash without a breakout signal`);
      assert.deepEqual(summaryProblems(w.summary), [], `${w.name}: ${w.summary}`);
      assert.ok(Array.isArray(w.details) && w.details.length > 0, `${w.name}: details`);
      assert.deepEqual(detailProblems(w.details), [], w.name);
      assert.equal(w.why, undefined, `${w.name}: the value "why" must not leak into a waiver row`);
      assert.equal(typeof w.onWaivers, "boolean");
      assert.ok(["fa", "waivers"].includes(w.availability), `${w.name}: ${w.availability}`);
      assert.ok(Number.isFinite(w.gain) && Number.isFinite(w.benchGain));
      assert.ok(!rostered.has(w.id), `${w.name} is rostered`);
    }
    // Stash watch (release (c)): ≤ 10 unrostered returners, finite numbers, short rows and bullets.
    assert.ok(Array.isArray(json.stash) && json.stash.length > 0 && json.stash.length <= 10, `stash rows ${json.stash?.length}`);
    for (const s of json.stash) {
      assert.ok(!rostered.has(s.id), `${s.name} is rostered`);
      for (const k of ["playoffPts", "healthyRate", "stashScore"]) assert.ok(Number.isFinite(s[k]), `${s.name}: ${k}=${s[k]}`);
      assert.ok(s.backWeek === null || Number.isInteger(s.backWeek));
      assert.ok(["add", "claim-cheap", "check"].includes(s.call), s.call);
      assert.ok(s.summary.length <= 255 && s.summary.startsWith(`${s.name} · ${s.pos} · ${s.team} · `), s.summary);
      assert.deepEqual(detailProblems(s.details), [], s.name);
      assert.equal(s.weekly, undefined);
    }
    for (let i = 1; i < json.stash.length; i++) assert.ok(json.stash[i - 1].stashScore >= json.stash[i].stashScore, "ranked by stash score");
  });

  test("GET league (League tab): standings, power parts, who is above me", async () => {
    const { status, json } = await get(`${L}/league?team=1`);
    assert.equal(status, 200);
    const bytes = JSON.stringify(json).length;
    assert.ok(bytes < 60_000, `league payload ${bytes} bytes`);
    assertClean(json, "league");
    assert.equal(json.myTeamId, "1");
    assert.equal(json.teams.length, 12);
    assert.deepEqual(json.weights, { projected: 0.7, results: 0.3 });
    assert.deepEqual(summaryProblems(json.summary), [], json.summary);
    const me = json.teams.find((t: any) => t.mine);
    assert.equal(me.id, "1");
    assert.equal(json.above.length, me.powerRank - 1);
    assert.equal(json.above.length + json.below.length, 11);
    for (const t of json.teams) {
      assert.ok(Math.abs(t.projectedPart + t.resultsPart - t.powerScore) <= 0.02, `${t.id}: power parts`);
      assert.ok(t.resultsPpg === null || typeof t.resultsPpg === "number", "actual ppg or null (unknown), never 0 for unknown");
      assert.ok(Number.isInteger(t.standingsRank), "demo has records");
      assert.equal(t.pointsAgainst, null, "demo has no PA: unknown, not 0");
    }
    for (const c of [...json.above, ...json.below]) {
      assert.notEqual(c.teamId, "1");
      assert.deepEqual(summaryProblems(c.summary), [], c.summary);
      assert.ok(c.groups.length >= 5);
      for (const k of c.keyPlayers) for (const p of k.players) assert.deepEqual(Object.keys(p).sort(), ["id", "name", "pos", "ppg"]);
    }
    const t7 = (await get(`${L}/league?team=7`)).json;
    assert.equal(t7.myTeamId, "7");
    assert.equal((await get(`${L}/league?team=99`)).status, 400);
  });

  test("GET breakouts", async () => {
    const { status, json } = await get(`${L}/breakouts?limit=30`);
    assert.equal(status, 200);
    assertClean(json, "breakouts");
    assert.ok(Array.isArray(json.how) && json.how.length > 0);
    assert.deepEqual(detailProblems(json.how), []);
    const bytes = JSON.stringify(json).length;
    assert.ok(bytes < 250_000, `breakouts payload ${bytes} bytes`);
    assert.ok(json.targets.length >= 10, `only ${json.targets.length} breakout targets`);
    const league = (await get(L)).json;
    const mine = new Set(league.teams.find((t: any) => t.id === league.myTeamId).playerIds);
    let prev = Infinity;
    let tier: string | undefined;
    for (const t of json.targets) {
      // Sorted by score within each tier (rising starters first, then stashes).
      if (t.tier !== tier) (tier = t.tier), (prev = Infinity);
      assert.ok(typeof t.player.name === "string" && Number.isFinite(t.player.value) && Number.isFinite(t.player.ppg), "breakouts: slim player");
      assert.equal(t.player.weeks, undefined, `${t.player.name}: weekly lines must not be in the breakouts payload`);
      assert.deepEqual(summaryProblems(t.summary), [], `${t.player.name}: ${t.summary}`);
      assert.ok(Array.isArray(t.details) && t.details.length >= 8, `${t.player.name}: details`);
      assert.deepEqual(detailProblems(t.details), [], t.player.name);
      assert.ok(["RB", "WR", "TE"].includes(t.player.pos), `${t.player.name}: ${t.player.pos}`);
      assert.ok(!mine.has(t.player.id), `${t.player.name} is on my roster`);
      assert.equal(t.thesis, undefined, `${t.player.name}: prose thesis is server-only`);
      assert.ok(t.where.type === "fa" || (t.where.type === "roster" && typeof t.where.teamName === "string"));
      assert.ok(typeof t.ask === "string" && t.ask.length > 0);
      assert.equal(t.snaps.length, t.weeks.length);
      assert.ok(t.score <= prev, "sorted by score");
      prev = t.score;
    }
    const rb = await get(`${L}/breakouts?pos=RB&limit=5`);
    assert.ok(rb.json.targets.length > 0 && rb.json.targets.every((t: any) => t.player.pos === "RB"));
    assert.equal((await get(`${L}/breakouts?pos=QB`)).status, 400);
  });

  test("unknown team / provider / route → JSON errors", async () => {
    const team = await get(`${L}/analysis?team=zzz`);
    assert.equal(team.status, 400);
    assert.equal(typeof team.json.error, "string");
    const prov = await get("/api/league/espn/1");
    assert.equal(prov.status, 404);
    assert.equal(typeof prov.json.error, "string");
    const route = await get("/api/nope");
    assert.equal(route.status, 404);
    assert.equal(typeof route.json.error, "string");
  });

  test("yahoo provider without credentials → 4xx {error, hint}", async () => {
    for (const url of ["/api/league/yahoo/999.l.1", "/api/yahoo/leagues"]) {
      const r = await get(url);
      assert.ok(r.status >= 400 && r.status < 500, `${url} → ${r.status}`);
      assert.equal(typeof r.json.error, "string", url);
      assert.equal(typeof r.json.hint, "string", url);
    }
  });

  test("auth routes when Yahoo is unconfigured", async () => {
    const start = await get("/auth/yahoo/start");
    assert.ok(start.status >= 400 && start.status < 500, `start → ${start.status}`);
    assert.equal(typeof start.json.error, "string");
    assert.equal(typeof start.json.hint, "string");

    const noCode = await post("/auth/yahoo/code", {});
    assert.equal(noCode.status, 400);
    assert.equal(typeof noCode.json.error, "string");
    const code = await post("/auth/yahoo/code", { code: "abc" });
    assert.ok(code.status >= 400 && code.status < 500, `code → ${code.status}`);
    assert.equal(typeof code.json.error, "string");

    const cb = await get("/auth/yahoo/callback");
    assert.equal(cb.status, 400);
    const denied = await get("/auth/yahoo/callback?error=access_denied");
    assert.equal(denied.status, 400);

    const disc = await post("/auth/yahoo/disconnect");
    assert.equal(disc.status, 200);
    assert.deepEqual(disc.json, { ok: true });
  });
});

// Import provider: a 12-team league re-created from the demo rosters as plain
// names / positions / teams (what the bookmarklet sends), then every endpoint.
describe("server integration (import provider)", { timeout: 300_000 }, () => {
  let id = "";
  let payload: any;

  test("POST /api/import (bookmarklet JSON) → id; GET /api/import lists it", async () => {
    const a = (await get(`${L}/analysis`)).json;
    payload = {
      id: "itest",
      name: "Imported Test League",
      numTeams: 12,
      slots: ["QB", "WR", "WR", "RB", "RB", "TE", "W/R/T", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR"],
      scoring: { rec: 1 },
      regularSeasonEnd: 14,
      finalWeek: 17,
      myTeamId: "3",
      settingsSource: "page",
      teams: a.league.teams.map((t: any, i: number) => ({
        id: String(i + 1),
        // Yahoo's pages prefix every team with the league name; the server strips it.
        name: `Imported Test League - ${t.name}`,
        players: t.playerIds.map((pid: string) => {
          const p = a.players[pid];
          return { yahooId: p.ids?.yahoo, name: p.name, pos: p.pos, team: p.team };
        }),
      })),
      importedAt: new Date().toISOString(),
    };
    payload.teams[0].players.push({ name: "Zzzz Nosuchplayer", pos: "WR", team: "NYJ" });
    const r = await post("/api/import", payload);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    id = r.json.id;
    assert.equal(id, "itest");
    const list = await get("/api/import");
    assert.ok(list.json.some((x: any) => x.id === id && x.numTeams === 12));
    assert.equal(r.json.importedBy, "Admin", "dev mode stamps the import as Admin");
    assert.equal(list.json.find((x: any) => x.id === id).importedBy, "Admin");
    // The server stamps the NFL week the projections were captured in (release (d) fix round 1).
    const st = (await get("/api/state")).json;
    assert.equal((await get(`/api/import/${id}`)).json.projWeek, st.currentWeek);
  });

  test("league / analysis / values / trades / waivers work with provider=import", async () => {
    const base = `/api/league/import/${id}`;
    const league = await get(base);
    assert.equal(league.status, 200);
    assert.equal(league.json.provider, "import");
    assert.equal(league.json.myTeamId, "3");
    assert.equal(league.json.settings.scoring.rec, 1);
    assert.equal(league.json.import.settingsSource, "page");
    assert.deepEqual(league.json.teams[0].unmatched, ["Zzzz Nosuchplayer (WR, NYJ)"]);
    const demo = (await get(L)).json;
    for (let i = 0; i < 12; i++) assert.equal(league.json.teams[i].playerIds.length, demo.teams[i].playerIds.length, `team ${i + 1} resolution`);

    const an = await get(`${base}/analysis`);
    assert.equal(an.status, 200);
    assertClean(an.json, "import analysis");
    // No team name anywhere in league / analysis / trades / waivers responses repeats the league name.
    assert.equal(JSON.stringify(league.json.teams.map((t: any) => t.name)).includes("Imported Test League -"), false);
    for (const t of an.json.teams) assert.ok(!String(t.team.name).startsWith("Imported Test League"), t.team.name);
    assert.equal(an.json.teams.length, 12);
    assert.equal(an.json.myTeamId, "3");

    const values = await get(`${base}/values`);
    assert.equal(values.status, 200);
    assert.ok(values.json[0].value >= 99);

    const trades = await get(`${base}/trades2`);
    assert.equal(trades.status, 200);
    assert.ok([...trades.json.trades, ...trades.json.smallerEdges, ...trades.json.nearMisses].length > 0, "no trades");
    assert.equal(JSON.stringify(trades.json).includes("Imported Test League -"), false, "trade text repeats the league name");
    assertClean(trades.json, "import trades");

    const w = await get(`${base}/waivers`);
    assert.equal(w.status, 200);
    assertClean(w.json, "import waivers");
    assert.ok(w.json.freeAgents.length >= 10);
    // No free-agent list in this import: availability is unknown (the UI asks for a re-import), counted as on waivers.
    assert.equal(w.json.faStatusKnown, false);
    assert.ok(w.json.freeAgents.every((f: any) => f.availability === "unknown" && f.onWaivers === true));
  });

  test("re-importing the same league updates rosters in place and keeps settings", async () => {
    const base = `/api/league/import/${id}`;
    const put = await req("PUT", `/api/import/${id}/settings`, { scoring: { rec: 0.5 }, waiverPriority: 6, myTeamId: "5" });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const before = (await get(base)).json; // warms the league cache
    const fa = (await get(`${base}/values`)).json.find((p: any) => !p.rostered && p.pos === "WR");
    assert.ok(fa, "an unrostered WR");
    const again = structuredClone(payload);
    const dropped = again.teams[1].players.pop();
    const faIds = (await get(`${base}/analysis`)).json.players[fa.id]?.ids;
    again.teams[1].players.push({ yahooId: faIds?.yahoo, name: fa.name, pos: fa.pos, team: fa.team });
    const r = await post("/api/import", again);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.id, id);
    assert.equal(r.json.updated, true);
    assert.deepEqual(r.json.changes, { teams: 1, playersChanged: 1 });

    const after = (await get(base)).json;
    assert.ok(after.teams[1].playerIds.includes(fa.id), "new roster served (cache busted)");
    assert.notDeepEqual(after.teams[1].playerIds, before.teams[1].playerIds);
    assert.equal(after.settings.scoring.rec, 0.5);
    assert.equal(after.myTeamId, "5");
    assert.equal(after.import.waiverPriority, 6);
    assert.equal(after.import.settingsSource, "user");
    assert.equal((await get("/api/import")).json.filter((x: any) => x.id === id).length, 1);

    const hist = (await get(`/api/import/${id}/history`)).json;
    assert.equal(hist.length, 2);
    assert.equal(hist[1].teams.length, 12);
    const ch = (await get(`/api/import/${id}/changes`)).json;
    assert.equal(ch.playersChanged, 1);
    assert.deepEqual(ch.teams, [{ id: "2", name: again.teams[1].name.replace(/^Imported Test League - /, ""), added: [fa.name], dropped: [dropped.name] }]);
  });

  test("import with standings and waiver order → analysis records, waivers priority = my team's rank", async () => {
    const base = `/api/league/import/${id}`;
    const withStandings = structuredClone(payload);
    withStandings.teams.forEach((t: any, i: number) => {
      t.record = { wins: i % 8, losses: 7 - (i % 8), ties: 0, pointsFor: 900 + i * 10.5, pointsAgainst: 880, rank: i + 1 };
      t.waiverRank = 12 - i;
    });
    const r = await post("/api/import", withStandings);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const an = (await get(`${base}/analysis`)).json;
    const t5 = an.teams.find((t: any) => t.team.id === "5").team;
    assert.deepEqual(t5.record, { wins: 4, losses: 3, ties: 0, pointsFor: 942, pointsAgainst: 880, rank: 5 });
    assert.ok(an.teams.every((t: any) => t.team.record && Number.isInteger(t.team.record.wins)));
    // myTeamId is "5" (set by PUT above): its rank is 8. The hand-entered priority 6 stays stored but the fresh rank wins.
    const w = (await get(`${base}/waivers`)).json;
    assert.equal(w.myPriority, 8);
    assert.equal((await get(`${base}/waivers?team=2`)).json.myPriority, 11);
    assert.equal((await get(base)).json.import.waiverPriority, 6);
    const lv = (await get(`${base}/league`)).json;
    const r5 = lv.teams.find((t: any) => t.id === "5");
    assert.equal(r5.standingsRank, 5, "League tab uses the imported standings rank");
    assert.equal(r5.pointsAgainst, 880);
    assert.equal(r5.record, "4-3");
  });

  test("PUT settings, paste mode, delete", async () => {
    const put = await req("PUT", `/api/import/${id}/settings`, { scoring: { rec: 0 }, slots: "QB, RB x2, WR x2, TE, W/R/T, K, DEF, BN x6, IR", waiverPriority: 4, myTeamId: "2" });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.settingsSource, "user");
    const league = (await get(`/api/league/import/${id}`)).json;
    assert.equal(league.settings.scoring.rec, 0);
    assert.equal(league.myTeamId, "2");
    const w = (await get(`/api/league/import/${id}/waivers`)).json;
    assert.equal(w.myPriority, 4);
    const bad = await req("PUT", `/api/import/${id}/settings`, { slots: "QB, NOPE" });
    assert.equal(bad.status, 400);

    // Paste mode: replace team 1's roster by name.
    const t1 = payload.teams[0];
    const text = t1.players.slice(0, 5).map((p: any) => `${p.name} ${p.team} - ${p.pos}`).join("\n");
    // The user types the team name as shown in the app (no league prefix).
    const paste = await post("/api/import", { id, text, teamName: t1.name.replace(/^Imported Test League - /, "") });
    assert.equal(paste.status, 200, JSON.stringify(paste.json));
    assert.equal(paste.json.id, id);
    const after = (await get(`/api/league/import/${id}`)).json;
    assert.equal(after.teams.length, 12);
    assert.equal(after.teams[0].playerIds.length, 5);

    const fresh = await post("/api/import", { text: "=== A ===\n" + text + "\n=== B ===\n" + text, teamName: "x" });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.json.teams.length, 2);
    const none = await post("/api/import", { text: "hello world" });
    assert.equal(none.status, 400);
    const tooMany = await post("/api/import", { teams: Array.from({ length: 21 }, () => ({ players: [] })) });
    assert.equal(tooMany.status, 400);

    assert.equal((await req("DELETE", `/api/import/${fresh.json.id}`)).status, 200);
    assert.equal((await req("DELETE", `/api/import/${id}`)).status, 200);
    assert.equal((await get(`/api/league/import/${id}`)).status, 404);
    assert.equal((await req("DELETE", `/api/import/${id}`)).status, 404);
  });

  test("GET /api/import/bookmarklet.js", async () => {
    const res = await fetch(`${base}/api/import/bookmarklet.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    const code = await res.text();
    assert.ok(code.length > 2000 && code.length < 60_000, `size ${code.length}`);
    assert.ok(!/\bimport\s*[{(*]|\brequire\(/.test(code), "must be self-contained");
    assert.equal(res.headers.get("cache-control"), "no-store", "edge/browser caches served an old bookmarklet");
    const r = await get("/api/import/bookmarklet-url");
    assert.ok((r.json.url as string).startsWith("javascript:"));
    assert.match(r.json.version, /^[0-9a-f]{8}$/);
  });
});

const NO_AUTH = { DISCORD_CLIENT_ID: "", DISCORD_CLIENT_SECRET: "", SESSION_SECRET: "", PUBLIC_URL: "" };

test("production without the four Discord sign-in vars refuses to start (fail closed)", { timeout: 60_000 }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-noauth-"));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(ROOT, "server/index.ts")], {
    cwd: workDir,
    // Empty values: dotenv never overwrites a variable that is already set.
    env: { ...process.env, NODE_ENV: "production", ...NO_AUTH, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stderr!.on("data", (d) => (log += d));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 1, log);
  assert.match(log, /refusing to start: missing DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET, PUBLIC_URL/);
});

test("production WITH Discord config: /api/state without a cookie is 401 (dev mode cannot leak into production)", { timeout: 60_000 }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-prodauth-"));
  fs.symlinkSync(path.join(ROOT, ".cache"), path.join(workDir, ".cache"), "dir");
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(ROOT, "server/index.ts")], {
    cwd: workDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      DISCORD_CLIENT_ID: "dummy-client-id",
      DISCORD_CLIENT_SECRET: "dummy-client-secret",
      SESSION_SECRET: "dummy-session-secret-of-at-least-32-chars",
      PUBLIC_URL: "https://ff.example",
      PORT: String(port),
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  try {
    const deadline = Date.now() + 30_000;
    let status = 0;
    while (Date.now() < deadline && child.exitCode === null) {
      status = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.status).catch(() => 0);
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(status, 200, log);
    const r = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(r.status, 401);
    assert.equal(((await r.json()) as { code: string }).code, "signin");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/import`, { method: "POST" })).status, 401);
    const login = await fetch(`http://127.0.0.1:${port}/auth/login`, { redirect: "manual" });
    assert.equal(login.status, 302);
    assert.match(login.headers.get("location") ?? "", /^https:\/\/discord\.com\/oauth2\/authorize\?.*redirect_uri=https%3A%2F%2Fff\.example%2Fauth%2Fcallback/);
    assert.match(log, /event=startup mode=discord/);
    assert.ok(!log.includes("dummy-session-secret") && !log.includes("dummy-client-secret"), "secrets never logged");
  } finally {
    child.kill();
  }
});
