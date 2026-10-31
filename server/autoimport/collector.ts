// Auto-import collector — STOPGAP until the Yahoo Fantasy API app is approved (docs/DESIGN.md "Auto-import (stopgap
// until Yahoo API)"). Opens the owner's league page in headless SYSTEM Google Chrome (channel "chrome"; Playwright never
// downloads a browser) on a dedicated persistent profile in which the owner signed in to Yahoo themselves
// (`npm run yahoo:login`). It never reads, prints or copies the profile's cookies and never automates a login: a
// signed-out profile is reported as "signed_out". The page runs the SAME collector as the bookmarklet
// (web/src/import/collect.ts, bundled by collectorCode()) and the payload is returned to the runner. Read-only toward
// Yahoo: the collector only GETs league pages.
// Docs: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type BrowserContext } from "playwright-core";
import { collectorCode } from "../providers/import-bookmarklet.js";

export type FailReason = "signed_out" | "captcha" | "empty" | "partial" | "timeout" | "error";
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

/** An error message fit for a log line: URLs lose their query/hash, one line, at most 200 chars. */
export function safeMessage(m: string): string {
  return m
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
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

/** PIDs of processes started on `profileDir` (Chrome's --user-data-dir), never the owner's own Chrome. */
export async function chromePidsFor(profileDir: string): Promise<number[]> {
  const { stdout } = await run("ps", ["-axo", "pid=,command="], { maxBuffer: 8 * 1024 * 1024 });
  const flag = `--user-data-dir=${profileDir}`;
  return stdout
    .split("\n")
    .filter((l) => l.includes(flag))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}

export interface CollectorOptions {
  profileDir: string;
  leagueId: string;
  /** Abort = the runner's timeout: the browser is closed and the result is "timeout". */
  signal?: AbortSignal;
  /** Tests: route the Yahoo host to local fixtures before the first navigation. */
  prepare?: (ctx: BrowserContext) => Promise<void>;
  log?: (line: string) => void;
}

/** One headless collection run. Always closes the browser and kills any Chrome left on this profile. */
export async function collectWithChrome(o: CollectorOptions): Promise<CollectResult> {
  const log = o.log ?? ((l: string) => console.warn(l));
  let ctx: BrowserContext | undefined;
  const aborted = () => !!o.signal?.aborted;
  const onAbort = () => void ctx?.close().catch(() => undefined);
  o.signal?.addEventListener("abort", onAbort);
  try {
    const code = await collectorCode();
    if (aborted()) return { ok: false, reason: "timeout", detail: "timed out before launch" };
    ctx = await chromium.launchPersistentContext(o.profileDir, { channel: "chrome", headless: true, timeout: 60_000 });
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
    return { ok: false, reason: "error", detail: safeMessage((e as Error).message ?? String(e)) };
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
    await Promise.race([ctx?.close().catch(() => undefined), new Promise((r) => setTimeout(r, 15_000))]);
    try {
      const left = await chromePidsFor(o.profileDir);
      for (const pid of left) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      if (left.length) log(`[autoimport] event=leftover_chrome killed=${left.length}`);
    } catch (e) {
      log(`[autoimport] event=leftover_check_failed error=${safeMessage((e as Error).message)}`);
    }
  }
}
