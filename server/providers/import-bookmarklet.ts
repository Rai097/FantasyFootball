// Compiles web/src/import/bookmarklet.ts (+ the shared parser) into one minified
// IIFE with esbuild (already installed as a dependency of tsx/vite). Built once
// per process and app URL on first request, then cached in memory. collectorCode() bundles the same collector
// (web/src/import/collectEntry.ts) for the server's headless auto-import.
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../../web/src/import/bookmarklet.ts", import.meta.url));
const COLLECT_ENTRY = fileURLToPath(new URL("../../web/src/import/collectEntry.ts", import.meta.url));

/** One esbuild IIFE bundle of `entry` (browser target, minified, self-contained). */
async function bundle(entry: string, define: Record<string, string> = {}): Promise<string> {
  const esbuild = await import("esbuild");
  const r = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    platform: "browser",
    write: false,
    legalComments: "none",
    charset: "utf8",
    define,
  });
  return r.outputFiles[0].text.trim();
}

const built = new Map<string, Promise<string>>();

/**
 * Normalises the Trade Desk URL the bookmarklet hands its result to (one-click import, docs/DESIGN.md "One-click
 * import (v7)"): http(s) only, no query/hash, no trailing slash. Throws on anything else.
 */
export function normaliseAppUrl(appUrl: string): string {
  const u = new URL(appUrl);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("app URL must be http(s)");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

/** `appUrl` = Trade Desk's public URL, injected as __FTD_APP_URL__ (the postMessage target is its origin). */
export function bookmarkletCode(appUrl: string): Promise<string> {
  const url = normaliseAppUrl(appUrl);
  let p = built.get(url);
  if (!p) {
    p = bundle(ENTRY, { __FTD_APP_URL__: JSON.stringify(url) });
    built.set(url, p);
    p.catch(() => built.delete(url));
  }
  return p;
}

/** The code as a `javascript:` URL suitable for a bookmark. */
export async function bookmarkletUrl(appUrl: string): Promise<string> {
  return `javascript:${encodeURIComponent(`void ${await bookmarkletCode(appUrl)}`)}`;
}

let collector: Promise<string> | undefined;
/**
 * The collector alone (sets `globalThis.__ftdCollect`), for page.evaluate in the auto-import's headless Chrome
 * (docs/DESIGN.md "Auto-import (stopgap until Yahoo API)"). Built once per process.
 */
export function collectorCode(): Promise<string> {
  if (!collector) {
    collector = bundle(COLLECT_ENTRY);
    collector.catch(() => (collector = undefined));
  }
  return collector;
}
