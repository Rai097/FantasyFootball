// ADVERSARIAL tests for Discord sign-in (docs/DESIGN.md "Discord sign-in, multi-tenant" + amendments), written by
// the tester, not the developer. Real guard + auth routes + Yahoo auth router + apiRouter in-process on ephemeral
// ports; sessions and access.json in a temp dir; cwd moves to that temp dir BEFORE the app modules load so imports
// are written there (never the repo's .data/). Raw http.request is used for path tricks (fetch normalises paths).
// Invariant for every probe: a caller never gets data they are not scoped to (status ∈ {401,403,404,...} AND the
// other league's canary string never appears in the body).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-adv-"));
fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.symlinkSync(path.join(ROOT, ".cache"), path.join(work, ".cache"), "dir");
process.chdir(work);
const { createAuth, clientKey, safeNext } = await import("./routes.js");
const { AccessFile } = await import("./access.js");
const { SessionStore } = await import("./sessions.js");
const { discordClient } = await import("./discord.js");
const { apiRouter, errorMiddleware } = await import("../api.js");
const { authRouter } = await import("../auth.js");
type SessionIO = import("./sessions.js").SessionIO;
type SessionRow = import("./sessions.js").SessionRow;
type DiscordClient = import("./discord.js").DiscordClient;

const PUBLIC_URL = "https://ff.example";
const SECRET = "adv-session-secret-0123456789-abcdefXYZ";
const OTHER_SECRET = "another-deploy-secret-0123456789-abcdef";
const CLIENT_SECRET = "discord-client-secret-ADV-SHOULD-NEVER-LOG";
const ADMIN = "100000000000000001";
const A = "200000000000000002"; // league yY team 4
const B = "300000000000000003"; // league yY team 7
const C = "500000000000000005"; // league yZ team 1
const STRANGER = "400000000000000004";
const CANARY = "CANARY7f3a";

const accessFile = path.join(work, "access.json");
const defaultUsers = () => [
  { discordId: A, leagueId: "yY", teamId: "4", note: "Alice" },
  { discordId: B, leagueId: "yY", teamId: "7", note: "Bob" },
  { discordId: C, leagueId: "yZ", teamId: "1", note: "Carol" },
];
let bump = 0;
function touch(file: string) {
  // Fresh mtime every write so AccessFile's mtime+size cache can never serve a stale list in the test.
  const t = new Date(Date.now() + ++bump * 10_000);
  fs.utimesSync(file, t, t);
}
function writeAccessRaw(content: string) {
  try {
    fs.chmodSync(accessFile, 0o644);
  } catch {
    /* may not exist */
  }
  try {
    if (fs.statSync(accessFile).isDirectory()) fs.rmdirSync(accessFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(accessFile, content);
  touch(accessFile);
}
const writeAccess = (users: unknown[] = defaultUsers(), admins: unknown = [ADMIN]) => writeAccessRaw(JSON.stringify({ admins, users }));

function fileIO(file: string): SessionIO & { failWrites: boolean } {
  const io = {
    failWrites: false,
    read: async () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null),
    write: async (rows: Record<string, SessionRow>) => {
      if (io.failWrites) throw Object.assign(new Error("EACCES: permission denied, open 'sessions.json.tmp'"), { code: "EACCES" });
      fs.writeFileSync(file, JSON.stringify(rows));
    },
  };
  return io;
}
const mainIO = fileIO(path.join(work, "sessions-main.json"));

// Single-use codes like Discord: a code works once.
const usedCodes = new Set<string>();
const fakeDiscord: DiscordClient = {
  exchange: async (code: string) => {
    if (!code.startsWith("code-") || usedCodes.has(code)) return null;
    usedCodes.add(code);
    return `token-${code.slice(5)}`;
  },
  me: async (token: string) => {
    const uid = token.slice(6).split("-")[0];
    return { id: uid, username: `user${uid.slice(0, 2)}`, global_name: null, avatar: null };
  },
};

const logs: string[] = [];
function buildApp(opts: { sessions?: InstanceType<typeof SessionStore>; discord?: DiscordClient; secret?: string; mode?: "discord" | "dev" } = {}) {
  const sessions = opts.sessions ?? new SessionStore(mainIO);
  const auth =
    opts.mode === "dev"
      ? createAuth({ mode: "dev", sessions, access: new AccessFile(accessFile, (m) => logs.push(m)), log: (l) => logs.push(l) })
      : createAuth({
          mode: "discord",
          clientId: "cid",
          clientSecret: CLIENT_SECRET,
          sessionSecret: opts.secret ?? SECRET,
          publicUrl: PUBLIC_URL,
          discord: opts.discord ?? fakeDiscord,
          sessions,
          access: new AccessFile(accessFile, (m) => logs.push(m)),
          log: (l) => logs.push(l),
        });
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(auth.guard);
  app.use(auth.router);
  app.use(authRouter);
  app.use(apiRouter);
  app.use(errorMiddleware);
  return { app, auth, sessions };
}

const servers: http.Server[] = [];
async function listen(app: express.Express): Promise<string> {
  const s = http.createServer(app);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

interface Res {
  status: number;
  text: string;
  json: any;
  headers: http.IncomingHttpHeaders;
}
/** Raw HTTP request: the path goes on the wire exactly as given (no URL normalisation). */
function raw(base: string, method: string, p: string, headers: Record<string, string | string[]> = {}, body?: string | Buffer): Promise<Res> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    // Over loopback the limiter trusts CF-Connecting-IP (by design); give each request its own so the many sign-ins
    // in this file never hit the 30/min per-client limit. The key function itself is tested separately below.
    const h = { "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250)}-${Math.random()}`, ...headers };
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers: h }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          json = text;
        }
        resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const setCookies = (r: Res) => ([] as string[]).concat(r.headers["set-cookie"] ?? []);
const cookieOf = (r: Res, name: string) =>
  setCookies(r)
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);

interface Who {
  cookie: string;
  csrf: string;
}

let base = "";
let codeSeq = 0;
async function startLogin(b: string, next = "/") {
  const r = await raw(b, "GET", `/auth/login?next=${encodeURIComponent(next)}`);
  assert.equal(r.status, 302);
  const loc = new URL(String(r.headers.location));
  const stateCookie = cookieOf(r, "td_oauth_state")!;
  return { state: loc.searchParams.get("state")!, stateCookie };
}
const callback = (b: string, code: string, state: string, cookie: string) =>
  raw(b, "GET", `/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, cookie ? { cookie } : {});

async function signIn(uid: string, b = base): Promise<Who> {
  const { state, stateCookie } = await startLogin(b);
  const r = await callback(b, `code-${uid}-${++codeSeq}`, state, stateCookie);
  assert.equal(r.status, 302, r.text);
  const cookie = cookieOf(r, "td_session")!;
  assert.ok(cookie, "session cookie set");
  const me = await raw(b, "GET", "/api/auth/me", { cookie });
  assert.equal(me.status, 200);
  return { cookie, csrf: me.json.csrf };
}

function call(who: Who | null, method: string, p: string, body?: unknown, opts: { origin?: string | null; csrf?: string | null; b?: string; headers?: Record<string, string | string[]> } = {}) {
  const headers: Record<string, string | string[]> = {};
  if (opts.origin !== null) headers.origin = opts.origin ?? PUBLIC_URL;
  if (who) {
    headers.cookie = who.cookie;
    if (opts.csrf !== null) headers["x-csrf-token"] = opts.csrf ?? who.csrf;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  Object.assign(headers, opts.headers ?? {});
  return raw(opts.b ?? base, method, p, headers, body !== undefined ? JSON.stringify(body) : undefined);
}

const leaguePayload = (id: string, leagueId: string, name: string, teamPrefix: string, myTeamId: string, teams = ["1", "4", "7"]) => ({
  id,
  leagueId,
  name,
  teams: teams.map((t) => ({ id: t, name: `${teamPrefix} ${t}`, players: [] })),
  myTeamId,
});

/** Every route a caller can hit, enumerated from server/api.ts, server/auth.ts and server/auth/routes.ts. */
const ROUTES = (lg: string, prov = "import"): [string, string, unknown?][] => [
  ["GET", "/api/state"],
  ["GET", `/api/players/search?q=a&provider=${prov}&id=${lg}`],
  ["GET", "/api/yahoo/leagues"],
  ["GET", `/api/league/${prov}/${lg}`],
  ["GET", `/api/league/${prov}/${lg}/analysis`],
  ["GET", `/api/league/${prov}/${lg}/trades`],
  ["GET", `/api/league/${prov}/${lg}/trades2`],
  ["GET", `/api/league/${prov}/${lg}/bench-upgrades`],
  ["POST", `/api/league/${prov}/${lg}/trade/evaluate`, { partner: "1", give: [], get: [] }],
  ["GET", `/api/league/${prov}/${lg}/waivers`],
  ["GET", `/api/league/${prov}/${lg}/breakouts`],
  ["GET", `/api/league/${prov}/${lg}/values`],
  ["GET", "/api/import"],
  ["POST", "/api/import", leaguePayload(lg, "777", "x", "x", "1")],
  ["GET", `/api/import/${lg}/history`],
  ["GET", `/api/import/${lg}/changes`],
  ["GET", `/api/import/${lg}`],
  ["PUT", `/api/import/${lg}/settings`, { name: "pwned" }],
  ["DELETE", `/api/import/${lg}`],
  ["GET", "/api/auth/me"],
  ["POST", "/api/auth/act-as", { discordId: null }],
  ["GET", "/api/access"],
  ["GET", "/auth/yahoo/start"],
  ["POST", "/auth/yahoo/code", { code: "x" }],
  ["GET", "/auth/yahoo/callback?code=x"],
  ["POST", "/auth/yahoo/disconnect"],
  ["GET", "/api/does-not-exist"],
];

const origConsole = { log: console.log, warn: console.warn, error: console.error };
let admin: Who, a: Who, b: Who;
before(async () => {
  for (const k of ["log", "warn", "error"] as const) console[k] = (...x: unknown[]) => void logs.push(x.map((v) => (v instanceof Error ? `${v.stack}` : String(v))).join(" "));
  writeAccess();
  base = await listen(buildApp().app);
  admin = await signIn(ADMIN);
  a = await signIn(A);
  b = await signIn(B);
  const y = await call(admin, "POST", "/api/import", leaguePayload("yY", "555", "League Y", "Team", "1"));
  assert.equal(y.status, 200, y.text);
  const z = await call(admin, "POST", "/api/import", leaguePayload("yZ", "777", `League Z ${CANARY}`, `Z ${CANARY}`, "1"));
  assert.equal(z.status, 200, z.text);
});
after(() => {
  Object.assign(console, origConsole);
  for (const s of servers) s.close();
});

function noLeak(r: Res, what: string) {
  assert.ok(!r.text.includes(CANARY), `${what}: response leaked league Z (${r.status} ${r.text.slice(0, 160)})`);
  assert.notEqual(r.status, 200, `${what}: must not be 200 (${r.text.slice(0, 160)})`);
  assert.ok(r.status < 500, `${what}: 5xx is not a clean refusal (${r.status} ${r.text.slice(0, 160)})`);
}

// ------------------------------------------------------------------------------------------------ anonymous
describe("anonymous and forged sessions", () => {
  test("every protected route without a cookie → 401 signin (never data)", async () => {
    for (const [m, p, body] of ROUTES("yZ")) {
      const r = await call(null, m, p, body);
      assert.equal(r.status, 401, `${m} ${p} → ${r.status} ${r.text.slice(0, 120)}`);
      assert.equal(r.json.code, "signin", `${m} ${p}`);
      noLeak(r, `${m} ${p}`);
    }
    // Demo provider is not public either.
    for (const [m, p, body] of ROUTES("42", "demo")) assert.equal((await call(null, m, p, body)).status, 401, `${m} ${p}`);
  });

  test("public routes stay public; nothing else under /api is", async () => {
    assert.equal((await raw(base, "GET", "/api/import/bookmarklet.js")).status, 200);
    assert.equal((await raw(base, "GET", "/api/docs/import")).status, 200);
    // A write to a public path is not public.
    assert.equal((await call(null, "POST", "/api/import/bookmarklet.js", {})).status, 401);
    assert.equal((await call(null, "DELETE", "/api/docs/import")).status, 401);
  });

  test("path tricks without a cookie never reach a handler with data", async () => {
    const variants = [
      "/API/state", "/Api/Import", "/api/state/", "/api/state//", "/api//state", "//api/state", "///api/import/yZ",
      "/%61pi/state", "/api/%73tate", "/x/../api/state", "/api/./state", "/api/import/./yZ", "/api/import/yY/../yZ",
      "/api/import/%2e%2e/yZ", "/api/import/yZ%2F", "/api%2Fimport/yZ", "/api/import/y%5A", "/api/IMPORT/yZ/",
      "/api/import/bookmarklet.js/../yZ", "/api/docs/import/../../import/yZ", "/api/import/bookmarklet.js%2F..%2FyZ",
      "/api/access/", "/API/ACCESS", "/auth/YAHOO/start", "/auth/yahoo//start", "//auth/yahoo/start", "/auth/yahoo/start/",
      "/api/league/import/yZ/analysis/", "/api/league/IMPORT/yZ",
    ];
    for (const p of variants) {
      const r = await raw(base, "GET", p);
      noLeak(r, `anon GET ${p}`);
      assert.ok(!/playerCount|"yahooConnected"/.test(r.text), `anon GET ${p} leaked /api/state (${r.status})`);
    }
  });

  test("forged, tampered, other-secret, malformed and duplicate cookies → 401", async () => {
    const [id, sig] = a.cookie.slice("td_session=".length).split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    const { signSessionId } = await import("./sessions.js");
    const forged = [
      "td_session=",
      "td_session=abc",
      `td_session=${id}`,
      `td_session=${id}.`,
      `td_session=${flip(id)}.${sig}`,
      `td_session=${id}.${flip(sig)}`,
      `td_session=${signSessionId(id, OTHER_SECRET)}`,
      `td_session=${signSessionId("A".repeat(43), SECRET)}`, // correctly signed, but no such session
      `td_session="${id}.${flip(sig)}"`,
      `td_session=${id}.${sig}${"x".repeat(300)}`,
      `td_session=${encodeURIComponent(`${id}.${flip(sig)}`)}`,
      `TD_SESSION=${id}.${sig}`, // cookie names are case-sensitive
      `td_session=${flip(id)}.${sig}; td_session=${id}.${sig}`, // first one wins
      `td_session=${id}.${sig.slice(0, -1)}`,
      `td_session=${id}%2E${sig}x`,
    ];
    for (const cookie of forged) {
      for (const [m, p] of [["GET", "/api/auth/me"], ["GET", "/api/import/yY"], ["GET", "/api/access"]] as const) {
        const r = await raw(base, m, p, { cookie, origin: PUBLIC_URL });
        assert.equal(r.status, 401, `${cookie.slice(0, 40)}… ${p} → ${r.status}`);
      }
    }
    // Sanity: the real cookie still works.
    assert.equal((await call(a, "GET", "/api/auth/me")).status, 200);
  });

  test("a cookie from a server with another SESSION_SECRET is rejected here", async () => {
    const otherBase = await listen(buildApp({ secret: OTHER_SECRET, sessions: new SessionStore(fileIO(path.join(work, "sessions-other.json"))) }).app);
    const other = await signIn(A, otherBase);
    assert.equal((await call(other, "GET", "/api/auth/me")).status, 401);
  });

  test("an expired session → 401, and stays dead when the clock comes back", async () => {
    let skew = 0;
    const store = new SessionStore(fileIO(path.join(work, "sessions-clock.json")), () => Date.now() + skew);
    const b2 = await listen(buildApp({ sessions: store }).app);
    const w = await signIn(A, b2);
    skew = 7 * 24 * 3600 * 1000 + 1000;
    assert.equal((await call(w, "GET", "/api/auth/me", undefined, { b: b2 })).status, 401);
    skew = 0;
    assert.equal((await call(w, "GET", "/api/auth/me", undefined, { b: b2 })).status, 401, "expired row was dropped");
  });
});

// ------------------------------------------------------------------------------------------------ cross-scope
describe("user of league Y (team 4) probing league Z, other teams and admin routes", () => {
  test("every league-Z route → 403 and no league-Z data", async () => {
    for (const [m, p, body] of ROUTES("yZ")) {
      if (["/api/state", "/api/import", "/api/auth/me", "/api/does-not-exist"].includes(p) && m === "GET") continue; // signed-only routes
      if (p === "/api/auth/act-as") continue;
      const r = await call(a, m, p, body);
      noLeak(r, `A ${m} ${p}`);
      assert.equal(r.status, 403, `A ${m} ${p} → ${r.status} ${r.text.slice(0, 120)}`);
    }
    const list = await call(a, "GET", "/api/import");
    assert.equal(list.status, 200);
    assert.ok(!list.text.includes(CANARY));
    assert.deepEqual(list.json.map((x: { id: string }) => x.id), ["yY"]);
  });

  test("the Yahoo provider and the Yahoo auth routes → 403 for a user", async () => {
    for (const [m, p, body] of ROUTES("nfl.l.1405188", "yahoo")) {
      if (!p.includes("yahoo")) continue;
      const r = await call(a, m, p, body);
      assert.equal(r.status, 403, `A ${m} ${p} → ${r.status}`);
    }
    for (const p of ["/api/players/search?q=a&provider=yahoo&id=1", "/api/players/search?q=a&provider=Yahoo&id=1", "/api/league/YAHOO/1"]) {
      assert.equal((await call(a, "GET", p)).status, 403, p);
    }
  });

  test("path and encoding tricks toward league Z → refused, no data", async () => {
    const variants = [
      "/api/import/yZ/", "/api/import/yZ//", "/API/IMPORT/yZ", "/api/Import/yZ/History", "/api/import/y%5A", "/api/import/%79Z",
      "/api/import/yZ%2F", "/api/import/./yZ", "/api/import/yY/../yZ", "/api/import/yY%2F..%2FyZ", "/api/import/yY%2f..%2fyZ",
      "/api/import/%2e%2e/yZ", "/api/import/yY/%2e%2e/yZ", "//api/import/yZ", "/api//import/yZ", "/api/import//yZ",
      "/api/import/yZ;yY", "/api/import/yZ%00", "/api/import/yZ?id=yY", "/api/import/yz", "/api/import/YZ",
      "/api/league/import/yZ", "/api/league/import/y%5A/analysis", "/api/league/IMPORT/yZ", "/api/league/Import/yZ/values",
      "/api/league/import/yY/../yZ/values", "/api/league/import/yY%2F..%2FyZ/values",
      "/api/league/import/yZ/values/", "/api/league//import/yZ", "/api/players/search?q=a&provider=import&id=yZ",
      "/api/players/search?q=a&provider=Import&id=yZ", "/api/players/search?q=a&provider=import&id=yY&id=yZ",
      "/api/players/search?q=a&provider=import&id[]=yZ", "/api/players/search?q=a&provider[]=import&id=yZ",
      "/api/players/search?q=a&provider=import&id=yZ%00", "/api/players/search?q=a&provider=import",
      "/api/import/yZ/changes?team=4", "/api/access?as=admin",
    ];
    for (const p of variants) {
      const r = await call(a, "GET", p);
      noLeak(r, `A GET ${p}`);
    }
  });

  test("team param tricks on the user's own league → 403 (team), never another team", async () => {
    const base4 = "/api/league/import/yY/values";
    for (const q of ["team=7", "team=4&team=7", "team=7&team=4", "team[]=4", "team[0]=4", "team[a]=4", "team=%37", "team=4%00", "team=%204", "team=4%20", "team=04", "team=1"]) {
      const r = await call(a, "GET", `${base4}?${q}`);
      assert.equal(r.status, 403, `?${q} → ${r.status} ${r.text.slice(0, 100)}`);
      assert.equal(r.json.code, "team", `?${q}`);
    }
    // Body team on the POST route, also as array/object, also hidden behind an empty query param.
    for (const body of [{ team: "7", partner: "1" }, { team: ["4"], partner: "1" }, { team: { x: "4" }, partner: "1" }, { team: 7, partner: "1" }]) {
      const r = await call(a, "POST", "/api/league/import/yY/trade/evaluate", body);
      assert.equal(r.status, 403, `${JSON.stringify(body)} → ${r.status}`);
    }
    const hidden = await call(a, "POST", "/api/league/import/yY/trade/evaluate?team=", { team: "7", partner: "1" });
    assert.equal(hidden.status, 403, "empty ?team= must not hide body.team");
  });

  test("admin-only routes → 403 for a user", async () => {
    for (const [m, p, body] of [
      ["GET", "/api/access"],
      ["GET", "/api/access/"],
      ["GET", "/API/Access"],
      ["POST", "/api/auth/act-as", { discordId: B }],
      ["POST", "/api/auth/ACT-AS/", { discordId: null }],
      ["PUT", "/api/import/yY/settings", { name: "pwned" }],
      ["PUT", "/api/import/yY/settings/", { name: "pwned" }],
      ["PUT", "/api/import/yY/SETTINGS", { name: "pwned" }],
      ["PUT", "/api/import/yY//settings", { name: "pwned" }],
      ["DELETE", "/api/import/yY"],
      ["DELETE", "/api/import/yY/"],
      ["DELETE", "/API/import/yY"],
      ["DELETE", "/api/import//yY"],
      ["GET", "/api/yahoo/leagues"],
      ["GET", "/api/YAHOO/leagues/"],
    ] as [string, string, unknown?][]) {
      const r = await call(a, m, p, body);
      assert.ok(r.status === 403 || r.status === 404, `A ${m} ${p} → ${r.status} ${r.text.slice(0, 120)}`);
    }
    const y = await call(admin, "GET", "/api/import/yY");
    assert.equal(y.status, 200, "league Y still exists");
    assert.equal(y.json.name, "League Y", "league Y not renamed");
  });

  test("method override headers / params do not turn a POST into a DELETE or PUT", async () => {
    for (const hdr of ["x-http-method-override", "x-http-method", "x-method-override"]) {
      const r = await call(a, "POST", "/api/import/yY", undefined, { headers: { [hdr]: "DELETE" } });
      assert.ok(r.status === 404 || r.status === 403, `${hdr} → ${r.status}`);
      const s = await call(a, "POST", "/api/import/yY/settings", { name: "pwned" }, { headers: { [hdr]: "PUT" } });
      assert.ok(s.status === 404 || s.status === 403, `${hdr} PUT → ${s.status}`);
    }
    assert.ok([403, 404].includes((await call(a, "POST", "/api/import/yY?_method=DELETE")).status));
    const y = await call(admin, "GET", "/api/import/yY");
    assert.equal(y.status, 200);
    assert.equal(y.json.name, "League Y");
  });

  test("access-list removal mid-session: every route → 403 not_allowed; restore → back", async () => {
    const c = await signIn(C);
    assert.equal((await call(c, "GET", "/api/import/yZ")).status, 200);
    writeAccess(defaultUsers().filter((u) => u.discordId !== C));
    try {
      for (const [m, p, body] of ROUTES("yZ")) {
        const r = await call(c, m, p, body);
        assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
        assert.equal(r.json.code, "not_allowed", `${m} ${p}`);
        noLeak(r, `removed C ${m} ${p}`);
      }
    } finally {
      writeAccess();
    }
    assert.equal((await call(c, "GET", "/api/import/yZ")).status, 200);
  });

  test("moving a user to another league in access.json moves their scope at once", async () => {
    const c = await signIn(C);
    writeAccess(defaultUsers().map((u) => (u.discordId === C ? { ...u, leagueId: "yY", teamId: "1" } : u)));
    try {
      noLeak(await call(c, "GET", "/api/import/yZ"), "moved C → yZ");
      assert.equal((await call(c, "GET", "/api/import/yY")).status, 200);
    } finally {
      writeAccess();
    }
  });
});

// ------------------------------------------------------------------------------------------------ act-as
describe("admin acting as a user", () => {
  test("scope is exactly the user's: other league, admin-only and Yahoo routes → 403", async () => {
    const r = await call(admin, "POST", "/api/auth/act-as", { discordId: A });
    assert.equal(r.status, 200, r.text);
    try {
      for (const [m, p, body] of ROUTES("yZ")) {
        if (["/api/state", "/api/import", "/api/auth/me", "/api/does-not-exist", "/api/auth/act-as", "/api/access"].includes(p) && m !== "POST") continue;
        if (p === "/api/auth/act-as") continue;
        if (m === "POST" && p === "/api/import") continue; // checked below
        const x = await call(admin, m, p, body);
        noLeak(x, `admin-as-A ${m} ${p}`);
        assert.equal(x.status, 403, `admin-as-A ${m} ${p} → ${x.status}`);
      }
      for (const [m, p, body] of [
        ["DELETE", "/api/import/yY"],
        ["PUT", "/api/import/yY/settings", { name: "x" }],
        ["GET", "/api/yahoo/leagues"],
        ["GET", "/auth/yahoo/start"],
        ["POST", "/auth/yahoo/disconnect"],
        ["GET", "/api/league/import/yY/values?team=7"],
        ["POST", "/api/import", leaguePayload("yZ", "777", "x", "x", "1")],
      ] as [string, string, unknown?][]) {
        const x = await call(admin, m, p, body);
        assert.equal(x.status, 403, `admin-as-A ${m} ${p} → ${x.status}`);
      }
      const list = await call(admin, "GET", "/api/import");
      assert.deepEqual(list.json.map((x: { id: string }) => x.id), ["yY"]);
      // Design: the real admin keeps the picker (realAdmin), so /api/access still answers while acting.
      assert.equal((await call(admin, "GET", "/api/access")).status, 200);
    } finally {
      await call(admin, "POST", "/api/auth/act-as", { discordId: null });
    }
    assert.equal((await call(admin, "GET", "/api/import/yZ")).status, 200, "back to admin");
  });

  test("act-as input validation: unknown, admin, stranger, array, object, number → 400; user cannot", async () => {
    for (const discordId of [STRANGER, ADMIN, [A], { id: A }, 200000000000000002, "", ` ${A}`, `${A} `]) {
      const r = await call(admin, "POST", "/api/auth/act-as", { discordId });
      assert.equal(r.status, 400, `${JSON.stringify(discordId)} → ${r.status}`);
    }
    assert.equal((await call(b, "POST", "/api/auth/act-as", { discordId: A })).status, 403);
    assert.equal((await call(b, "POST", "/api/auth/act-as", { discordId: null })).status, 403);
    // A text/plain body never reaches the handler as JSON.
    const t = await raw(base, "POST", "/api/auth/act-as", { cookie: admin.cookie, origin: PUBLIC_URL, "x-csrf-token": admin.csrf, "content-type": "text/plain" }, JSON.stringify({ discordId: A }));
    assert.equal(t.status, 400);
    assert.equal((await call(admin, "GET", "/api/auth/me")).json.actingAs, null);
  });

  test("an admin removed from access.json while acting as a user loses everything", async () => {
    const adm2 = await signIn(ADMIN);
    await call(adm2, "POST", "/api/auth/act-as", { discordId: A });
    writeAccess(defaultUsers(), []);
    try {
      for (const p of ["/api/import/yY", "/api/auth/me", "/api/access"]) {
        const r = await call(adm2, "GET", p);
        assert.equal(r.status, 403, p);
        assert.equal(r.json.code, "not_allowed", p);
      }
    } finally {
      writeAccess();
      await call(adm2, "POST", "/api/auth/act-as", { discordId: null });
    }
  });
});

// ------------------------------------------------------------------------------------------------ writes
describe("write protection: Origin and CSRF", () => {
  // A cheap write every signed-in user may make: POST /api/import of their own league, here as admin act-as reset.
  const write = (who: Who, opts: Parameters<typeof call>[4]) => call(who, "POST", "/api/auth/act-as", { discordId: null }, opts);

  test("bad Origin → 403 bad_origin", async () => {
    for (const origin of [
      null, "", "null", "https://evil.example", "https://ff.example.evil.com", "https://evil.com/ff.example", "http://ff.example",
      "https://ff.example:8443", "https://ff.example.", "https://xff.example", "https://ff.example/x", "https://ff.example\\",
      "https://ff.example, https://evil.example", "https://evil.example, https://ff.example",
    ]) {
      const r = await write(admin, { origin });
      assert.equal(r.status, 403, `origin ${JSON.stringify(origin)} → ${r.status}`);
      assert.equal(r.json.code, "bad_origin", `origin ${JSON.stringify(origin)}`);
    }
    // Two Origin headers on the wire.
    const two = await raw(base, "POST", "/api/auth/act-as", { cookie: admin.cookie, "x-csrf-token": admin.csrf, origin: ["https://evil.example", PUBLIC_URL], "content-type": "application/json" }, JSON.stringify({ discordId: null }));
    assert.equal(two.status, 403, "duplicate Origin headers");
    // Referer alone is not an Origin.
    const ref = await raw(base, "POST", "/api/auth/act-as", { cookie: admin.cookie, "x-csrf-token": admin.csrf, referer: `${PUBLIC_URL}/`, "content-type": "application/json" }, JSON.stringify({ discordId: null }));
    assert.equal(ref.status, 403, "Referer without Origin");
  });

  test("bad CSRF → 403 csrf (missing, empty, wrong, another session's, in query/body, duplicated)", async () => {
    const cases: [string, Parameters<typeof call>[4]][] = [
      ["missing", { csrf: null }],
      ["empty", { csrf: "" }],
      ["wrong", { csrf: "x".repeat(32) }],
      ["other session (user B)", { csrf: b.csrf }],
      ["other session (user A)", { csrf: a.csrf }],
      ["dev-mode token", { csrf: "dev-mode" }],
      ["prefix", { csrf: admin.csrf.slice(0, -1) }],
      ["duplicated header", { csrf: null, headers: { "x-csrf-token": [admin.csrf, admin.csrf] } }],
    ];
    for (const [what, opts] of cases) {
      const r = await write(admin, opts);
      assert.equal(r.status, 403, `${what} → ${r.status}`);
      assert.equal(r.json.code, "csrf", what);
    }
    assert.equal((await call(admin, "POST", `/api/auth/act-as?csrf=${admin.csrf}&x-csrf-token=${admin.csrf}`, { discordId: null }, { csrf: null })).status, 403, "token in query");
    assert.equal((await call(admin, "POST", "/api/auth/act-as", { discordId: null, csrf: admin.csrf, "x-csrf-token": admin.csrf }, { csrf: null })).status, 403, "token in body");
    // Sanity: the right token + origin works; Origin case and trailing slash are normalised by design.
    assert.equal((await write(admin, {})).status, 200);
    assert.equal((await write(admin, { origin: "https://FF.example/" })).status, 200);
  });

  test("every write route refuses a missing Origin or CSRF before doing anything (as admin)", async () => {
    for (const [m, p, body] of ROUTES("yY")) {
      if (m === "GET") continue;
      const noOrigin = await call(admin, m, p, body, { origin: null });
      assert.equal(noOrigin.status, 403, `no origin ${m} ${p} → ${noOrigin.status}`);
      const noCsrf = await call(admin, m, p, body, { csrf: null });
      assert.equal(noCsrf.status, 403, `no csrf ${m} ${p} → ${noCsrf.status}`);
    }
    // Unusual methods are writes too.
    for (const m of ["PATCH", "PURGE", "PROPFIND"]) {
      const r = await call(admin, m, "/api/import/yY", undefined, { csrf: null });
      assert.equal(r.status, 403, `${m} without csrf → ${r.status}`);
    }
    assert.equal((await call(admin, "GET", "/api/import/yY")).status, 200, "league Y untouched");
  });

  test("logout needs the site's Origin (no cross-site logout)", async () => {
    const w = await signIn(B);
    for (const origin of [null, "null", "https://evil.example"]) {
      assert.equal((await call(w, "POST", "/auth/logout", undefined, { origin })).status, 403, String(origin));
    }
    assert.equal((await call(w, "GET", "/api/auth/me")).status, 200);
  });

  test("content-type tricks and oversized bodies never write", async () => {
    const before = (await call(admin, "GET", "/api/import/yY")).json;
    const plain = await raw(base, "POST", "/api/import", { cookie: a.cookie, origin: PUBLIC_URL, "x-csrf-token": a.csrf, "content-type": "text/plain" }, JSON.stringify(leaguePayload("yZ", "777", "pwned", "pwned", "1")));
    assert.notEqual(plain.status, 200, `text/plain import → ${plain.status}`);
    const form = await raw(base, "POST", "/api/import", { cookie: a.cookie, origin: PUBLIC_URL, "x-csrf-token": a.csrf, "content-type": "application/x-www-form-urlencoded" }, "id=yZ&name=pwned");
    assert.notEqual(form.status, 200, `form import → ${form.status}`);
    const big = JSON.stringify({ ...leaguePayload("yY", "555", "League Y", "Team", "4"), pad: "x".repeat(1_200_000) });
    const huge = await raw(base, "POST", "/api/import", { cookie: a.cookie, origin: PUBLIC_URL, "x-csrf-token": a.csrf, "content-type": "application/json" }, big);
    assert.equal(huge.status, 413, `oversized → ${huge.status}`);
    const anonHuge = await raw(base, "POST", "/api/import", { "content-type": "application/json" }, big);
    assert.ok(anonHuge.status === 413 || anonHuge.status === 401, `anon oversized → ${anonHuge.status}`);
    const after = (await call(admin, "GET", "/api/import/yY")).json;
    assert.equal(after.name, before.name);
    assert.equal((await call(admin, "GET", "/api/import/yZ")).json.name, `League Z ${CANARY}`);
  });
});

// ------------------------------------------------------------------------------------------------ import
describe("import scoping (user A of league Y)", () => {
  test("payloads aimed at another league → 403 and nothing written", async () => {
    const payloads: [string, unknown][] = [
      ["id yZ", leaguePayload("yZ", "777", "pwned", "pwned", "1")],
      ["id yY but league Z's Yahoo leagueId", leaguePayload("yY", "777", "pwned", "pwned", "1")],
      ["no id, league Z's leagueId", { ...leaguePayload("yY", "777", "pwned", "pwned", "1"), id: undefined }],
      ["invalid id (falls back to a generated id)", { ...leaguePayload("yY!", "123", "pwned", "pwned", "1") }],
      ["id with path", leaguePayload("yY/../yZ", "777", "pwned", "pwned", "1")],
      ["id array", { ...leaguePayload("yY", "777", "pwned", "pwned", "1"), id: ["yY"] }],
      ["paste without id", { text: "Patrick Mahomes KC - QB", teamName: "x" }],
      ["paste into league Z", { text: "Patrick Mahomes KC - QB", teamName: "x", id: "yZ" }],
      ["paste with two teams into own league", { text: "=== Team A ===\nPatrick Mahomes KC - QB\n=== Team B ===\nJosh Allen BUF - QB", teamName: "x", id: "yY" }],
    ];
    for (const [what, body] of payloads) {
      const r = await call(a, "POST", "/api/import", body);
      assert.ok(r.status === 403 || r.status === 400, `${what} → ${r.status} ${r.text.slice(0, 120)}`);
    }
    const z = await call(admin, "GET", "/api/import/yZ");
    assert.equal(z.json.name, `League Z ${CANARY}`, "league Z untouched");
    assert.deepEqual((await call(admin, "GET", "/api/import")).json.map((x: { id: string }) => x.id).sort(), ["yY", "yZ"], "no new league created");
  });

  test("re-import of the user's own league never writes myTeamId", async () => {
    const before = (await call(admin, "GET", "/api/import/yY")).json;
    const r = await call(a, "POST", "/api/import", leaguePayload("yY", "555", "League Y", "Team", "4"));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.myTeamId, "4");
    assert.equal((await call(admin, "GET", "/api/import/yY")).json.myTeamId, before.myTeamId);
  });

  test("re-import by a user must not change admin-only league settings (scoring/slots/name)", async () => {
    const before = (await call(admin, "GET", "/api/import/yY")).json;
    const forged = {
      ...leaguePayload("yY", "555", "League Y (renamed by a user)", "Team", "4"),
      settingsSource: "page",
      scoring: { rec: 10, passTd: 50, rushTd: 0 },
      slots: ["QB", "QB", "QB", "BN"],
      finalWeek: 3,
      regularSeasonEnd: 1,
    };
    const r = await call(a, "POST", "/api/import", forged);
    assert.equal(r.status, 200, r.text);
    const after = (await call(admin, "GET", "/api/import/yY")).json;
    try {
      assert.deepEqual(after.scoring, before.scoring, "scoring changed by a non-admin re-import");
      assert.deepEqual(after.slots, before.slots, "slots changed by a non-admin re-import");
      assert.equal(after.finalWeek, before.finalWeek, "finalWeek changed by a non-admin re-import");
      assert.equal(after.name, before.name, "league renamed by a non-admin re-import");
    } finally {
      // Restore for later tests.
      await call(admin, "PUT", "/api/import/yY/settings", { name: before.name, scoring: before.scoring, slots: before.slots, finalWeek: before.finalWeek, regularSeasonEnd: before.regularSeasonEnd });
    }
  });

  test("history/changes/detail of another league → 403, own → 200", async () => {
    for (const p of ["/api/import/yZ/history", "/api/import/yZ/changes", "/api/import/yZ", "/api/import/yZ/history/", "/api/import/y%5A/changes"]) {
      noLeak(await call(a, "GET", p), `A GET ${p}`);
      noLeak(await call(b, "GET", p), `B GET ${p}`);
    }
    for (const p of ["/api/import/yY/history", "/api/import/yY/changes", "/api/import/yY"]) assert.equal((await call(a, "GET", p)).status, 200, p);
  });

  test("DESIGN NOTE (passes; documents scope): a user's paste into their own league can rewrite another manager's team", async () => {
    // Spec allows a user to re-import their own league, so user A can overwrite user B's (team 7) roster. Documented
    // here so a future decision to restrict it has a test to flip.
    const r = await call(a, "POST", "/api/import", { text: "Patrick Mahomes KC - QB", teamName: "Team 7", id: "yY" });
    assert.equal(r.status, 200, r.text);
    const y = (await call(admin, "GET", "/api/import/yY")).json;
    const t7 = y.teams.find((t: { id: string }) => t.id === "7");
    assert.ok(t7, "team 7 still exists");
  });
});

// ------------------------------------------------------------------------------------------------ OAuth
describe("OAuth callback hardening", () => {
  test("tampered next never redirects off-site", async () => {
    const bad = [
      "//evil.com", "/\\evil.com", "\\/evil.com", "%2F%2Fevil.com", "/%2F%2Fevil.com", "/%5Cevil.com", "javascript:alert(1)", "/javascript:alert(1)",
      "https://evil.com", "http:evil.com", "/\r\nSet-Cookie: td_session=x", "/%0d%0aSet-Cookie:%20x=y", "/\t/evil.com", "/ /evil.com",
      "/ evil", "///evil.com", "/.//evil.com", "/..//evil.com", "/x/..//evil.com", "/@evil.com", "/%09/evil.com", `/${"a".repeat(600)}`,
    ];
    for (const next of bad) {
      const { state, stateCookie } = await startLogin(base, next);
      const r = await callback(base, `code-${A}-n${++codeSeq}`, state, stateCookie);
      assert.equal(r.status, 302, `${JSON.stringify(next)} → ${r.status}`);
      const loc = String(r.headers.location);
      assert.ok(!/[\r\n]/.test(loc), `CRLF in Location for ${JSON.stringify(next)}`);
      const resolved = new URL(loc, PUBLIC_URL);
      assert.equal(resolved.origin, PUBLIC_URL, `${JSON.stringify(next)} → Location ${loc}`);
      assert.ok(!setCookies(r).some((c) => c.startsWith("x=")), "no injected cookie");
    }
  });

  test("callback error / missing / array params → 4xx, no session", async () => {
    const { state, stateCookie } = await startLogin(base);
    const qs = [
      `error=access_denied&state=${encodeURIComponent(state)}`,
      `error=access_denied&code=code-${A}-e1&state=${encodeURIComponent(state)}`,
      `error[]=x&code=code-${A}-e2&state=${encodeURIComponent(state)}`,
      `code=code-${A}-e3&code=code-${A}-e4&state=${encodeURIComponent(state)}`,
      `code=code-${A}-e5&state=${encodeURIComponent(state)}&state=${encodeURIComponent(state)}`,
      `code=code-${A}-e6`,
      `state=${encodeURIComponent(state)}`,
      `code=code-${A}-e7&state=${encodeURIComponent(state + "x".repeat(2100))}`,
    ];
    for (const q of qs) {
      const r = await raw(base, "GET", `/auth/callback?${q}`, { cookie: stateCookie });
      assert.ok(r.status >= 400 && r.status < 500, `${q.slice(0, 60)} → ${r.status}`);
      assert.equal(cookieOf(r, "td_session"), undefined, q.slice(0, 60));
    }
  });

  test("state signed with another secret (both URL and cookie) → 400", async () => {
    const { signState } = await import("./sessions.js");
    const st = signState("/", OTHER_SECRET);
    const r = await callback(base, `code-${A}-os`, st, `td_oauth_state=${st}`);
    assert.equal(r.status, 400);
    assert.equal(cookieOf(r, "td_session"), undefined);
  });

  test("state from another browser (cookie mismatch) → 400 even with a valid code", async () => {
    const mine = await startLogin(base);
    const theirs = await startLogin(base);
    const r = await callback(base, `code-${A}-x1`, theirs.state, mine.stateCookie);
    assert.equal(r.status, 400);
    assert.equal(cookieOf(r, "td_session"), undefined);
  });

  test("replaying a completed callback (same code) → no second session", async () => {
    const { state, stateCookie } = await startLogin(base);
    const code = `code-${A}-replay`;
    const first = await callback(base, code, state, stateCookie);
    assert.equal(first.status, 302);
    const again = await callback(base, code, state, stateCookie);
    assert.equal(cookieOf(again, "td_session"), undefined, "replayed code must not mint a session");
  });

  test("INFO: a used state is not single-use server-side (relies on Discord's single-use code)", async () => {
    const { state, stateCookie } = await startLogin(base);
    assert.equal((await callback(base, `code-${A}-s1`, state, stateCookie)).status, 302);
    const r = await callback(base, `code-${A}-s2`, state, stateCookie);
    // Documented, not asserted as a failure: the server keeps no nonce store (perp reference doesn't either).
    assert.ok(r.status === 302 || r.status === 400);
  });

  test("Discord failures (timeout, network error, non-200, garbage JSON, bad ids) → 502, no session, no secret in output", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const isToken = url.endsWith("/oauth2/token");
      const body = isToken ? new URLSearchParams(String(init.body)) : null;
      const code = body?.get("code") ?? (init.headers as Record<string, string>).Authorization.slice("Bearer tok-".length);
      seen.push(code);
      const kind = code.split(":")[0];
      if (isToken) {
        if (kind === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        if (kind === "neterr") throw new TypeError(`fetch failed for code ${code} secret ${CLIENT_SECRET}`);
        if (kind === "500") return new Response("oops", { status: 500 });
        if (kind === "garbage") return new Response("<html>not json", { status: 200 });
        if (kind === "notoken") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 200 });
        if (kind === "numtoken") return new Response(JSON.stringify({ access_token: 12345 }), { status: 200 });
        return new Response(JSON.stringify({ access_token: `tok-${code}` }), { status: 200 });
      }
      const idByKind: Record<string, unknown> = {
        nonnum: "abc",
        short: "1234",
        long: "1".repeat(30),
        numeric: Number(A),
        newline: `${A}\n`,
        space: ` ${A}`,
        plus: `+${A}`,
        unicode: "２００００００００００００００００２",
        adminarr: [ADMIN],
      };
      if (kind === "megarbage") return new Response("{{{", { status: 200 });
      if (kind === "me401") return new Response("no", { status: 401 });
      if (kind === "metimeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (kind === "ok") return new Response(JSON.stringify({ id: code.split(":")[1], username: "u", avatar: null }), { status: 200 });
      return new Response(JSON.stringify({ id: idByKind[kind] ?? A, username: "u", avatar: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const b3 = await listen(buildApp({ discord: discordClient("cid", CLIENT_SECRET, fakeFetch), sessions: new SessionStore(fileIO(path.join(work, "sessions-discord.json"))) }).app);
    const before = logs.length;
    for (const kind of ["timeout", "neterr", "500", "garbage", "notoken", "numtoken", "megarbage", "me401", "metimeout", "nonnum", "short", "long", "numeric", "newline", "space", "plus", "unicode", "adminarr"]) {
      const { state, stateCookie } = await startLogin(b3);
      const r = await callback(b3, `${kind}:secretcode${kind}`, state, stateCookie);
      assert.equal(r.status, 502, `${kind} → ${r.status} ${r.text.slice(0, 80)}`);
      assert.equal(cookieOf(r, "td_session"), undefined, kind);
      assert.ok(!r.text.includes(CLIENT_SECRET) && !r.text.includes("secretcode"), `${kind}: response leaks secret/code`);
    }
    const out = logs.slice(before).join("\n");
    assert.ok(!out.includes(CLIENT_SECRET), "client secret in logs");
    assert.ok(!out.includes("secretcode"), "OAuth code in logs");
    // Not allowlisted with a well-formed id → refused redirect.
    const { state, stateCookie } = await startLogin(b3);
    const r = await raw(b3, "GET", `/auth/callback?code=ok:${STRANGER}&state=${encodeURIComponent(state)}`, { cookie: stateCookie });
    assert.ok(r.status === 302 || r.status === 502);
    assert.equal(cookieOf(r, "td_session"), undefined);
  });

  test("safeNext unit: the obvious open-redirect shapes collapse to /", () => {
    for (const p of ["//evil", "/\\evil", "\\evil", "https://evil", "/\nx", "/\x7f", "", "evil"]) assert.equal(safeNext(p), "/", JSON.stringify(p));
  });
});

// ------------------------------------------------------------------------------------------------ sessions
describe("sessions: logout, restart, failing storage", () => {
  test("logout then reuse the cookie → 401 (also after a restart)", async () => {
    const io = fileIO(path.join(work, "sessions-logout.json"));
    const b4 = await listen(buildApp({ sessions: new SessionStore(io) }).app);
    const w = await signIn(A, b4);
    assert.equal((await call(w, "POST", "/auth/logout", undefined, { b: b4 })).status, 200);
    assert.equal((await call(w, "GET", "/api/auth/me", undefined, { b: b4 })).status, 401);
    const store2 = new SessionStore(io);
    await store2.load();
    const b5 = await listen(buildApp({ sessions: store2 }).app);
    assert.equal((await call(w, "GET", "/api/auth/me", undefined, { b: b5 })).status, 401, "revoked session resurrected after restart");
  });

  test("logout of a user already removed from access.json still revokes the session", async () => {
    const io = fileIO(path.join(work, "sessions-removed.json"));
    const b6 = await listen(buildApp({ sessions: new SessionStore(io) }).app);
    const w = await signIn(B, b6);
    writeAccess(defaultUsers().filter((u) => u.discordId !== B));
    try {
      assert.equal((await call(w, "POST", "/auth/logout", undefined, { b: b6 })).status, 200);
    } finally {
      writeAccess();
    }
    assert.equal((await call(w, "GET", "/api/auth/me", undefined, { b: b6 })).status, 401, "re-listing must not revive a logged-out session");
  });

  test("sessions survive a restart (load from storage)", async () => {
    const store2 = new SessionStore(mainIO);
    await store2.load();
    const b7 = await listen(buildApp({ sessions: store2 }).app);
    assert.equal((await call(a, "GET", "/api/auth/me", undefined, { b: b7 })).json.id, A);
  });

  test("unwritable session storage: sign-in fails closed (5xx, no cookie, no secrets in body)", async () => {
    const io = fileIO(path.join(work, "sessions-ro.json"));
    io.failWrites = true;
    const b8 = await listen(buildApp({ sessions: new SessionStore(io) }).app);
    const { state, stateCookie } = await startLogin(b8);
    const code = `code-${A}-ro`;
    const r = await callback(b8, code, state, stateCookie);
    assert.ok(r.status >= 500, `→ ${r.status}`);
    assert.equal(cookieOf(r, "td_session"), undefined);
    for (const s of [code, state, SECRET, CLIENT_SECRET]) assert.ok(!r.text.includes(s), "5xx body leaks a secret");
  });

  test("logout while session storage is unwritable must not leave a session that a restart revives", async () => {
    const io = fileIO(path.join(work, "sessions-ro2.json"));
    const store9 = new SessionStore(io);
    const b9 = await listen(buildApp({ sessions: store9 }).app);
    const w = await signIn(A, b9);
    io.failWrites = true;
    const out = await call(w, "POST", "/auth/logout", undefined, { b: b9 });
    assert.equal(out.status, 503, "a logout that could not be saved says so");
    assert.ok(setCookies(out as Res).some((c) => /^td_session=;/.test(c)), "the cookie is cleared anyway");
    io.failWrites = false;
    assert.equal(await store9.flush(), true, "the pending write lands once storage works (the store retries it)");
    const store2 = new SessionStore(io);
    await store2.load();
    const b10 = await listen(buildApp({ sessions: store2 }).app);
    const after = await call(w, "GET", "/api/auth/me", undefined, { b: b10 });
    assert.equal(after.status, 401, `logout answered ${out.status}; after a restart the "logged out" cookie is ${after.status === 200 ? "valid again" : after.status}`);
  });

  test("corrupt session storage loads as zero sessions (everyone signs in again)", async () => {
    const { hashId } = await import("./sessions.js");
    const validKey = hashId("x".repeat(43));
    const cases: unknown[] = [
      "garbage",
      [1, 2],
      42,
      null,
      { [validKey]: { uid: A, name: "x", avatar: null, csrf: "short", createdMs: 0, expiresMs: Date.now() + 1e9 } },
      { [validKey]: { uid: A, name: "x", avatar: null, csrf: "c".repeat(32), createdMs: 0, expiresMs: "never" } },
      { [validKey]: { uid: A, name: "x", avatar: null, csrf: "c".repeat(32), createdMs: 0, expiresMs: Date.now() - 1 } },
      { "not-a-hash": { uid: A, name: "x", avatar: null, csrf: "c".repeat(32), createdMs: 0, expiresMs: Date.now() + 1e9 } },
      { __proto__: { uid: A }, [validKey]: { uid: 5, name: "x", avatar: null, csrf: "c".repeat(32), createdMs: 0, expiresMs: Date.now() + 1e9 } },
    ];
    for (const c of cases) {
      const s = new SessionStore({ read: async () => c, write: async () => undefined });
      await s.load();
      assert.equal(s.size, 0, JSON.stringify(c));
    }
    const throwing = new SessionStore({ read: async () => Promise.reject(new Error("EIO")), write: async () => undefined });
    await assert.rejects(() => throwing.load(), "a read error must surface (start-up fails) rather than silently open");
  });
});

// ------------------------------------------------------------------------------------------------ access.json
describe("access.json missing / corrupt → nobody", () => {
  const bad: [string, () => void][] = [
    ["missing", () => fs.rmSync(accessFile, { force: true })],
    ["empty file", () => writeAccessRaw("")],
    ["not JSON", () => writeAccessRaw("{admins:")],
    ["{}", () => writeAccessRaw("{}")],
    ["[]", () => writeAccessRaw("[]")],
    ["null", () => writeAccessRaw("null")],
    ["admins string", () => writeAccess(defaultUsers(), ADMIN)],
    ["admins object", () => writeAccess(defaultUsers(), { 0: ADMIN, length: 1 })],
    ["admins numbers", () => writeAccess([], [Number(ADMIN)])],
    ["users string", () => writeAccessRaw(JSON.stringify({ admins: [], users: A }))],
    ["users bad rows", () => writeAccessRaw(JSON.stringify({ admins: [], users: [{ discordId: Number(A), leagueId: "yY", teamId: "4" }, { discordId: A, leagueId: "../yZ", teamId: "4" }, { discordId: A, leagueId: "yY", teamId: ["4"] }] }))],
    ["directory", () => {
      fs.rmSync(accessFile, { force: true });
      fs.mkdirSync(accessFile);
    }],
    ["unreadable (chmod 000)", () => {
      writeAccess();
      fs.chmodSync(accessFile, 0o000);
      touch(accessFile);
    }],
  ];
  test("existing sessions → 403 not_allowed; new sign-ins → refused", async () => {
    const adm = await signIn(ADMIN);
    const usr = await signIn(A);
    try {
      for (const [what, setup] of bad) {
        setup();
        // chmod 000 doesn't stop root; skip that case when running as root.
        if (what.startsWith("unreadable") && process.getuid?.() === 0) continue;
        for (const [who, uid] of [[adm, ADMIN], [usr, A]] as const) {
          const r = await call(who, "GET", "/api/import");
          assert.equal(r.status, 403, `${what}: ${uid === ADMIN ? "admin" : "user"} → ${r.status}`);
          assert.equal(r.json.code, "not_allowed", what);
        }
        const { state, stateCookie } = await startLogin(base);
        const r = await callback(base, `code-${ADMIN}-acc${++codeSeq}`, state, stateCookie);
        assert.equal(cookieOf(r, "td_session"), undefined, `${what}: sign-in minted a session`);
      }
    } finally {
      try {
        fs.chmodSync(accessFile, 0o644);
      } catch {
        /* ignore */
      }
      writeAccess();
    }
    assert.equal((await call(adm, "GET", "/api/import")).status, 200, "restored list works again");
  });
});

// ------------------------------------------------------------------------------------------------ rate limit
describe("sign-in rate limit key", () => {
  const fakeReq = (peer: string, cf?: string) => ({ socket: { remoteAddress: peer }, headers: cf === undefined ? {} : { "cf-connecting-ip": cf } }) as unknown as Parameters<typeof clientKey>[0];
  test("CF-Connecting-IP from a non-loopback peer never chooses the bucket", () => {
    for (const peer of ["10.0.0.5", "192.168.1.2", "127.0.0.2", "::ffff:10.0.0.5", "fe80::1", "0.0.0.0", "localhost"]) {
      assert.equal(clientKey(fakeReq(peer, "1.2.3.4")), `peer:${peer}`, peer);
    }
  });
  test("loopback peer (cloudflared) uses CF-Connecting-IP; missing header → the peer", () => {
    assert.equal(clientKey(fakeReq("127.0.0.1", "1.2.3.4")), "cf:1.2.3.4");
    assert.equal(clientKey(fakeReq("::1", "")), "peer:::1");
  });
  test("31st sign-in attempt from one non-loopback client in a minute → 429 even with rotating CF headers", async () => {
    // Over HTTP the peer is loopback, so rotate peers via the exported key function instead: simulate via a fresh limiter.
    const { signInLimiter } = await import("./routes.js");
    const allow = signInLimiter(() => 0);
    let ok = 0;
    for (let i = 0; i < 40; i++) if (allow(clientKey(fakeReq("10.9.9.9", `6.6.6.${i}`)))) ok++;
    assert.equal(ok, 30);
  });
});

// ------------------------------------------------------------------------------------------------ dev mode
describe("dev mode (no Discord config, non-production)", () => {
  test("DOCUMENTS: every request is a built-in admin with no cookie, no Origin, no CSRF", async () => {
    const bd = await listen(buildApp({ mode: "dev" }).app);
    const r = await raw(bd, "GET", "/api/import/yZ");
    assert.equal(r.status, 200, "dev mode serves every league to anyone — must never run outside a laptop");
    const w = await raw(bd, "POST", "/api/auth/act-as", { "content-type": "application/json", origin: "https://evil.example" }, JSON.stringify({ discordId: null }));
    assert.equal(w.status, 200);
  });
});

// ------------------------------------------------------------------------------------------------ logs
describe("log hygiene", () => {
  test("no client secret, session secret, code, state, cookie, raw session id or csrf in any captured output", async () => {
    // Run one more of each flow so the log is populated.
    const { state, stateCookie } = await startLogin(base, "/#x");
    const code = `code-${A}-logcheck`;
    const r = await callback(base, code, state, stateCookie);
    const cookie = cookieOf(r, "td_session")!;
    const rawId = cookie.slice("td_session=".length).split(".")[0];
    await raw(base, "GET", `/auth/callback?code=code-${STRANGER}-lc&state=${encodeURIComponent(state)}`, { cookie: stateCookie });
    await call(admin, "GET", "/auth/yahoo/callback?code=yahoo-oauth-code-SECRET123");
    await call(admin, "POST", "/auth/yahoo/code", { code: "yahoo-paste-code-SECRET456" });
    await call(a, "PUT", "/api/import/yY/settings", { name: "x" }, { csrf: "wrong-csrf-SECRET789" });
    await call(a, "GET", `/api/import/yZ?token=${a.csrf}`);
    const all = logs.join("\n");
    assert.ok(all.includes("event=login"), "login events logged");
    for (const s of [SECRET, CLIENT_SECRET, code, state, stateCookie.split("=")[1], cookie.split("=")[1], rawId, a.csrf, b.csrf, admin.csrf, a.cookie.split("=")[1], "yahoo-oauth-code-SECRET123", "yahoo-paste-code-SECRET456", "wrong-csrf-SECRET789"]) {
      assert.ok(!all.includes(s), `log leaked ${s.slice(0, 16)}…`);
    }
  });
});
