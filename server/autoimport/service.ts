// Auto-import service — STOPGAP until the Yahoo API is approved (docs/DESIGN.md "Auto-import (stopgap until Yahoo
// API)"). Wires the in-process scheduler (croner, America/Los_Angeles by default), the runner, the manual-refresh rate
// limit and the status the API serves. The server process is the only writer of .data (the import and
// autoimport-state.json); Chrome itself writes only inside its profile directory.
// Docs: https://croner.56k.guru/usage/examples/#time-zone
import fs from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import { DATA_DIR, readJson, writeJson } from "../providers/store.js";
import type { CollectResult } from "./collector.js";
import { AutoImportRunner, MAX_RUN_MS, type AutoImportState } from "./runner.js";
import { nextFire, scheduleFromEnv, type ScheduleConfig } from "./schedule.js";

export const STATE_FILE = "autoimport-state";
/** Manual "Refresh from Yahoo now": at most one accepted request per 2 minutes. */
export const MANUAL_MIN_GAP_MS = 2 * 60_000;
export const RUN_TIMEOUT_MS = 3 * 60_000;
/** Hard cap on a whole run, retry included (fix round 1). */
export const RUN_DEADLINE_MS = MAX_RUN_MS;
export const RETRY_DELAY_MS = 30_000;

export interface AutoImportConfig {
  enabled: boolean;
  /** Why it is off (shown in the status and the startup line). */
  disabledReason?: string;
  /** Off because the config is invalid (AUTO_IMPORT=1 was set): the startup line is an error, not info. */
  invalid?: boolean;
  leagueId?: string;
  profileDir: string;
  schedule?: ScheduleConfig;
}

export const defaultProfileDir = () => path.join(DATA_DIR, "yahoo-chrome-profile");

/**
 * AUTO_IMPORT=1 turns it on (off in tests and dev unless set), AUTO_IMPORT_LEAGUE_ID names the Yahoo league,
 * AUTO_IMPORT_PROFILE overrides the profile dir (default .data/yahoo-chrome-profile), which must already exist
 * (the owner signs in with `npm run yahoo:login`). AUTO_IMPORT_CRON / AUTO_IMPORT_TZ override the schedule.
 */
export function autoImportConfig(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): AutoImportConfig {
  const profileDir = (env.AUTO_IMPORT_PROFILE ?? "").trim() || defaultProfileDir();
  const off = (disabledReason: string, leagueId?: string, invalid = true): AutoImportConfig => ({ enabled: false, disabledReason, profileDir, leagueId, invalid });
  if ((env.AUTO_IMPORT ?? "").trim() !== "1") return off("AUTO_IMPORT is not 1", undefined, false);
  const leagueId = (env.AUTO_IMPORT_LEAGUE_ID ?? "").trim();
  if (!/^\d{1,12}$/.test(leagueId)) return off("AUTO_IMPORT_LEAGUE_ID is missing or not a number");
  if (!exists(profileDir)) return off("Chrome profile not found: run npm run yahoo:login", leagueId);
  let schedule: ScheduleConfig;
  try {
    schedule = scheduleFromEnv(env);
  } catch (e) {
    return off(`bad schedule: ${(e as Error).message}`, leagueId);
  }
  return { enabled: true, leagueId, profileDir, schedule };
}

export interface AutoImportStatus {
  enabled: boolean;
  disabledReason?: string;
  leagueId?: string;
  /** The stored import this refreshes ("y<leagueId>"). */
  importId?: string;
  state: "ok" | "paused";
  reason?: string;
  detail?: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  lastTeams?: number;
  nextRunAt?: string;
  running: boolean;
  timezone?: string;
}

export type RefreshResult =
  | { ok: true; status: "running"; runId: string }
  | { ok: false; code: "disabled" | "busy" | "rate_limited"; retryAfterSec?: number };

export interface ServiceDeps {
  collect: (signal: AbortSignal) => Promise<CollectResult>;
  apply: (payload: Record<string, unknown>, signal: AbortSignal) => Promise<{ teams: number }>;
  isPartial: (e: unknown) => boolean;
  log?: (line: string) => void;
  /** The startup line when AUTO_IMPORT=1 but the config is invalid (default console.error). */
  logError?: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxRunMs?: number;
  retryDelayMs?: number;
  /** Tests: keep the croner jobs off (status still computes nextRunAt). */
  noTimers?: boolean;
  loadState?: () => Promise<AutoImportState | null>;
  saveState?: (s: AutoImportState) => Promise<void>;
}

export class AutoImportService {
  readonly runner: AutoImportRunner | null;
  private jobs: Cron[] = [];
  private lastManual = -Infinity;
  private readonly now: () => Date;

  private constructor(
    readonly cfg: AutoImportConfig,
    deps: ServiceDeps,
    initial: AutoImportState,
  ) {
    this.now = deps.now ?? (() => new Date());
    const log = deps.log ?? ((l: string) => console.log(l));
    this.runner = cfg.enabled
      ? new AutoImportRunner(
          {
            collect: deps.collect,
            apply: deps.apply,
            isPartial: deps.isPartial,
            saveState: deps.saveState ?? ((s) => writeJson(STATE_FILE, s)),
            log,
            now: deps.now,
            sleep: deps.sleep,
            timeoutMs: deps.timeoutMs ?? RUN_TIMEOUT_MS,
            maxRunMs: deps.maxRunMs ?? RUN_DEADLINE_MS,
            retryDelayMs: deps.retryDelayMs ?? RETRY_DELAY_MS,
          },
          initial,
        )
      : null;
    if (cfg.enabled && cfg.schedule && !deps.noTimers)
      this.jobs = cfg.schedule.patterns.map((p) => new Cron(p, { timezone: cfg.schedule!.timezone, catch: true }, () => void this.runner!.trigger("schedule")));
    const next = this.nextRunAt();
    const line =
      `[autoimport] event=startup enabled=${cfg.enabled} league=${cfg.leagueId ?? "-"} next=${next ?? "-"}` +
      (cfg.enabled ? ` tz=${cfg.schedule?.timezone} state=${initial.state}` : ` why="${cfg.disabledReason}"`);
    // AUTO_IMPORT=1 with an invalid config (bad / never-firing cron, no league id, no profile): loud, not info.
    if (!cfg.enabled && cfg.invalid) (deps.logError ?? ((l: string) => console.error(l)))(`${line.replace("event=startup", "event=startup level=error")} — auto-import is OFF`);
    else log(line);
  }

  static async create(cfg: AutoImportConfig, deps: ServiceDeps): Promise<AutoImportService> {
    const saved = cfg.enabled ? await (deps.loadState ?? (() => readJson<AutoImportState>(STATE_FILE)))() : null;
    return new AutoImportService(cfg, deps, saved && (saved.state === "ok" || saved.state === "paused") ? saved : { state: "ok" });
  }

  nextRunAt(): string | undefined {
    if (!this.cfg.enabled || !this.cfg.schedule) return undefined;
    return nextFire(this.cfg.schedule, this.now())?.toISOString();
  }

  status(): AutoImportStatus {
    const base = { enabled: this.cfg.enabled, leagueId: this.cfg.leagueId, importId: this.cfg.leagueId ? `y${this.cfg.leagueId}` : undefined };
    if (!this.runner) return { ...base, disabledReason: this.cfg.disabledReason, state: "ok", running: false };
    return { ...base, ...this.runner.state(), nextRunAt: this.nextRunAt(), timezone: this.cfg.schedule?.timezone };
  }

  /** "Refresh from Yahoo now": rate-limited (accepted requests only), rejected while a run is in progress. */
  refreshNow(): RefreshResult {
    if (!this.runner) return { ok: false, code: "disabled" };
    if (this.runner.isRunning()) return { ok: false, code: "busy" };
    const t = this.now().getTime();
    const wait = this.lastManual + MANUAL_MIN_GAP_MS - t;
    if (wait > 0) return { ok: false, code: "rate_limited", retryAfterSec: Math.ceil(wait / 1000) };
    const r = this.runner.trigger("manual");
    if (!r.started) return { ok: false, code: "busy" };
    this.lastManual = t;
    return { ok: true, status: "running", runId: r.runId };
  }

  stop(): void {
    for (const j of this.jobs) j.stop();
    this.jobs = [];
  }
}

let current: AutoImportService | null = null;
/** Set once by server/index.ts; the API reads it (null = not started, e.g. in tests). */
export function setAutoImport(s: AutoImportService | null): void {
  current = s;
}
export function getAutoImport(): AutoImportService | null {
  return current;
}
