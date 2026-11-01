// PUT / DELETE /api/league/:provider/:id/overrides/:playerId (the owner's "Out for season" toggle) through the real
// guard + auth routes + apiRouter in-process (fake Discord, temp cwd BEFORE the app modules load, so .data/ is a temp
// dir, never the repo's). Harness from accuracy-api.test.ts.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-marks-"));
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
const SECRET = "marks-session-secret-0123456789-abcdef";
const ADMIN = "100000000000000001";
const A = "200000000000000002"; // league yY team 1 (a user who may view the league, never mark players)
const accessFile = path.join(work, "access.json");
fs.writeFileSync(accessFile, JSON.stringify({ admins: [ADMIN], users: [{ discordId: A, leagueId: "yY", teamId: "1", note: "A" }] }));
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
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  return { cookie, csrf: ((await me.json()) as { csrf: string }).csrf };
}
async function call(who: Who | null, method: string, p: string, body?: unknown, origin: string | null = PUBLIC_URL) {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
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
  return { status: r.status, json };
}

let admin: Who, a: Who;
let demo: any;
let starId = "";
const marksFile = () => path.join(work, ".data", "overrides-yY.json");

function yLeague(): any {
  const teams = demo.league.teams.map((t: any, i: number) => ({
    id: String(i + 1),
    name: `Team ${i + 1}`,
    players: t.playerIds.map((pid: string, j: number) => {
      const p = demo.players[pid];
      return { yahooId: p.ids?.yahoo, name: p.name, pos: p.pos, team: p.team, slot: j < 2 ? p.pos : "BN" };
    }),
  }));
  return { id: "yY", leagueId: "555", name: "League Y", numTeams: 12, slots: ["QB", "WR", "WR", "RB", "TE", "W/R/T", "W/R/T", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR", "IR"], scoring: { rec: 1 }, settingsSource: "page", teams, myTeamId: "1" };
}
const valueRow = async (id: string) => (await call(admin, "GET", `/api/league/import/yY/values?id=${encodeURIComponent(id)}`)).json[0];

before(
  async () => {
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const k of ["log", "warn"] as const) console[k] = (...x: unknown[]) => void logs.push(x.map(String).join(" "));
    admin = await signIn(ADMIN);
    a = await signIn(A);
    const an = await call(admin, "GET", "/api/league/demo/42/analysis");
    assert.equal(an.status, 200);
    demo = an.json;
    const y = await call(admin, "POST", "/api/import", yLeague());
    assert.equal(y.status, 200, JSON.stringify(y.json));
    // A healthy rostered starter with real value.
    const vals = (await call(admin, "GET", "/api/league/import/yY/values")).json as any[];
    starId = vals.find((v) => v.rostered && v.value > 10 && !v.injury && !v.seasonStatus && v.pos === "WR")!.id;
  },
  { timeout: 300_000 },
);
after(() => server?.close());

describe("season marks API", { timeout: 300_000 }, () => {
  test("only the league owner writes: a league user 403, no session 401, wrong Origin 403; nothing is written", async () => {
    const p = `/api/league/import/yY/overrides/${starId}`;
    const u = await call(a, "PUT", p, { seasonOver: true });
    assert.equal(u.status, 403);
    assert.equal(u.json.code, "admin_only");
    assert.equal((await call(a, "DELETE", p)).status, 403);
    assert.equal((await call(null, "PUT", p, { seasonOver: true })).status, 401);
    const o = await call(admin, "PUT", p, { seasonOver: true }, "https://evil.example");
    assert.equal(o.status, 403);
    assert.equal(o.json.code, "bad_origin");
    assert.equal(fs.existsSync(marksFile()), false);
    // The league user can still read the league.
    assert.equal((await call(a, "GET", "/api/league/import/yY/values")).status, 200);
  });

  test("bad requests: body, provider, unknown league / player, bad ids", async () => {
    const p = `/api/league/import/yY/overrides/${starId}`;
    assert.equal((await call(admin, "PUT", p, { seasonOver: "yes" })).status, 400);
    assert.equal((await call(admin, "PUT", p, {})).status, 400);
    assert.equal((await call(admin, "PUT", `/api/league/demo/42/overrides/${starId}`, { seasonOver: true })).status, 404);
    assert.equal((await call(admin, "PUT", `/api/league/import/nope/overrides/${starId}`, { seasonOver: true })).status, 404);
    assert.equal((await call(admin, "PUT", "/api/league/import/yY/overrides/no-such-player", { seasonOver: true })).status, 404);
    assert.equal((await call(admin, "PUT", "/api/league/import/yY/overrides/__proto__", { seasonOver: true })).status, 400);
    assert.equal(fs.existsSync(marksFile()), false);
  });

  test("mark out → value 0 and the chip source 'owner'; not out; DELETE → automatic; a re-import never touches the marks", async () => {
    const before = await valueRow(starId);
    assert.ok(before.value > 0);
    const p = `/api/league/import/yY/overrides/${starId}`;
    const put = await call(admin, "PUT", p, { seasonOver: true });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.deepEqual(put.json, { playerId: starId, mark: true });
    assert.ok(logs.some((l) => l.includes(`[overrides] event=set league=yY player=${starId} seasonOver=true`)));
    const out = await valueRow(starId);
    assert.equal(out.value, 0);
    assert.equal(out.seasonStatus.over, true);
    assert.equal(out.seasonStatus.source, "owner");
    assert.equal(out.seasonStatus.owner, true);
    const file = JSON.parse(fs.readFileSync(marksFile(), "utf8"));
    assert.equal(file.players[starId].seasonOver, true);
    // The league user sees the owner's call too (one league, one set of marks).
    const asUser = (await call(a, "GET", `/api/league/import/yY/values?id=${starId}`)).json[0];
    assert.equal(asUser.seasonStatus.over, true);
    // A re-import of the same league (rosters refresh) never overwrites the marks.
    assert.equal((await call(admin, "POST", "/api/import", yLeague())).status, 200);
    assert.equal(JSON.parse(fs.readFileSync(marksFile(), "utf8")).players[starId].seasonOver, true);
    assert.equal((await valueRow(starId)).value, 0);
    // "Not out": the healthy starter is valued as before.
    assert.equal((await call(admin, "PUT", p, { seasonOver: false })).status, 200);
    const notOut = await valueRow(starId);
    assert.equal(notOut.value, before.value);
    assert.equal(notOut.seasonStatus.over, false);
    // Back to automatic.
    assert.equal((await call(admin, "DELETE", p)).status, 200);
    const auto = await valueRow(starId);
    assert.equal(auto.value, before.value);
    assert.equal(auto.seasonStatus, undefined);
    assert.equal(fs.existsSync(marksFile()), false, "no marks: no file");
  });

  test("deleting the league deletes its marks", async () => {
    assert.equal((await call(admin, "PUT", `/api/league/import/yY/overrides/${starId}`, { seasonOver: true })).status, 200);
    assert.ok(fs.existsSync(marksFile()));
    assert.equal((await call(admin, "DELETE", "/api/import/yY")).status, 200);
    assert.equal(fs.existsSync(marksFile()), false);
  });
});
