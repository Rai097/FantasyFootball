// ADVERSARIAL API tests (tester, not developer) for Model v4 release (c): GET /waivers `stash` and the request team's
// `ret` on /analysis, on the real 2026 cache (demo league 42), plus auth on /waivers in production. Boots the real
// server/index.ts as a child process in a temp dir with a minimal environment (never .env / .data), kills it after.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detailProblems } from "./model/testkit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const L = "/api/league/demo/42";

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

async function boot(env: Record<string, string>, ready: string): Promise<{ base: string; kill: () => Promise<void>; log: () => string }> {
  const port = await freePort();
  fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-advstash-"));
  fs.symlinkSync(path.join(ROOT, ".cache"), path.join(dir, ".cache"), "dir");
  const child: ChildProcess = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(ROOT, "server/index.ts")], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir(), PORT: String(port), HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const exited = new Promise<void>((r) => child.on("exit", () => r()));
  const base = `http://127.0.0.1:${port}`;
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    const s = await fetch(base + ready).then((r) => r.status).catch(() => 0);
    if (s === 200) break;
    if (Date.now() > deadline) {
      await kill();
      throw new Error(`server not ready:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { base, kill, log: () => log };
}

test("production: /waivers (and ?refresh=1) without a session cookie is 401, never data", { timeout: 90_000 }, async () => {
  const s = await boot(
    { NODE_ENV: "production", DISCORD_CLIENT_ID: "adv-id", DISCORD_CLIENT_SECRET: "adv-secret-NEVER-LOG", SESSION_SECRET: "adv-session-secret-0123456789-abcdef", PUBLIC_URL: "https://ff.example" },
    "/healthz",
  );
  try {
    for (const p of [`${L}/waivers`, `${L}/waivers?refresh=1`, `${L}/waivers?team=1`, "/api/league/import/x/waivers"]) {
      const r = await fetch(s.base + p, { headers: { cookie: "ftd_session=forged.value" } });
      assert.equal(r.status, 401, `${p} → ${r.status}`);
      const body = await r.text();
      assert.ok(!/stash|freeAgents/.test(body), `${p} leaked data`);
    }
  } finally {
    await s.kill();
  }
});

describe("dev server, demo league 42 (real 2026 cache)", { timeout: 400_000 }, () => {
  let s: Awaited<ReturnType<typeof boot>>;
  const get = async (p: string) => {
    const r = await fetch(s.base + p);
    return { status: r.status, json: (await r.json()) as any };
  };
  before(async () => {
    s = await boot({ NODE_ENV: "test", DISCORD_CLIENT_ID: "", YAHOO_CLIENT_ID: "", YAHOO_CLIENT_SECRET: "", YAHOO_REDIRECT_URI: "" }, "/api/state");
  }, { timeout: 200_000 });
  after(async () => s && (await s.kill()));

  test("/waivers: timing, payload cap, stash rows sane on real data", async () => {
    const t0 = Date.now();
    const { status, json } = await get(`${L}/waivers`);
    const cold = Date.now() - t0;
    assert.equal(status, 200);
    assert.ok(cold < 20_000, `cold /waivers ${cold} ms`);
    const t1 = Date.now();
    await get(`${L}/waivers`);
    const warm = Date.now() - t1;
    assert.ok(warm < 500, `warm /waivers ${warm} ms (cached)`);
    assert.ok(JSON.stringify(json.stash).length < 25_000, `stash payload ${JSON.stringify(json.stash).length} bytes`);
    const state = (await get("/api/state")).json;
    const league = (await get(L)).json;
    const rostered = new Set(league.teams.flatMap((t: any) => t.playerIds));
    const final = league.settings.finalWeek;
    assert.ok(json.stash.length <= 10);
    for (const r of json.stash) {
      assert.ok(!rostered.has(r.id), `${r.name} rostered`);
      if (r.call === "add") assert.equal(r.availability, "fa", `${r.name}: Add now while ${r.availability}`);
      if (r.availability !== "fa") assert.notEqual(r.call, "add", r.name);
      if (r.backWeek !== null) assert.ok(r.backWeek >= state.currentWeek && r.backWeek <= final, `${r.name}: back wk ${r.backWeek} (current ${state.currentWeek}, final ${final})`);
      else assert.equal(r.confidence, "unknown", r.name);
      if (r.flag) assert.ok(r.details.some((d: any) => d.label === "Practice" && /limited|full/.test(d.value)), `${r.name}: practice flag without a practice bullet`);
      assert.ok(r.summary.length <= 255);
      assert.deepEqual(detailProblems(r.details), [], r.name);
      assert.ok(r.healthyRate >= (json.stash.length ? 0 : 0) && Number.isFinite(r.stashScore) && r.stashScore > 0, r.name);
    }
    assert.equal((await get(`${L}/waivers?team=99`)).status, 400);
  });

  test("/analysis ret (request team only): week in range, 0 before the return, numbers finite; measure the Stash-vs-projection playoff gap", async (t) => {
    const league = (await get(L)).json;
    const state = (await get("/api/state")).json;
    const gaps: string[] = [];
    let seen = 0;
    for (const tm of league.teams) {
      const an = (await get(`${L}/analysis?team=${tm.id}`)).json;
      for (const p of Object.values(an.players) as any[]) {
        if (!p.ret) continue;
        seen++;
        assert.ok(tm.playerIds.includes(p.id), `${p.name}: ret leaked for another team (request ${tm.id})`);
        const r = p.ret;
        assert.ok(["high", "medium", "low", "unknown"].includes(r.confidence));
        assert.equal(r.week === null, r.confidence === "unknown", `${p.name}: week ${r.week} conf ${r.confidence}`);
        for (const k of ["healthyRate", "returnValue", "playoffPts", "stashScore", "tradeValue"]) if (r[k] !== undefined) assert.ok(Number.isFinite(r[k]), `${p.name}.${k}`);
        assert.deepEqual(detailProblems(r.reasons), [], p.name);
        if (r.week !== null) {
          assert.ok(r.week >= state.currentWeek && r.week <= league.settings.finalWeek, `${p.name}: wk ${r.week}`);
          if (p.weekly && r.absent) {
            const before = p.weekly.slice(0, r.week - p.weeklyFrom);
            assert.ok(before.every((x: number) => x === 0), `${p.name}: back wk ${r.week} but weekly ${before}`);
          }
          if (r.playoffPts !== undefined && Math.abs(r.playoffPts - p.playoffPts) > 0.1 * Math.max(1, r.playoffPts)) gaps.push(`${p.name} hold ${r.playoffPts} vs proj ${p.playoffPts}`);
        } else if (r.absent && p.weekly) assert.ok(p.weekly.every((x: number) => x === 0), `${p.name}: return unconfirmed but projected ${p.weekly}`);
      }
    }
    t.diagnostic(`players with ret on their own team: ${seen}; known-return playoff gaps > 10%: ${gaps.length} ${gaps.join(" | ")}`);
  });
});
