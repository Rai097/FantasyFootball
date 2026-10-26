// Sign-in routes and the scoped API, in-process: the real guard + routes + Yahoo auth router + apiRouter on an
// ephemeral port, a fake Discord client, sessions and access.json in a temp dir. The process cwd moves to a
// temp dir BEFORE the app modules load, so imports are written there (never the developer's .data/).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-routes-"));
// Shared public-data cache (as in integration.test.ts) so league analysis can build the player DB.
fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.symlinkSync(path.join(ROOT, ".cache"), path.join(work, ".cache"), "dir");
process.chdir(work);
const { createAuth, safeNext, signInLimiter } = await import("./routes.js");
const { AccessFile } = await import("./access.js");
const { SessionStore } = await import("./sessions.js");
const { apiRouter, errorMiddleware } = await import("../api.js");
const { authRouter } = await import("../auth.js");
type SessionIO = import("./sessions.js").SessionIO;
type SessionRow = import("./sessions.js").SessionRow;

const PUBLIC_URL = "https://ff.example";
const SECRET = "test-session-secret-0123456789-abcdef";
const CLIENT_SECRET = "discord-client-secret-XYZ";
const ADMIN = "100000000000000001";
const A = "200000000000000002";
const B = "300000000000000003";
const STRANGER = "400000000000000004";
const accessFile = path.join(work, "access.json");
const writeAccess = (users = [
  { discordId: A, leagueId: "yY", teamId: "4", note: "Alice" },
  { discordId: B, leagueId: "yY", teamId: "7", note: "Bob" },
]) => {
  fs.writeFileSync(accessFile, JSON.stringify({ admins: [ADMIN], users }));
  const t = new Date(Date.now() + Math.random() * 100_000);
  fs.utimesSync(accessFile, t, t);
};

const sessionFile = path.join(work, "sessions-test.json");
const io: SessionIO = {
  read: async () => (fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, "utf8")) : null),
  write: async (rows: Record<string, SessionRow>) => fs.writeFileSync(sessionFile, JSON.stringify(rows)),
};
const fakeDiscord = {
  exchange: async (code: string) => (code.startsWith("code-") ? `token-${code.slice(5)}` : null),
  me: async (token: string) => {
    const uid = token.slice(6);
    return { id: uid, username: `user${uid.slice(0, 2)}`, global_name: null, avatar: null };
  },
};

const logs: string[] = [];
function buildApp(sessions = new SessionStore(io)) {
  const auth = createAuth({ mode: "discord", clientId: "cid", clientSecret: CLIENT_SECRET, sessionSecret: SECRET, publicUrl: PUBLIC_URL, discord: fakeDiscord, sessions, access: new AccessFile(accessFile, (m) => logs.push(m)), log: (l) => logs.push(l) });
  const app = express();
  app.use(express.json());
  app.use(auth.guard);
  app.use(auth.router);
  app.use(authRouter);
  app.use(apiRouter);
  app.use(errorMiddleware);
  return { app, auth };
}

let server: http.Server;
let base = "";
async function listen(app: express.Express) {
  server?.close();
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);

async function startLogin(next = "/") {
  const r = await fetch(`${base}/auth/login?next=${encodeURIComponent(next)}`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get("location")!);
  const stateCookie = cookieOf(r, "td_oauth_state")!;
  assert.ok(stateCookie, "state cookie set");
  assert.match(r.headers.getSetCookie().join("\n"), /td_oauth_state=.*HttpOnly.*SameSite=Lax/i);
  return { state: loc.searchParams.get("state")!, stateCookie, loc };
}

async function callback(code: string, state: string, cookie: string) {
  return fetch(`${base}/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie } });
}

interface Who {
  cookie: string;
  csrf: string;
}
async function signIn(uid: string): Promise<Who> {
  const { state, stateCookie } = await startLogin("/#team");
  const r = await callback(`code-${uid}`, state, stateCookie);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/#team");
  const cookie = cookieOf(r, "td_session")!;
  assert.ok(cookie, "session cookie set");
  assert.match(r.headers.getSetCookie().join("\n"), /td_session=.*HttpOnly.*Secure.*SameSite=Strict/i);
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  return { cookie, csrf: ((await me.json()) as { csrf: string }).csrf };
}

async function call(who: Who | null, method: string, p: string, body?: unknown, opts: { origin?: string; csrf?: string } = {}) {
  const headers: Record<string, string> = { origin: opts.origin ?? PUBLIC_URL };
  if (who) {
    headers.cookie = who.cookie;
    headers["x-csrf-token"] = opts.csrf ?? who.csrf;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

const league = (myTeamId: string) => ({
  id: "yY",
  leagueId: "555",
  name: "League Y",
  teams: ["1", "4", "7"].map((id) => ({ id, name: `Team ${id}`, players: [] })),
  myTeamId,
});

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
before(async () => {
  for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  writeAccess();
  await listen(buildApp().app);
});
after(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
  server?.close();
});

describe("safeNext", () => {
  test("only same-site paths survive", () => {
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "\\\\evil", "evil", "", "/\x00x", "/\nx", "///evil"]) assert.equal(safeNext(bad), "/", JSON.stringify(bad));
    assert.equal(safeNext("/x?y=1#z"), "/x?y=1#z");
    assert.equal(safeNext(undefined), "/");
    assert.equal(safeNext(["/a"]), "/");
  });
  test("unsafe next on /auth/login is replaced by /", async () => {
    for (const bad of ["//evil", "/\\evil", "https://evil"]) {
      const { state, stateCookie } = await startLogin(bad);
      const r = await callback(`code-${A}`, state, stateCookie);
      assert.equal(r.headers.get("location"), "/", bad);
    }
  });
});

describe("Discord callback", () => {
  test("state mismatch / missing cookie / expired / bad signature → 400 and no session", async () => {
    const a = await startLogin();
    const b = await startLogin();
    const cases: [string, string, string][] = [
      ["mismatch", a.state, b.stateCookie],
      ["no cookie", a.state, ""],
      ["bad signature", `${a.state.slice(0, -2)}xx`, `td_oauth_state=${a.state.slice(0, -2)}xx`],
    ];
    for (const [what, state, cookie] of cases) {
      const r = await callback(`code-${A}`, state, cookie);
      assert.equal(r.status, 400, what);
      assert.equal(cookieOf(r, "td_session"), undefined, `${what}: no session`);
    }
    // Expired: a server whose clock is 11 minutes ahead.
    const later = createAuth({ mode: "discord", clientId: "cid", clientSecret: CLIENT_SECRET, sessionSecret: SECRET, publicUrl: PUBLIC_URL, discord: fakeDiscord, sessions: new SessionStore({ read: async () => null, write: async () => undefined }), access: new AccessFile(accessFile), log: () => undefined, now: () => Date.now() + 11 * 60_000 });
    const app = express();
    app.use(later.router);
    const s2 = http.createServer(app);
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", r));
    try {
      const r = await fetch(`http://127.0.0.1:${(s2.address() as { port: number }).port}/auth/callback?code=code-${A}&state=${encodeURIComponent(a.state)}`, { redirect: "manual", headers: { cookie: a.stateCookie } });
      assert.equal(r.status, 400);
      assert.match(await r.text(), /expired/);
      assert.equal(cookieOf(r, "td_session"), undefined);
    } finally {
      s2.close();
    }
  });

  test("not-allowlisted Discord id → no session, redirect /?error=not_allowed", async () => {
    const { state, stateCookie } = await startLogin();
    const r = await callback(`code-${STRANGER}`, state, stateCookie);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/?error=not_allowed");
    assert.equal(cookieOf(r, "td_session"), undefined);
    assert.ok(logs.some((l) => l.includes(`event=login uid=${STRANGER} result=refused`)));
  });

  test("failed code exchange → 502, no session", async () => {
    const { state, stateCookie } = await startLogin();
    const r = await callback("bogus", state, stateCookie);
    assert.equal(r.status, 502);
    assert.equal(cookieOf(r, "td_session"), undefined);
  });

  test("sign-in is rate limited per client", () => {
    let t = 0;
    const allow = signInLimiter(() => t);
    for (let i = 0; i < 30; i++) assert.equal(allow("peer:1"), true);
    assert.equal(allow("peer:1"), false);
    assert.equal(allow("peer:2"), true, "another client has its own budget");
    t += 60_000;
    assert.equal(allow("peer:1"), true, "new window");
  });
});

describe("scoped API", () => {
  let admin: Who, a: Who, b: Who;
  before(async () => {
    admin = await signIn(ADMIN);
    a = await signIn(A);
    b = await signIn(B);
    const r = await call(admin, "POST", "/api/import", league("1"));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const other = await call(admin, "POST", "/api/import", { ...league("1"), id: "yZ", leagueId: "777", name: "League Z" });
    assert.equal(other.status, 200);
  });

  test("/api/auth/me: role, scope, csrf; no cookie → 401 signin", async () => {
    const me = await call(a, "GET", "/api/auth/me");
    assert.equal(me.json.id, A);
    assert.equal(me.json.role, "user");
    assert.deepEqual(me.json.scope, { leagueId: "yY", teamId: "4" });
    assert.equal(me.json.actingAs, null);
    assert.equal((await call(admin, "GET", "/api/auth/me")).json.scope, null);
    const anon = await call(null, "GET", "/api/auth/me");
    assert.equal(anon.status, 401);
    assert.equal(anon.json.code, "signin");
    assert.doesNotMatch(String(anon.json.hint), /Yahoo/);
  });

  test("GET /api/import lists only the user's league; another league's details → 403", async () => {
    assert.deepEqual((await call(a, "GET", "/api/import")).json.map((x: { id: string }) => x.id), ["yY"]);
    assert.equal((await call(admin, "GET", "/api/import")).json.length, 2);
    assert.equal((await call(a, "GET", "/api/import/yZ")).status, 403);
    assert.equal((await call(a, "GET", "/api/import/yZ/changes")).status, 403);
    assert.equal((await call(a, "GET", "/api/import/yY/history")).status, 200);
  });

  test("user B re-importing league Y leaves user A's team and the stored myTeamId unchanged", async () => {
    const r = await call(b, "POST", "/api/import", league("7"));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.updated, true);
    assert.equal(r.json.myTeamId, "7", "B sees their own team");
    assert.equal((await call(admin, "GET", "/api/import/yY")).json.myTeamId, "1", "stored myTeamId unchanged");
    assert.deepEqual((await call(a, "GET", "/api/auth/me")).json.scope, { leagueId: "yY", teamId: "4" });
    // Paste mode into their own league: same rule.
    const p = await call(b, "POST", "/api/import", { text: "Patrick Mahomes KC - QB", teamName: "Team 7", id: "yY" });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.equal((await call(admin, "GET", "/api/import/yY")).json.myTeamId, "1");
  });

  test("user POST /api/import of a different league (or a new paste league) → 403", async () => {
    const r = await call(a, "POST", "/api/import", { ...league("4"), id: "yZ", leagueId: "777" });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "league");
    assert.equal((await call(a, "POST", "/api/import", { ...league("4"), id: "yQ", leagueId: "777" })).status, 403, "same Yahoo league under another id");
    assert.equal((await call(a, "POST", "/api/import", { ...league("4"), id: "yNew", leagueId: "999" })).status, 403);
    assert.equal((await call(a, "POST", "/api/import", { text: "Patrick Mahomes KC - QB", teamName: "Mine" })).status, 403);
  });

  test("DELETE / PUT settings: user → 403, admin → OK", async () => {
    assert.equal((await call(a, "PUT", "/api/import/yY/settings", { name: "Hacked" })).status, 403);
    assert.equal((await call(a, "DELETE", "/api/import/yZ")).status, 403);
    const put = await call(admin, "PUT", "/api/import/yZ/settings", { name: "Renamed Z" });
    assert.equal(put.status, 200);
    assert.equal(put.json.name, "Renamed Z");
    assert.equal((await call(admin, "DELETE", "/api/import/yZ")).status, 200);
    assert.equal((await call(admin, "GET", "/api/import/yZ")).status, 404);
  });

  test("league API: a user's team comes from the guard (missing team → theirs), not the stored myTeamId", { timeout: 240_000 }, async () => {
    const an = await call(a, "GET", "/api/league/import/yY/analysis");
    assert.equal(an.status, 200, JSON.stringify(an.json).slice(0, 300));
    assert.equal(an.json.myTeamId, "4");
    assert.equal(an.json.league.myTeamId, "4");
    assert.equal((await call(a, "GET", "/api/league/import/yY")).json.myTeamId, "4");
    assert.equal((await call(a, "GET", "/api/league/import/yY/analysis?team=4")).json.myTeamId, "4");
    const adm = await call(admin, "GET", "/api/league/import/yY/analysis");
    assert.equal(adm.json.myTeamId, "1", "admin default: the stored myTeamId");
    assert.equal(adm.json.league.myTeamId, "1");
    assert.equal((await call(admin, "GET", "/api/league/import/yY/analysis?team=7")).json.myTeamId, "7");
    await call(admin, "POST", "/api/auth/act-as", { discordId: B });
    try {
      const asB = await call(admin, "GET", "/api/league/import/yY/analysis");
      assert.equal(asB.json.myTeamId, "7");
      assert.equal(asB.json.league.myTeamId, "7");
    } finally {
      await call(admin, "POST", "/api/auth/act-as", { discordId: null });
    }
  });

  test("user: Yahoo provider / Yahoo auth / other league → 403", async () => {
    assert.equal((await call(a, "GET", "/api/league/yahoo/nfl.l.1")).status, 403);
    assert.equal((await call(a, "GET", "/auth/yahoo/start")).status, 403);
    assert.equal((await call(a, "POST", "/auth/yahoo/disconnect")).status, 403);
    assert.equal((await call(a, "GET", "/api/yahoo/leagues")).status, 403);
    assert.equal((await call(a, "GET", "/api/league/import/yZ/analysis")).status, 403);
    assert.equal((await call(a, "GET", "/api/league/import/yY/analysis?team=7")).json.code, "team");
  });

  test("writes without CSRF or from another Origin → 403", async () => {
    assert.equal((await call(admin, "PUT", "/api/import/yY/settings", { name: "x" }, { csrf: "wrong" })).json.code, "csrf");
    assert.equal((await call(admin, "PUT", "/api/import/yY/settings", { name: "x" }, { origin: "https://evil.example" })).json.code, "bad_origin");
    assert.equal((await call(admin, "PUT", "/api/import/yY/settings", { name: "x" }, { origin: "http://127.0.0.1:5070" })).json.code, "bad_origin");
  });

  test("admin act-as: scope becomes that user's exactly; null → admin; users can't act-as", async () => {
    assert.equal((await call(a, "POST", "/api/auth/act-as", { discordId: B })).status, 403);
    assert.equal((await call(admin, "POST", "/api/auth/act-as", { discordId: STRANGER })).status, 400);
    const r = await call(admin, "POST", "/api/auth/act-as", { discordId: B });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.scope, { leagueId: "yY", teamId: "7" });
    assert.equal(r.json.actingAs.discordId, B);
    assert.equal(r.json.role, "admin");
    assert.deepEqual((await call(admin, "GET", "/api/import")).json.map((x: { id: string }) => x.id), ["yY"]);
    assert.equal((await call(admin, "DELETE", "/api/import/yY")).status, 403);
    assert.equal((await call(admin, "GET", "/api/league/import/yY/waivers?team=4")).status, 403);
    assert.equal((await call(admin, "GET", "/api/access")).status, 200, "the real admin keeps the picker");
    const back = await call(admin, "POST", "/api/auth/act-as", { discordId: null });
    assert.equal(back.json.scope, null);
    assert.equal(back.json.actingAs, null);
    const acc = await call(admin, "GET", "/api/access");
    assert.deepEqual(acc.json.users.map((u: { discordId: string }) => u.discordId), [A, B]);
    assert.deepEqual(acc.json.leagues.map((l: { id: string }) => l.id), ["yY"]);
  });

  test("removing an id from access.json locks out the existing session on the next request", async () => {
    const c = await signIn(B);
    assert.equal((await call(c, "GET", "/api/import")).status, 200);
    writeAccess([{ discordId: A, leagueId: "yY", teamId: "4", note: "Alice" }]);
    const r = await call(c, "GET", "/api/import");
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "not_allowed");
    writeAccess();
  });

  test("sessions persist across a restart (reload from file)", async () => {
    const sessions = new SessionStore(io);
    await sessions.load();
    await listen(buildApp(sessions).app);
    assert.equal((await call(a, "GET", "/api/auth/me")).json.id, A);
  });

  test("logout revokes server-side: the old cookie → 401", async () => {
    const c = await signIn(A);
    const bad = await call(c, "POST", "/auth/logout", undefined, { origin: "https://evil.example" });
    assert.equal(bad.status, 403);
    assert.equal((await call(c, "GET", "/api/auth/me")).status, 200, "cross-site logout did nothing");
    const out = await call(c, "POST", "/auth/logout");
    assert.equal(out.status, 200);
    const after = await call(c, "GET", "/api/auth/me");
    assert.equal(after.status, 401);
    assert.equal(after.json.code, "signin");
  });

  test("secrets, codes, tokens and cookies never appear in log output", async () => {
    const r = await startLogin();
    await callback(`code-${A}`, r.state, r.stateCookie);
    const all = logs.join("\n");
    assert.ok(all.includes("event=login"), "login events are logged");
    assert.ok(all.includes("event=write"), "writes are logged");
    for (const secret of [SECRET, CLIENT_SECRET, `code-${A}`, `token-${A}`, r.state, a.cookie.split("=")[1], a.csrf, admin.csrf]) {
      assert.ok(!all.includes(secret), `log leaked ${secret.slice(0, 12)}…`);
    }
  });
});
