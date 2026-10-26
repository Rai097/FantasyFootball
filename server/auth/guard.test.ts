// Guard unit tests: route classification, scope resolution, and the middleware on a tiny echo app
// (real SessionStore in memory, access list held in a variable so tests can edit it).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import type { AccessList } from "./access.js";
import { classify, createGuard, resolveScope, scopeOf, SESSION_COOKIE } from "./guard.js";
import { SessionStore, signSessionId } from "./sessions.js";

const SECRET = "x".repeat(40);
const ORIGIN = "https://ff.example";
const ADMIN = "100000000000000001";
const A = "200000000000000002";
const B = "300000000000000003";
let list: AccessList | null = null;
const fresh = (): AccessList => ({ admins: [ADMIN], users: [{ discordId: A, leagueId: "yA", teamId: "4" }, { discordId: B, leagueId: "yB", teamId: "7" }] });

describe("classify", () => {
  const c = (m: string, p: string, q = {}) => classify(m, p, q);
  test("open, public and protected paths", () => {
    assert.equal(c("GET", "/").kind, "open");
    assert.equal(c("GET", "/healthz").kind, "open");
    assert.equal(c("GET", "/auth/login").kind, "open");
    assert.equal(c("GET", "/auth/callback").kind, "open");
    assert.equal(c("GET", "/api/import/bookmarklet.js").kind, "public");
    assert.equal(c("GET", "/api/docs/import").kind, "public");
    assert.equal(c("POST", "/api/docs/import").kind, "signed");
    assert.equal(c("GET", "/api/state").kind, "signed");
    assert.equal(c("GET", "/api/nope").kind, "signed");
    assert.equal(c("GET", "/api").kind, "signed");
  });
  test("case and trailing slashes cannot dodge a rule (Express routing is case-insensitive)", () => {
    assert.equal(c("GET", "/API/State/").kind, "signed");
    assert.equal(c("GET", "/Auth/Yahoo/start").kind, "admin");
    assert.equal(c("DELETE", "/API/IMPORT/yA/").kind, "admin");
    assert.equal(c("PUT", "/api/Import/yA/Settings").kind, "admin");
  });
  test("admin-only and scoped routes", () => {
    assert.equal(c("GET", "/auth/yahoo/start").kind, "admin");
    assert.equal(c("POST", "/auth/yahoo/disconnect").kind, "admin");
    assert.equal(c("GET", "/api/yahoo/leagues").kind, "admin");
    assert.equal(c("DELETE", "/api/import/yA").kind, "admin");
    assert.equal(c("PUT", "/api/import/yA/settings").kind, "admin");
    assert.equal(c("GET", "/api/access").kind, "realAdmin");
    assert.equal(c("POST", "/api/auth/act-as").kind, "realAdmin");
    assert.equal(c("GET", "/api/auth/me").kind, "signed");
    assert.deepEqual(c("GET", "/api/import/yA/history"), { kind: "importId", id: "yA" });
    assert.deepEqual(c("GET", "/api/league/import/yA/waivers"), { kind: "league", provider: "import", id: "yA" });
    assert.deepEqual(c("GET", "/api/players/search", { q: "x" }), { kind: "league", provider: "demo", id: "42" });
    assert.deepEqual(c("GET", "/api/players/search", { provider: "import", id: "yB" }), { kind: "league", provider: "import", id: "yB" });
  });
});

describe("resolveScope", () => {
  const sess = (uid: string, actAs?: string) => ({ uid, name: "n", avatar: null, csrf: "c".repeat(30), actAs, key: "k" });
  test("user scope, admin, act-as, act-as target removed, not listed", () => {
    const l = fresh();
    assert.deepEqual(
      (({ role, leagueId, teamId }) => ({ role, leagueId, teamId }))(resolveScope(sess(A), l)!),
      { role: "user", leagueId: "yA", teamId: "4" },
    );
    assert.equal(resolveScope(sess(ADMIN), l)?.role, "admin");
    const acting = resolveScope(sess(ADMIN, B), l)!;
    assert.equal(acting.role, "user");
    assert.equal(acting.realRole, "admin");
    assert.equal(acting.leagueId, "yB");
    assert.equal(acting.teamId, "7");
    assert.equal(resolveScope(sess(ADMIN, "999999"), l)?.role, "admin");
    assert.equal(resolveScope(sess(A, B), l)?.leagueId, "yA", "a user cannot act as anyone");
    assert.equal(resolveScope(sess("999999"), l), null);
    assert.equal(resolveScope(sess(ADMIN), null), null, "no access file = nobody");
  });
});

describe("guard middleware (discord mode)", () => {
  const logs: string[] = [];
  const sessions = new SessionStore({ read: async () => null, write: async () => undefined });
  const g = createGuard({ mode: "discord", secret: SECRET, publicOrigin: ORIGIN, sessions, access: { get: async () => list }, log: (l) => logs.push(l) });
  const app = express();
  app.use(express.json());
  app.use(g.middleware);
  app.use((req, res) => {
    if (!req.auth) return void res.json({ path: req.path, public: true });
    const s = scopeOf(req);
    res.json({ path: req.path, role: s.role, leagueId: s.leagueId ?? null, teamId: s.teamId ?? null });
  });
  let server: http.Server;
  let base = "";
  const cookies: Record<string, string> = {};
  const csrf: Record<string, string> = {};

  before(async () => {
    list = fresh();
    for (const uid of [ADMIN, A, B]) {
      const { id, session } = await sessions.create({ uid, name: uid, avatar: null });
      cookies[uid] = `${SESSION_COOKIE}=${signSessionId(id, SECRET)}`;
      csrf[uid] = session.csrf;
    }
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => server.close());

  const call = async (uid: string | null, method: string, p: string, opts: { body?: unknown; csrf?: string | null; origin?: string | null } = {}) => {
    const headers: Record<string, string> = {};
    if (uid) headers.cookie = cookies[uid];
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const tok = opts.csrf === undefined ? (uid ? csrf[uid] : undefined) : opts.csrf;
    if (tok) headers["x-csrf-token"] = tok;
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    if (origin) headers.origin = origin;
    const r = await fetch(base + p, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };

  test("no cookie / forged cookie → 401 signin; public paths pass", async () => {
    assert.equal((await call(null, "GET", "/api/state")).status, 401);
    assert.equal((await call(null, "GET", "/api/state")).json.code, "signin");
    const r = await fetch(`${base}/api/state`, { headers: { cookie: `${SESSION_COOKIE}=${"A".repeat(43)}.${"B".repeat(43)}` } });
    assert.equal(r.status, 401);
    assert.equal((await call(null, "GET", "/api/import/bookmarklet.js")).status, 200);
    assert.equal((await call(null, "GET", "/healthz")).status, 200);
    assert.equal((await call(null, "GET", "/auth/yahoo/start")).status, 401);
  });

  test("user: own league OK, missing team OK, other team / other league / yahoo → 403", async () => {
    assert.equal((await call(A, "GET", "/api/league/import/yA/analysis")).status, 200);
    assert.equal((await call(A, "GET", "/api/league/import/yA/analysis?team=4")).status, 200);
    const other = await call(A, "GET", "/api/league/import/yA/analysis?team=5");
    assert.equal(other.status, 403);
    assert.equal(other.json.code, "team");
    assert.equal((await call(A, "GET", "/api/league/import/yA/analysis?team=4&team=5")).status, 403);
    assert.equal((await call(A, "POST", "/api/league/import/yA/trade/evaluate", { body: { team: "5", partner: "1" } })).status, 403);
    assert.equal((await call(A, "GET", "/api/league/import/yB")).json.code, "league");
    assert.equal((await call(A, "GET", "/api/league/import/YA")).status, 403, "ids compare exactly");
    assert.equal((await call(A, "GET", "/api/league/yahoo/yA")).status, 403);
    assert.equal((await call(A, "GET", "/api/league/demo/42/analysis?team=9")).status, 200, "demo: read-only sample data");
    assert.equal((await call(A, "GET", "/api/players/search?q=x&provider=import&id=yB")).status, 403);
    assert.equal((await call(A, "GET", "/api/import/yB/history")).status, 403);
    assert.equal((await call(A, "GET", "/api/import/yA/changes")).status, 200);
    assert.equal((await call(A, "GET", "/api/yahoo/leagues")).status, 403);
    assert.equal((await call(A, "GET", "/auth/yahoo/start")).status, 403);
  });

  test("user: DELETE / PUT settings / act-as / access → 403 admin_only; admin → passes", async () => {
    const del = await call(A, "DELETE", "/api/import/yA");
    assert.equal(del.status, 403);
    assert.equal(del.json.code, "admin_only");
    assert.equal((await call(A, "PUT", "/api/import/yA/settings", { body: {} })).status, 403);
    assert.equal((await call(A, "GET", "/api/access")).status, 403);
    assert.equal((await call(A, "POST", "/api/auth/act-as", { body: { discordId: null } })).status, 403);
    assert.equal((await call(ADMIN, "DELETE", "/api/import/yA")).status, 200);
    assert.equal((await call(ADMIN, "PUT", "/api/import/yB/settings", { body: {} })).status, 200);
    assert.equal((await call(ADMIN, "GET", "/api/league/yahoo/x")).status, 200);
    assert.equal((await call(ADMIN, "GET", "/api/league/import/yA/analysis?team=9")).status, 200);
  });

  test("writes: missing CSRF, wrong CSRF, wrong or missing Origin → 403", async () => {
    const noCsrf = await call(ADMIN, "POST", "/api/import", { body: {}, csrf: null });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.code, "csrf");
    assert.equal((await call(ADMIN, "POST", "/api/import", { body: {}, csrf: csrf[A] })).json.code, "csrf");
    assert.equal((await call(ADMIN, "POST", "/api/import", { body: {}, origin: "https://evil.example" })).json.code, "bad_origin");
    assert.equal((await call(ADMIN, "POST", "/api/import", { body: {}, origin: null })).json.code, "bad_origin");
    assert.equal((await call(ADMIN, "POST", "/api/import", { body: {} })).status, 200);
    assert.ok(logs.some((l) => /event=write uid=\S+ method=POST path=\/api\/import result=allowed/.test(l)));
    assert.ok(logs.some((l) => /event=refused .*code=csrf/.test(l)));
  });

  test("admin act-as: scope becomes the user's exactly; null → admin", async () => {
    const s = (await g.scopeFor({ headers: { cookie: cookies[ADMIN] } } as never)) as any;
    await g.setActAs(s, B);
    assert.deepEqual((await call(ADMIN, "GET", "/api/state")).json, { path: "/api/state", role: "user", leagueId: "yB", teamId: "7" });
    assert.equal((await call(ADMIN, "GET", "/api/league/import/yA")).status, 403);
    assert.equal((await call(ADMIN, "GET", "/api/league/import/yB/waivers?team=4")).status, 403);
    assert.equal((await call(ADMIN, "DELETE", "/api/import/yB")).status, 403, "acting admin is a user for admin-only routes");
    await g.setActAs(s, null);
    assert.deepEqual((await call(ADMIN, "GET", "/api/state")).json, { path: "/api/state", role: "admin", leagueId: null, teamId: null });
  });

  test("removing an id from the access list locks out an existing session on the next request", async () => {
    assert.equal((await call(B, "GET", "/api/state")).status, 200);
    list = { ...fresh(), users: fresh().users.filter((u) => u.discordId !== B) };
    const r = await call(B, "GET", "/api/state");
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "not_allowed");
    list = null;
    assert.equal((await call(ADMIN, "GET", "/api/state")).status, 403, "unreadable access list = nobody");
    list = fresh();
  });
});

describe("guard middleware (dev mode)", () => {
  test("every request is the built-in admin; writes skip Origin/CSRF", async () => {
    const g = createGuard({ mode: "dev", secret: "", publicOrigin: "", sessions: new SessionStore({ read: async () => null, write: async () => undefined }), access: { get: async () => null }, log: () => undefined });
    const app = express();
    app.use(g.middleware);
    app.use((req, res) => res.json({ role: scopeOf(req).role, dev: scopeOf(req).dev }));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const r = await fetch(`${base}/api/import/x`, { method: "DELETE" });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { role: "admin", dev: true });
    } finally {
      server.close();
    }
  });
});
