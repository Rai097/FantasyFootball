// Auto-import runner — STOPGAP until the Yahoo API is approved (docs/DESIGN.md "Auto-import (stopgap until Yahoo
// API)"). One run at a time (mutex), a hard timeout per attempt, at most one retry after a short backoff, then the
// state becomes "paused" with the reason. Scheduled runs keep trying while paused; a success clears the pause.
// Every run also has an overall hard deadline (maxRunMs): it ends the run as "timeout" and releases the mutex even
// when the collector or the import ignores its abort signal. Members see only a short sanitized detail
// (publicDetail); the full (credential-free) message goes to the server log.
// A failed, empty or partial result is NEVER imported: only a collector "ok" reaches `apply` (the same server-side
// import as POST /api/import), and `apply` itself refuses fewer teams than the stored league (PartialImportError).
// I/O is injected (collector, import, state file, clock) so the state machine is tested without Chrome or Yahoo.
import type { CollectResult, FailReason } from "./collector.js";
import { publicDetail, safeMessage } from "./collector.js";

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
  /**
   * The server-side import; returns the team count saved. Throws PartialImportError (→ "partial") or anything
   * (→ "error"). `signal` aborts when the attempt or the run deadline passes: the import must then write nothing.
   */
  apply: (payload: Record<string, unknown>, signal: AbortSignal) => Promise<{ teams: number }>;
  isPartial: (e: unknown) => boolean;
  saveState: (s: AutoImportState) => Promise<void>;
  log: (line: string) => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Per attempt, separately for the collection and for the import (owner brief: 3 minutes). */
  timeoutMs: number;
  /** Hard cap on a whole run, retry included (fix round 1: 4 minutes). */
  maxRunMs?: number;
  /** Pause before the one retry. */
  retryDelayMs: number;
}

/** Signed out or a captcha/consent page will not fix itself in a minute: no retry, pause at once. */
const NO_RETRY = new Set<FailReason>(["signed_out", "captcha", "profile_in_use"]);
/** Default hard cap on a whole run. */
export const MAX_RUN_MS = 4 * 60_000;

type Attempt = { ok: true; teams: number } | { ok: false; reason: FailReason; detail: string };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settles with `p`, or with "aborted" as soon as `signal` aborts (p keeps running; its rejection is swallowed). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<{ v: T } | { e: unknown } | "aborted"> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.resolve("aborted");
  }
  return new Promise((resolve) => {
    const onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => resolve({ v }),
      (e) => resolve({ e }),
    ).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** An AbortController that aborts after `ms` or when `parent` aborts; `done()` clears the timer. */
function bounded(ms: number, parent: AbortSignal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const onParent = () => ac.abort();
  parent.addEventListener("abort", onParent, { once: true });
  if (parent.aborted) ac.abort();
  return {
    signal: ac.signal,
    done: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParent);
    },
  };
}

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

  private async attempt(run: AbortSignal): Promise<Attempt> {
    const secs = Math.round(this.d.timeoutMs / 1000);
    const late = (what: string): Attempt => ({ ok: false, reason: "timeout", detail: run.aborted ? "the run passed its time limit" : `no ${what} within ${secs} s` });
    const c = bounded(this.d.timeoutMs, run);
    let r: CollectResult;
    try {
      const got = await raceAbort(Promise.resolve().then(() => this.d.collect(c.signal)), c.signal);
      if (got === "aborted" || c.signal.aborted) return late("result");
      r = "e" in got ? { ok: false, reason: "error", detail: errText(got.e) } : got.v;
    } finally {
      c.done();
    }
    if (!r.ok) return r;
    if (!r.teams) return { ok: false, reason: "empty", detail: "0 teams" };
    const a = bounded(this.d.timeoutMs, run);
    try {
      const got = await raceAbort(Promise.resolve().then(() => this.d.apply(r.payload, a.signal)), a.signal);
      if (got === "aborted") return late("import");
      if ("v" in got) return { ok: true, teams: got.v.teams };
      return { ok: false, reason: this.d.isPartial(got.e) ? "partial" : "error", detail: errText(got.e) };
    } finally {
      a.done();
    }
  }

  private async runOnce(runId: string, trigger: Trigger): Promise<void> {
    const started = this.now();
    const maxRunMs = this.d.maxRunMs ?? MAX_RUN_MS;
    const run = new AbortController();
    const deadline = setTimeout(() => run.abort(), maxRunMs);
    let attempts = 0;
    const work = (async (): Promise<Attempt> => {
      attempts = 1;
      let r = await this.attempt(run.signal);
      if (!r.ok && !NO_RETRY.has(r.reason) && !run.signal.aborted) {
        await this.sleep(this.d.retryDelayMs);
        if (run.signal.aborted) return r;
        attempts = 2;
        r = await this.attempt(run.signal);
      }
      return r;
    })();
    const got = await raceAbort(work, run.signal);
    clearTimeout(deadline);
    const r: Attempt =
      got === "aborted"
        ? { ok: false, reason: "timeout", detail: `the run passed its ${Math.round(maxRunMs / 1000)} s limit` }
        : "v" in got
          ? got.v
          : { ok: false, reason: "error", detail: errText(got.e) };
    // A run that ended any other way stops whatever is still in flight (an attempt that ignored its signal).
    run.abort();
    const end = this.now();
    this.st.lastAttemptAt = end.toISOString();
    if (r.ok) this.st = { state: "ok", lastSuccessAt: end.toISOString(), lastAttemptAt: end.toISOString(), lastTeams: r.teams };
    else this.st = { ...this.st, state: "paused", reason: r.reason, detail: publicDetail(r.detail) };
    const ms = end.getTime() - started.getTime();
    this.d.log(
      `[autoimport] event=run run=${runId} trigger=${trigger} result=${r.ok ? "ok" : "failed"} reason=${r.ok ? "-" : r.reason} ms=${ms} teams=${r.ok ? r.teams : "-"} attempts=${attempts}` +
        (r.ok ? "" : ` error="${safeMessage(r.detail, 500).replace(/"/g, "'")}"`),
    );
    try {
      await this.d.saveState(this.st);
    } catch (e) {
      this.d.log(`[autoimport] event=state_save_failed error=${safeMessage(errText(e))}`);
    }
  }
}
