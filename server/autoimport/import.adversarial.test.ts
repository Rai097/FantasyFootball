// Adversarial: the auto-import's write path (importPayload with refusePartial, the real store) and its HTTP routes
// through the real guard (Discord mode). No Chrome, no Yahoo. cwd moves to a temp dir BEFORE the app modules load, so
// every write lands there, never in the repo's .data/.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-autoimport-adv-"));
fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.symlinkSync(path.join(ROOT, ".cache"), path.join(work, ".cache"), "dir");
process.chdir(work);
const { createAuth } = await import("../auth/routes.js");
const { AccessFile } = await import("../auth/access.js");
const { SessionStore, signSessionId } = await import("../auth/sessions.js");
const { SESSION_COOKIE } = await import("../auth/guard.js");
const { apiRouter, errorMiddleware, importPayload, PartialImportError } = await import("../api.js");
const { AutoImportService, setAutoImport, STATE_FILE } = await import("./service.js");
const { writeJson } = await import("../providers/store.js");
type CollectResult = import("./collector.js").CollectResult;

const PUBLIC_URL = "https://ff.example";
const SECRET = "autoimport-adv-secret-0123456789-abcdef";
const ADMIN = "100000000000000001";
const ADMIN2 = "100000000000000003";
const USER = "200000000000000002";
const LEAGUE = "1405188";
const DATA = path.join(work, ".data");
const FILE = path.join(DATA, `import-y${LEAGUE}.json`);
const HIST = path.join(DATA, `import-y${LEAGUE}-history.json`);

fs.writeFileSync(path.join(work, "access.json"), JSON.stringify({ admins: [ADMIN, ADMIN2], users: [{ discordId: USER, leagueId: `y${LEAGUE}`, teamId: "1" }] }));
const sessions = new SessionStore({ read: async () => null, write: async () => undefined });
const auth = createAuth({
  mode: "discord",
  clientId: "cid",
  clientSecret: "client-secret",
  sessionSecret: SECRET,
  publicUrl: PUBLIC_URL,
  discord: { exchange: async () => null, me: async () => null } as never,
  sessions,
  access: new AccessFile(path.join(work, "access.json"), () => undefined),
  log: () => undefined,
});
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(auth.guard);
app.use(auth.router);
app.use(apiRouter);
app.use(errorMiddleware);

type Who = "admin" | "admin2" | "user" | "actas";
let base = "";
let server: http.Server;
const cookies: Partial<Record<Who, { cookie: string; csrf: string }>> = {};
before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [k, uid] of [["admin", ADMIN], ["admin2", ADMIN2], ["user", USER], ["actas", ADMIN]] as const) {
    const { id, session } = await sessions.create({ uid, name: k, avatar: null });
    cookies[k] = { cookie: `${SESSION_COOKIE}=${encodeURIComponent(signSessionId(id, SECRET))}`, csrf: session.csrf };
  }
  // The "actas" admin session views the app as the league member.
  const r = await call("POST", "/api/auth/act-as", "actas", {}, { discordId: USER });
  assert.equal(r.status, 200, `act-as setup: ${JSON.stringify(r.body)}`);
});
after(() => {
  setAutoImport(null);
  server.close();
  process.chdir(ROOT);
  fs.rmSync(work, { recursive: true, force: true });
});

function payload(teams: number, players = 3, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "yahoo-bookmarklet",
    id: `y${LEAGUE}`,
    leagueId: LEAGUE,
    name: "Adv league",
    numTeams: teams,
    settingsSource: "default",
    teams: Array.from({ length: teams }, (_, i) => ({
      id: String(i + 1),
      name: `Team ${i + 1}`,
      players: Array.from({ length: players }, (_, j) => ({ yahooId: String(1000 + i * 50 + j), name: `Player ${i}-${j}`, pos: "WR", team: "DET" })),
    })),
    freeAgents: [{ yahooId: "9001", name: "Free Agent", pos: "RB", team: "KC" }],
    importedAt: new Date().toISOString(),
    diagnostics: [],
    ...over,
  };
}

async function call(method: string, p: string, who?: Who, opts: { origin?: string | null; csrf?: string | null } = {}, body: unknown = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who) headers.cookie = cookies[who]!.cookie;
  const origin = opts.origin === undefined ? PUBLIC_URL : opts.origin;
  if (origin) headers.origin = origin;
  const csrf = opts.csrf === undefined ? (who ? cookies[who]!.csrf : null) : opts.csrf;
  if (csrf) headers["x-csrf-token"] = csrf;
  const r = await fetch(base + p, { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: r.status, body: json, text, retryAfter: r.headers.get("retry-after") };
}

const autoApply = async (p: Record<string, unknown>) => ({ teams: (await importPayload(p, { importedBy: "Auto-import", refusePartial: true })).stored.teams.length });

async function service(collect: () => Promise<CollectResult>, over: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const s = await AutoImportService.create(
    { enabled: true, leagueId: LEAGUE, profileDir: path.join(work, "profile-never-used"), schedule: { patterns: ["0 9 * * 0"], timezone: "America/Los_Angeles" } },
    { collect, apply: autoApply, isPartial: (e) => e instanceof PartialImportError, log: (l) => logs.push(l), noTimers: true, retryDelayMs: 0, sleep: async () => undefined, ...over },
  );
  setAutoImport(s);
  return { s, logs };
}

/** Every file under .data except Chrome-free scratch: name → content. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(DATA)) return out;
  for (const f of fs.readdirSync(DATA)) if (f.endsWith(".json") && f !== `${STATE_FILE}.json`) out[f] = fs.readFileSync(path.join(DATA, f), "utf8");
  return out;
}
const settle = () => new Promise((r) => setTimeout(r, 300));

async function seed() {
  await importPayload(payload(12, 15), { importedBy: "Admin" });
  await settle();
}

async function runAuto(res: CollectResult | (() => Promise<CollectResult>)) {
  const { s, logs } = await service(typeof res === "function" ? res : async () => res);
  const t = s.runner!.trigger("schedule");
  assert.ok(t.started);
  await t.done;
  return { s, logs };
}

// ------------------------------------------------------------------ data safety
test("garbage collector results never touch import, history or projlog files", async () => {
  await seed();
  const before = snapshot();
  assert.ok(before[`import-y${LEAGUE}.json`] && before[`import-y${LEAGUE}-history.json`], `seeded files: ${Object.keys(before)}`);
  const big = payload(12, 15);
  (big.teams as { players: Record<string, unknown>[] }[])[0].players[0].name = "x".repeat(1_100_000);
  const cases: [string, Record<string, unknown>, number][] = [
    ["teams not an array", { ...payload(12), teams: "12" }, 12],
    ["teams null", { ...payload(12), teams: null }, 12],
    ["21 teams (limit 20)", payload(21, 1), 21],
    ["41 players on a team", payload(12, 41), 12],
    ["> 1 MB", big, 12],
    ["fewer teams than stored", payload(11, 15), 11],
    ["numTeams says more than read", payload(12, 15, { numTeams: 14 }), 12],
    ["player entries are garbage", { ...payload(12, 15), teams: (payload(12, 15).teams as Record<string, unknown>[]).map((t) => ({ ...t, players: [42, "x", null] })) }, 12],
  ];
  for (const [name, p, teams] of cases) {
    const { s } = await runAuto({ ok: true, payload: p, teams });
    await settle();
    assert.equal(s.status().state, "paused", name);
    assert.deepEqual(snapshot(), before, `${name}: .data changed`);
  }
});

test("a different league in the payload never overwrites the owner's league file", async () => {
  await seed();
  const before = fs.readFileSync(FILE, "utf8");
  // importPayload itself does not check the league (index.ts's apply does): the stored owner league must survive anyway.
  await importPayload(payload(12, 15, { id: "y999", leagueId: "999" }), { importedBy: "Auto-import", refusePartial: true }).catch(() => undefined);
  await settle();
  assert.equal(fs.readFileSync(FILE, "utf8"), before);
});

test(
  "a team that read 0 players is refused (it would wipe that manager's roster)",
  async () => {
    await seed();
    const before = fs.readFileSync(FILE, "utf8");
    const p = payload(12, 15);
    (p.teams as { players: unknown[] }[])[4].players = [];
    const { s } = await runAuto({ ok: true, payload: p, teams: 12 });
    assert.equal(s.status().state, "paused");
    assert.equal(fs.readFileSync(FILE, "utf8"), before);
    // Same hole: a null team entry becomes an empty team.
    const { s: s2 } = await runAuto({ ok: true, payload: { ...payload(12, 15), teams: [...(payload(11, 15).teams as unknown[]), null] }, teams: 12 });
    assert.equal(s2.status().state, "paused", "null team entry");
    assert.equal(fs.readFileSync(FILE, "utf8"), before);
  },
);

test(
  "rosters that collapsed (every team 1 of 15 players) are refused",
  async () => {
    await seed();
    const before = fs.readFileSync(FILE, "utf8");
    const { s } = await runAuto({ ok: true, payload: payload(12, 1), teams: 12 });
    assert.equal(s.status().state, "paused");
    assert.equal(fs.readFileSync(FILE, "utf8"), before);
  },
);

test(
  "a run whose free-agent pages failed keeps the stored free agents",
  async () => {
    await seed();
    const { freeAgents: _fa, ...noFa } = payload(12, 15);
    await runAuto({ ok: true, payload: noFa, teams: 12 });
    const stored = JSON.parse(fs.readFileSync(FILE, "utf8"));
    assert.ok(Array.isArray(stored.freeAgents) && stored.freeAgents.length > 0, "stored free agents were dropped");
  },
);

test("a good run after garbage succeeds and clears the pause", async () => {
  await seed();
  const { s } = await runAuto({ ok: true, payload: payload(12, 16), teams: 12 });
  assert.equal(s.status().state, "ok");
  assert.equal(JSON.parse(fs.readFileSync(FILE, "utf8")).teams[0].players.length, 16);
});

// ------------------------------------------------------------------ concurrency: two writers
test(
  "auto-import and a manual POST /api/import paste at the same moment: both succeed, valid JSON, one coherent league, history intact",
  async () => {
  await seed();
  const histBefore = JSON.parse(fs.readFileSync(HIST, "utf8")) as unknown[];
  const a = payload(12, 14);
  const b = payload(12, 13);
  const [r1, r2] = await Promise.allSettled([autoApply(a), call("POST", "/api/import", "admin", {}, b)]);
  await settle();
  assert.equal(r1.status, "fulfilled", String((r1 as PromiseRejectedResult).reason));
  assert.equal(r2.status, "fulfilled");
  assert.equal((r2 as PromiseFulfilledResult<{ status: number }>).value.status, 200);
  const stored = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const sizes = new Set((stored.teams as { players: unknown[] }[]).map((t) => t.players.length));
  assert.equal(sizes.size, 1, "teams from two different payloads were mixed");
  assert.ok([13, 14].includes([...sizes][0]));
  const hist = JSON.parse(fs.readFileSync(HIST, "utf8")) as { teams: { playerIds: string[] }[] }[];
  // Both writes are in the history (capped at HISTORY_CAP = 8, so "+2" holds only below the cap): the last two
  // snapshots are the two payloads, and the newest one is what the league file holds.
  assert.equal(hist.length, Math.min(histBefore.length + 2, 8), "history lost entries");
  const lastTwo = hist.slice(-2).map((h) => h.teams[0].playerIds.length);
  assert.deepEqual([...lastTwo].sort(), [13, 14], `the last two snapshots are both writes (${lastTwo})`);
  assert.equal(lastTwo[1], [...sizes][0], "the newest snapshot is the stored league");
  // No leftover temp files from the atomic writes.
  assert.deepEqual(fs.readdirSync(DATA).filter((f) => f.endsWith(".tmp")), []);
  },
);

test(
  "two writes of the same file in the same millisecond: both succeed and the file is one of them (atomic)",
  async () => {
    const small = { v: "small" };
    const large = { v: "large", pad: "y".repeat(20_000) };
    for (let i = 0; i < 50; i++) {
      const results = await Promise.allSettled([writeJson("race-a", large), writeJson("race-a", small)]);
      const errs = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason));
      const text = fs.readFileSync(path.join(DATA, "race-a.json"), "utf8");
      let parsed: { v?: string } | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* corrupt */
      }
      assert.deepEqual(errs, [], `round ${i}: a writer failed`);
      assert.ok(parsed && (parsed.v === "small" || parsed.v === "large"), `round ${i}: file is corrupt (${text.length} bytes)`);
    }
  },
);

test("crash mid-write: a stray tmp file never replaces the import (readers see the old file)", async () => {
  await seed();
  const before = fs.readFileSync(FILE, "utf8");
  // What a crash between writeFile and rename leaves behind.
  fs.writeFileSync(`${FILE}.99999.1.tmp`, '{"truncat');
  await settle();
  assert.equal(fs.readFileSync(FILE, "utf8"), before);
  const r = await call("GET", "/api/import", "admin");
  assert.equal(r.status, 200);
  fs.unlinkSync(`${FILE}.99999.1.tmp`);
});

// ------------------------------------------------------------------ auth and the route
test("refresh: case / trailing-slash variants are still admin-only; act-as (admin viewing as a member) is refused", async () => {
  await service(async () => ({ ok: false, reason: "error", detail: "x" }));
  for (const p of ["/api/autoimport/refresh", "/API/AutoImport/Refresh", "/api/autoimport/refresh/", "/api//autoimport/refresh"]) {
    const r = await call("POST", p, "user");
    assert.ok(r.status === 403 || r.status === 404, `${p}: ${r.status}`);
    assert.notEqual(r.status, 202, p);
  }
  const a = await call("POST", "/api/autoimport/refresh", "actas");
  assert.equal(a.status, 403, `act-as: ${a.status} ${a.text}`);
  // Origin variants an attacker might try.
  for (const origin of ["https://ff.example.evil.com", "http://ff.example", "null", "https://FF.EXAMPLE.evil"]) {
    const r = await call("POST", "/api/autoimport/refresh", "admin", { origin });
    assert.equal(r.status, 403, origin);
  }
  assert.equal((await call("POST", "/api/autoimport/refresh", "admin", { csrf: "wrong" })).status, 403);
  // Another admin's CSRF token does not work with this admin's cookie.
  assert.equal((await call("POST", "/api/autoimport/refresh", "admin", { csrf: cookies.admin2!.csrf })).status, 403);
});

test("rate limit cannot be bypassed with a second admin session: 429 for both", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const { s } = await service(async () => (await hold, { ok: false, reason: "error", detail: "x" }));
  assert.equal((await call("POST", "/api/autoimport/refresh", "admin")).status, 202);
  release();
  while (s.status().running) await new Promise((r) => setTimeout(r, 5));
  const r2 = await call("POST", "/api/autoimport/refresh", "admin2");
  assert.equal(r2.status, 429);
  assert.ok(Number(r2.retryAfter) > 0);
  assert.equal((await call("POST", "/api/autoimport/refresh", "admin")).status, 429);
});

const STATUS_KEYS = new Set(["enabled", "disabledReason", "leagueId", "importId", "state", "reason", "detail", "lastSuccessAt", "lastAttemptAt", "lastTeams", "nextRunAt", "running", "timezone"]);

test("status (any member) exposes only the documented fields: no profile path, cookies, tokens or stacks", async () => {
  const thrown = new Error("page.goto: net::ERR_ABORTED at https://football.fantasysports.yahoo.com/f1/1405188?crumb=SECRET_CRUMB&T=z=COOKIEVAL");
  thrown.stack = `Error: x\n    at collectWithChrome (${work}/server/autoimport/collector.ts:99:1)`;
  const { s } = await service(async () => {
    throw thrown;
  });
  await (s.runner!.trigger("schedule") as { done: Promise<void> }).done;
  const r = await call("GET", "/api/autoimport", "user");
  assert.equal(r.status, 200);
  assert.equal(r.body?.state, "paused");
  for (const k of Object.keys(r.body ?? {})) assert.ok(STATUS_KEYS.has(k), `unexpected status field ${k}`);
  for (const bad of ["SECRET_CRUMB", "COOKIEVAL", "profile-never-used", "collector.ts", "    at "]) assert.ok(!r.text.includes(bad), `status leaks ${bad}`);
  assert.equal(r.text.includes(work), false, "status leaks a server path");
});

test(
  "status detail never shows a local file path or terminal escape codes to a league member",
  async () => {
    const msg =
      "browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory. Call log: \u001b[2m- <launching> /Users/owner/FantasyFootball-run/.data/yahoo-chrome-profile";
    const { s } = await service(async () => {
      throw new Error(`EACCES: permission denied, open '/Users/owner/FantasyFootball-run/.data/yahoo-chrome-profile/SingletonLock'`);
    });
    await (s.runner!.trigger("schedule") as { done: Promise<void> }).done;
    const r = await call("GET", "/api/autoimport", "user");
    assert.ok(!r.text.includes("/Users/owner"), `detail: ${r.body?.detail}`);
    const { s: s2 } = await service(async () => {
      throw new Error(msg);
    });
    await (s2.runner!.trigger("schedule") as { done: Promise<void> }).done;
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\u0000-\u001f]/.test(String(s2.status().detail)), "detail carries control characters");
  },
);

test("logs from a failed run carry no query-string token or cookie value", async () => {
  const { logs } = await runAuto(async () => {
    throw new Error("navigation to https://login.yahoo.com/?.done=x&crumb=TOK123#frag=COOKIE456 failed");
  });
  const all = logs.join("\n");
  assert.ok(!all.includes("TOK123") && !all.includes("COOKIE456"), all);
});

// ------------------------------------------------------------------ persisted state (real writeJson, temp cwd)
test("paused state persists through a restart (real state file) and the next success clears it on disk", async () => {
  let n = 0;
  const persisted = await AutoImportService.create(
    { enabled: true, leagueId: LEAGUE, profileDir: work, schedule: { patterns: ["0 9 * * 0"], timezone: "America/Los_Angeles" } },
    { collect: async () => (n++, { ok: false, reason: "captcha", detail: "landed on guce.yahoo.com/consent" }), apply: autoApply, isPartial: (e) => e instanceof PartialImportError, log: () => undefined, noTimers: true, retryDelayMs: 0 },
  );
  await (persisted.runner!.trigger("schedule") as { done: Promise<void> }).done;
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, `${STATE_FILE}.json`), "utf8"));
  assert.equal(onDisk.state, "paused");
  assert.equal(onDisk.reason, "captcha");
  const restarted = await AutoImportService.create(
    { enabled: true, leagueId: LEAGUE, profileDir: work, schedule: { patterns: ["0 9 * * 0"], timezone: "America/Los_Angeles" } },
    { collect: async () => ({ ok: true, payload: payload(12, 15), teams: 12 }), apply: autoApply, isPartial: (e) => e instanceof PartialImportError, log: () => undefined, noTimers: true, retryDelayMs: 0 },
  );
  assert.equal(restarted.status().state, "paused");
  await (restarted.runner!.trigger("schedule") as { done: Promise<void> }).done;
  const after = JSON.parse(fs.readFileSync(path.join(DATA, `${STATE_FILE}.json`), "utf8"));
  assert.equal(after.state, "ok");
  assert.equal(after.reason, undefined);
});
