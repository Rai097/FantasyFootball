// Adversarial: the collector's Chrome cleanup and shutdown behaviour with REAL headless system Chrome on temp
// profiles (never .data, never the owner's profile, never real Yahoo: every yahoo.com request is fulfilled locally).
// Skipped when Google Chrome is not installed.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext } from "playwright-core";
import { chromePidsFor, collectWithChrome } from "./collector.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const L = "1405188";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const hasChrome = process.platform === "darwin" ? fs.existsSync(CHROME) : ["/usr/bin/google-chrome", "/opt/google/chrome/chrome"].some((p) => fs.existsSync(p));
const skip = hasChrome ? false : "Google Chrome (system) not installed: real-browser adversarial tests skipped";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-chrome-adv-"));
const started: ChildProcess[] = [];
const contexts: BrowserContext[] = [];

after(async () => {
  for (const c of contexts) await c.close().catch(() => undefined);
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  // Belt and braces: nothing may survive on our temp profiles.
  for (const d of fs.readdirSync(tmp)) for (const pid of await chromePidsFor(path.join(tmp, d)).catch(() => [])) process.kill(pid, "SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A dummy process whose command line carries `--user-data-dir=<dir>` (stands in for another Chrome). */
function fakeChrome(dir: string): ChildProcess {
  const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)", "--", `--user-data-dir=${dir}`], { stdio: "ignore" });
  started.push(c);
  return c;
}

test("chromePidsFor: profile /x/p must not match another Chrome on /x/p-backup (prefix match)", async () => {
  const p = path.join(tmp, "prof");
  const other = fakeChrome(`${p}-backup`);
  await new Promise((r) => setTimeout(r, 200));
  const pids = await chromePidsFor(p);
  assert.ok(!pids.includes(other.pid!), `chromePidsFor("${p}") returned the pid of the Chrome on "${p}-backup"`);
});

test("chromePidsFor: the exact profile is found (the cleanup does work)", async () => {
  const p = path.join(tmp, "exact");
  const c = fakeChrome(p);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok((await chromePidsFor(p)).includes(c.pid!));
  c.kill("SIGKILL");
});

// ------------------------------------------------------------------ real Chrome
/** Every yahoo.com request answers from here: a league page that never finishes loading when `stall` is set. */
let stall = false;
async function prepare(ctx: BrowserContext) {
  await ctx.route(/^https:\/\/[^/]*yahoo\.com\//, async (route) => {
    if (stall) return; // never fulfilled: the run stays mid-flight
    await route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>league</body></html>" });
  });
}

test(
  "profile lock: a tick while `npm run yahoo:login` holds the profile fails AND leaves the owner's Chrome running",
  { skip: skip || undefined, timeout: 120_000 },
  async () => {
    const p = path.join(tmp, "locked");
    fs.mkdirSync(p);
    // Stands in for `npm run yahoo:login` (same launch call, headless here).
    const owner = await chromium.launchPersistentContext(p, { channel: "chrome", headless: true });
    contexts.push(owner);
    const before = await chromePidsFor(p);
    assert.ok(before.length > 0, "the owner's Chrome is on the profile");
    const logs: string[] = [];
    const r = await collectWithChrome({ profileDir: p, leagueId: L, prepare, log: (l) => logs.push(l) });
    assert.equal(r.ok, false, "the run cannot use a locked profile");
    assert.equal(!r.ok && r.reason, "profile_in_use");
    // A pid check alone is not enough (a killed child of this process stays a zombie): the browser must still answer.
    const answer = await Promise.race([
      owner.newPage().then((pg) => pg.evaluate("1 + 1")),
      new Promise((res) => setTimeout(() => res("no answer"), 10_000)),
    ]).catch((e: Error) => `error: ${e.message.split("\n")[0]}`);
    assert.equal(answer, 2, `the owner's Chrome was killed by the run (${logs.join(" | ")}; result ${JSON.stringify(r)})`);
  },
);

/** A child process that runs collectWithChrome against a stalled league page and prints its Chrome pids. */
function childRun(profile: string): Promise<{ child: ChildProcess; pids: number[] }> {
  const script = path.join(tmp, `child-${path.basename(profile)}.mts`);
  fs.writeFileSync(
    script,
    `import { collectWithChrome, chromePidsFor } from ${JSON.stringify(path.join(ROOT, "server/autoimport/collector.ts"))};
const prepare = async (ctx) => { await ctx.route(/^https:\\/\\/[^/]*yahoo\\.com\\//, () => undefined); };
const t = setInterval(async () => { const p = await chromePidsFor(${JSON.stringify(profile)}); if (p.length) { console.log("PIDS " + p.join(",")); clearInterval(t); } }, 200);
await collectWithChrome({ profileDir: ${JSON.stringify(profile)}, leagueId: "${L}", prepare });
`,
  );
  // node itself with the tsx loader (not the tsx CLI, which runs the script in a grandchild that a SIGKILL would miss).
  const loader = path.join(ROOT, "node_modules/tsx/dist/loader.mjs");
  const child = spawn(process.execPath, ["--import", `file://${loader}`, script], { cwd: tmp, stdio: ["ignore", "pipe", "pipe"] });
  started.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    const to = setTimeout(() => reject(new Error(`child never launched Chrome: ${out}`)), 60_000);
    child.stdout!.on("data", (d) => {
      out += String(d);
      const m = /PIDS ([\d,]+)/.exec(out);
      if (m) {
        clearTimeout(to);
        resolve({ child, pids: m[1].split(",").map(Number) });
      }
    });
    child.stderr!.on("data", (d) => (out += String(d)));
  });
}

async function waitGone(pids: number[], ms: number): Promise<number[]> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!pids.some(alive)) return [];
    await new Promise((r) => setTimeout(r, 200));
  }
  return pids.filter(alive);
}

test("shutdown: SIGTERM to the server mid-run leaves no Chrome on the profile", { skip, timeout: 120_000 }, async () => {
  const p = path.join(tmp, "sigterm");
  fs.mkdirSync(p);
  const { child, pids } = await childRun(p);
  child.kill("SIGTERM");
  const left = await waitGone(pids, 15_000);
  assert.deepEqual(left, [], "Chrome survived the server's SIGTERM");
  assert.deepEqual(await chromePidsFor(p), []);
});

test("shutdown: SIGKILL to the server mid-run leaves no Chrome on the profile", { skip, timeout: 120_000 }, async () => {
  const p = path.join(tmp, "sigkill");
  fs.mkdirSync(p);
  const { child, pids } = await childRun(p);
  child.kill("SIGKILL");
  const left = await waitGone(pids, 15_000);
  assert.deepEqual(left, [], "Chrome survived the server's SIGKILL (orphan until the next run)");
});
