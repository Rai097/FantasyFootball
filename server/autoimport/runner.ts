// Auto-import runner — STOPGAP until the Yahoo API is approved (docs/DESIGN.md "Auto-import (stopgap until Yahoo
// API)"). One run at a time (mutex), a hard timeout per attempt, at most one retry after a short backoff, then the
// state becomes "paused" with the reason. Scheduled runs keep trying while paused; a success clears the pause.
// A failed, empty or partial result is NEVER imported: only a collector "ok" reaches `apply` (the same server-side
// import as POST /api/import), and `apply` itself refuses fewer teams than the stored league (PartialImportError).
// I/O is injected (collector, import, state file, clock) so the state machine is tested without Chrome or Yahoo.
import type { CollectResult, FailReason } from "./collector.js";
import { safeMessage } from "./collector.js";

export type Trigger = "schedule" | "manual";

export interface AutoImportState {
  state: "ok" | "paused";
  /** Why the last run failed (kept while paused). */
  reason?: FailReason;
  detail?: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  lastTeams?: number;
}

export interface RunnerDeps {
  /** One collection attempt; must stop and resolve "timeout" soon after `signal` aborts. */
  collect: (signal: AbortSignal) => Promise<CollectResult>;
  /** The server-side import; returns the team count saved. Throws PartialImportError (→ "partial") or anything (→ "error"). */
  apply: (payload: Record<string, unknown>) => Promise<{ teams: number }>;
  isPartial: (e: unknown) => boolean;
  saveState: (s: AutoImportState) => Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Per attempt (owner brief: 3 minutes). */
  timeoutMs: number;
  /** Pause before the one retry. */
  retryDelayMs: number;
}

/** Signed out or a captcha/consent page will not fix itself in a minute: no retry, pause at once. */
const NO_RETRY = new Set<FailReason>(["signed_out", "captcha"]);

export class AutoImportRunner {
  private st: AutoImportState;
  private running: Promise<void> | null = null;
  private seq = 0;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly d: RunnerDeps,
    initial: AutoImportState = { state: "ok" },
  ) {
    this.st = { ...initial };
    this.now = d.now ?? (() => new Date());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  state(): AutoImportState & { running: boolean } {
    return { ...this.st, running: !!this.running };
  }

  isRunning(): boolean {
    return !!this.running;
  }

  /** Starts a run unless one is in progress (mutex). Returns at once; `done` settles when the run ends. */
  trigger(trigger: Trigger): { started: false } | { started: true; runId: string; done: Promise<void> } {
    if (this.running) {
      this.d.log(`[autoimport] event=skipped trigger=${trigger} reason=busy`);
      return { started: false };
    }
    const runId = `${this.now().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${++this.seq}`;
    const done = this.runOnce(runId, trigger).finally(() => {
      this.running = null;
    });
    this.running = done;
    return { started: true, runId, done };
  }

  private async attempt(): Promise<{ ok: true; teams: number } | { ok: false; reason: FailReason; detail: string }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.d.timeoutMs);
    let r: CollectResult;
    try {
      r = await this.d.collect(ac.signal);
    } catch (e) {
      r = { ok: false, reason: "error", detail: safeMessage((e as Error)?.message ?? String(e)) };
    } finally {
      clearTimeout(timer);
    }
    if (ac.signal.aborted) return { ok: false, reason: "timeout", detail: `no result within ${Math.round(this.d.timeoutMs / 1000)} s` };
    if (!r.ok) return r;
    if (!r.teams) return { ok: false, reason: "empty", detail: "0 teams" };
    try {
      const a = await this.d.apply(r.payload);
      return { ok: true, teams: a.teams };
    } catch (e) {
      const detail = safeMessage((e as Error)?.message ?? String(e));
      return this.d.isPartial(e) ? { ok: false, reason: "partial", detail } : { ok: false, reason: "error", detail };
    }
  }

  private async runOnce(runId: string, trigger: Trigger): Promise<void> {
    const started = this.now();
    let r = await this.attempt();
    let attempts = 1;
    if (!r.ok && !NO_RETRY.has(r.reason)) {
      await this.sleep(this.d.retryDelayMs);
      r = await this.attempt();
      attempts = 2;
    }
    const end = this.now();
    this.st.lastAttemptAt = end.toISOString();
    if (r.ok) this.st = { state: "ok", lastSuccessAt: end.toISOString(), lastAttemptAt: end.toISOString(), lastTeams: r.teams };
    else this.st = { ...this.st, state: "paused", reason: r.reason, detail: r.detail };
    const ms = end.getTime() - started.getTime();
    this.d.log(
      `[autoimport] event=run run=${runId} trigger=${trigger} result=${r.ok ? "ok" : "failed"} reason=${r.ok ? "-" : r.reason} ms=${ms} teams=${r.ok ? r.teams : "-"} attempts=${attempts}` +
        (r.ok ? "" : ` detail="${r.detail.replace(/"/g, "'")}"`),
    );
    try {
      await this.d.saveState(this.st);
    } catch (e) {
      this.d.log(`[autoimport] event=state_save_failed error=${safeMessage((e as Error).message)}`);
    }
  }
}
