// Auto-import end to end inside the server (no Chrome, no Yahoo): the real guard (Discord mode) + apiRouter + the
// real server-side import (importPayload) with a fake collector. cwd moves to a temp dir BEFORE the app modules load,
// so imports land there, never in the repo's .data/.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-autoimport-"));
fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
fs.symlinkSync(path.join(ROOT, ".cache"), path.join(work, ".cache"), "dir");
process.chdir(work);
const { createAuth } = await import("../auth/routes.js");
const { AccessFile } = await import("../auth/access.js");
const { SessionStore, signSessionId } = await import("../auth/sessions.js");
const { SESSION_COOKIE } = await import("../auth/guard.js");
const { apiRouter, errorMiddleware, importPayload, PartialImportError } = await import("../api.js");
const { AutoImportService, autoImportConfig, setAutoImport } = await import("./service.js");
type CollectResult = import("./collector.js").CollectResult;

const PUBLIC_URL = "https://ff.example";
const SECRET = "autoimport-test-secret-0123456789-abcdef";
const ADMIN = "100000000000000001";
const USER = "200000000000000002";
const LEAGUE = "1405188";
const FILE = path.join(work, ".data", `import-y${LEAGUE}.json`);

fs.writeFileSync(path.join(work, "access.json"), JSON.stringify({ admins: [ADMIN], users: [{ discordId: USER, leagueId: `y${LEAGUE}`, teamId: "1" }] }));
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
app.use(express.json({ limit: "1mb" }));
app.use(auth.guard);
app.use(auth.router);
app.use(apiRouter);
app.use(errorMiddleware);

let base = "";
let server: http.Server;
const cookies: Record<string, { cookie: string; csrf: string }> = {};
before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [k, uid] of [["admin", ADMIN], ["user", USER]] as const) {
    const { id, session } = await sessions.create({ uid, name: k, avatar: null });
    cookies[k] = { cookie: `${SESSION_COOKIE}=${encodeURIComponent(signSessionId(id, SECRET))}`, csrf: session.csrf };
  }
});
after(() => {
  setAutoImport(null);
  server.close();
  process.chdir(ROOT);
  fs.rmSync(work, { recursive: true, force: true });
});

function payload(teams: number): Record<string, unknown> {
  return {
    source: "yahoo-bookmarklet",
    id: `y${LEAGUE}`,
    leagueId: LEAGUE,
    name: "Test league",
    numTeams: teams,
    settingsSource: "default",
    teams: Array.from({ length: teams }, (_, i) => ({
      id: String(i + 1),
      name: `Team ${i + 1}`,
      players: [{ yahooId: String(100 + i), name: `Player ${i}`, pos: "WR", team: "DET" }],
    })),
    importedAt: new Date().toISOString(),
    diagnostics: [],
  };
}

async function call(method: string, p: string, who?: "admin" | "user", opts: { origin?: string | null; csrf?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who) headers.cookie = cookies[who].cookie;
  const origin = opts.origin === undefined ? PUBLIC_URL : opts.origin;
  if (origin) headers.origin = origin;
  const csrf = opts.csrf === undefined ? (who ? cookies[who].csrf : null) : opts.csrf;
  if (csrf) headers["x-csrf-token"] = csrf;
  const r = await fetch(base + p, { method, headers, body: method === "POST" ? "{}" : undefined });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null, retryAfter: r.headers.get("retry-after") };
}

/** A service whose collector returns the queued results; apply = the real server-side import. */
async function service(results: CollectResult[], hold?: Promise<void>) {
  let i = 0;
  const logs: string[] = [];
  const s = await AutoImportService.create(
    { enabled: true, leagueId: LEAGUE, profileDir: work, schedule: { patterns: ["0 9 * * 0"], timezone: "America/Los_Angeles" } },
    {
      collect: async () => {
        if (hold) await hold;
        return results[Math.min(i++, results.length - 1)];
      },
      apply: async (p) => ({ teams: (await importPayload(p, { importedBy: "Auto-import", refusePartial: true })).stored.teams.length }),
      isPartial: (e) => e instanceof PartialImportError,
      log: (l) => logs.push(l),
      noTimers: true,
      retryDelayMs: 0,
      loadState: async () => null,
      saveState: async () => undefined,
    },
  );
  setAutoImport(s);
  return { s, logs };
}
const ok = (n: number): CollectResult => ({ ok: true, payload: payload(n), teams: n });

test("auth: status and refresh need a session (401); refresh is admin-only (403) with Origin + CSRF", async () => {
  await service([ok(3)]);
  assert.equal((await call("GET", "/api/autoimport")).status, 401);
  assert.equal((await call("POST", "/api/autoimport/refresh")).status, 401);
  const u = await call("POST", "/api/autoimport/refresh", "user");
  assert.equal(u.status, 403);
  assert.equal(u.body?.code, "admin_only");
  assert.equal((await call("POST", "/api/autoimport/refresh", "admin", { origin: null })).body?.code, "bad_origin");
  assert.equal((await call("POST", "/api/autoimport/refresh", "admin", { origin: "https://evil.example" })).status, 403);
  assert.equal((await call("POST", "/api/autoimport/refresh", "admin", { csrf: null })).body?.code, "csrf");
  const st = await call("GET", "/api/autoimport", "user");
  assert.equal(st.status, 200);
  assert.equal(st.body?.enabled, true);
  assert.equal(st.body?.importId, `y${LEAGUE}`);
  assert.ok(typeof st.body?.nextRunAt === "string");
});

test("refresh: 202 running, 409 while running (mutex), 429 within 2 minutes; the import goes through the real path", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const { s, logs } = await service([ok(3)], hold);
  const r1 = await call("POST", "/api/autoimport/refresh", "admin");
  assert.equal(r1.status, 202);
  assert.equal(r1.body?.status, "running");
  assert.equal((await call("GET", "/api/autoimport", "admin")).body?.running, true);
  const r2 = await call("POST", "/api/autoimport/refresh", "admin");
  assert.equal(r2.status, 409);
  assert.equal(r2.body?.code, "busy");
  release();
  while (s.status().running) await new Promise((r) => setTimeout(r, 10));
  const st = s.status();
  assert.equal(st.state, "ok");
  assert.equal(st.lastTeams, 3);
  const stored = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.equal(stored.teams.length, 3);
  assert.equal(stored.importedBy, "Auto-import");
  const r3 = await call("POST", "/api/autoimport/refresh", "admin");
  assert.equal(r3.status, 429);
  assert.ok(Number(r3.retryAfter) > 0 && Number(r3.retryAfter) <= 120);
  assert.match(logs.join("\n"), /event=run run=\S+ trigger=manual result=ok reason=- ms=\d+ teams=3 attempts=1/);
});

test("failures never touch good data: signed out, empty and partial → paused, file byte-identical; success clears", async () => {
  await importPayload(payload(3), { importedBy: "Admin" });
  const before = fs.readFileSync(FILE, "utf8");
  const cases: [CollectResult, string][] = [
    [{ ok: false, reason: "signed_out", detail: "landed on login.yahoo.com/" }, "signed_out"],
    [{ ok: true, payload: { ...payload(1), teams: [] }, teams: 0 }, "empty"],
    [{ ok: false, reason: "empty", detail: "the collector found 0 teams" }, "empty"],
    [ok(2), "partial"],
  ];
  for (const [res, reason] of cases) {
    const { s } = await service([res]);
    const t = s.runner!.trigger("schedule");
    assert.ok(t.started);
    await t.done;
    assert.equal(s.status().state, "paused", reason);
    assert.equal(s.status().reason, reason);
    assert.equal(fs.readFileSync(FILE, "utf8"), before, `${reason}: stored league unchanged`);
  }
  const { s } = await service([ok(3)]);
  await (s.runner!.trigger("schedule") as { done: Promise<void> }).done;
  assert.equal(s.status().state, "ok");
  assert.notEqual(fs.readFileSync(FILE, "utf8"), before);
});

test("disabled server: status says why, refresh is 409 disabled", async () => {
  const cfg = autoImportConfig({});
  assert.equal(cfg.enabled, false);
  const s = await AutoImportService.create(cfg, { collect: async () => ok(1), apply: async () => ({ teams: 1 }), isPartial: () => false, log: () => undefined });
  setAutoImport(s);
  const st = await call("GET", "/api/autoimport", "admin");
  assert.equal(st.body?.enabled, false);
  assert.match(String(st.body?.disabledReason), /AUTO_IMPORT/);
  const r = await call("POST", "/api/autoimport/refresh", "admin");
  assert.equal(r.status, 409);
  assert.equal(r.body?.code, "disabled");
});

test("config: needs AUTO_IMPORT=1, a numeric league id and an existing profile dir", () => {
  const yes = () => true;
  assert.equal(autoImportConfig({ AUTO_IMPORT: "1", AUTO_IMPORT_LEAGUE_ID: LEAGUE }, yes).enabled, true);
  assert.equal(autoImportConfig({ AUTO_IMPORT: "1", AUTO_IMPORT_LEAGUE_ID: LEAGUE }, () => false).enabled, false);
  assert.match(String(autoImportConfig({ AUTO_IMPORT: "1", AUTO_IMPORT_LEAGUE_ID: LEAGUE }, () => false).disabledReason), /yahoo:login/);
  assert.equal(autoImportConfig({ AUTO_IMPORT: "1" }, yes).enabled, false);
  assert.equal(autoImportConfig({ AUTO_IMPORT: "true", AUTO_IMPORT_LEAGUE_ID: LEAGUE }, yes).enabled, false);
  assert.equal(autoImportConfig({ AUTO_IMPORT: "1", AUTO_IMPORT_LEAGUE_ID: LEAGUE, AUTO_IMPORT_CRON: "bad" }, yes).enabled, false);
  assert.match(autoImportConfig({}).profileDir, /\.data\/yahoo-chrome-profile$/);
});
