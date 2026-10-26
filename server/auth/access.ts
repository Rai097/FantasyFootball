// Access list `.data/access.json` (git-ignored: Discord ids are personal and the repo is public).
//   { "admins": ["<discord id>"], "users": [{ "discordId": "...", "leagueId": "y1405188", "teamId": "4", "note": "..." }] }
// Re-checked on every request through an mtime+size cache, so removing an id locks that user out on their
// next request. Missing, unreadable or malformed file = nobody is allowed (fail closed).
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../providers/store.js";

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

const DISCORD_ID = /^\d{5,25}$/;
const LEAGUE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const TEAM_ID = /^[A-Za-z0-9_-]{1,20}$/;

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
    if (typeof r.note === "string" && r.note.trim()) row.note = r.note.trim().slice(0, 80);
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
}
