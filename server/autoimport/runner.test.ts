// Auto-import runner state machine with fake collector / import (no Chrome, no Yahoo, no .data).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectResult } from "./collector.js";
import { AutoImportRunner, type AutoImportState, type RunnerDeps } from "./runner.js";

class PartialErr extends Error {}
const okResult = (teams = 12): CollectResult => ({ ok: true, payload: { teams: Array.from({ length: teams }, (_, i) => ({ id: String(i + 1) })) }, teams });

function setup(results: (CollectResult | "hang" | "throw")[], over: Partial<RunnerDeps> = {}, initial?: AutoImportState) {
  const logs: string[] = [];
  const applied: unknown[] = [];
  const saved: AutoImportState[] = [];
  let calls = 0;
  const deps: RunnerDeps = {
    collect: (signal) => {
      const r = results[Math.min(calls++, results.length - 1)];
      if (r === "throw") return Promise.reject(new Error("boom at https://login.yahoo.com/x?token=SECRET123"));
      if (r === "hang") return new Promise((res) => signal.addEventListener("abort", () => res({ ok: false, reason: "timeout", detail: "closed" })));
      return Promise.resolve(r);
    },
    apply: async (p) => (applied.push(p), { teams: (p.teams as unknown[]).length }),
    isPartial: (e) => e instanceof PartialErr,
    saveState: async (s) => void saved.push({ ...s }),
    log: (l) => logs.push(l),
    sleep: async () => undefined,
    timeoutMs: 50,
    retryDelayMs: 0,
    ...over,
  };
  const runner = new AutoImportRunner(deps, initial);
  return { runner, logs, applied, saved, calls: () => calls };
}

async function runOnce(r: AutoImportRunner, trigger: "schedule" | "manual" = "schedule") {
  const t = r.trigger(trigger);
  assert.ok(t.started);
  await t.done;
}

test("success: imports, state ok, one structured log line with run id, trigger, result, ms, teams", async () => {
  const s = setup([okResult(12)]);
  await runOnce(s.runner, "manual");
  assert.equal(s.applied.length, 1);
  const st = s.runner.state();
  assert.equal(st.state, "ok");
  assert.ok(st.lastSuccessAt && st.lastAttemptAt);
  assert.equal(st.running, false);
  const runLines = s.logs.filter((l) => l.includes("event=run "));
  assert.equal(runLines.length, 1);
  assert.match(runLines[0], /^\[autoimport\] event=run run=\S+ trigger=manual result=ok reason=- ms=\d+ teams=12 attempts=1$/);
  assert.equal(s.saved.at(-1)?.state, "ok");
});

test("signed out: no retry, paused, nothing imported", async () => {
  const s = setup([{ ok: false, reason: "signed_out", detail: "landed on login.yahoo.com/" }]);
  await runOnce(s.runner);
  assert.equal(s.calls(), 1, "signed_out is not retried");
  assert.equal(s.applied.length, 0);
  const st = s.runner.state();
  assert.equal(st.state, "paused");
  assert.equal(st.reason, "signed_out");
  assert.equal(st.lastSuccessAt, undefined);
  assert.match(s.logs.join("\n"), /result=failed reason=signed_out .*attempts=1/);
});

test("empty: retried once, then paused; nothing imported", async () => {
  const s = setup([{ ok: false, reason: "empty", detail: "0 teams" }]);
  await runOnce(s.runner);
  assert.equal(s.calls(), 2);
  assert.equal(s.applied.length, 0);
  assert.equal(s.runner.state().reason, "empty");
  assert.equal(s.runner.state().state, "paused");
});

test("ok with 0 teams is treated as empty (never imported)", async () => {
  const s = setup([{ ok: true, payload: { teams: [] }, teams: 0 }]);
  await runOnce(s.runner);
  assert.equal(s.applied.length, 0);
  assert.equal(s.runner.state().reason, "empty");
});

test("timeout: the attempt is aborted, retried once, then paused 'timeout'", async () => {
  const s = setup(["hang"]);
  const t0 = Date.now();
  await runOnce(s.runner);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(s.calls(), 2);
  assert.equal(s.runner.state().reason, "timeout");
  assert.equal(s.applied.length, 0);
});

test("a late ok after the timeout is still a timeout and is NOT imported", async () => {
  const late: RunnerDeps["collect"] = (signal) => new Promise((res) => signal.addEventListener("abort", () => setTimeout(() => res(okResult()), 5)));
  const s = setup([], { collect: late });
  await runOnce(s.runner);
  assert.equal(s.applied.length, 0);
  assert.equal(s.runner.state().reason, "timeout");
});

test("error then success: one retry, state ok", async () => {
  const s = setup(["throw", okResult(10)]);
  await runOnce(s.runner);
  assert.equal(s.calls(), 2);
  assert.equal(s.applied.length, 1);
  assert.equal(s.runner.state().state, "ok");
  assert.match(s.logs.join("\n"), /attempts=2/);
});

test("error detail never carries URL queries (tokens)", async () => {
  const s = setup(["throw"]);
  await runOnce(s.runner);
  const all = s.logs.join("\n") + JSON.stringify(s.runner.state());
  assert.ok(!all.includes("SECRET123"));
  assert.match(all, /login\.yahoo\.com\/x/);
});

test("partial (import refuses fewer teams): paused 'partial'", async () => {
  const s = setup([okResult(5)], {
    apply: async () => {
      throw new PartialErr("5 of 12 teams read");
    },
  });
  await runOnce(s.runner);
  assert.equal(s.runner.state().reason, "partial");
  assert.equal(s.runner.state().state, "paused");
});

test("while paused a scheduled run still tries; a success clears the pause", async () => {
  const s = setup([okResult()], {}, { state: "paused", reason: "signed_out", detail: "x", lastSuccessAt: "2026-10-30T13:00:00.000Z" });
  assert.equal(s.runner.state().state, "paused");
  await runOnce(s.runner, "schedule");
  const st = s.runner.state();
  assert.equal(st.state, "ok");
  assert.equal(st.reason, undefined);
  assert.equal(st.detail, undefined);
  assert.notEqual(st.lastSuccessAt, "2026-10-30T13:00:00.000Z");
});

test("failure keeps the previous lastSuccessAt", async () => {
  const s = setup([{ ok: false, reason: "captcha", detail: "x" }], {}, { state: "ok", lastSuccessAt: "2026-10-30T13:00:00.000Z" });
  await runOnce(s.runner);
  assert.equal(s.runner.state().lastSuccessAt, "2026-10-30T13:00:00.000Z");
  assert.equal(s.runner.state().reason, "captcha");
});

test("mutex: a second trigger during a run is rejected; free again afterwards", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup([], { collect: async () => (await gate, okResult()), timeoutMs: 5_000 });
  const first = s.runner.trigger("schedule");
  assert.ok(first.started);
  assert.equal(s.runner.state().running, true);
  const second = s.runner.trigger("manual");
  assert.equal(second.started, false);
  assert.match(s.logs.join("\n"), /event=skipped trigger=manual reason=busy/);
  release();
  await first.done;
  assert.equal(s.applied.length, 1, "only one run imported");
  assert.equal(s.runner.state().running, false);
  assert.ok(s.runner.trigger("manual").started);
});

// ------------------------------------------------------------------ fix round 1
test("overall run deadline: retries included, the run ends as timeout and frees the mutex; the import sees an aborted signal", async () => {
  let applySignal: AbortSignal | undefined;
  // Each attempt is within its own 1 s budget, but the whole run is capped at 60 ms.
  const s = setup([], {
    collect: () => new Promise<CollectResult>(() => undefined),
    timeoutMs: 1_000,
    maxRunMs: 60,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    retryDelayMs: 10,
  });
  const t0 = Date.now();
  await runOnce(s.runner);
  assert.ok(Date.now() - t0 < 500, `run took ${Date.now() - t0} ms`);
  assert.equal(s.runner.state().reason, "timeout");
  assert.equal(s.runner.isRunning(), false);
  const s2 = setup([okResult()], { apply: (_p, signal) => ((applySignal = signal), new Promise(() => undefined)), timeoutMs: 1_000, maxRunMs: 60 });
  await runOnce(s2.runner);
  assert.equal(s2.runner.state().reason, "timeout");
  assert.equal(applySignal?.aborted, true, "a late import is told to write nothing");
});

test("profile_in_use: no retry, no backoff (the next tick tries again)", async () => {
  const sleeps: number[] = [];
  const s = setup([{ ok: false, reason: "profile_in_use", detail: "open in another Chrome" }], { sleep: async (ms) => void sleeps.push(ms), retryDelayMs: 30_000 });
  await runOnce(s.runner);
  assert.equal(s.calls(), 1);
  assert.deepEqual(sleeps, []);
  assert.equal(s.runner.state().reason, "profile_in_use");
});

test("status detail is short and path-free; the log keeps the full (credential-free) message", async () => {
  const s = setup(["throw"], { collect: () => Promise.reject(new Error(`EACCES open '/Users/owner/.data/yahoo-chrome-profile/SingletonLock' ${"x".repeat(300)} cookie=SECRETC`)) });
  await runOnce(s.runner);
  const d = String(s.runner.state().detail);
  assert.ok(d.length <= 120 && !d.includes("/Users"), d);
  const log = s.logs.join("\n");
  assert.match(log, /\/Users\/owner\/\.data\/yahoo-chrome-profile/);
  assert.ok(!log.includes("SECRETC"));
});
