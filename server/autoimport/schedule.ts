// Auto-import schedule (stopgap until the Yahoo API is approved; docs/DESIGN.md "Auto-import (stopgap until Yahoo
// API)"). Pure: cron patterns + time zone in, next fire time out. DST is croner's job, never hand-rolled.
// Docs: https://croner.56k.guru/usage/examples/#time-zone
import { Cron } from "croner";

/** Owner-approved default (America/Los_Angeles): Mon–Fri 06/12/18, Sat every 2 h 06–22, Sun 09:00. */
export const DEFAULT_PATTERNS = ["0 6,12,18 * * 1-5", "0 6-22/2 * * 6", "0 9 * * 0"];
export const DEFAULT_TIMEZONE = "America/Los_Angeles";

export interface ScheduleConfig {
  patterns: string[];
  timezone: string;
}

/**
 * Parses AUTO_IMPORT_CRON ("pattern; pattern; …", 5-field cron) and AUTO_IMPORT_TZ; unset = the defaults. Throws on
 * an invalid pattern or time zone, an empty list, or a pattern with no next fire after `from` (fail closed: the server
 * logs it loudly and leaves auto-import off).
 */
export function scheduleFromEnv(env: NodeJS.ProcessEnv, from: Date = new Date()): ScheduleConfig {
  const raw = (env.AUTO_IMPORT_CRON ?? "").trim();
  const patterns = raw ? raw.split(";").map((s) => s.trim()).filter(Boolean) : DEFAULT_PATTERNS;
  const timezone = (env.AUTO_IMPORT_TZ ?? "").trim() || DEFAULT_TIMEZONE;
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }); // throws RangeError on an unknown time zone
  if (!patterns.length) throw new Error("AUTO_IMPORT_CRON has no pattern");
  for (const p of patterns) {
    if (p.split(/\s+/).length !== 5) throw new Error(`AUTO_IMPORT_CRON: "${p}" must have 5 fields (minute hour day month weekday)`);
    const c = new Cron(p, { timezone, paused: true }); // throws on a bad pattern
    // A pattern that never fires (e.g. Feb 31) is invalid too: it would leave auto-import "on" with no runs.
    const next = c.nextRun(from);
    c.stop();
    if (!next) throw new Error(`AUTO_IMPORT_CRON: "${p}" never fires`);
  }
  return { patterns, timezone };
}

/** The first fire time strictly after `from` across all patterns, or null when none (never for the defaults). */
export function nextFire(cfg: ScheduleConfig, from: Date): Date | null {
  let best: Date | null = null;
  for (const p of cfg.patterns) {
    const c = new Cron(p, { timezone: cfg.timezone, paused: true });
    const n = c.nextRun(from);
    c.stop();
    if (n && (!best || n < best)) best = n;
  }
  return best;
}

/** The next `count` fire times after `from` (tests and the docs table). */
export function nextFires(cfg: ScheduleConfig, from: Date, count: number): Date[] {
  const out: Date[] = [];
  let t = from;
  for (let i = 0; i < count; i++) {
    const n = nextFire(cfg, t);
    if (!n) break;
    out.push(n);
    t = n;
  }
  return out;
}
