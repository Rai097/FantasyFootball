// ADVERSARIAL start-up tests for Discord sign-in (docs/DESIGN.md "Discord sign-in, multi-tenant"), by the tester.
// Boots the real server/index.ts as a child process in a temp dir with a MINIMAL environment (never the developer's
// shell vars or .env), on a pre-chosen free port bound to 127.0.0.1, and kills it afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOOD = {
  DISCORD_CLIENT_ID: "adv-client-id",
  DISCORD_CLIENT_SECRET: "adv-client-secret-NEVER-LOG",
  SESSION_SECRET: "adv-session-secret-0123456789-abcdef-NEVER-LOG",
  PUBLIC_URL: "https://ff.example",
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

function workDir(data: Record<string, string | null> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-advstart-"));
  fs.mkdirSync(path.join(ROOT, ".cache"), { recursive: true });
  fs.symlinkSync(path.join(ROOT, ".cache"), path.join(dir, ".cache"), "dir");
  if (Object.keys(data).length) fs.mkdirSync(path.join(dir, ".data"));
  for (const [name, content] of Object.entries(data)) {
    const f = path.join(dir, ".data", name);
    if (content === null) fs.mkdirSync(f);
    else fs.writeFileSync(f, content);
  }
  return dir;
}

interface Boot {
  code: number | null;
  log: string;
  base: string;
  kill: () => Promise<void>;
}

/** Start server/index.ts. Resolves when it exits or /healthz answers 200 (then `code` is null). */
async function boot(env: Record<string, string>, data: Record<string, string | null> = {}): Promise<Boot> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(ROOT, "server/index.ts")], {
    cwd: workDir(data),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir(), PORT: String(port), HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  const base = `http://127.0.0.1:${port}`;
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  };
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { code: child.exitCode, log, base, kill };
    const ok = await fetch(`${base}/healthz`).then((r) => r.status === 200).catch(() => false);
    if (ok) return { code: null, log, base, kill };
    await new Promise((r) => setTimeout(r, 150));
  }
  await kill();
  throw new Error(`server neither started nor exited:\n${log}`);
}

const without = (k: keyof typeof GOOD) => Object.fromEntries(Object.entries(GOOD).filter(([x]) => x !== k));

for (const k of Object.keys(GOOD) as (keyof typeof GOOD)[]) {
  test(`production with ${k} missing → exit 1, secrets not printed`, { timeout: 60_000 }, async () => {
    const b = await boot({ NODE_ENV: "production", ...without(k) });
    try {
      assert.equal(b.code, 1, b.log);
      assert.match(b.log, new RegExp(`refusing to start: missing ${k}`));
      assert.ok(!b.log.includes(GOOD.DISCORD_CLIENT_SECRET) && !b.log.includes(GOOD.SESSION_SECRET), "secret printed");
    } finally {
      await b.kill();
    }
  });
}

const BAD_PROD: [string, Record<string, string>][] = [
  ["SESSION_SECRET of 31 chars", { SESSION_SECRET: "s".repeat(31) }],
  ["PUBLIC_URL over plain http", { PUBLIC_URL: "http://ff.example" }],
  ["PUBLIC_URL not a URL", { PUBLIC_URL: "ff.example" }],
  ["PUBLIC_URL javascript:", { PUBLIC_URL: "javascript:alert(1)" }],
  ["empty DISCORD_CLIENT_SECRET", { DISCORD_CLIENT_SECRET: "" }],
  ["SESSION_SECRET of 32 spaces (whitespace only)", { SESSION_SECRET: " ".repeat(32) }],
];
for (const [what, over] of BAD_PROD) {
  test(`production with ${what} → exit 1`, { timeout: 60_000 }, async () => {
    const b = await boot({ NODE_ENV: "production", ...GOOD, ...over });
    try {
      assert.equal(b.code, 1, `started anyway:\n${b.log}`);
      assert.match(b.log, /refusing to start/);
    } finally {
      await b.kill();
    }
  });
}

test("non-production with a PARTIAL Discord config → exit 1 (no silent fallback to dev mode)", { timeout: 60_000 }, async () => {
  for (const NODE_ENV of ["development", "staging", ""]) {
    const b = await boot({ ...(NODE_ENV ? { NODE_ENV } : {}), DISCORD_CLIENT_ID: "adv-client-id" });
    try {
      assert.equal(b.code, 1, `NODE_ENV=${NODE_ENV}: ${b.log}`);
    } finally {
      await b.kill();
    }
  }
});

test("production with all four vars and corrupt sessions.json / access.json → starts, everything 401 without a cookie", { timeout: 90_000 }, async () => {
  const corrupt: Record<string, string | null>[] = [
    { "sessions.json": "{not json", "access.json": "{also not json" },
    { "sessions.json": null, "access.json": null }, // directories
    { "sessions.json": JSON.stringify(["x"]), "access.json": JSON.stringify({ admins: "100000000000000001" }) },
  ];
  for (const data of corrupt) {
    const b = await boot({ NODE_ENV: "production", ...GOOD }, data);
    try {
      assert.equal(b.code, null, `did not start:\n${b.log}`);
      for (const p of ["/api/state", "/api/import", "/api/auth/me", "/api/access", "/auth/yahoo/start", "/api/league/demo/42"]) {
        const r = await fetch(b.base + p);
        assert.equal(r.status, 401, `${p} → ${r.status}`);
      }
      const w = await fetch(`${b.base}/api/import`, { method: "POST", headers: { "content-type": "application/json", origin: GOOD.PUBLIC_URL }, body: "{}" });
      assert.equal(w.status, 401);
      assert.match(b.log, /event=startup mode=discord/);
      assert.ok(!b.log.includes(GOOD.DISCORD_CLIENT_SECRET) && !b.log.includes(GOOD.SESSION_SECRET), "secret printed");
    } finally {
      await b.kill();
    }
  }
});

test("NODE_ENV unset / mis-cased with no Discord vars → exit 1 (dev mode needs an explicit development/test)", { timeout: 90_000 }, async () => {
  // Fail closed: a service started without NODE_ENV (or with "Production") must not serve admin to anyone.
  for (const NODE_ENV of ["", "Production", "prod"]) {
    const b = await boot({ ...(NODE_ENV ? { NODE_ENV } : {}) });
    try {
      assert.equal(b.code, 1, `NODE_ENV=${JSON.stringify(NODE_ENV)}: ${b.log}`);
    } finally {
      await b.kill();
    }
  }
  const dev = await boot({ NODE_ENV: "development" });
  try {
    assert.equal(dev.code, null, dev.log);
    assert.match(dev.log, /mode=dev/);
  } finally {
    await dev.kill();
  }
});
