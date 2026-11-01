// ADVERSARIAL tests for the matchups backend (import v9 → matchlog → GET matchup), harness copied from
// matchup-api.test.ts (fake Discord, temp dir cwd, never the repo's .data/). Known defects are `todo: "DEFECT …"` so the
// suite stays green; remove the todo when fixed. Fixtures: the real (anonymized) Yahoo pages, relabelled to week W.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-match-"));
fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.symlinkSync(path.join(ROOT, ".cache"), path.join(work, ".cache"), "dir");
process.chdir(work);
const { createAuth } = await import("./routes.js");
const { AccessFile } = await import("./access.js");
const { SessionStore } = await import("./sessions.js");
const { apiRouter, errorMiddleware, projCaptureIdle } = await import("../api.js");
const { authRouter } = await import("../auth.js");
const { getPlayerDb } = await import("../data/players.js");
const { collectMatchups } = await import("../../web/src/import/matchups.js");
type SessionIO = import("./sessions.js").SessionIO;
type SessionRow = import("./sessions.js").SessionRow;
type MatchLog = import("../model/matchLog.js").MatchLog;

const PUBLIC_URL = "https://ff.example";
const SECRET = "match-session-secret-0123456789-abcdef";
const ADMIN = "100000000000000001";
const A = "200000000000000002"; // league yM team 4 (the importer's pairing)
const B = "300000000000000003"; // league yM team 1 (another pairing)
const C = "500000000000000005"; // league yZ team 1
const accessFile = path.join(work, "access.json");
fs.writeFileSync(
  accessFile,
  JSON.stringify({
    admins: [ADMIN],
    users: [
      { discordId: A, leagueId: "yM", teamId: "4", note: "A" },
      { discordId: B, leagueId: "yM", teamId: "1", note: "B" },
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
let demo: any;
let W = 0;
const logFile = (id = "yM") => path.join(work, ".data", `matchlog-${id}.json`);
const readLog = (id = "yM"): MatchLog => JSON.parse(fs.readFileSync(logFile(id), "utf8"));
const storedImport = (id = "yM") => JSON.parse(fs.readFileSync(path.join(work, ".data", `import-${id}.json`), "utf8"));

/** The fixtures as the collector reads them (weeks 8 / 7), relabelled to weeks `w` / `w − 1`. */
async function fixtureMatchups(w: number): Promise<any> {
  const dir = path.join(ROOT, "server/providers/fixtures/matchups");
  const B = "https://y.test/f1/1405188";
  const pages: Record<string, string> = {
    [B]: "league-home-module-w8-live.html",
    [`${B}?matchup_week=7&module=matchups`]: "league-home-module-w7-final.html",
    [`${B}/matchup?week=8&mid1=4&mid2=7`]: "matchup-w8-live.html",
    [`${B}/matchup?week=7&mid1=4&mid2=3`]: "matchup-w7-final.html",
  };
  const r = await collectMatchups({ base: B, leagueId: "1405188", myTeamId: "4", getPage: async (u) => ({ ok: true, status: 200, html: fs.readFileSync(path.join(dir, pages[u]), "utf8") }) });
  const m = JSON.parse(JSON.stringify(r.matchups));
  m.weeks[0].week = w;
  m.weeks[1].week = w - 1;
  return m;
}

/** An import league from the demo league's real players (12 teams, ids 1–12): 9 starters per team, the rest bench. */
function mLeague(extra: Record<string, unknown> = {}): any {
  const teams = demo.league.teams.map((t: any, i: number) => ({
    id: String(i + 1),
    name: `Team ${i + 1}`,
    players: t.playerIds.map((pid: string, j: number) => {
      const p = demo.players[pid];
      return { yahooId: p.ids?.yahoo, name: p.name, pos: p.pos, team: p.team, slot: j < 9 ? p.pos : "BN", yahooProjWeekly: 10 };
    }),
  }));
  return { id: "yM", leagueId: "1405188", name: "League M", numTeams: 12, slots: ["QB", "WR", "WR", "RB", "TE", "W/R/T", "W/R/T", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR", "IR"], scoring: { rec: 1 }, settingsSource: "page", teams, myTeamId: "4", ...extra };
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
    demo = an.json;
    W = (await getPlayerDb()).state.currentWeek;
    assert.ok(W >= 2 && W <= 18, `calendar week ${W}`);
    const z = await call(admin, "POST", "/api/import", { id: "yZ", leagueId: "777", name: "League Z", teams: [{ id: "1", name: "Z1", players: [] }] });
    assert.equal(z.status, 200);
  },
  { timeout: 300_000 },
);
after(() => server?.close());

const weeklyServed = (j: unknown) => (JSON.stringify(j).match(/"yahooProjWeekly":/g) ?? []).length;

describe("matchups adversarial (import v9)", { timeout: 300_000 }, () => {
  test("hostile matchups payloads never refuse the import, never fail a capture, and store the rosters exactly as a v8 import", async () => {
    const v8 = await call(admin, "POST", "/api/import", mLeague());
    assert.equal(v8.status, 200);
    await projCaptureIdle();
    const teamsV8 = JSON.stringify(storedImport().teams);
    const hostile: [string, Record<string, unknown>][] = [
      ["matchupWeek as a string", { matchupWeek: String(W) }],
      ["matchupWeek 0", { matchupWeek: 0 }],
      ["matchupWeek 99", { matchupWeek: 99 }],
      ["matchupWeek 1.5", { matchupWeek: 1.5 }],
      ["matchups null", { matchupWeek: W, matchups: null }],
      ["matchups array", { matchupWeek: W, matchups: [1, 2, 3] }],
      ["matchups without matchupWeek", { matchups: { weeks: [{ week: W, pairings: [], pages: [] }] } }],
      ["weeks not an array", { matchupWeek: W, matchups: { weeks: "x" } }],
      ["4000 junk weeks", { matchupWeek: W, matchups: { weeks: Array.from({ length: 4000 }, (_, i) => ({ week: i, pairings: [{}], pages: [[]] })) } }],
      ["deep junk", { matchupWeek: W, matchups: { weeks: [{ week: W, pairings: [{ mid1: "1", mid2: "1", sides: [{}, {}] }, null, 7], pages: [{ mid1: 4, mid2: 7, sides: [{ teamId: "4", rows: "x" }, null] }] }] } }],
      ["numbers out of range / strings", { matchupWeek: W, matchups: { weeks: [{ week: W, pairings: [{ mid1: "1", mid2: "2", sides: [{ teamId: "1", points: "99", yahooProj: 1e9 }, { teamId: "2", points: -1e9, yahooProj: null }] }], pages: [] }] } }],
      ["__proto__ keys", JSON.parse(`{"matchupWeek":${W},"matchups":{"__proto__":{"weeks":[1]},"weeks":[{"week":${W},"__proto__":{"status":"final"},"pairings":[],"pages":[]}]}}`)],
    ];
    for (const [name, extra] of hostile) {
      const r = await call(admin, "POST", "/api/import", { ...mLeague(), ...extra });
      assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.json).slice(0, 200)}`);
      await projCaptureIdle();
      assert.equal(JSON.stringify(storedImport().teams), teamsV8, `${name}: rosters stored as v8`);
    }
    assert.ok(!logs.some((l) => /capture failed/.test(l)), logs.filter((l) => /capture failed/.test(l)).join("\n"));
    assert.equal(({} as any).weeks, undefined, "no prototype pollution");
    assert.equal(({} as any).status, undefined, "no prototype pollution");
  });

  test("an invalid matchupWeek falls back to the NFL calendar: projWeek and Yahoo's weekly numbers kept", async () => {
    for (const mw of [0, 19, String(W), null]) {
      const r = await call(admin, "POST", "/api/import", { ...mLeague(), matchupWeek: mw });
      assert.equal(r.status, 200);
      await projCaptureIdle();
      assert.equal(storedImport().projWeek, W, `matchupWeek ${JSON.stringify(mw)}`);
    }
    const an = await call(admin, "GET", "/api/league/import/yM/analysis?refresh=1");
    assert.ok(weeklyServed(an.json) > 0);
  });

  // Fixed (fix round 1, decision 1): projWeek keeps its v8 meaning (the calendar's week); Yahoo's week is stored apart
  // as matchupWeek for the matchups only. The test now expects projWeek W (was W+1) and EXACTLY v8's served numbers.
  test("rollover (Yahoo already on W+1, the NFL calendar still on W): analysis and waivers serve exactly what v8 served", async () => {
    if (W >= 18) return;
    const rostered = new Set(demo.league.teams.flatMap((t: any) => t.playerIds));
    const freeAgents = Object.values<any>(demo.players)
      .filter((p) => (p.pos === "K" || p.pos === "DEF") && !rostered.has(p.id))
      .slice(0, 8)
      .map((p) => ({ ...(p.ids?.yahoo ? { yahooId: p.ids.yahoo } : {}), name: p.name, pos: p.pos, team: p.team, yahooProjWeekly: 12 }));
    const served = async () => {
      const an = (await call(admin, "GET", "/api/league/import/yM/analysis?refresh=1")).json;
      const wv = (await call(admin, "GET", "/api/league/import/yM/waivers?refresh=1")).json;
      return { analysis: weeklyServed(an), waivers: JSON.stringify(wv).match(/"weekStream":\{/g)?.length ?? 0, waiversWeekly: weeklyServed(wv) };
    };
    const v8 = await call(admin, "POST", "/api/import", mLeague({ freeAgents }));
    assert.equal(v8.status, 200);
    await projCaptureIdle();
    const before = await served();
    assert.ok(before.analysis > 0 && before.waiversWeekly > 0 && before.waivers > 0, `v8: served ${JSON.stringify(before)}`);
    const r = await call(admin, "POST", "/api/import", { ...mLeague({ freeAgents }), matchupWeek: W + 1, matchups: await fixtureMatchups(W + 1) });
    assert.equal(r.status, 200);
    await projCaptureIdle();
    assert.equal(storedImport().projWeek, W, "projWeek = the calendar's week (v8)");
    assert.equal(storedImport().matchupWeek, W + 1, "Yahoo's week kept apart, for the matchups");
    assert.deepEqual(await served(), before, "v9 rollover serves exactly v8's numbers");
    assert.equal(readLog().currentWeek, W + 1, "the matchups follow Yahoo's week");
  });

  test("rollover: the projlog still captures Yahoo's weekly numbers under Yahoo's week (held)", async () => {
    if (W >= 18) return;
    const r = await call(admin, "POST", "/api/import", { ...mLeague(), id: "yR2", leagueId: "998", matchupWeek: W + 1, matchups: await fixtureMatchups(W + 1) });
    assert.equal(r.status, 200);
    await projCaptureIdle();
    const pl = JSON.parse(fs.readFileSync(path.join(work, ".data", "projlog-yR2.json"), "utf8"));
    const entries = Object.values<any>(pl.weeks[String(W + 1)] ?? {});
    assert.ok(entries.length > 0 && entries.every((e) => e.yahoo === 10), `${entries.length} entries`);
  });

  test("a matchupWeek far from the calendar (a misread picker) is not trusted: projWeek, the projlog and the matchlog ignore it", async () => {
    const far = W > 4 ? W - 4 : W + 4;
    const before = readLog();
    const n = logs.length;
    const r = await call(admin, "POST", "/api/import", { ...mLeague(), matchupWeek: far, matchups: await fixtureMatchups(far) });
    assert.equal(r.status, 200);
    await projCaptureIdle();
    const s = storedImport();
    assert.equal(s.projWeek, W, `matchupWeek ${far} vs calendar ${W}`);
    assert.equal(s.matchupWeek, undefined);
    assert.ok(s.diagnostics.some((d: any) => d.step === "matchups" && /not trusted, matchups ignored/.test(d.note)), JSON.stringify(s.diagnostics));
    assert.deepEqual(readLog(), before, "matchlog untouched (no week far / far−1, current week unchanged)");
    assert.ok(logs.slice(n).some((l) => new RegExp(`\\[projlog\\] import=yM week=${W} `).test(l)), "projlog captures the calendar's week");
  });

  test("concurrent v9 imports (W/W−1 and W+1/W) never lose a week: both captures land in the log", async () => {
    if (W >= 18) return;
    const id = "yC";
    const m1 = await fixtureMatchups(W);
    const m2 = await fixtureMatchups(W + 1);
    const [r1, r2] = await Promise.all([
      call(admin, "POST", "/api/import", { ...mLeague(), id, leagueId: "997", matchupWeek: W, matchups: m1 }),
      call(admin, "POST", "/api/import", { ...mLeague(), id, leagueId: "997", matchupWeek: W + 1, matchups: m2 }),
    ]);
    assert.deepEqual([r1.status, r2.status], [200, 200]);
    await projCaptureIdle();
    const log = readLog(id);
    assert.deepEqual(Object.keys(log.weeks).map(Number).sort((x, y) => x - y), [W - 1, W, W + 1]);
    for (const w of [W - 1, W, W + 1]) assert.equal(log.weeks[String(w)].pairings.length, 6, `week ${w}`);
  });

  test("a later capture with nothing usable for a FINAL week never demotes it (the record keeps it)", async () => {
    const id = "yF";
    const r = await call(admin, "POST", "/api/import", { ...mLeague(), id, leagueId: "996", matchupWeek: W, matchups: await fixtureMatchups(W) });
    assert.equal(r.status, 200);
    await projCaptureIdle();
    const stored = readLog(id).weeks[String(W - 1)];
    assert.equal(stored.status, "final");
    const junk = await call(admin, "POST", "/api/import", { ...mLeague(), id, leagueId: "996", matchupWeek: W, matchups: { weeks: [{ week: W - 1, status: "unknown", pairings: [], pages: [] }] } });
    assert.equal(junk.status, 200);
    await projCaptureIdle();
    assert.deepEqual(readLog(id).weeks[String(W - 1)], stored, "the final week is kept as it was (status, points, fetchedAt)");
    const g = await call(admin, "GET", `/api/league/import/${id}/matchup?week=${W - 1}`);
    assert.equal(g.json.record.weeks.find((x: any) => x.week === W - 1)?.games.length, 6, "still in the track record");
  });

  test("GET matchup: no manager-identifying data (owner names never sent); payload ≤ 48 KB; week / team fuzz", async () => {
    const lg = mLeague();
    lg.teams = lg.teams.map((t: any, i: number) => ({ ...t, owner: `ManagerSecret${i}` }));
    const r = await call(admin, "POST", "/api/import", { ...lg, matchupWeek: W, matchups: await fixtureMatchups(W) });
    assert.equal(r.status, 200);
    await projCaptureIdle();
    for (const q of ["", `?week=${W - 1}`]) {
      const g = await call(a, "GET", `/api/league/import/yM/matchup${q}`);
      assert.equal(g.status, 200);
      assert.ok(g.bytes <= 48_000, `${g.bytes} bytes`);
      const t = JSON.stringify(g.json);
      assert.ok(!/ManagerSecret|"owner"|profile|guid|@/.test(t), t.match(/.{40}(ManagerSecret|"owner"|profile|guid|@).{40}/)?.[0]);
    }
    for (const w of ["-1", "1e400", "99999999999999999999", "NaN", "Infinity", "%00", "8;drop", "[]"]) assert.equal((await call(a, "GET", `/api/league/import/yM/matchup?week=${encodeURIComponent(w)}`)).status, 400, w);
    assert.equal((await call(a, "GET", "/api/league/import/yM/matchup?week=1&week=2")).status, 400, "repeated param");
    assert.equal((await call(b, "GET", "/api/league/import/yM/matchup?team=4")).status, 403, "B cannot view as A's team");
    assert.equal((await call(c, "GET", "/api/league/import/yM/matchup?week=7")).status, 403);
    assert.equal((await call(null, "GET", `/api/league/import/yM/matchup?week=${W}`)).status, 401);
  });

  test("delete league removes matchlog; a v8 import afterwards does not resurrect it", async () => {
    const id = "yD";
    assert.equal((await call(admin, "POST", "/api/import", { ...mLeague(), id, leagueId: "995", matchupWeek: W, matchups: await fixtureMatchups(W) })).status, 200);
    await projCaptureIdle();
    assert.ok(fs.existsSync(logFile(id)));
    assert.equal((await call(admin, "DELETE", `/api/import/${id}`)).status, 200);
    assert.equal(fs.existsSync(logFile(id)), false);
    assert.equal((await call(admin, "POST", "/api/import", { ...mLeague(), id, leagueId: "995" })).status, 200);
    await projCaptureIdle();
    assert.equal(fs.existsSync(logFile(id)), false);
  });
});

