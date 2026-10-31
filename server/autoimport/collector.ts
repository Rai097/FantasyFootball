// Auto-import collector — STOPGAP until the Yahoo Fantasy API app is approved (docs/DESIGN.md "Auto-import (stopgap
// until Yahoo API)"). Opens the owner's league page in headless SYSTEM Google Chrome (channel "chrome"; Playwright never
// downloads a browser) on a dedicated persistent profile in which the owner signed in to Yahoo themselves
// (`npm run yahoo:login`). It never reads, prints or copies the profile's cookies and never automates a login: a
// signed-out profile is reported as "signed_out". The page runs the SAME collector as the bookmarklet
// (web/src/import/collect.ts, bundled by collectorCode()) and the payload is returned to the runner. Read-only toward
// Yahoo: the collector only GETs league pages.
// Docs: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext } from "playwright-core";
import { collectorCode } from "../providers/import-bookmarklet.js";

export type FailReason = "signed_out" | "captcha" | "empty" | "partial" | "timeout" | "profile_in_use" | "error";
export type CollectResult = { ok: true; payload: Record<string, unknown>; teams: number } | { ok: false; reason: FailReason; detail: string };

export const YAHOO_HOST = "football.fantasysports.yahoo.com";
export const leagueUrl = (leagueId: string) => `https://${YAHOO_HOST}/f1/${leagueId}`;

/** host + path of a URL, never its query or hash (Yahoo puts session tokens there). */
export function safeUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`.slice(0, 120);
  } catch {
    return "(unparsable url)";
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]+/g;
/** `name=value` / `name: value` pairs whose value is a credential; the value is replaced, the name kept. */
const SECRET_PAIR = /\b(cookie|set-cookie|token|access_token|refresh_token|id_token|crumb|secret|password|authorization|session)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const BEARER = /\b(bearer)\s+[\w.~+/=-]+/gi;

/**
 * An error message fit for the SERVER LOG: URLs lose their query/hash, credential values are redacted, terminal escape
 * codes and control characters go, one line, at most `max` chars. Local paths stay (the log is the owner's).
 */
export function safeMessage(m: string, max = 200): string {
  return m
    .replace(ANSI, "")
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1")
    .replace(BEARER, "$1 [redacted]")
    .replace(SECRET_PAIR, "$1$2[redacted]")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Local file paths (absolute, ~ or a Windows drive) after a space, quote, bracket, "=" or ","; never a URL's path. */
const LOCAL_PATH = /(^|[\s'"(<\[=,])(?:~|[A-Za-z]:\\|\/)[^\s'")>\],]+/g;
export const PUBLIC_DETAIL_MAX = 120;

/**
 * The failure detail shown to league members (GET /api/autoimport): safeMessage, then no local paths ("<path>"),
 * at most 120 chars. The full message goes only to the server log.
 */
export function publicDetail(m: string): string {
  const s = safeMessage(m, 1000).replace(LOCAL_PATH, "$1<path>").replace(/\s+/g, " ").trim();
  return s.length > PUBLIC_DETAIL_MAX ? `${s.slice(0, PUBLIC_DETAIL_MAX - 1)}…` : s;
}

/**
 * Where page.goto landed. A Yahoo sign-in page = "signed_out"; a consent / captcha / bot-check page = "captcha";
 * the league page = null (go on); anything else = "error". Best effort: Yahoo's exact URLs for these pages are not
 * documented, so unknown pages fail closed as "error".
 */
export function classifyLanding(finalUrl: string, leagueId: string): { reason: FailReason; detail: string } | null {
  let u: URL;
  try {
    u = new URL(finalUrl);
  } catch {
    return { reason: "error", detail: "landed on an unparsable URL" };
  }
  const host = u.hostname.toLowerCase();
  const where = `landed on ${safeUrl(finalUrl)}`;
  // Any login.yahoo.com page (sign-in form, its own recaptcha challenge): the owner must sign in again (yahoo:login).
  if (host === "login.yahoo.com") return { reason: "signed_out", detail: where };
  if (/(^|\.)(guce|consent)\.yahoo\.com$/.test(host) || /captcha|challenge|sorry|blocked/i.test(u.pathname)) return { reason: "captcha", detail: where };
  if (host === YAHOO_HOST && new RegExp(`^/f1/${leagueId}(?:[/?#]|$)`).test(u.pathname)) return null;
  return { reason: "error", detail: where };
}

const run = promisify(execFile);

/** True when `line` (a `ps` command line) carries exactly `--user-data-dir=<dir>` (not a longer path sharing the prefix). */
export function hasProfileArg(line: string, dirs: string[]): boolean {
  return dirs.some((d) => {
    const flag = `--user-data-dir=${d}`;
    for (let i = line.indexOf(flag); i >= 0; i = line.indexOf(flag, i + 1)) {
      const before = i === 0 ? " " : line[i - 1];
      const after = line[i + flag.length];
      if (/\s/.test(before) && (after === undefined || /\s/.test(after))) return true;
    }
    return false;
  });
}

/** PIDs of processes whose command line carries exactly `--user-data-dir=<profileDir>` (as given or resolved). */
export async function chromePidsFor(profileDir: string): Promise<number[]> {
  const { stdout } = await run("ps", ["-axo", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  const dirs = [...new Set([profileDir, path.resolve(profileDir)])];
  return stdout
    .split("\n")
    .filter((l) => hasProfileArg(l, dirs))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}

/** Chrome refuses a profile another Chrome holds (its ProcessSingleton / SingletonLock). */
export const isProfileLockError = (m: string) => /ProcessSingleton|SingletonLock|profile (directory )?is (already )?in use/i.test(m);

export interface CollectorOptions {
  profileDir: string;
  leagueId: string;
  /** Abort = the runner's timeout: the browser is closed and the result is "timeout". */
  signal?: AbortSignal;
  /** Tests: route the Yahoo host to local fixtures before the first navigation. */
  prepare?: (ctx: BrowserContext) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * One headless collection run. A profile another Chrome already holds (e.g. the owner's `npm run yahoo:login` window)
 * fails at once as "profile_in_use": nothing is launched and nothing is killed. Otherwise the browser is always closed
 * in `finally`, and only the Chrome processes THIS run launched (the new pids on the profile right after launch) are
 * killed if they outlive the close; never any other Chrome.
 */
export async function collectWithChrome(o: CollectorOptions): Promise<CollectResult> {
  const log = o.log ?? ((l: string) => console.warn(l));
  let ctx: BrowserContext | undefined;
  let owned: number[] = [];
  const aborted = () => !!o.signal?.aborted;
  const onAbort = () => void ctx?.close().catch(() => undefined);
  o.signal?.addEventListener("abort", onAbort);
  const inUse = (detail: string): CollectResult => ({ ok: false, reason: "profile_in_use", detail });
  try {
    const code = await collectorCode();
    if (aborted()) return { ok: false, reason: "timeout", detail: "timed out before launch" };
    const before = await chromePidsFor(o.profileDir);
    if (before.length) return inUse(`the Chrome profile is open in another Chrome (${before.length} process${before.length === 1 ? "" : "es"}): next run retries`);
    try {
      ctx = await chromium.launchPersistentContext(o.profileDir, { channel: "chrome", headless: true, timeout: 60_000 });
    } catch (e) {
      const m = (e as Error)?.message ?? String(e);
      if (isProfileLockError(m)) return inUse("the Chrome profile is locked by another Chrome: next run retries");
      throw e;
    }
    // Ours = the processes on the profile now that were not there before the launch (before was empty).
    owned = (await chromePidsFor(o.profileDir).catch(() => [] as number[])).filter((p) => !before.includes(p));
    if (aborted()) return { ok: false, reason: "timeout", detail: "timed out during launch" };
    if (o.prepare) await o.prepare(ctx);
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(leagueUrl(o.leagueId), { waitUntil: "domcontentloaded", timeout: 60_000 });
    const landing = classifyLanding(page.url(), o.leagueId);
    if (landing) return { ok: false, ...landing };
    await page.evaluate(code);
    const payload = (await page.evaluate(() => (globalThis as unknown as { __ftdCollect: () => Promise<unknown> }).__ftdCollect())) as Record<string, unknown>;
    if (aborted()) return { ok: false, reason: "timeout", detail: "timed out while reading Yahoo" };
    const teams = Array.isArray(payload?.teams) ? payload.teams.length : 0;
    if (!teams) return { ok: false, reason: "empty", detail: "the collector found 0 teams" };
    return { ok: true, payload, teams };
  } catch (e) {
    if (aborted()) return { ok: false, reason: "timeout", detail: "timed out (browser closed)" };
    const m = (e as Error)?.message ?? String(e);
    if (isProfileLockError(m)) return inUse("the Chrome profile is locked by another Chrome: next run retries");
    return { ok: false, reason: "error", detail: safeMessage(m) };
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
    await Promise.race([ctx?.close().catch(() => undefined), new Promise((r) => setTimeout(r, 15_000))]);
    if (owned.length) {
      let killed = 0;
      for (const pid of owned) {
        try {
          process.kill(pid, 0); // still there?
          process.kill(pid, "SIGKILL");
          killed++;
        } catch {
          /* already gone */
        }
      }
      if (killed) log(`[autoimport] event=leftover_chrome killed=${killed}`);
    }
  }
}
