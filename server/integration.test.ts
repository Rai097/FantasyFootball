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
      env: { ...process.env, PORT: String(port), NODE_ENV: "test", YAHOO_CLIENT_ID: "", YAHOO_CLIENT_SECRET: "", YAHOO_REDIRECT_URI: "" },
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

  test("GET values: sorted, top ≈ 100", async () => {
    const { status, json } = await get(`${L}/values`);
    assert.equal(status, 200);
    assert.ok(json.length > 200);
    assertClean(json, "values");
    assert.ok(json[0].value >= 99 && json[0].value <= 100.05, `top value ${json[0].value}`);
    for (let i = 1; i < json.length; i++) assert.ok(json[i - 1].value >= json[i].value, "values not sorted");
    for (const p of json.slice(0, 300)) {
      assertValuedPlayer(p, "values");
      assert.ok(p.value >= 0 && p.value <= 100.05, `${p.name} value ${p.value}`);
      assert.ok(p.remainingGames >= 0, `${p.name} remainingGames ${p.remainingGames}`);
      assert.ok(p.ppg >= 0 && p.ppg < 40, `${p.name} ppg ${p.ppg}`);
      if (p.pos === "K" || p.pos === "DEF") assert.ok(p.value <= 15, `${p.pos} ${p.name} value ${p.value}`);
    }
    const rostered = json.filter((p: any) => p.rostered);
    assert.ok(rostered.length >= 12 * 15);
    assert.ok(rostered.every((p: any) => typeof p.ownerTeamId === "string"));
  });

  let trades: any[] = [];
  test("GET trades (unfiltered)", async () => {
    const { status, json } = await get(`${L}/trades`);
    assert.equal(status, 200);
    trades = json;
    assert.ok(json.length >= 10, `only ${json.length} trades`);
    assert.ok(json.length <= 40);
    assertClean(json, "trades");
    const keys = new Set<string>();
    for (const t of json) {
      assert.ok(t.me.lineupDelta >= 0.75, `${t.key}: me.lineupDelta ${t.me.lineupDelta}`);
      assert.ok(t.acceptance >= 0 && t.acceptance <= 1);
      assert.ok(t.fairness > 0);
      assert.ok(t.me.gives.length >= 1 && t.me.gives.length <= 2);
      assert.ok(t.them.gives.length >= 1 && t.them.gives.length <= 2);
      for (const p of [...t.me.gives, ...t.them.gives]) assert.ok(p.pos !== "K" && p.pos !== "DEF", `${t.key}: K/DEF traded (${p.name})`);
      assert.ok(t.summary && t.why && Array.isArray(t.tags));
      assert.ok(!keys.has(t.key), `duplicate trade ${t.key}`);
      keys.add(t.key);
    }
    for (let i = 1; i < json.length; i++) assert.ok(json[i - 1].score >= json[i].score, "trades not sorted by score");
  });

  test("GET trades with partner / wantPos filters", async () => {
    const partner = trades[0].them.teamId;
    const byPartner = await get(`${L}/trades?partner=${partner}`);
    assert.equal(byPartner.status, 200);
    assert.ok(byPartner.json.length > 0);
    for (const t of byPartner.json) assert.equal(t.them.teamId, partner);

    for (const pos of ["RB", "WR"]) {
      const r = await get(`${L}/trades?wantPos=${pos}`);
      assert.equal(r.status, 200);
      for (const t of r.json) assert.ok(t.them.gives.some((p: any) => p.pos === pos), `${t.key}: no ${pos} received`);
    }
    const lower = await get(`${L}/trades?wantPos=te&maxGive=1&maxGet=1`);
    assert.equal(lower.status, 200);
    for (const t of lower.json) {
      assert.ok(t.them.gives.some((p: any) => p.pos === "TE"));
      assert.equal(t.me.gives.length, 1);
      assert.equal(t.them.gives.length, 1);
    }
    const bad = await get(`${L}/trades?partner=nope`);
    assert.equal(bad.status, 400);
    assert.equal(typeof bad.json.error, "string");
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
    assert.equal(lop.json.verdict, "Decline");
    assert.ok(lop.json.why.length > 0);

    // A finder trade should evaluate to a non-Decline verdict.
    const t = trades[0];
    const ok = await post(`${L}/trade/evaluate`, {
      team: t.me.teamId,
      partner: t.them.teamId,
      give: t.me.gives.map((p: any) => p.id),
      get: t.them.gives.map((p: any) => p.id),
    });
    assert.equal(ok.status, 200);
    assert.notEqual(ok.json.verdict, "Decline");
    assert.equal(ok.json.me.lineupDelta, t.me.lineupDelta);

    // Duplicate ids are counted once.
    const dup = await post(`${L}/trade/evaluate`, { team: me.team.id, partner: partner.team.id, give: [myBest, myBest], get: [theirWorst] });
    assert.equal(dup.status, 200);
    assert.equal(dup.json.me.gives.length, 1);
    assert.equal(dup.json.me.valueGiven, lop.json.me.valueGiven);

    // Errors.
    const notMine = await post(`${L}/trade/evaluate`, { team: me.team.id, partner: partner.team.id, give: [partner.team.playerIds[0]], get: [] });
    assert.equal(notMine.status, 400);
    assert.equal(typeof notMine.json.error, "string");
    const self = await post(`${L}/trade/evaluate`, { team: me.team.id, partner: me.team.id, give: [myBest], get: [] });
    assert.equal(self.status, 400);
    const noPartner = await post(`${L}/trade/evaluate`, { team: me.team.id, give: [myBest], get: [] });
    assert.equal(noPartner.status, 400);
    const empty = await post(`${L}/trade/evaluate`, { team: me.team.id, partner: partner.team.id, give: [], get: [] });
    assert.equal(empty.status, 400);
  });

  test("GET waivers", async () => {
    const { status, json } = await get(`${L}/waivers`);
    assert.equal(status, 200);
    assertClean(json, "waivers");
    assert.equal(json.numTeams, 12);
    assert.equal(typeof json.advice, "string");
    assert.ok(json.freeAgents.length >= 10);
    const league = (await get(L)).json;
    const rostered = new Set(league.teams.flatMap((t: any) => t.playerIds));
    for (const w of json.freeAgents) {
      assertValuedPlayer(w, "waivers");
      assert.ok(["claim", "wait", "optional", "pass"].includes(w.recommendation), `${w.name}: ${w.recommendation}`);
      assert.ok(typeof w.why === "string" && w.why.length > 0, `${w.name}: why`);
      assert.ok(Number.isFinite(w.gain) && Number.isFinite(w.benchGain));
      assert.ok(!rostered.has(w.id), `${w.name} is rostered`);
    }
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
