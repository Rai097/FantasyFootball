import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const CACHE_DIR = path.resolve(process.cwd(), ".cache");

/**
 * Fetch a URL as text with an on-disk cache. Files older than ttlHours are
 * refreshed; on network failure a stale copy is served rather than failing.
 */
export async function fetchCached(url: string, ttlHours = 6): Promise<string> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  const key = createHash("sha1").update(url).digest("hex").slice(0, 16);
  const name = url.split("/").pop()?.replace(/[^\w.-]/g, "_") ?? "file";
  const file = path.join(CACHE_DIR, `${key}-${name}`);
  let stale: string | null = null;
  try {
    const st = await fs.stat(file);
    const ageH = (Date.now() - st.mtimeMs) / 36e5;
    const body = await fs.readFile(file, "utf8");
    if (ageH < ttlHours) return body;
    stale = body;
  } catch {
    /* no cache */
  }
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const body = await res.text();
    await fs.writeFile(file, body);
    return body;
  } catch (err) {
    if (stale !== null) {
      console.warn(`[cache] using stale copy of ${name}: ${(err as Error).message}`);
      return stale;
    }
    throw err;
  }
}
