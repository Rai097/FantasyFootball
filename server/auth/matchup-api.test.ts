// Matchups and results log through the real guard + auth routes + apiRouter in-process (harness from
// accuracy-api.test.ts: fake Discord, sessions and access.json in a temp dir; cwd moves there BEFORE the app modules
// load, so imports, projlog and matchlog files are written there, never the repo's .data/). The payload's matchups are
// the real (anonymized) Yahoo fixtures read by the collector's own parsers, relabelled to the calendar's current week.
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

describe("matchups log (import v9)", { timeout: 300_000 }, () => {
  test("an import with matchups writes .data/matchlog-<id>.json after the save: W and W−1, the owner's pages, Yahoo's totals", async () => {
    const r = await call(admin, "POST", "/api/import", { ...mLeague(), matchupWeek: W, matchups: await fixtureMatchups(W) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await projCaptureIdle();
    assert.ok(logs.some((l) => new RegExp(`\\[matchlog\\] import=yM week=${W} weeks=${W}:live:6p/1pg,${W - 1}:final:6p/1pg written=3`).test(l)), logs.filter((l) => l.includes("matchlog")).join("\n"));
    const log = readLog();
    assert.equal(log.currentWeek, W);
    assert.deepEqual(Object.keys(log.weeks).sort(), [String(W - 1), String(W)].sort());
    const prev = log.weeks[String(W - 1)];
    assert.equal(prev.status, "final");
    assert.ok(prev.pages["4-3"], "the owner's final page");
    assert.equal(prev.pages["4-3"].sides[0].rows[0].name, "Joe Burrow");
    // Week W−1 is final and was first recorded now (after its kickoffs): Yahoo's final-page "Proj" = its pre-game number.
    assert.deepEqual([prev.yahooLock["4"].proj, prev.yahooLock["4"].pregame, prev.yahooLock["3"].proj], [123.86, false, 134.97]);
    assert.equal(storedImport().projWeek, W, "projWeek = the calendar's week (v8)");
    assert.equal(storedImport().matchupWeek, W, "Yahoo's matchup week kept apart for the matchups");
    assert.ok(!(storedImport().diagnostics ?? []).some((d: any) => d.step === "matchups" && d.level === "warning"));
  });

  test("bad matchups never refuse the import: dropped with a diagnostics note, the stored log untouched", async () => {
    const before = fs.readFileSync(logFile(), "utf8");
    const r = await call(admin, "POST", "/api/import", { ...mLeague(), matchupWeek: W, matchups: { weeks: [{ week: W, pairings: "x" }, { week: 1, pairings: [] }, "junk"] } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await projCaptureIdle();
    const d = storedImport().diagnostics.filter((x: any) => x.step === "matchups");
    assert.ok(d.some((x: any) => /dropped: bad shape/.test(x.note)), JSON.stringify(d));
    const log = readLog();
    // The week-W entry gets this capture's status only; its stored pairings and pages are kept (a fetch never removes).
    assert.equal(log.weeks[String(W)].pairings.length, 6);
    assert.ok(log.weeks[String(W)].pages["4-7"]);
    assert.equal(JSON.parse(before).weeks[String(W - 1)].fetchedAt, log.weeks[String(W - 1)].fetchedAt, "week W−1 not in this capture: untouched");
  });

  test("an older bookmark (no matchups) leaves the log alone and logs nothing for it", async () => {
    const before = fs.readFileSync(logFile(), "utf8");
    const n = logs.filter((l) => l.includes("[matchlog]")).length;
    const r = await call(admin, "POST", "/api/import", mLeague());
    assert.equal(r.status, 200);
    await projCaptureIdle();
    assert.equal(fs.readFileSync(logFile(), "utf8"), before);
    assert.equal(logs.filter((l) => l.includes("[matchlog]")).length, n);
    assert.equal(storedImport().projWeek, W, "no Yahoo week: the calendar's");
  });

  test("rollover: Yahoo's week differs from the NFL calendar's → diagnostics note; projWeek stays the calendar's, Yahoo's week used for the matchups and the projlog capture", async () => {
    const yw = W + 1 <= 18 ? W + 1 : W - 1;
    const r = await call(admin, "POST", "/api/import", { ...mLeague(), id: "yR", leagueId: "999", matchupWeek: yw, matchups: await fixtureMatchups(yw) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await projCaptureIdle();
    const s = storedImport("yR");
    assert.equal(s.projWeek, W, "fix round 1: projWeek keeps its v8 meaning");
    assert.equal(s.matchupWeek, yw);
    assert.ok(s.diagnostics.some((d: any) => d.step === "matchups" && new RegExp(`week ${yw} differs from the NFL calendar's week ${W}`).test(d.note)));
    assert.ok(logs.some((l) => new RegExp(`\\[projlog\\] import=yR week=${yw} `).test(l)), "projlog capture week = Yahoo's");
    assert.equal(readLog("yR").currentWeek, yw);
  });

  test("GET matchup: auth fails closed (401 / 403 / demo + yahoo 404); bad week 400; own league 200", async () => {
    const none = await call(null, "GET", "/api/league/import/yM/matchup");
    assert.equal(none.status, 401);
    assert.equal(none.json.week, undefined);
    const other = await call(c, "GET", "/api/league/import/yM/matchup");
    assert.equal(other.status, 403);
    assert.equal(other.json.week, undefined);
    assert.equal((await call(a, "GET", "/api/league/import/yZ/matchup")).status, 403);
    assert.equal((await call(a, "GET", "/api/league/yahoo/yM/matchup")).status, 403);
    assert.equal((await call(admin, "GET", "/api/league/demo/42/matchup")).status, 404);
    assert.equal((await call(admin, "GET", "/api/league/yahoo/yM/matchup")).status, 404);
    assert.equal((await call(admin, "GET", "/api/league/import/nope/matchup")).status, 404);
    for (const w of ["0", "19", "x", "1.5", "1e1", "0x8", "+8", " 8", "008"]) assert.equal((await call(admin, "GET", `/api/league/import/yM/matchup?week=${w}`)).status, 400, w);
    assert.equal((await call(a, "GET", "/api/league/import/yM/matchup?team=1")).status, 403, "a user cannot pick another team");
    assert.equal((await call(a, "GET", "/api/league/import/yM/matchup")).status, 200);
  });

  test("GET matchup: current week (default) and the final week before; mine first, others, record; payload ≤ 30 KB", async () => {
    const p = await call(admin, "POST", "/api/import", { ...mLeague(), matchupWeek: W, matchups: await fixtureMatchups(W) });
    assert.equal(p.status, 200);
    await projCaptureIdle();
    const r = await call(a, "GET", "/api/league/import/yM/matchup");
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.bytes <= 30_000, `${r.bytes} bytes`);
    const j = r.json;    assert.deepEqual([j.week, j.currentWeek, j.status], [W, W, "live"]);
    assert.ok(j.weeks.includes(W) && j.weeks.includes(W - 1));
    assert.equal(j.mine.lineupSource, "page");
    assert.deepEqual(j.mine.sides.map((s: any) => s.teamId), ["4", "7"]);
    assert.equal(j.mine.sides[0].yahooLive, 131.79);
    assert.equal(j.mine.rows[0].a.name, "Joe Burrow");
    assert.equal(j.mine.rows[0].a.points, null, "'–' on Yahoo's page: null, never 0");
    for (const s of j.mine.sides) assert.ok(s.ours === null ? s.oursIncomplete > 0 : s.oursIncomplete === 0, JSON.stringify(s));
    assert.equal(j.others.length, 5);
    assert.ok(typeof j.teams["7"] === "string");
    // Week W−1 (final): Yahoo's totals and points from the final page; no projlog for it → ours not recorded.
    const prev = await call(a, "GET", `/api/league/import/yM/matchup?week=${W - 1}`);
    assert.equal(prev.status, 200);
    assert.deepEqual([prev.json.status, prev.json.mine.sides[0].yahoo, prev.json.mine.sides[0].points, prev.json.mine.sides[1].yahoo], ["final", 123.86, 165.78, 134.97]);
    const rw = prev.json.record.weeks.find((x: any) => x.week === W - 1);
    assert.ok(rw && rw.games[0].mine && rw.games[0].yahooCall === false, JSON.stringify(rw?.games[0]));
    assert.equal(prev.json.record.summary.teamWeeks, 0, "no projection of ours for W−1: not in the metrics");
    // User B (team 1): their own pairing, starters from the import's Yahoo slots (no page read for it).
    const rb = await call(b, "GET", "/api/league/import/yM/matchup");
    assert.equal(rb.status, 200);
    assert.equal(rb.json.mine.sides[0].teamId, "1");
    assert.equal(rb.json.mine.lineupSource, "import");
    assert.equal(rb.json.mine.rows.length, 9);
  });

  test("GET matchup: a new matchlog write invalidates the cached answer", async () => {
    const first = await call(admin, "GET", "/api/league/import/yM/matchup");
    assert.equal(first.json.mine.sides[0].points, 0);
    const m = await fixtureMatchups(W);
    m.weeks[0].pairings[0].sides[0].points = 42.5;
    await call(admin, "POST", "/api/import", { ...mLeague(), matchupWeek: W, matchups: m });
    await projCaptureIdle();
    const second = await call(admin, "GET", "/api/league/import/yM/matchup");
    assert.equal(second.json.mine.sides[0].points, 42.5);
  });

  test("deleting the league removes its matchups log", async () => {
    assert.ok(fs.existsSync(logFile("yR")));
    const d = await call(admin, "DELETE", "/api/import/yR");
    assert.equal(d.status, 200);
    assert.equal(fs.existsSync(logFile("yR")), false);
  });
});
