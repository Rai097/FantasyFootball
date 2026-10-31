// Compiles web/src/import/bookmarklet.ts (+ the shared parser) into one minified
// IIFE with esbuild (already installed as a dependency of tsx/vite). Built once
// per process and app URL on first request, then cached in memory.
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../../web/src/import/bookmarklet.ts", import.meta.url));

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
    p = (async () => {
      const esbuild = await import("esbuild");
      const r = await esbuild.build({
        entryPoints: [ENTRY],
        bundle: true,
        minify: true,
        format: "iife",
        target: "es2020",
        platform: "browser",
        write: false,
        legalComments: "none",
        charset: "utf8",
        define: { __FTD_APP_URL__: JSON.stringify(url) },
      });
      return r.outputFiles[0].text.trim();
    })();
    built.set(url, p);
    p.catch(() => built.delete(url));
  }
  return p;
}

/** The code as a `javascript:` URL suitable for a bookmark. */
export async function bookmarkletUrl(appUrl: string): Promise<string> {
  return `javascript:${encodeURIComponent(`void ${await bookmarkletCode(appUrl)}`)}`;
}
