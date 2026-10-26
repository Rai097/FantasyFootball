// ADVERSARIAL tests (tester, not developer) for GET /api/league/:provider/:id/waivers after Waivers v3, through the
// real guard + auth routes + apiRouter in-process (fake Discord, sessions and access.json in a temp dir; cwd moves
// to that temp dir BEFORE the app modules load, so imports are written there, never the repo's .data/).
// A synthetic import league is built from the demo league's real players (so names resolve), with free agents
// marked FA / on waivers / unknown, plus K and DEF without a Yahoo id.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { detailProblems, summaryProblems } from "../model/testkit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-advw-"));
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
const SECRET = "advw-session-secret-0123456789-abcdef";
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

/** Everything the user reads in a row. */
const rowText = (w: any) => [w.summary, ...w.details.map((d: any) => `${d.label}: ${d.value}`)].join("\n");
const JUNK = /\bundefined\b|\bNaN\b|\bnull\b|\bInfinity\b|\[object/;
function assertRows(json: any, where: string, rosteredIds: Set<string>, playerIds: Set<string>) {
  assert.deepEqual(summaryProblems(json.advice), [], `${where} advice: ${json.advice}`);
  for (const w of json.freeAgents) {
    assert.deepEqual(summaryProblems(w.summary), [], `${where} ${w.name}: ${w.summary}`);
    assert.deepEqual(detailProblems(w.details), [], `${where} ${w.name}`);
    assert.doesNotMatch(rowText(w), JUNK, `${where} ${w.name}:\n${rowText(w)}`);
    for (const id of playerIds) if (id.length >= 6) assert.ok(!rowText(w).includes(id), `${where} ${w.name}: raw id ${id} in row text`);
    assert.ok(!rosteredIds.has(w.id), `${where}: ${w.name} is rostered`);
    if (!w.onWaivers) {
      assert.notEqual(w.recommendation, "wait", `${where} ${w.name}: a free agent never waits`);
      assert.doesNotMatch(rowText(w), /uses your #|drop to #|Costs your waiver priority|Not worth priority|before spending priority|clears waivers/, `${where} ${w.name}:\n${rowText(w)}`);
    }
    if (w.pos === "K" || w.pos === "DEF") {
      assert.notEqual(w.recommendation, "claim", `${where} ${w.name}: K/DEF claim`);
      assert.doesNotMatch(rowText(w), /uses your #|Costs your waiver priority/, `${where} ${w.name}`);
    }
    if (w.onWaivers && w.injury && ["Q", "QUESTIONABLE", "D", "DOUBTFUL", "O", "OUT", "DNP"].includes(String(w.injury.status).toUpperCase()))
      assert.notEqual(w.recommendation, "claim", `${where} ${w.name}: injured (${w.injury.status}) waiver claim`);
  }
}

let admin: Who, a: Who, b: Who, c: Who;
let demoAnalysis: any;
let rosteredDemo = new Set<string>();
const faPlan = new Map<string, boolean | undefined | "str">(); // name → onWaivers sent

function yLeague(): any {
  const teams = demoAnalysis.league.teams.map((t: any, i: number) => ({
    id: String(i + 1),
    name: `League Y - ${t.name}`,
    players: t.playerIds.map((pid: string) => {
      const p = demoAnalysis.players[pid];
      return { yahooId: p.ids?.yahoo, name: p.name, pos: p.pos, team: p.team };
    }),
  }));
  // Free agents: the best unrostered players by value, cycling FA / waivers / unknown / string "true".
  const pool = Object.values(demoAnalysis.players as Record<string, any>)
    .filter((p) => !rosteredDemo.has(p.id) && p.pos !== "K" && p.pos !== "DEF")
    .sort((x, y) => y.value - x.value || y.ppg - x.ppg)
    .slice(0, 80);
  const kdef = Object.values(demoAnalysis.players as Record<string, any>)
    .filter((p) => !rosteredDemo.has(p.id) && (p.pos === "K" || p.pos === "DEF"))
    .slice(0, 8);
  const freeAgents = [...pool, ...kdef].map((p, i) => {
    const mode = i % 4 === 0 ? false : i % 4 === 1 ? true : i % 4 === 2 ? undefined : "str";
    faPlan.set(p.name, mode);
    const fa: Record<string, unknown> = { name: p.name, pos: p.pos, team: p.team };
    if (p.pos !== "K" && p.pos !== "DEF" && p.ids?.yahoo) fa.yahooId = p.ids.yahoo; // K / DEF: no Yahoo id, like the bookmarklet's DEF rows
    if (mode === "str") fa.onWaivers = "true";
    else if (mode !== undefined) fa.onWaivers = mode;
    return fa;
  });
  return { id: "yY", leagueId: "555", name: "League Y", numTeams: 12, slots: ["QB", "WR", "WR", "RB", "TE", "W/R/T", "W/R/T", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR", "IR"], scoring: { rec: 1 }, settingsSource: "page", teams, freeAgents, myTeamId: "1", waiverPriority: 3 };
}

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
    const an = await call(admin, "GET", "/api/league/demo/42/analysis");
    assert.equal(an.status, 200);
    demoAnalysis = an.json;
    rosteredDemo = new Set(demoAnalysis.league.teams.flatMap((t: any) => t.playerIds));
    const y = await call(admin, "POST", "/api/import", yLeague());
    assert.equal(y.status, 200, JSON.stringify(y.json));
    const z = await call(admin, "POST", "/api/import", { id: "yZ", leagueId: "777", name: "League Z", teams: [{ id: "1", name: "Z1", players: [] }, { id: "2", name: "Z2", players: [] }] });
    assert.equal(z.status, 200);
  },
  { timeout: 300_000 },
);
after(() => server?.close());

describe("waivers API (adversarial)", { timeout: 300_000 }, () => {
  test("no session → 401 signin on demo and import waivers", async () => {
    for (const p of ["/api/league/demo/42/waivers", "/api/league/import/yY/waivers", "/api/league/import/yY/waivers?team=4"]) {
      const r = await call(null, "GET", p);
      assert.equal(r.status, 401, p);
      assert.equal(r.json.code, "signin", p);
      assert.equal(r.json.freeAgents, undefined);
    }
  });

  test("another league's user → 403 and no rows", async () => {
    const r = await call(c, "GET", "/api/league/import/yY/waivers");
    assert.equal(r.status, 403);
    assert.equal(r.json.freeAgents, undefined);
    const r2 = await call(a, "GET", "/api/league/import/yZ/waivers");
    assert.equal(r2.status, 403);
  });

  test("team param forced for users: another team → 403 code team; missing / own → their team", async () => {
    const other = await call(a, "GET", "/api/league/import/yY/waivers?team=7");
    assert.equal(other.status, 403);
    assert.equal(other.json.code, "team");
    const mine = await call(a, "GET", "/api/league/import/yY/waivers");
    const explicit = await call(a, "GET", "/api/league/import/yY/waivers?team=4");
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.json, explicit.json);
    const adm4 = await call(admin, "GET", "/api/league/import/yY/waivers?team=4");
    // Same rows as the admin's view of team 4 (drops come from team 4's roster).
    assert.deepEqual(
      mine.json.freeAgents.map((w: any) => [w.id, w.drop?.id ?? null]),
      adm4.json.freeAgents.map((w: any) => [w.id, w.drop?.id ?? null]),
    );
  });

  test("the importer's waiver priority is not shown to another team's user as theirs (and the cache does not decide it)", async () => {
    // Stored waiverPriority 3 belongs to the importer's team (myTeamId 1). User A is team 4.
    const asA = await call(a, "GET", "/api/league/import/yY/waivers?refresh=1");
    assert.equal(asA.status, 200);
    assert.notEqual(asA.json.myPriority, 3, `user A (team 4) is told they hold priority #3 — the admin/importer's (team 1) priority`);
    const asAdminFor4 = await call(admin, "GET", "/api/league/import/yY/waivers?team=4");
    assert.equal(asAdminFor4.json.myPriority, asA.json.myPriority, "same team, different myPriority depending on who asked first (cache key has no viewer)");
  });

  test("admin's own team sees the stored priority", async () => {
    const r = await call(admin, "GET", "/api/league/import/yY/waivers?refresh=1");
    assert.equal(r.status, 200);
    assert.equal(r.json.myPriority, 3);
  });

  test("synthetic import: availability per free agent matches what was imported (string 'true' → unknown), K/DEF without id resolve", async () => {
    const r = await call(admin, "GET", "/api/league/import/yY/waivers?refresh=1");
    assert.equal(r.status, 200);
    assert.equal(r.json.faStatusKnown, true);
    assert.ok(r.bytes < 150_000, `payload ${r.bytes} bytes`);
    const league = await call(admin, "GET", "/api/league/import/yY");
    const rostered = new Set<string>(league.json.teams.flatMap((t: any) => t.playerIds));
    assertRows(r.json, "import", rostered, new Set(Object.keys(demoAnalysis.players)));
    let checked = 0;
    for (const w of r.json.freeAgents) {
      if (!faPlan.has(w.name)) continue;
      const sent = faPlan.get(w.name);
      const want = sent === false ? ["fa", false] : sent === true ? ["waivers", true] : ["unknown", true];
      assert.deepEqual([w.availability, w.onWaivers], want, `${w.name}: sent onWaivers=${JSON.stringify(sent)}`);
      checked++;
    }
    assert.ok(checked >= 10, `only ${checked} imported free agents came back`);
    assert.ok(r.json.freeAgents.some((w: any) => w.availability === "fa") && r.json.freeAgents.some((w: any) => w.availability === "waivers"));
    // Team names never repeat the league prefix in any row text.
    assert.equal(JSON.stringify(r.json).includes("League Y - "), false);
  });

  test("synthetic import: imported K / DEF free agents (no Yahoo id) reach the response; the 60-row cap must not crowd them out (K / DEF chips)", async () => {
    const r = await call(admin, "GET", "/api/league/import/yY/waivers");
    const kdefSent = [...faPlan.keys()].filter((n) => Object.values(demoAnalysis.players as Record<string, any>).some((p) => p.name === n && (p.pos === "K" || p.pos === "DEF")));
    assert.ok(kdefSent.length > 0);
    const back = r.json.freeAgents.filter((w: any) => w.pos === "K" || w.pos === "DEF").map((w: any) => w.name);
    const recs = r.json.freeAgents.map((w: any) => `${w.pos}:${w.recommendation}`).join(" ");
    assert.ok(back.length > 0, `no K/DEF rows at all; sent ${kdefSent.join(", ")}; got ${r.json.freeAgents.length} rows: ${recs}`);
  });

  test("demo league: payload < 150 KB; every row clean; FA rows never cost priority; K/DEF never claim", async () => {
    const r = await call(admin, "GET", "/api/league/demo/42/waivers");
    assert.equal(r.status, 200);
    assert.ok(r.bytes < 150_000, `${r.bytes} bytes`);
    assertRows(r.json, "demo", rosteredDemo, new Set(Object.keys(demoAnalysis.players)));
    for (const team of ["2", "5", "9", "12"]) {
      const t = await call(admin, "GET", `/api/league/demo/42/waivers?team=${team}`);
      assert.equal(t.status, 200);
      assert.ok(t.bytes < 150_000, `team ${team}: ${t.bytes} bytes`);
      assertRows(t.json, `demo team ${team}`, rosteredDemo, new Set());
    }
  });

  test("demo league: the K and DEF position chips have rows (streaming options are not cut by the row cap)", async () => {
    const r = await call(admin, "GET", "/api/league/demo/42/waivers");
    const n = (pos: string) => r.json.freeAgents.filter((w: any) => w.pos === pos).length;
    assert.ok(n("K") > 0 && n("DEF") > 0, `K rows ${n("K")}, DEF rows ${n("DEF")} of ${r.json.freeAgents.length}`);
  });

  test("user re-import of their league cannot change league settings or priority, but refreshes free-agent status", async () => {
    const before = (await call(admin, "GET", "/api/import/yY")).json;
    const payload = yLeague();
    Object.assign(payload, { name: "Hacked", numTeams: 20, slots: ["QB", "QB", "QB", "BN"], scoring: { rec: 0, passTd: 10 }, regularSeasonEnd: 3, finalWeek: 4, tradeDeadlineWeek: 2, waiverPriority: 1, myTeamId: "4", settingsSource: "user" });
    payload.freeAgents = payload.freeAgents.map((f: any) => ({ ...f, onWaivers: false }));
    const r = await call(a, "POST", "/api/import", payload);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const after = (await call(admin, "GET", "/api/import/yY")).json;
    for (const k of ["name", "numTeams", "slots", "scoring", "regularSeasonEnd", "finalWeek", "tradeDeadlineWeek", "waiverPriority", "settingsSource", "myTeamId", "leagueId"])
      assert.deepEqual(after[k], before[k], `user re-import changed ${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
    assert.ok(after.freeAgents.every((f: any) => f.onWaivers === false), "free-agent status refreshed");
    const w = await call(admin, "GET", "/api/league/import/yY/waivers");
    assert.ok(w.json.freeAgents.every((x: any) => x.availability === "fa" || !faPlan.has(x.name)), "waivers cache busted by the re-import");
  });
});
