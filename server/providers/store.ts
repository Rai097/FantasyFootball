// Tiny JSON persistence under .data/ (git-ignored). Used for Yahoo OAuth tokens
// and short-lived Yahoo league / free-agent caches.
import fs from "node:fs/promises";
import path from "node:path";

export const DATA_DIR = path.resolve(process.cwd(), ".data");

/** Make a string safe to use as a file name (league keys contain dots, which are fine). */
export function safeName(s: string): string {
  return s.replace(/[^\w.-]/g, "_");
}

function fileFor(name: string): string {
  return path.join(DATA_DIR, safeName(name.endsWith(".json") ? name : `${name}.json`));
}

export async function readJson<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(fileFor(name), "utf8")) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.warn(`[store] could not read ${name}: ${(err as Error).message}`);
    return null;
  }
}

/** Atomic write (tmp file + rename). `secret` restricts the file to the current user. */
export async function writeJson(name: string, data: unknown, opts: { secret?: boolean } = {}): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const file = fileFor(name);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: opts.secret ? 0o600 : 0o644 });
  await fs.rename(tmp, file);
}

export async function removeJson(name: string): Promise<void> {
  await fs.rm(fileFor(name), { force: true });
}

interface CacheEnvelope<T> {
  fetchedAt: string;
  data: T;
}

/** Returns cached data if younger than ttlMs, else null. */
export async function readCached<T>(name: string, ttlMs: number): Promise<{ data: T; fetchedAt: string } | null> {
  const env = await readJson<CacheEnvelope<T>>(name);
  if (!env || !env.fetchedAt || env.data === undefined) return null;
  const age = Date.now() - new Date(env.fetchedAt).getTime();
  if (!(age >= 0 && age < ttlMs)) return null;
  return env;
}

export async function writeCached<T>(name: string, data: T): Promise<string> {
  const fetchedAt = new Date().toISOString();
  await writeJson(name, { fetchedAt, data } satisfies CacheEnvelope<T>);
  return fetchedAt;
}
