import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const CACHE_DIR = path.resolve(process.cwd(), ".cache");

/** The on-disk cache file of one URL (sha1 prefix + last path segment). */
export function cacheFileOf(url: string): string {
  const key = createHash("sha1").update(url).digest("hex").slice(0, 16);
  const name = url.split("/").pop()?.replace(/[^\w.-]/g, "_") ?? "file";
  return path.join(CACHE_DIR, `${key}-${name}`);
}

export interface CachedBody {
  body: string;
  /** "cache" = fresh copy on disk, "network" = fetched now, "stale" = fetch or validation failed, old copy served. */
  source: "cache" | "network" | "stale";
  /** Age in hours of the copy served (0 when fetched now). */
  ageH: number;
  /** Why the fetch failed (source "stale"). */
  error?: string;
}

export interface FetchOpts {
  /** Throws when a fetched body is unusable: it is then never written, and the old copy is served (or the error thrown). */
  validate?: (body: string) => void;
  /** Abort the network fetch (headers and body) after this many ms; the old copy is then served (or the error thrown). */
  timeoutMs?: number;
  /** Abort a response body larger than this many bytes (declared or streamed); the old copy is then served (or thrown). */
  maxBytes?: number;
}

/** The response body as text, aborted once it passes `max` bytes (a declared Content-Length is checked first). */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    throw new Error(`response too large: ${declared} bytes declared, cap ${max}`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      throw new Error(`response too large: over ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetch a URL as text with an on-disk cache. Files older than ttlHours are refreshed; on network failure (or a body
 * the validator rejects) a stale copy is served rather than failing, and the good copy on disk is never overwritten.
 */
export async function fetchCachedMeta(url: string, ttlHours = 6, opts: FetchOpts = {}): Promise<CachedBody> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const file = cacheFileOf(url);
  const name = path.basename(file).slice(17);
  let stale: { body: string; ageH: number } | null = null;
  try {
    const st = await fs.stat(file);
    const ageH = (Date.now() - st.mtimeMs) / 36e5;
    const body = await fs.readFile(file, "utf8");
    if (ageH < ttlHours) return { body, source: "cache", ageH };
    stale = { body, ageH };
  } catch {
    /* no cache */
  }
  try {
    const res = await fetch(url, { redirect: "follow", ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const body = opts.maxBytes ? await readCapped(res, opts.maxBytes) : await res.text();
    opts.validate?.(body);
    // Write-then-rename: a crash mid-write never leaves a truncated copy in place of the good one.
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, file);
    return { body, source: "network", ageH: 0 };
  } catch (err) {
    if (stale !== null) {
      console.warn(`[cache] using stale copy of ${name}: ${(err as Error).message}`);
      return { body: stale.body, source: "stale", ageH: stale.ageH, error: (err as Error).message };
    }
    throw err;
  }
}

/** fetchCachedMeta's body only. */
export async function fetchCached(url: string, ttlHours = 6, opts: FetchOpts = {}): Promise<string> {
  return (await fetchCachedMeta(url, ttlHours, opts)).body;
}
