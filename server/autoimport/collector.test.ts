// Collector: pure landing / log-safety rules, plus the REAL Playwright collector in headless system Chrome against the
// hand-written Yahoo fixtures (server/providers/fixtures) served by a local http server; the Yahoo host is faked with
// context.route. Skipped (with a message) when Google Chrome is not installed. Temp profile, never .data.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { BrowserContext } from "playwright-core";
import { chromePidsFor, classifyLanding, collectWithChrome, safeMessage, safeUrl } from "./collector.js";

const L = "1405188";

test("classifyLanding: league page ok; login = signed_out; consent/captcha = captcha; elsewhere = error", () => {
  assert.equal(classifyLanding(`https://football.fantasysports.yahoo.com/f1/${L}`, L), null);
  assert.equal(classifyLanding(`https://football.fantasysports.yahoo.com/f1/${L}/3?x=1`, L), null);
  assert.equal(classifyLanding(`https://login.yahoo.com/?.src=fantasy&done=https%3A%2F%2Ffootball`, L)?.reason, "signed_out");
  assert.equal(classifyLanding(`https://login.yahoo.com/account/challenge/recaptcha?sessionIndex=1`, L)?.reason, "signed_out");
  assert.equal(classifyLanding(`https://guce.yahoo.com/consent?gcrumb=abc`, L)?.reason, "captcha");
  assert.equal(classifyLanding(`https://consent.yahoo.com/v2/collectConsent?sessionId=x`, L)?.reason, "captcha");
  assert.equal(classifyLanding(`https://football.fantasysports.yahoo.com/captcha`, L)?.reason, "captcha");
  assert.equal(classifyLanding(`https://football.fantasysports.yahoo.com/f1/999`, L)?.reason, "error");
  assert.equal(classifyLanding(`https://www.yahoo.com/`, L)?.reason, "error");
  assert.ok(!classifyLanding(`https://login.yahoo.com/?token=SECRET`, L)?.detail.includes("SECRET"), "detail drops the query");
});

test("safeUrl / safeMessage drop queries and hashes", () => {
  assert.equal(safeUrl("https://login.yahoo.com/a/b?crumb=SECRET#x"), "login.yahoo.com/a/b");
  const m = safeMessage('net::ERR at https://x.yahoo.com/p?token=SECRET and "https://y.com/q#frag"\nline2');
  assert.ok(!m.includes("SECRET") && !m.includes("frag") && !m.includes("\n"));
  assert.match(m, /https:\/\/x\.yahoo\.com\/p/);
});

// ------------------------------------------------------------------ real headless Chrome
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const hasChrome = process.platform === "darwin" ? fs.existsSync(CHROME) : ["/usr/bin/google-chrome", "/opt/google/chrome/chrome"].some((p) => fs.existsSync(p));
const skip = hasChrome ? false : "Google Chrome (system) not installed: real-browser collector test skipped";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "../providers/fixtures");
const fixture = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");
let server: http.Server;
let local = "";
let profile = "";
let signedOut = false;

/** Fixture league: two team pages, settings, standings, and the player lists. */
function serve(req: http.IncomingMessage, res: http.ServerResponse) {
  const u = new URL(req.url ?? "/", "http://x");
  const p = u.pathname.replace(/\/+$/, "");
  const send = (status: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
    res.end(body);
  };
  if (signedOut && p === `/f1/${L}`) return send(302, "", { location: "https://login.yahoo.com/?.src=fantasy&token=SECRET" });
  if (p === `/f1/${L}` || p === `/f1/${L}/1` || p === `/f1/${L}/2`) return send(200, fixture("yahoo-web-roster.html"));
  if (p === `/f1/${L}/settings`) return send(200, fixture("yahoo-web-settings.html"));
  if (p === `/f1/${L}/standings`) return send(200, fixture("yahoo-web-standings.html"));
  if (p === `/f1/${L}/players`) return send(200, u.searchParams.get("status") === "A" ? fixture("yahoo-web-players.html") : "<html><body></body></html>");
  if (u.hostname === "x" && p === "/login") return send(200, "<html><body>Sign in</body></html>");
  return send(404, "not found");
}

/** Yahoo hosts → the local fixture server (the page keeps its yahoo.com URL, so same-origin fetches work). */
async function prepare(ctx: BrowserContext) {
  await ctx.route(/^https:\/\/(football\.fantasysports|login)\.yahoo\.com\//, async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === "login.yahoo.com") return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>Sign in</body></html>" });
    const r = await fetch(local + u.pathname + u.search, { redirect: "manual" });
    await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) });
  });
}

before(async () => {
  if (skip) return console.log(`# ${skip}`);
  server = http.createServer(serve);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "ftd-chrome-profile-"));
});
after(() => {
  server?.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test("real Chrome: the bundled collector reads the fixture league; the browser is closed afterwards", { skip, timeout: 120_000 }, async () => {
  signedOut = false;
  const r = await collectWithChrome({ profileDir: profile, leagueId: L, prepare });
  assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  if (!r.ok) return;
  assert.equal(r.teams, 2);
  const teams = r.payload.teams as { players: unknown[] }[];
  assert.ok(teams.every((t) => t.players.length > 0), "rosters parsed");
  assert.equal(r.payload.leagueId, L);
  assert.equal(r.payload.source, "yahoo-bookmarklet");
  assert.deepEqual(await chromePidsFor(profile), [], "no Chrome left on the profile");
});

test("real Chrome: a sign-in redirect is 'signed_out' (nothing collected, no token in the detail)", { skip, timeout: 120_000 }, async () => {
  signedOut = true;
  const r = await collectWithChrome({ profileDir: profile, leagueId: L, prepare });
  signedOut = false;
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "signed_out");
  assert.ok(!r.detail.includes("SECRET"));
  assert.deepEqual(await chromePidsFor(profile), []);
});

test("real Chrome: an abort (runner timeout) closes the browser and reports 'timeout'", { skip, timeout: 120_000 }, async () => {
  const ac = new AbortController();
  const slow = async (ctx: BrowserContext) => {
    await prepare(ctx);
    setTimeout(() => ac.abort(), 50);
    await new Promise((r) => setTimeout(r, 300));
  };
  const r = await collectWithChrome({ profileDir: profile, leagueId: L, prepare: slow, signal: ac.signal });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "timeout");
  assert.deepEqual(await chromePidsFor(profile), []);
});
