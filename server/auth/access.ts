// Access list `.data/access.json` (git-ignored: Discord ids are personal and the repo is public).
//   { "admins": ["<discord id>"], "users": [{ "discordId": "...", "leagueId": "y1405188", "teamId": "4", "note": "..." }] }
// Re-checked on every request through an mtime+size cache, so removing an id locks that user out on their
// next request. Missing, unreadable or malformed file = nobody is allowed (fail closed).
// The owner edits `users` from Connect → "Who can sign in" (`AccessFile.editUsers`); `admins` are only ever changed by
// hand on the server, so no request can lock the owner out or add an admin.
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, writeFileAtomic } from "../providers/store.js";

export interface AccessUser {
  discordId: string;
  /** Import id of the user's league (e.g. "y1405188"). */
  leagueId: string;
  teamId: string;
  note?: string;
}
export interface AccessList {
  admins: string[];
  users: AccessUser[];
}
export type Role = { role: "admin" } | { role: "user"; user: AccessUser };

export const DISCORD_ID = /^\d{5,25}$/;
export const LEAGUE_ID = /^[A-Za-z0-9_-]{1,40}$/;
export const TEAM_ID = /^[A-Za-z0-9_-]{1,20}$/;
export const NOTE_MAX = 80;

/** Strict parse; invalid user rows are dropped (they get no access), a wrong top-level shape = null. */
export function parseAccess(raw: unknown, warn: (m: string) => void = () => undefined): AccessList | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.admins) || (o.users !== undefined && !Array.isArray(o.users))) return null;
  const admins = o.admins.filter((x): x is string => typeof x === "string" && DISCORD_ID.test(x));
  if (admins.length !== o.admins.length) warn(`[auth] event=access_file result=warning detail=${o.admins.length - admins.length}_invalid_admin_ids_ignored`);
  const users: AccessUser[] = [];
  const seen = new Set<string>(admins);
  for (const u of (o.users ?? []) as unknown[]) {
    const r = (u ?? {}) as Record<string, unknown>;
    const ok =
      typeof r.discordId === "string" && DISCORD_ID.test(r.discordId) &&
      typeof r.leagueId === "string" && LEAGUE_ID.test(r.leagueId) &&
      typeof r.teamId === "string" && TEAM_ID.test(r.teamId);
    if (!ok || seen.has(r.discordId as string)) {
      warn(`[auth] event=access_file result=warning detail=user_row_ignored`);
      continue;
    }
    seen.add(r.discordId as string);
    const row: AccessUser = { discordId: r.discordId as string, leagueId: r.leagueId as string, teamId: r.teamId as string };
    if (typeof r.note === "string" && r.note.trim()) row.note = r.note.trim().slice(0, NOTE_MAX);
    users.push(row);
  }
  return { admins, users };
}

export function roleOf(list: AccessList | null, uid: string): Role | null {
  if (!list) return null;
  if (list.admins.includes(uid)) return { role: "admin" };
  const user = list.users.find((u) => u.discordId === uid);
  return user ? { role: "user", user } : null;
}

export class AccessFile {
  private cache: { mtimeMs: number; size: number; list: AccessList | null } | null = null;

  constructor(
    readonly file = path.join(DATA_DIR, "access.json"),
    private warn: (m: string) => void = (m) => console.warn(m),
  ) {}

  /** The current list, or null (nobody allowed) when the file is missing or invalid. */
  async get(): Promise<AccessList | null> {
    let st: { mtimeMs: number; size: number };
    try {
      st = await fs.stat(this.file);
    } catch {
      if (this.cache?.size !== -1) this.warn("[auth] event=access_file result=missing detail=nobody_can_sign_in");
      this.cache = { mtimeMs: 0, size: -1, list: null };
      return null;
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.list;
    let list: AccessList | null = null;
    try {
      list = parseAccess(JSON.parse(await fs.readFile(this.file, "utf8")), this.warn);
    } catch {
      list = null;
    }
    if (!list) this.warn("[auth] event=access_file result=invalid detail=nobody_can_sign_in");
    this.cache = { mtimeMs: st.mtimeMs, size: st.size, list };
    return list;
  }

  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Replace the `users` rows with `change(current users)`; every other key (admins included) is written back as read.
   * Edits run one at a time. A missing or invalid file is never rewritten (it stays "nobody allowed" until fixed by
   * hand). The written list is cached at once: a same-size rewrite within one mtime tick would fool the stat cache.
   */
  editUsers(change: (users: AccessUser[], list: AccessList) => AccessUser[]): Promise<AccessList> {
    const run = this.queue.then(async () => {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, unknown>;
      } catch {
        throw new Error("access list missing or unreadable");
      }
      const list = parseAccess(raw, this.warn);
      if (!list) throw new Error("access list invalid");
      const users = change(list.users.map((u) => ({ ...u })), list);
      const next = parseAccess({ ...raw, users }, this.warn);
      if (!next || next.users.length !== users.length) throw new Error("edited access list would be invalid");
      await writeFileAtomic(this.file, `${JSON.stringify({ ...raw, users }, null, 2)}\n`, 0o600);
      const st = await fs.stat(this.file);
      this.cache = { mtimeMs: st.mtimeMs, size: st.size, list: next };
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
