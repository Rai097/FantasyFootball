// Adversarial tests for PUT / DELETE /api/league/:provider/:id/overrides/:playerId (the owner's "Out for season"
// toggle): CSRF, other leagues, encoded / cased path tricks, id and body fuzz, concurrency, cache refresh and a corrupt
// marks file. Real guard + auth routes + apiRouter in-process (harness from season-marks-api.test.ts; temp cwd BEFORE
// the app modules load, so .data/ is a temp dir). Known defects are `todo`.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-marks-adv-"));
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
const SECRET = "marks-adv-session-secret-0123456789-abcdef";
const ADMIN = "100000000000000001";
const A = "200000000000000002"; // member of league yY (team 1)
const Z = "300000000000000003"; // member of league yZ (team 1)
const accessFile = path.join(work, "access.json");
fs.writeFileSync(
  accessFile,
  JSON.stringify({ admins: [ADMIN], users: [{ discordId: A, leagueId: "yY", teamId: "1", note: "A" }, { discordId: Z, leagueId: "yZ", teamId: "1", note: "Z" }] }),
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
  const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
  return { cookie, csrf: ((await me.json()) as { csrf: string }).csrf };
}
/** Raw request (no URL normalisation by fetch): keeps encoded / dot segments exactly as written. */
function raw(who: Who | null, method: string, p: string, body?: string, extra: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const u = new URL(base);
  const headers: Record<string, string> = { origin: PUBLIC_URL, ...extra };
  if (who) (headers.cookie = who.cookie), (headers["x-csrf-token"] = who.csrf);
  if (body !== undefined) headers["content-type"] ??= "application/json";
  if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => {
        let json: any;
        try {
          json = JSON.parse(t);
        } catch {
          json = t;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const call = (who: Who | null, method: string, p: string, body?: unknown, extra: Record<string, string> = {}) =>
  raw(who, method, p, body === undefined ? undefined : JSON.stringify(body), extra);

let admin: Who, a: Who, z: Who;
let demo: any;
let starId = "";
const dataDir = path.join(work, ".data");
const marksFile = (id = "yY") => path.join(dataDir, `overrides-${id}.json`);
const dataFiles = () => (fs.existsSync(dataDir) ? fs.readdirSync(dataDir).sort() : []);

function yLeague(id: string): any {
  const teams = demo.league.teams.map((t: any, i: number) => ({
    id: String(i + 1),
    name: `Team ${i + 1}`,
    players: t.playerIds.map((pid: string, j: number) => {
      const p = demo.players[pid];
      return { yahooId: p.ids?.yahoo, name: p.name, pos: p.pos, team: p.team, slot: j < 2 ? p.pos : "BN" };
    }),
  }));
  return { id, leagueId: id === "yY" ? "555" : "556", name: `League ${id}`, numTeams: 12, slots: ["QB", "WR", "WR", "RB", "TE", "W/R/T", "W/R/T", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR", "IR"], scoring: { rec: 1 }, settingsSource: "page", teams, myTeamId: "1" };
}
const valueRow = async (league: string, id: string) => (await call(admin, "GET", `/api/league/import/${league}/values?id=${encodeURIComponent(id)}`)).json[0];

before(
  async () => {
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const k of ["log", "warn"] as const) console[k] = (...x: unknown[]) => void logs.push(x.map(String).join(" "));
    admin = await signIn(ADMIN);
    a = await signIn(A);
    z = await signIn(Z);
    const an = await call(admin, "GET", "/api/league/demo/42/analysis");
    assert.equal(an.status, 200);
    demo = an.json;
    for (const id of ["yY", "yZ"]) {
      const y = await call(admin, "POST", "/api/import", yLeague(id));
      assert.equal(y.status, 200, JSON.stringify(y.json));
    }
    const vals = (await call(admin, "GET", "/api/league/import/yY/values")).json as any[];
    starId = vals.find((v) => v.rostered && v.value > 10 && !v.injury && !v.seasonStatus && v.pos === "WR")!.id;
  },
  { timeout: 300_000 },
);
after(() => server?.close());

describe("season marks API (adversarial)", { timeout: 300_000 }, () => {
  test("auth: missing CSRF, a member of another league, admin 'viewing as' nothing else; cased / encoded path tricks never write", async () => {
    const p = `/api/league/import/yY/overrides/${starId}`;
    const noCsrf = await raw(null, "PUT", p, JSON.stringify({ seasonOver: true }), { cookie: admin.cookie });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.code, "csrf");
    const wrongCsrf = await raw(null, "PUT", p, JSON.stringify({ seasonOver: true }), { cookie: admin.cookie, "x-csrf-token": z.csrf });
    assert.equal(wrongCsrf.status, 403);
    // A member of yZ on yY, and on their own league: admin only either way.
    assert.equal((await call(z, "PUT", p, { seasonOver: true })).status, 403);
    assert.equal((await call(z, "PUT", `/api/league/import/yZ/overrides/${starId}`, { seasonOver: true })).status, 403);
    // Path spellings Express may still route: upper case, trailing slash, percent-encoded letters, dot segments.
    for (const q of [
      `/api/league/import/yY/OVERRIDES/${starId}`,
      `/api/league/import/yY/overrides/${starId}/`,
      `/api/league/import/yY/%6Fverrides/${starId}`,
      `/api/league/import/yY/x/../overrides/${starId}`,
      `/API/league/import/yY/overrides/${starId}`,
      `/api/league/import/yY//overrides/${starId}`,
    ]) {
      for (const m of ["PUT", "DELETE"]) {
        const r = await call(a, m, q, m === "PUT" ? { seasonOver: true } : undefined);
        assert.ok(r.status >= 400, `${m} ${q} → ${r.status} ${JSON.stringify(r.json)}`);
      }
    }
    assert.equal(fs.existsSync(marksFile()), false, "nothing written");
  });

  test("player id fuzz: traversal, huge, unicode, NUL, prototype keys, inherited names → 400 / 404, never a stray file", async () => {
    const before = dataFiles();
    const ids = [
      "..", "../import-yY", "..%2F..%2Fimport-yY", "%2e%2e%2fimport-yY", "a".repeat(65), "a".repeat(5000), "%C3%A9l%C3%A8ve", "%F0%9F%8F%88",
      "%00", "a%00b", "__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "DEF:KC%0A", "%20", "a%2Fb",
    ];
    for (const id of ids) {
      const r = await call(admin, "PUT", `/api/league/import/yY/overrides/${id}`, { seasonOver: true });
      assert.ok([400, 404].includes(r.status), `PUT ${id.slice(0, 40)} → ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
      const d = await call(admin, "DELETE", `/api/league/import/yY/overrides/${id}`);
      assert.ok(d.status < 500, `DELETE ${id.slice(0, 40)} → ${d.status}`);
    }
    assert.deepEqual(dataFiles(), before, "no file created anywhere under .data");
    assert.ok(!fs.existsSync(path.join(work, "import-yY.json")) && !fs.existsSync(path.join(work, "overrides-yY.json")));
    // A bad league id in the path.
    for (const lid of ["..", "y%2F..", "a".repeat(60), "__proto__"]) {
      const r = await call(admin, "PUT", `/api/league/import/${lid}/overrides/${starId}`, { seasonOver: true });
      assert.ok([400, 404].includes(r.status), `league ${lid.slice(0, 20)} → ${r.status}`);
    }
    assert.deepEqual(dataFiles(), before);
  });

  test("body fuzz: wrong types, arrays, strings, null, prototype pollution, text/plain, oversize → 4xx, nothing written", async () => {
    const p = `/api/league/import/yY/overrides/${starId}`;
    const bodies = ["true", "[true]", '"true"', "null", '{"seasonOver":1}', '{"seasonOver":"false"}', '{"seasonOver":null}', '{"__proto__":{"seasonOver":true}}', '{"constructor":{"prototype":{"seasonOver":true}}}', "{bad json", ""];
    for (const b of bodies) {
      const r = await raw(admin, "PUT", p, b);
      assert.ok(r.status >= 400 && r.status < 500, `body ${b} → ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    }
    assert.ok((await raw(admin, "PUT", p, '{"seasonOver":true}', { "content-type": "text/plain" })).status >= 400);
    assert.equal((await raw(admin, "PUT", p, JSON.stringify({ seasonOver: true, pad: "x".repeat(1_200_000) }))).status, 413);
    assert.equal(fs.existsSync(marksFile()), false);
    assert.equal(({} as Record<string, unknown>).seasonOver, undefined, "no prototype pollution");
  });

  test("concurrent toggles through the API: every write lands, the file stays one valid version, the last write per player wins", async () => {
    const vals = (await call(admin, "GET", "/api/league/import/yY/values")).json as any[];
    const ids = vals.filter((v) => /^\d\d-\d+$/.test(v.id)).slice(0, 25).map((v) => v.id as string);
    const rs = await Promise.all(ids.map((id, i) => call(admin, "PUT", `/api/league/import/yY/overrides/${id}`, { seasonOver: i % 2 === 0 })));
    assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.filter((r) => r.status !== 200)));
    const file = JSON.parse(fs.readFileSync(marksFile(), "utf8"));
    assert.equal(Object.keys(file.players).length, ids.length);
    // Interleaved PUT / DELETE on one player, in order: the last (DELETE) wins.
    const one = ids[0];
    await Promise.all([
      call(admin, "PUT", `/api/league/import/yY/overrides/${one}`, { seasonOver: false }),
      call(admin, "PUT", `/api/league/import/yY/overrides/${one}`, { seasonOver: true }),
    ]);
    await Promise.all(ids.map((id) => call(admin, "DELETE", `/api/league/import/yY/overrides/${id}`)));
    assert.equal(fs.existsSync(marksFile()), false, "all cleared → file removed");
    assert.ok(!dataFiles().some((f) => f.endsWith(".tmp")), `no tmp files left: ${dataFiles().join(",")}`);
  });

  test("marks stay in their league and refresh every cached view (values, analysis, waivers)", async () => {
    // Warm every cache first.
    const v0 = await valueRow("yY", starId);
    const an0 = (await call(admin, "GET", "/api/league/import/yY/analysis")).json;
    const w0 = (await call(admin, "GET", "/api/league/import/yY/waivers")).json;
    assert.ok(v0.value > 0);
    assert.ok(w0 && an0);
    assert.equal((await call(admin, "PUT", `/api/league/import/yY/overrides/${starId}`, { seasonOver: true })).status, 200);
    assert.equal((await valueRow("yY", starId)).value, 0);
    assert.notDeepEqual((await call(admin, "GET", "/api/league/import/yY/analysis")).json, an0, "analysis recomputed");
    // The same player in league yZ (same roster copy) is untouched, for the admin and for yZ's member.
    const zRow = await valueRow("yZ", starId);
    assert.equal(zRow.value, v0.value);
    assert.equal(zRow.seasonStatus, undefined);
    assert.equal((await call(z, "GET", `/api/league/import/yZ/values?id=${starId}`)).json[0].seasonStatus, undefined);
    // yZ's member cannot read yY's marks through the league routes.
    assert.equal((await call(z, "GET", `/api/league/import/yY/values?id=${starId}`)).status, 403);
    assert.equal((await call(admin, "DELETE", `/api/league/import/yY/overrides/${starId}`)).status, 200);
    assert.equal((await valueRow("yY", starId)).value, v0.value);
  });

  test("a toggle over a corrupt marks file sets it aside (kept as .corrupt-<ts>, never deleted) and writes the new mark", async () => {
    // Expectation changed by the owner decision 2026-10-31 (was: the PUT fails and leaves the file in place).
    fs.mkdirSync(dataDir, { recursive: true });
    const bad = '{"version":1,"players":{';
    fs.writeFileSync(marksFile("yZ"), bad);
    const before = new Set(dataFiles());
    const r = await call(admin, "PUT", `/api/league/import/yZ/overrides/${starId}`, { seasonOver: true });
    assert.equal(r.status, 200, `PUT over a corrupt file → ${r.status} ${JSON.stringify(r.json)}`);
    const aside = dataFiles().filter((f) => f.startsWith("overrides-yZ.json.corrupt-") && !before.has(f));
    assert.equal(aside.length, 1, dataFiles().join(","));
    assert.equal(fs.readFileSync(path.join(dataDir, aside[0]), "utf8"), bad, "the unreadable copy is kept byte for byte");
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(marksFile("yZ"), "utf8")).players), [starId]);
    assert.equal((await valueRow("yZ", starId)).value, 0, "the new mark applies");
    assert.equal((await call(admin, "DELETE", `/api/league/import/yZ/overrides/${starId}`)).status, 200);
    fs.writeFileSync(marksFile("yZ"), JSON.stringify({ version: 1, players: {} }));
  });

  test("a mark PUT and the league DELETE share one lock: a PUT queued behind a league delete never resurrects its marks", async () => {
    const { withLock } = await import("../providers/lock.js");
    const { IMPORT_LOCK } = await import("../api.js");
    const imp = await call(admin, "POST", "/api/import", { ...yLeague("yQ"), leagueId: "557" });
    assert.equal(imp.status, 200);
    assert.equal(imp.json.id, "yQ");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = withLock(IMPORT_LOCK, () => gate);
    // Both start while the lock is held; the league DELETE is queued first, then the mark PUT.
    const del = call(admin, "DELETE", "/api/import/yQ");
    await new Promise((r) => setTimeout(r, 50));
    const put = call(admin, "PUT", `/api/league/import/yQ/overrides/${starId}`, { seasonOver: true });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fs.existsSync(marksFile("yQ")), false, "nothing written while the lock is held");
    release();
    await held;
    assert.equal((await del).status, 200);
    assert.equal((await put).status, 404, "the league is gone: the mark is refused");
    assert.equal(fs.existsSync(marksFile("yQ")), false, "no orphan marks file");
  });

  test(
    "a corrupt marks file must not take the whole league down: values / analysis / waivers still served, marks unknown",
    async () => {
      fs.writeFileSync(marksFile("yZ"), "{not json");
      try {
        for (const p of ["values", "analysis", "waivers"]) {
          const r = await call(admin, "GET", `/api/league/import/yZ/${p}?refresh=1`);
          assert.equal(r.status, 200, `${p} → ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
        }
      } finally {
        fs.writeFileSync(marksFile("yZ"), JSON.stringify({ version: 1, players: {} }));
      }
    },
  );

  test("deleting a league removes even a corrupt marks file; a re-import of the same id starts with no marks", async () => {
    fs.writeFileSync(marksFile("yZ"), "{not json");
    assert.equal((await call(admin, "DELETE", "/api/import/yZ")).status, 200);
    assert.equal(fs.existsSync(marksFile("yZ")), false);
    assert.equal((await call(admin, "POST", "/api/import", yLeague("yZ"))).status, 200);
    assert.equal((await valueRow("yZ", starId)).seasonStatus, undefined);
  });
});
