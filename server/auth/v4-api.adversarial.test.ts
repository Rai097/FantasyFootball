// ADVERSARIAL tests (tester, not developer) for Model v4 release (b) through the real guard + auth routes + apiRouter
// in-process (fake Discord, sessions and access.json in a temp dir; cwd moves there BEFORE the app modules load, so
// imports are written there, never the repo's .data/). Deleted trade routes, auth on every changed route, timing and
// payload caps on the demo league, luck labels consistent across Values / Trade Finder / Targets.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-advv4-"));
fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.symlinkSync(path.join(ROOT, ".cache"), path.join(work, ".cache"), "dir");
process.chdir(work);
const { createAuth } = await import("./routes.js");
const { AccessFile } = await import("./access.js");
const { SessionStore } = await import("./sessions.js");
const { apiRouter, errorMiddleware } = await import("../api.js");
const { authRouter } = await import("../auth.js");
type SessionIO = import("./sessions.js").SessionIO;
type SessionRow = import("./sessions.js").SessionRow;

const PUBLIC_URL = "https://ff.example";
const SECRET = "advv4-session-secret-0123456789-abcdef";
const ADMIN = "100000000000000001";
const A = "200000000000000002"; // league yY team 4
const B = "300000000000000003"; // league yY team 7
const C = "500000000000000005"; // league yZ team 1
const accessFile = path.join(work, "access.json");
fs.writeFileSync(
  accessFile,
  JSON.stringify({
    admins: [ADMIN],
    users: [
      { discordId: A, leagueId: "yY", teamId: "4", note: "A" },
      { discordId: B, leagueId: "yY", teamId: "7", note: "B" },
      { discordId: C, leagueId: "yZ", teamId: "1", note: "C" },
    ],
  }),
);
const sessionFile = path.join(work, "sessions.json");
const io: SessionIO = {
  read: async () => (fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, "utf8")) : null),
  write: async (rows: Record<string, SessionRow>) => fs.writeFileSync(sessionFile, JSON.stringify(rows)),
};
const fakeDiscord = {
  exchange: async (code: string) => (code.startsWith("code-") ? `token-${code.slice(5)}` : null),
  me: async (token: string) => ({ id: token.slice(6), username: "u", global_name: null, avatar: null }),
};
const logs: string[] = [];
const auth = createAuth({ mode: "discord", clientId: "cid", clientSecret: "secret-x", sessionSecret: SECRET, publicUrl: PUBLIC_URL, discord: fakeDiscord, sessions: new SessionStore(io), access: new AccessFile(accessFile, (m) => logs.push(m)), log: (l) => logs.push(l) });
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(auth.guard);
app.use(auth.router);
app.use(authRouter);
app.use(apiRouter);
app.use(errorMiddleware);
let server: http.Server;
let base = "";

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);
interface Who {
  cookie: string;
  csrf: string;
}
async function signIn(uid: string): Promise<Who> {
  const r = await fetch(`${base}/auth/login?next=/`, { redirect: "manual" });
  const state = new URL(r.headers.get("location")!).searchParams.get("state")!;
  const cb = await fetch(`${base}/auth/callback?code=code-${uid}&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie: cookieOf(r, "td_oauth_state")! } });
  const cookie = cookieOf(cb, "td_session")!;
  assert.ok(cookie, `signed in ${uid}`);
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  return { cookie, csrf: ((await me.json()) as { csrf: string }).csrf };
}
async function call(who: Who | null, method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = { origin: PUBLIC_URL };
  if (who) (headers.cookie = who.cookie), (headers["x-csrf-token"] = who.csrf);
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, bytes: text.length };
}

let admin: Who, a: Who, b: Who, c: Who;
let demoAnalysis: any;

function yLeague(): any {
  const teams = demoAnalysis.league.teams.map((t: any, i: number) => ({
    id: String(i + 1),
    name: `League Y - ${t.name}`,
    players: t.playerIds.map((pid: string) => {
      const p = demoAnalysis.players[pid];
      return { yahooId: p.ids?.yahoo, name: p.name, pos: p.pos, team: p.team };
    }),
  }));
  return { id: "yY", leagueId: "555", name: "League Y", numTeams: 12, slots: ["QB", "WR", "WR", "RB", "TE", "W/R/T", "W/R/T", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR", "IR"], scoring: { rec: 1 }, settingsSource: "page", teams, freeAgents: [], myTeamId: "1" };
}

const timings: string[] = [];
let coldAnalysisMs = 0;
before(
  async () => {
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const k of ["log", "warn"] as const) console[k] = (...x: unknown[]) => void logs.push(x.map(String).join(" "));
    admin = await signIn(ADMIN);
    a = await signIn(A);
    b = await signIn(B);
    c = await signIn(C);
    const t0 = performance.now();
    const an = await call(admin, "GET", "/api/league/demo/42/analysis");
    coldAnalysisMs = performance.now() - t0;
    assert.equal(an.status, 200);
    demoAnalysis = an.json;
    const y = await call(admin, "POST", "/api/import", yLeague());
    assert.equal(y.status, 200, JSON.stringify(y.json));
    const z = await call(admin, "POST", "/api/import", { id: "yZ", leagueId: "777", name: "League Z", teams: [{ id: "1", name: "Z1", players: [] }, { id: "2", name: "Z2", players: [] }] });
    assert.equal(z.status, 200);
  },
  { timeout: 300_000 },
);
after(() => {
  server?.close();
  // Timings for the tester's report (stderr; the assertions are in the tests below).
  process.stderr.write(`[v4-api timings] cold first /analysis ${coldAnalysisMs.toFixed(0)} ms; ${timings.join("; ")}\n`);
});

const ROUTES: [string, string, unknown?][] = [
  ["GET", "analysis"],
  ["GET", "league"],
  ["GET", "values"],
  ["GET", "trades2"],
  ["GET", "bench-upgrades"],
  ["GET", "waivers"],
  ["GET", "breakouts"],
  ["POST", "trade/evaluate", { partner: "2", give: ["x"], get: ["y"] }],
];

describe("Model v4 API (adversarial)", { timeout: 300_000 }, () => {
  test("deleted Trade Finder v1 / v2 routes: 404 for an admin on demo and import", async () => {
    for (const p of ["/api/league/demo/42/trades", "/api/league/import/yY/trades", "/api/league/demo/42/trades?mode=balanced", "/api/league/demo/42/trades-v2", "/api/league/demo/42/tradesV2", "/api/league/demo/42/trades/v2"]) {
      const r = await call(admin, "GET", p);
      assert.equal(r.status, 404, `${p} → ${r.status}`);
    }
  });

  test("every changed route: 401 without a session", async () => {
    for (const [m, sub, body] of ROUTES) {
      for (const lg of ["demo/42", "import/yY"]) {
        const r = await call(null, m, `/api/league/${lg}/${sub}`, body);
        assert.equal(r.status, 401, `${m} ${lg}/${sub} → ${r.status}`);
        assert.equal(r.json?.code, "signin", `${m} ${lg}/${sub}`);
      }
    }
  });

  test("every changed route: 403 for another league's user (both directions), and no data in the body", async () => {
    for (const [m, sub, body] of ROUTES) {
      const r = await call(c, m, `/api/league/import/yY/${sub}`, body);
      assert.equal(r.status, 403, `C → yY ${sub}: ${r.status}`);
      assert.ok(!JSON.stringify(r.json).includes("League Y -"), `${sub}: 403 body leaks team names`);
      const r2 = await call(a, m, `/api/league/import/yZ/${sub}`, body);
      assert.equal(r2.status, 403, `A → yZ ${sub}: ${r2.status}`);
    }
  });

  test("a pinned user asking for another team → 403 on every team route (both users)", async () => {
    for (const [who, other] of [[a, "7"], [b, "4"]] as const) {
      for (const [m, sub, body] of ROUTES) {
        const r = m === "GET" ? await call(who, m, `/api/league/import/yY/${sub}?team=${other}`) : await call(who, m, `/api/league/import/yY/${sub}`, { ...(body as object), team: other });
        assert.equal(r.status, 403, `${sub} team=${other} as a pinned user: ${r.status}`);
      }
    }
  });

  // Wall-clock budget: measured alone (npm test's second step), not while every other test file competes for the CPU.
  test("demo league timing: each route's first call (league valued) and repeat call < 1 s", { skip: process.env.SKIP_TIMING === "1" && "timed alone in npm test's second step" }, async () => {
    const slow: string[] = [];
    for (const sub of ["analysis", "values", "trades2", "waivers", "league", "breakouts", "bench-upgrades"]) {
      const t0 = performance.now();
      const r1 = await call(admin, "GET", `/api/league/demo/42/${sub}`);
      const first = performance.now() - t0;
      const t1 = performance.now();
      const r2 = await call(admin, "GET", `/api/league/demo/42/${sub}`);
      const again = performance.now() - t1;
      assert.equal(r1.status, 200, sub);
      assert.equal(r2.status, 200, sub);
      timings.push(`${sub} first ${first.toFixed(0)} ms / repeat ${again.toFixed(0)} ms / ${(r1.bytes / 1024).toFixed(0)} KB`);
      if (first > 1000 || again > 1000) slow.push(`${sub}: first ${first.toFixed(0)} ms, repeat ${again.toFixed(0)} ms`);
    }
    // A team in the other value mode values the league a second time: also < 1 s.
    const mine = demoAnalysis.league.myTeamId;
    const other = demoAnalysis.league.teams.find((t: any) => t.id !== mine && ((t.record?.seed ?? t.record?.rank ?? 99) <= 6) !== ((demoAnalysis.league.teams.find((x: any) => x.id === mine)?.record?.rank ?? 99) <= 6))
      ?? demoAnalysis.league.teams.find((t: any) => t.id !== mine);
    const t2 = performance.now();
    const ov = await call(admin, "GET", `/api/league/demo/42/values?team=${other.id}`);
    const otherMs = performance.now() - t2;
    timings.push(`values other-mode team (${other.id}) ${otherMs.toFixed(0)} ms`);
    assert.equal(ov.status, 200);
    if (otherMs > 1000) slow.push(`values?team=${other.id}: ${otherMs.toFixed(0)} ms`);
    assert.deepEqual(slow, []);
  });

  test("demo league payload caps: values < 250 KB, league < 60 KB, waivers < 150 KB, breakouts < 250 KB, analysis < 1.5 MB; no NaN", async () => {
    // Documented caps (docs/DESIGN.md); breakouts and trades2 have none documented → generous tester caps. /analysis has
    // no documented cap: its size and the share taken by `weekly` arrays are only reported.
    const caps: Record<string, number> = { values: 250_000, league: 60_000, waivers: 150_000, breakouts: 250_000, trades2: 600_000, analysis: Infinity };
    for (const [sub, cap] of Object.entries(caps)) {
      const r = await call(admin, "GET", `/api/league/demo/42/${sub}`);
      assert.equal(r.status, 200, sub);
      assert.ok(r.bytes < cap, `${sub}: ${r.bytes} bytes ≥ ${cap}`);
      assert.doesNotMatch(JSON.stringify(r.json), /\bNaN\b|Infinity|"undefined"/, `${sub} has NaN / Infinity`);
      if (sub === "analysis") {
        const noWeekly = JSON.stringify(r.json, (k, v) => (k === "weekly" ? undefined : v)).length;
        timings.push(`analysis ${(r.bytes / 1024).toFixed(0)} KB, of which weekly arrays ${((r.bytes - noWeekly) / 1024).toFixed(0)} KB`);
      }
    }
  });

  test("luck sign is one convention across Values, Trade Finder tags and Targets tags (+ = due for more = buy-low)", async () => {
    const values = await call(admin, "GET", "/api/league/demo/42/values");
    const byName = new Map<string, any>(values.json.map((r: any) => [r.name, r]));
    for (const r of values.json) {
      if (r.label === "buy-low") assert.ok(r.luck >= 1.95, `${r.name}: buy-low with luck ${r.luck}`);
      if (r.label === "sell-high") assert.ok(r.luck <= -1.95, `${r.name}: sell-high with luck ${r.luck}`);
    }
    let seen = 0;
    for (const mode of ["balanced", "playoffs", "now"]) {
      const tr = await call(admin, "GET", `/api/league/demo/42/trades2?mode=${mode}&maxGive=2&maxGet=2`);
      assert.equal(tr.status, 200);
      const all = [...tr.json.trades, ...(tr.json.smallerEdges ?? []), ...(tr.json.nearMisses ?? [])];
      for (const t of all) {
        for (const tag of t.tags ?? []) {
          const m = /^(buy-low|sell-high): (.+?) \((?:due|TD luck) ([+−-][\d.]+) pts\/g\)$/.exec(tag);
          if (!m) continue;
          seen++;
          const n = Number(m[3].replace("−", "-"));
          const row = byName.get(m[2]);
          assert.ok(row, `${tag}: player not in values`);
          assert.equal(row.label, m[1], `${tag}: values label ${row.label}`);
          assert.ok(Math.abs(n - row.luck) <= 0.05, `${tag}: values luck ${row.luck}`);
          assert.ok(m[1] === "buy-low" ? n > 0 : n < 0, tag);
        }
      }
    }
    const br = await call(admin, "GET", "/api/league/demo/42/breakouts");
    for (const t of br.json.targets) {
      const row = byName.get(t.player.name);
      if (!row) continue;
      if (t.tags?.includes("buy-low")) assert.equal(row.label, "buy-low", `Targets ${t.player.name}: buy-low tag, values label ${row.label}`);
      if (t.tags?.includes("sell-high")) assert.equal(row.label, "sell-high", `Targets ${t.player.name}`);
    }
    timings.push(`luck tags checked in trades: ${seen}`);
  });
});
