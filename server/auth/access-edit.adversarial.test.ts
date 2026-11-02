// Adversarial: the owner's access-list editing (PUT/DELETE /api/access/users/:id, AccessFile.editUsers), the refused
// sign-in log, and managers' "Refresh from Yahoo now" limits, through the real guard (Discord mode) with a fake
// Discord client. cwd moves to a temp dir BEFORE the app modules load, so every write lands there, never in .data/.
// docs/DESIGN.md "Managers' Connect tab and access editing (2026-11-02)".
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-access-adv-"));
fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.symlinkSync(path.join(ROOT, ".cache"), path.join(work, ".cache"), "dir");
process.chdir(work);
const { createAuth, refusedLog, REFUSED_MAX, REFUSED_TTL_MS } = await import("./routes.js");
const { AccessFile } = await import("./access.js");
const { SessionStore, signSessionId } = await import("./sessions.js");
const { SESSION_COOKIE } = await import("./guard.js");
const { apiRouter, errorMiddleware } = await import("../api.js");
const { AutoImportService, setAutoImport, MANUAL_MIN_GAP_MS, USER_MIN_GAP_MS, USER_DAILY_MAX } = await import("../autoimport/service.js");
type CollectResult = import("../autoimport/collector.js").CollectResult;

const PUBLIC_URL = "https://ff.example";
const SECRET = "access-adv-secret-0123456789-abcdef-xyz";
const CLIENT_SECRET = "discord-client-secret-ADV";
const ADMIN = "100000000000000001";
const ADMIN2 = "100000000000000009";
const A = "200000000000000002"; // manager of yY (the access-edit league)
const M = "500000000000000005"; // manager of the auto-imported league
const OTHER = "600000000000000006"; // manager of another league
const STRANGER = "400000000000000004";
const AUTO_LEAGUE = "1405188";
const CAP_MANAGERS = Array.from({ length: USER_DAILY_MAX + 2 }, (_, i) => `7000000000000${String(i).padStart(5, "0")}`);
const accessFile = path.join(work, "access.json");

const baseUsers = () => [
  { discordId: A, leagueId: "yY", teamId: "4", note: "Alice" },
  { discordId: M, leagueId: `y${AUTO_LEAGUE}`, teamId: "1" },
  { discordId: OTHER, leagueId: "yZ", teamId: "1" },
  ...CAP_MANAGERS.map((id) => ({ discordId: id, leagueId: `y${AUTO_LEAGUE}`, teamId: "2" })),
];
function writeAccessRaw(text: string) {
  fs.writeFileSync(accessFile, text);
  const t = new Date(Date.now() + Math.random() * 1_000_000);
  fs.utimesSync(accessFile, t, t);
}
const writeAccess = (extra: Record<string, unknown> = {}, users: unknown[] = baseUsers()) => writeAccessRaw(JSON.stringify({ admins: [ADMIN, ADMIN2], users, ...extra }));
const readAccess = () => JSON.parse(fs.readFileSync(accessFile, "utf8"));
const tmpLeftovers = () => fs.readdirSync(work).filter((f) => f.endsWith(".tmp"));

// Fake Discord: code-<uid> → token-<uid>; names per uid (to inject odd display names).
const names: Record<string, string> = {};
const fakeDiscord = {
  exchange: async (code: string) => (code.startsWith("code-") ? `token-${code.slice(5)}` : null),
  me: async (token: string) => {
    const uid = token.slice(6);
    return { id: uid, username: `user${uid.slice(0, 2)}`, global_name: names[uid] ?? null, avatar: null };
  },
};

const logs: string[] = [];
const sessions = new SessionStore({ read: async () => null, write: async () => undefined });
writeAccess();
const auth = createAuth({
  mode: "discord",
  clientId: "cid",
  clientSecret: CLIENT_SECRET,
  sessionSecret: SECRET,
  publicUrl: PUBLIC_URL,
  discord: fakeDiscord,
  sessions,
  access: new AccessFile(accessFile, (m) => logs.push(m)),
  log: (l) => logs.push(l),
});
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(auth.guard);
app.use(auth.router);
app.use(apiRouter);
app.use(errorMiddleware);

interface Who {
  cookie: string;
  csrf: string;
  uid: string;
}
const secrets: string[] = [];
async function session(uid: string): Promise<Who> {
  const { id, session: s } = await sessions.create({ uid, name: `n${uid.slice(0, 3)}`, avatar: null });
  const signed = signSessionId(id, SECRET);
  secrets.push(signed, s.csrf, id);
  return { cookie: `${SESSION_COOKIE}=${encodeURIComponent(signed)}`, csrf: s.csrf, uid };
}

let base = "";
let server: http.Server;
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
let admin: Who, admin2: Who, actas: Who, a: Who, m: Who, m2: Who, other: Who;

async function call(who: Who | null, method: string, p: string, body?: unknown, opts: { raw?: string; origin?: string } = {}) {
  const headers: Record<string, string> = { origin: opts.origin ?? PUBLIC_URL };
  if (who) {
    headers.cookie = who.cookie;
    headers["x-csrf-token"] = who.csrf;
  }
  const payload = opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined);
  if (payload !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + p, { method, headers, body: payload, redirect: "manual" });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, retryAfter: r.headers.get("retry-after") };
}

const league = (id: string, teamIds: string[], leagueId: string) => ({
  id,
  leagueId,
  name: `League ${id}`,
  teams: teamIds.map((t) => ({ id: t, name: `Team ${t}`, players: [] })),
  myTeamId: teamIds[0],
});

before(async () => {
  for (const k of ["log", "warn", "error"] as const) console[k] = (...x: unknown[]) => void logs.push(x.map(String).join(" "));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = await session(ADMIN);
  admin2 = await session(ADMIN2);
  actas = await session(ADMIN);
  a = await session(A);
  m = await session(M);
  m2 = await session(M); // a second browser of the same Discord account
  other = await session(OTHER);
  for (const l of [league("yY", ["1", "4", "7"], "555"), league("yZ", ["1", "2"], "777"), league("yOdd", ["a b", "1.5"], "888")]) {
    const r = await call(admin, "POST", "/api/import", l);
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const r = await call(actas, "POST", "/api/auth/act-as", { discordId: A });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});
after(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
  setAutoImport(null);
  server?.close();
  process.chdir(ROOT);
  fs.rmSync(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------- authorization and paths
test("a manager can't read or edit the list through any path spelling; nothing is written, no access_set line", async () => {
  writeAccess();
  const before = fs.readFileSync(accessFile, "utf8");
  const n = logs.length;
  const paths = [
    `/api/access/users/${STRANGER}`,
    `/API/ACCESS/USERS/${STRANGER}`,
    `/api/Access/Users/${STRANGER}`,
    `/api/access/users/${STRANGER}/`,
    `/api//access/users/${STRANGER}`,
    `/api/access//users/${STRANGER}`,
    `/api/access/users/..%2F${STRANGER}`,
    `/api/access/users/${STRANGER}%2F..`,
  ];
  for (const who of [a, m, other]) {
    for (const p of paths) {
      for (const method of ["PUT", "DELETE", "PATCH", "POST"]) {
        const r = await call(who, method, p, { leagueId: "yY", teamId: "1" });
        assert.ok(r.status === 403 || r.status === 404, `${method} ${p} → ${r.status}`);
        assert.notEqual(r.status, 200);
      }
    }
    const g = await call(who, "GET", "/api/access");
    assert.equal(g.status, 403);
    assert.equal(g.json.code, "admin_only");
    assert.equal(g.json.requests, undefined, "no refused-sign-in list for a manager");
    assert.equal(g.json.users, undefined);
    assert.equal((await call(who, "GET", "/API/Access/")).status, 403);
  }
  assert.equal(fs.readFileSync(accessFile, "utf8"), before);
  assert.ok(!logs.slice(n).some((l) => l.includes("event=access_set") || l.includes("event=access_remove")));
});

test("the owner: malformed ids and path tricks never write; act-as (still the real owner) and a second admin may edit", async () => {
  writeAccess();
  const before = fs.readFileSync(accessFile, "utf8");
  const bad = [
    "12ab",
    "1234",
    "1".repeat(26),
    "%00",
    `${STRANGER}%00`,
    `${STRANGER}%0A`,
    "..",
    "%2E%2E",
    `${STRANGER.slice(0, 9)}%2F${STRANGER.slice(9)}`,
    "%EF%BC%91%EF%BC%92%EF%BC%93%EF%BC%94%EF%BC%95", // full-width digits
    "-12345",
    "+12345",
    "12345.0",
    " 12345",
  ];
  for (const id of bad) {
    for (const method of ["PUT", "DELETE"]) {
      const r = await call(admin, method, `/api/access/users/${id}`, { leagueId: "yY", teamId: "1" });
      assert.notEqual(r.status, 200, `${method} ${id}`);
      assert.ok(r.status === 400 || r.status === 404, `${method} ${id} → ${r.status} ${JSON.stringify(r.json)}`);
    }
  }
  assert.equal(fs.readFileSync(accessFile, "utf8"), before);
  assert.deepEqual(tmpLeftovers(), []);

  // Act-as: realAdmin, so allowed (spec); the second admin too. Case/trailing-slash spellings reach the same route.
  assert.equal((await call(actas, "PUT", `/api/access/users/${STRANGER}`, { leagueId: "yY", teamId: "1" })).status, 200);
  assert.equal((await call(admin2, "PUT", `/API/access/users/${STRANGER}/`, { leagueId: "yY", teamId: "7" })).status, 200);
  assert.deepEqual(readAccess().users.at(-1), { discordId: STRANGER, leagueId: "yY", teamId: "7" });
  assert.equal((await call(admin, "DELETE", `/api/access/users/${STRANGER}`)).status, 200);
  assert.ok(!readAccess().users.some((u: { discordId: string }) => u.discordId === STRANGER));
  // Write checks still apply to the owner.
  assert.equal((await call(admin, "PUT", `/api/access/users/${STRANGER}`, { leagueId: "yY", teamId: "1" }, { origin: "https://evil.example" })).json.code, "bad_origin");
  assert.equal((await call({ ...admin, csrf: "x" }, "PUT", `/api/access/users/${STRANGER}`, { leagueId: "yY", teamId: "1" })).json.code, "csrf");
});

test("admins can't be assigned, moved or removed; their file entries (even malformed ones) and other keys survive edits", async () => {
  const raw = `{"admins":["${ADMIN}","${ADMIN2}","not-an-id"],"__proto__":{"polluted":true},"constructor":{"x":1},"keep":[1,2],"users":${JSON.stringify(baseUsers())}}`;
  writeAccessRaw(raw);
  for (const id of [ADMIN, ADMIN2]) {
    const r = await call(admin, "PUT", `/api/access/users/${id}`, { leagueId: "yY", teamId: "1" });
    assert.equal(r.json.code, "is_admin", id);
    assert.equal((await call(admin, "DELETE", `/api/access/users/${id}`)).status, 404);
  }
  assert.equal(fs.readFileSync(accessFile, "utf8"), raw, "refusals write nothing");
  const ok = await call(admin, "PUT", `/api/access/users/${STRANGER}`, { leagueId: "yY", teamId: "1" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const after = JSON.parse(fs.readFileSync(accessFile, "utf8"));
  assert.deepEqual(after.admins, [ADMIN, ADMIN2, "not-an-id"], "admins written back as read");
  assert.deepEqual(Object.getOwnPropertyDescriptor(after, "__proto__")?.value, { polluted: true }, "__proto__ key kept as plain data");
  assert.deepEqual(after.constructor, { x: 1 });
  assert.deepEqual(after.keep, [1, 2]);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype untouched");
  // Owner still signs in (admins intact).
  assert.equal((await call(admin, "GET", "/api/auth/me")).json.role, "admin");
  writeAccess();
});

// ---------------------------------------------------------------- body type confusion
test("PUT body confusion: wrong types, arrays, prototype keys → 400 and nothing written; long / HTML note is capped and never logged", async () => {
  writeAccess();
  const before = fs.readFileSync(accessFile, "utf8");
  const p = `/api/access/users/${STRANGER}`;
  const bodies: { raw: string; what: string }[] = [
    { raw: "[]", what: "array" },
    { raw: `[{"leagueId":"yY","teamId":"1"}]`, what: "array of body" },
    { raw: `"yY"`, what: "string" },
    { raw: "123", what: "number" },
    { raw: "null", what: "null" },
    { raw: `{"leagueId":["yY"],"teamId":"1"}`, what: "league array" },
    { raw: `{"leagueId":"yY","teamId":1}`, what: "team number" },
    { raw: `{"leagueId":"yY","teamId":"1","note":{}}`, what: "note object" },
    { raw: `{"leagueId":"yY","teamId":"1","note":["x"]}`, what: "note array" },
    { raw: `{"leagueId":"yY","teamId":"1","note":5}`, what: "note number" },
    { raw: `{"__proto__":{"leagueId":"yY","teamId":"1"}}`, what: "__proto__ body" },
    { raw: `{"constructor":{"prototype":{"leagueId":"yY","teamId":"1"}}}`, what: "constructor body" },
    { raw: `{"leagueId":"__proto__","teamId":"1"}`, what: "__proto__ league" },
    { raw: `{"leagueId":"yY","teamId":"constructor"}`, what: "constructor team" },
    { raw: `{"leagueId":"../yY","teamId":"1"}`, what: "traversal league" },
    { raw: `{"leagueId":"yY-history","teamId":"1"}`, what: "history file as league" },
    { raw: `{"leagueId":"yY","teamId":"1 "}`, what: "team with space" },
    { raw: `{"leagueId":"yY",`, what: "broken json" },
  ];
  for (const b of bodies) {
    const r = await call(admin, "PUT", p, undefined, { raw: b.raw });
    assert.ok(r.status >= 400 && r.status < 500, `${b.what} → ${r.status} ${JSON.stringify(r.json)}`);
  }
  assert.equal(fs.readFileSync(accessFile, "utf8"), before);
  assert.equal(({} as Record<string, unknown>).leagueId, undefined, "Object.prototype untouched");
  assert.equal(({} as Record<string, unknown>).teamId, undefined);

  // note: null is accepted (= no note); a 10k note with markup and newlines is trimmed and capped, never logged.
  assert.equal((await call(admin, "PUT", p, { leagueId: "yY", teamId: "1", note: null })).status, 200);
  assert.equal(readAccess().users.at(-1).note, undefined);
  const n = logs.length;
  const evil = `  <script>alert(1)</script>\n[auth] event=login uid=${ADMIN} role=admin result=ok\u0000${"x".repeat(10_000)}`;
  const r = await call(admin, "PUT", p, { leagueId: "yY", teamId: "1", note: evil });
  assert.equal(r.status, 200);
  const note = readAccess().users.at(-1).note as string;
  assert.ok(note.length <= 80);
  assert.ok(note.startsWith("<script>"));
  assert.ok(!logs.slice(n).some((l) => l.includes("<script>") || l.includes("xxxxx") || /\n/.test(l)), "note never reaches the log");
  assert.equal(logs.slice(n).filter((l) => l.includes("event=access_set")).length, 1);
  writeAccess();
});

test("BUG: an edit silently drops hand-written user rows the parser ignores and per-row extra keys", { todo: "BUG: AccessFile.editUsers rewrites users from parseAccess output (access.ts editUsers: change(list.users) then {...raw, users}): any hand-entered row with a typo, a duplicate, or an extra key is deleted/stripped by the next unrelated PUT/DELETE" }, async () => {
  const typo = { discordId: "880000000000000088", leagueId: "y 1405188", teamId: "3", note: "fix the league id later" };
  const users = [...baseUsers(), typo, { discordId: "990000000000000099", leagueId: "yY", teamId: "1", note: "B", since: "2026-10-01" }];
  writeAccess({}, users);
  const r = await call(admin, "PUT", `/api/access/users/${STRANGER}`, { leagueId: "yY", teamId: "1" });
  assert.equal(r.status, 200);
  const after = readAccess().users as Record<string, unknown>[];
  try {
    assert.ok(after.some((u) => u.discordId === typo.discordId), "the owner's hand-written (still invalid) row is kept for them to fix");
    assert.equal(after.find((u) => u.discordId === "990000000000000099")?.since, "2026-10-01", "extra per-row keys kept");
  } finally {
    writeAccess();
  }
});

test("BUG: assigning a team whose imported id isn't a valid access-list team id → misleading 503 'check access.json'", { todo: "BUG: PUT checks teamId only against the import's teams (routes.ts PUT), but imports accept ids like 'a b' / '1.5' (import.ts validateImport str(t.id,20)) that parseAccess TEAM_ID rejects → editUsers length check throws → 503 access_file for a valid UI pick" }, async () => {
  writeAccess();
  const r = await call(admin, "PUT", `/api/access/users/${STRANGER}`, { leagueId: "yOdd", teamId: "1.5" });
  assert.notEqual(r.json.code, "access_file", `got ${r.status} ${JSON.stringify(r.json)}`);
  assert.ok(r.status === 200 || r.status === 400);
});

// ---------------------------------------------------------------- concurrency and the cache
test("concurrent PUT/DELETE storm: no lost update, file valid JSON, mode 600, no tmp leftovers; the guard sees the result at once", async () => {
  writeAccess();
  const adds = Array.from({ length: 20 }, (_, i) => `8100000000000${String(i).padStart(5, "0")}`);
  const removes = CAP_MANAGERS.slice(0, 6);
  const moves = Array.from({ length: 6 }, (_, i) => ["1", "4", "7"][i % 3]);
  const results = await Promise.all([
    ...adds.map((id, i) => call(i % 2 ? admin : admin2, "PUT", `/api/access/users/${id}`, { leagueId: "yY", teamId: ["1", "4", "7"][i % 3], note: `n${i}` })),
    ...removes.map((id) => call(admin, "DELETE", `/api/access/users/${id}`)),
    ...moves.map((t) => call(admin, "PUT", `/api/access/users/${A}`, { leagueId: "yY", teamId: t })),
  ]);
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.json));
  const file = readAccess();
  const ids = file.users.map((u: { discordId: string }) => u.discordId);
  assert.equal(new Set(ids).size, ids.length, "no duplicates");
  for (const id of adds) assert.ok(ids.includes(id), `added ${id}`);
  for (const id of removes) assert.ok(!ids.includes(id), `removed ${id}`);
  assert.ok(ids.includes(A) && ids.includes(M) && ids.includes(OTHER));
  assert.equal(file.users.find((u: { discordId: string }) => u.discordId === A).note, "Alice", "note kept across moves");
  assert.deepEqual(file.admins, [ADMIN, ADMIN2]);
  assert.equal(fs.statSync(accessFile).mode & 0o777, 0o600);
  assert.deepEqual(tmpLeftovers(), []);
  // Removed managers are locked out on their next request; the guard's cached list equals the file.
  const removed = await session(removes[0]);
  assert.equal((await call(removed, "GET", "/api/auth/me")).json.code, "not_allowed");
  const g = await call(admin, "GET", "/api/access");
  assert.deepEqual(g.json.users.map((u: { discordId: string }) => u.discordId).sort(), [...ids].sort());
  writeAccess();
});

test("same id: concurrent add and remove resolve to one consistent state (listed ⇔ in file ⇔ guard)", async () => {
  for (let round = 0; round < 5; round++) {
    writeAccess();
    const id = `8200000000000${String(round).padStart(5, "0")}`;
    await Promise.all([
      call(admin, "PUT", `/api/access/users/${id}`, { leagueId: "yY", teamId: "1" }),
      call(admin, "DELETE", `/api/access/users/${id}`),
      call(admin, "PUT", `/api/access/users/${id}`, { leagueId: "yY", teamId: "4" }),
    ]);
    const inFile = readAccess().users.some((u: { discordId: string }) => u.discordId === id);
    const s = await session(id);
    const me = await call(s, "GET", "/api/auth/me");
    assert.equal(me.status === 200, inFile, `round ${round}: guard agrees with the file`);
  }
  writeAccess();
});

test("a broken or missing file is never rewritten by PUT/DELETE (the guard already locks everyone out)", async () => {
  for (const text of ["{ not json", JSON.stringify({ users: [] }), JSON.stringify([ADMIN])]) {
    writeAccessRaw(text);
    const r = await call(admin, "PUT", `/api/access/users/${STRANGER}`, { leagueId: "yY", teamId: "1" });
    assert.equal(r.json.code, "not_allowed");
    assert.equal((await call(admin, "DELETE", `/api/access/users/${A}`)).json.code, "not_allowed");
    assert.equal(fs.readFileSync(accessFile, "utf8"), text);
  }
  writeAccess();
});

// ---------------------------------------------------------------- refused sign-ins
async function refusedSignIn(uid: string) {
  const r1 = await fetch(`${base}/auth/login?next=%2F`, { redirect: "manual" });
  const stateCookie = r1.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("td_oauth_state="))!;
  const state = new URL(r1.headers.get("location")!).searchParams.get("state")!;
  const r = await fetch(`${base}/auth/callback?code=code-${uid}&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie: stateCookie } });
  assert.equal(r.headers.get("location"), "/?error=not_allowed");
}

test("refused sign-ins: hostile Discord names stay out of the log, are capped, and only the owner sees them", async () => {
  writeAccess();
  const uid = "450000000000000045";
  names[uid] = `Evil\n[auth] event=login uid=${ADMIN} role=admin result=ok <img src=x onerror=alert(1)>${"é".repeat(100)}`;
  const n = logs.length;
  await refusedSignIn(uid);
  const fresh = logs.slice(n);
  assert.ok(fresh.some((l) => l === `[auth] event=login uid=${uid} result=refused reason=not_allowed`));
  assert.ok(!fresh.some((l) => l.includes("Evil") || l.includes("onerror")), "the display name is not logged");
  const g = await call(admin, "GET", "/api/access");
  const row = g.json.requests.find((r: { discordId: string }) => r.discordId === uid);
  assert.ok(row);
  assert.ok(row.name.length <= 64);
  assert.ok(!Number.isNaN(Date.parse(row.at)));
  assert.equal((await call(a, "GET", "/api/access")).json.requests, undefined);
  assert.equal((await call(actas, "GET", "/api/access")).status, 200, "the owner viewing as a manager is still the owner");
  // Assigning removes it from requests; the edit takes the id from the path, never the refused row.
  assert.equal((await call(admin, "PUT", `/api/access/users/${uid}`, { leagueId: "yY", teamId: "1" })).json.requests.some((r: { discordId: string }) => r.discordId === uid), false);
  writeAccess();
});

test("refusedLog: bounded, newest first, one row per account, invalid ids ignored, 7-day expiry", () => {
  let t = Date.parse("2026-11-02T12:00:00Z");
  const log = refusedLog(() => t);
  for (let i = 0; i < REFUSED_MAX + 5; i++) {
    log.add(String(30000 + i), `u${i}`);
    t += 1000;
  }
  let rows = log.list();
  assert.equal(rows.length, REFUSED_MAX);
  assert.equal(rows[0].discordId, String(30000 + REFUSED_MAX + 4), "newest first");
  assert.ok(!rows.some((r) => r.discordId === "30000"), "oldest evicted");
  log.add(String(30010), "again");
  rows = log.list();
  assert.equal(rows.length, REFUSED_MAX);
  assert.equal(rows[0].name, "again");
  assert.equal(rows.filter((r) => r.discordId === "30010").length, 1);
  for (const bad of ["", "abc", "1234", "1".repeat(26), "__proto__", "12345\n"]) log.add(bad, "x");
  assert.equal(log.list().length, REFUSED_MAX);
  assert.ok(!log.list().some((r) => r.name === "x"));
  // A list() result is a copy.
  log.list().pop();
  assert.equal(log.list().length, REFUSED_MAX);
  t += REFUSED_TTL_MS - 1;
  assert.deepEqual(log.list().map((r) => r.discordId), [String(30010)]);
  t += 1;
  assert.deepEqual(log.list(), []);
});

// ---------------------------------------------------------------- managers' refresh
async function service(now: () => Date, cfg: Partial<import("../autoimport/service.js").AutoImportConfig> = {}) {
  let runs = 0;
  const ok: CollectResult = { ok: true, payload: {} as never, teams: 3 } as CollectResult;
  const s = await AutoImportService.create(
    { enabled: true, leagueId: AUTO_LEAGUE, profileDir: work, schedule: { patterns: ["0 9 * * 0"], timezone: "America/Los_Angeles" }, ...cfg },
    {
      collect: async () => {
        runs++;
        return ok;
      },
      apply: async () => ({ teams: 3 }),
      isPartial: () => false,
      log: (l) => logs.push(l),
      noTimers: true,
      retryDelayMs: 0,
      now,
      loadState: async () => null,
      saveState: async () => undefined,
    },
  );
  setAutoImport(s);
  const settle = async () => {
    while (s.status().running) await new Promise((r) => setTimeout(r, 5));
  };
  return { s, settle, runs: () => runs };
}
const refresh = (who: Who) => call(who, "POST", "/api/autoimport/refresh", {});

test("refresh: another league's manager → 403 league, nothing runs; act-as owner isn't league-gated or cooled down", async () => {
  writeAccess();
  let t = Date.parse("2026-11-08T18:00:00Z");
  const { settle, runs } = await service(() => new Date(t));
  const r = await refresh(other);
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "league");
  assert.equal(runs(), 0);
  assert.equal((await refresh(a)).json.code, "league", "manager of yY");
  assert.equal(runs(), 0);
  // The owner viewing as a yY manager is still the owner.
  assert.equal((await refresh(actas)).status, 202);
  await settle();
  t += MANUAL_MIN_GAP_MS;
  assert.equal((await refresh(actas)).status, 202, "no manager cooldown for the owner");
  await settle();
  // Other auto-import writes stay owner-only even for the right manager, whatever the spelling.
  for (const [method, p] of [["POST", "/api/autoimport/refresh/extra"], ["PATCH", "/api/autoimport/refresh"], ["PUT", "/api/autoimport/refresh"], ["DELETE", "/api/autoimport"], ["POST", "/api/autoimport"]] as const) {
    const x = await call(m, method, p, {});
    assert.equal(x.status, 403, `${method} ${p}`);
    assert.equal(x.json.code, "admin_only");
  }
  t += MANUAL_MIN_GAP_MS;
  assert.equal((await call(m, "POST", "/API/AutoImport/Refresh/", {})).status, 202, "case + trailing slash reach the same handler and its limits");
  await settle();
});

test("refresh: a disabled / unconfigured auto-import never lets a manager in", async () => {
  writeAccess();
  const t = Date.parse("2026-11-08T18:00:00Z");
  await service(() => new Date(t), { enabled: false, leagueId: undefined, disabledReason: "AUTO_IMPORT is not 1" });
  const r = await refresh(m);
  assert.notEqual(r.status, 202);
  setAutoImport(null);
  const r2 = await refresh(m);
  assert.notEqual(r2.status, 202);
  assert.equal(r2.json.code, "disabled");
});

test("refresh cooldown is per Discord account: a second session of the same account is held; rejected tries don't extend it", async () => {
  writeAccess();
  let t = Date.parse("2026-11-08T18:00:00Z");
  const { settle, runs } = await service(() => new Date(t));
  assert.equal((await refresh(m)).status, 202);
  await settle();
  t += MANUAL_MIN_GAP_MS;
  const r = await refresh(m2);
  assert.equal(r.status, 429);
  assert.equal(r.json.code, "user_cooldown");
  const first = Number(r.retryAfter);
  assert.ok(first > 0 && first <= USER_MIN_GAP_MS / 1000);
  for (let i = 0; i < 5; i++) assert.equal((await refresh(i % 2 ? m : m2)).json.code, "user_cooldown");
  assert.equal(runs(), 1);
  t += first * 1000;
  assert.equal((await refresh(m2)).status, 202, "free exactly when Retry-After said");
  await settle();
});

test("daily cap counts accepted refreshes only; Retry-After points at the oldest; the owner is never capped", async () => {
  writeAccess();
  const t0 = Date.parse("2026-11-10T08:00:00Z");
  let t = t0;
  const { settle, runs } = await service(() => new Date(t));
  const who = await Promise.all(CAP_MANAGERS.map((id) => session(id)));
  // Rejected attempts (another league, the 2-minute gap) between accepted ones must not count.
  for (let i = 0; i < USER_DAILY_MAX; i++) {
    t += MANUAL_MIN_GAP_MS;
    assert.equal((await refresh(other)).status, 403);
    const acc = await refresh(who[i]);
    assert.equal(acc.status, 202, `accepted ${i}: ${JSON.stringify(acc.json)}`);
    await settle();
    assert.equal((await refresh(who[i + 1])).json.code, "rate_limited", "within 2 minutes of the last accepted");
  }
  assert.equal(runs(), USER_DAILY_MAX);
  t += MANUAL_MIN_GAP_MS;
  const cap = await refresh(who[USER_DAILY_MAX]);
  assert.equal(cap.status, 429);
  assert.equal(cap.json.code, "daily_cap");
  assert.equal(Number(cap.retryAfter), Math.ceil((t0 + MANUAL_MIN_GAP_MS + 24 * 3600_000 - t) / 1000));
  assert.match(cap.json.error, /limit/);
  for (let i = 0; i < 3; i++) assert.equal((await refresh(who[USER_DAILY_MAX + 1])).json.code, "daily_cap");
  assert.equal((await refresh(admin)).status, 202, "owner unaffected");
  await settle();
  t = t0 + MANUAL_MIN_GAP_MS + 24 * 3600_000;
  assert.equal((await refresh(who[USER_DAILY_MAX])).status, 202, "one slot frees up 24 h after the oldest");
  await settle();
  setAutoImport(null);
});

// ---------------------------------------------------------------- logs
test("no log line carries a session cookie, csrf token, session id or a secret", () => {
  assert.ok(logs.length > 20);
  for (const l of logs) {
    for (const s of [...secrets, SECRET, CLIENT_SECRET]) assert.ok(!l.includes(s), `log leaks a secret: ${l.slice(0, 80)}`);
    assert.ok(!/td_session=/.test(l), l.slice(0, 80));
  }
});
