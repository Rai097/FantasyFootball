// GET /api/league/:provider/:id/accuracy and the import-time projection capture, through the real guard + auth routes +
// apiRouter in-process (fake Discord, sessions and access.json in a temp dir; cwd moves to that temp dir BEFORE the app
// modules load, so imports and projlog files are written there, never the repo's .data/). Harness copied from
// waivers-api.adversarial.test.ts.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { detailProblems } from "../model/testkit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-acc-"));
fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.symlinkSync(path.join(ROOT, ".cache"), path.join(work, ".cache"), "dir");
process.chdir(work);
const { createAuth } = await import("./routes.js");
const { AccessFile } = await import("./access.js");
const { SessionStore } = await import("./sessions.js");
const { apiRouter, errorMiddleware, projCaptureIdle } = await import("../api.js");
const { authRouter } = await import("../auth.js");
const { getPlayerDb } = await import("../data/players.js");
const { getSeasonTables } = await import("../data/signalTables.js");
const { score } = await import("../model/scoring.js");
type SessionIO = import("./sessions.js").SessionIO;
type SessionRow = import("./sessions.js").SessionRow;
type ProjLog = import("../model/projLog.js").ProjLog;
type ProjEntry = import("../model/projLog.js").ProjEntry;

const PUBLIC_URL = "https://ff.example";
const SECRET = "acc-session-secret-0123456789-abcdef";
const ADMIN = "100000000000000001";
const A = "200000000000000002"; // league yY team 4
const C = "500000000000000005"; // league yZ team 1
const accessFile = path.join(work, "access.json");
fs.writeFileSync(
  accessFile,
  JSON.stringify({
    admins: [ADMIN],
    users: [
      { discordId: A, leagueId: "yY", teamId: "4", note: "A" },
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

let admin: Who, a: Who, c: Who;
let demo: any;
const logFile = () => path.join(work, ".data", "projlog-yY.json");

/** An import league built from the demo league's real players: two starters per team, the rest on the bench, Yahoo weekly 10. */
function yLeague(): any {
  const teams = demo.league.teams.map((t: any, i: number) => ({
    id: String(i + 1),
    name: `Team ${i + 1}`,
    players: t.playerIds.map((pid: string, j: number) => {
      const p = demo.players[pid];
      return { yahooId: p.ids?.yahoo, name: p.name, pos: p.pos, team: p.team, slot: j < 2 ? p.pos : "BN", yahooProjWeekly: 10 };
    }),
  }));
  // A first import carrying an old importedAt (replayed payload): the capture must use the server's clock.
  return { importedAt: "2020-01-01T00:00:00.000Z", id: "yY", leagueId: "555", name: "League Y", numTeams: 12, slots: ["QB", "WR", "WR", "RB", "TE", "W/R/T", "W/R/T", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR", "IR"], scoring: { rec: 1 }, settingsSource: "page", teams, myTeamId: "1" };
}

before(
  async () => {
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (const k of ["log", "warn"] as const) console[k] = (...x: unknown[]) => void logs.push(x.map(String).join(" "));
    admin = await signIn(ADMIN);
    a = await signIn(A);
    c = await signIn(C);
    const an = await call(admin, "GET", "/api/league/demo/42/analysis");
    assert.equal(an.status, 200);
    demo = an.json;
    const y = await call(admin, "POST", "/api/import", yLeague());
    assert.equal(y.status, 200, JSON.stringify(y.json));
    const z = await call(admin, "POST", "/api/import", { id: "yZ", leagueId: "777", name: "League Z", teams: [{ id: "1", name: "Z1", players: [] }] });
    assert.equal(z.status, 200);
    await projCaptureIdle();
  },
  { timeout: 300_000 },
);
after(() => server?.close());

describe("projection accuracy API", { timeout: 300_000 }, () => {
  test("import capture: only skill players, only before their own kickoff, Yahoo only for the capture week", async () => {
    const db = await getPlayerDb();
    const week = db.state.currentWeek;
    const { games } = await getSeasonTables(db.season);
    const kick = new Map<string, number>();
    for (const g of games.values()) if (g.week === week && g.kickoff) (kick.set(g.home, Date.parse(g.kickoff)), kick.set(g.away, Date.parse(g.kickoff)));
    assert.ok(logs.some((l) => /\[projlog\] import=yY week=\d+ kept=\d+ ignored=\d+/.test(l)), `capture logged:\n${logs.filter((l) => l.includes("projlog")).join("\n")}`);
    const log: ProjLog | null = fs.existsSync(logFile()) ? JSON.parse(fs.readFileSync(logFile(), "utf8")) : null;
    const entries: ProjEntry[] = Object.values(log?.weeks?.[String(week)] ?? {});
    for (const e of entries) {
      assert.ok(Date.parse(e.capturedAt) > Date.parse("2025-01-01"), `${e.name}: capturedAt ${e.capturedAt} taken from the payload`);
      assert.ok(["QB", "RB", "WR", "TE"].includes(e.pos), `${e.name} ${e.pos}`);
      const k = kick.get(e.team);
      assert.ok(k !== undefined && Date.parse(e.capturedAt) < k, `${e.name} (${e.team}) captured at/after kickoff`);
      assert.equal(e.yahoo, 10);
      assert.ok(Number.isFinite(e.app) && e.app >= 0);
      assert.equal(typeof e.starter, "boolean");
    }
    // Every skill player whose kickoff is still ahead was captured (real calendar: may be none late in the week).
    const ahead = [...kick.values()].some((k) => k > Date.parse(entries[0]?.capturedAt ?? new Date().toISOString()));
    if (ahead) assert.ok(entries.length > 0, "kickoffs ahead but nothing captured");
  });

  test("auth fails closed: no session 401, another league 403, demo / yahoo 404; own league 200", async () => {
    const none = await call(null, "GET", "/api/league/import/yY/accuracy");
    assert.equal(none.status, 401);
    assert.equal(none.json.season, undefined);
    const other = await call(c, "GET", "/api/league/import/yY/accuracy");
    assert.equal(other.status, 403);
    assert.equal(other.json.season, undefined);
    assert.equal((await call(a, "GET", "/api/league/import/yZ/accuracy")).status, 403);
    assert.equal((await call(a, "GET", "/api/league/yahoo/yY/accuracy")).status, 403);
    assert.equal((await call(admin, "GET", "/api/league/demo/42/accuracy")).status, 404);
    assert.equal((await call(admin, "GET", "/api/league/import/nope/accuracy")).status, 404);
    assert.equal((await call(a, "GET", "/api/league/import/yY/accuracy")).status, 200);
  });

  test("resolved past weeks: same-set comparison, did-not-play kept out, Vs Yahoo bullet ≤ 90 chars, payload < 60 KB", async () => {
    const db = await getPlayerDb();
    const imp = JSON.parse(fs.readFileSync(path.join(work, ".data", "import-yY.json"), "utf8"));
    const scoring = imp.scoring;
    // Synthetic captures for past weeks (real actuals from the player db): rostered skill players with stat rows.
    const log: ProjLog = fs.existsSync(logFile()) ? JSON.parse(fs.readFileSync(logFile(), "utf8")) : { season: db.season, weeks: {} };
    const rostered = demo.league.teams.flatMap((t: any, i: number) => t.playerIds.map((id: string) => ({ id, teamId: String(i + 1) })));
    const weeks = [1, 2, 3, 4].filter((w) => w < db.state.currentWeek);
    assert.ok(weeks.length >= 3, "needs 3 played weeks in the cached season");
    let target: { id: string; name: string } | undefined;
    let dnp: { id: string; week: number } | undefined;
    const final = new Set<string>();
    for (const g of (await getSeasonTables(db.season)).games.values()) if (g.result !== undefined) (final.add(`${g.home}|${g.week}`), final.add(`${g.away}|${g.week}`));
    for (const { id, teamId } of rostered) {
      const p = db.players.get(id);
      if (!p || !["QB", "RB", "WR", "TE"].includes(p.pos)) continue;
      for (const w of weeks) {
        const line = p.weeks.find((x) => x.season === db.season && x.week === w);
        const team = line?.team ?? p.team;
        if (!line && !(final.has(`${team}|${w}`) && !dnp)) continue;
        if (!line) dnp = { id, week: w };
        (log.weeks[String(w)] ??= {})[id] = { id, name: p.name, pos: p.pos, team, teamId, starter: true, app: 8, yahoo: 7, capturedAt: "2026-09-01T00:00:00.000Z" };
      }
      if (!target && weeks.every((w) => p.weeks.some((x) => x.season === db.season && x.week === w))) target = { id, name: p.name };
    }
    // A played row without a Yahoo number: app-only, never in the comparison.
    assert.ok(target, "a rostered player who played every synthetic week");
    const first = Object.values(log.weeks[String(weeks[0])]).find((e) => e.id !== target!.id && e.id !== dnp?.id)!;
    delete first.yahoo;
    fs.writeFileSync(logFile(), JSON.stringify(log));

    const r = await call(admin, "GET", "/api/league/import/yY/accuracy?refresh=1");
    assert.equal(r.status, 200);
    assert.ok(r.bytes < 60_000, `${r.bytes} bytes`);
    const j = r.json;
    assert.ok(j.season.n > 0);
    assert.deepEqual(j.weeks.filter((w: number) => weeks.includes(w)), weeks);
    // Recompute the comparison independently from the db (same set: played + both projections).
    let n = 0;
    let appErr = 0;
    let yErr = 0;
    for (const w of weeks)
      for (const e of Object.values(log.weeks[String(w)])) {
        const line = db.players.get(e.id)?.weeks.find((x) => x.season === db.season && x.week === w);
        if (!line || e.yahoo === undefined) continue;
        const pts = Math.round(score(scoring, line.actual, e.pos) * 100) / 100;
        n++;
        appErr += Math.abs(pts - e.app);
        yErr += Math.abs(pts - e.yahoo);
      }
    const pastOnly = j.byWeek.filter((x: any) => weeks.includes(x.week)).reduce((s: number, x: any) => s + x.n, 0);
    assert.equal(pastOnly, n, "compared player-weeks = played with both projections");
    const wk = j.byWeek.filter((x: any) => weeks.includes(x.week));
    const mae = wk.reduce((s: number, x: any) => s + x.appMae * x.n, 0) / n;
    assert.ok(Math.abs(mae - appErr / n) < 0.05, `app MAE ${mae} vs ${appErr / n}`);
    assert.ok(Math.abs(wk.reduce((s: number, x: any) => s + x.yahooMae * x.n, 0) / n - yErr / n) < 0.05);
    assert.ok(j.counts.noYahoo >= 1, "the Yahoo-less row is counted apart");
    if (dnp) assert.ok(j.counts.dnp >= 1, "a final game with no stat row = did not play");
    assert.ok(j.teams.length > 0 && j.teams.every((t: any) => typeof t.name === "string" && t.name.length > 0));
    assert.ok(j.mostBeat.length <= 5 && j.mostMissed.length <= 5);

    // Value details: the "Vs Yahoo" bullet for a player with ≥ 3 compared weeks.
    const v = await call(admin, "GET", `/api/league/import/yY/values?id=${encodeURIComponent(target!.id)}&refresh=1`);
    assert.equal(v.status, 200);
    const item = v.json[0].whyItems.find((x: any) => x.label === "Vs Yahoo");
    assert.ok(item, `${target!.name}: no Vs Yahoo bullet in ${JSON.stringify(v.json[0].whyItems.map((x: any) => x.label))}`);
    assert.match(item.value, /^[+−±]\d+\.\d pts\/wk over \d+ wks \(beat \d+ of \d+\)$/);
    assert.deepEqual(detailProblems([item]), []);
  });

  test("deleting the league removes its projection log", async () => {
    assert.ok(fs.existsSync(logFile()));
    const d = await call(admin, "DELETE", "/api/import/yY");
    assert.equal(d.status, 200);
    assert.equal(fs.existsSync(logFile()), false);
  });
});
