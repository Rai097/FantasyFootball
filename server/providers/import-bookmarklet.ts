// Compiles web/src/import/bookmarklet.ts (+ the shared parser) into one minified
// IIFE with esbuild (already installed as a dependency of tsx/vite). Built once
// per process on first request, then cached in memory.
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../../web/src/import/bookmarklet.ts", import.meta.url));

let built: Promise<string> | undefined;

export function bookmarkletCode(): Promise<string> {
  built ??= (async () => {
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
    });
    return r.outputFiles[0].text.trim();
  })();
  built.catch(() => (built = undefined));
  return built;
}

/** The code as a `javascript:` URL suitable for a bookmark. */
export async function bookmarkletUrl(): Promise<string> {
  return `javascript:${encodeURIComponent(`void ${await bookmarkletCode()}`)}`;
}
