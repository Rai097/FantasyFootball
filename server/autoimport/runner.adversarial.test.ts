// Adversarial: the runner state machine and the service's scheduler / rate limit (fake collector and import; no
// Chrome, no Yahoo, no .data — the service's state I/O is injected).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectResult } from "./collector.js";
import { AutoImportRunner, type AutoImportState, type RunnerDeps } from "./runner.js";
import { DEFAULT_PATTERNS, DEFAULT_TIMEZONE, nextFires, scheduleFromEnv } from "./schedule.js";
import { AutoImportService, autoImportConfig, MANUAL_MIN_GAP_MS, type ServiceDeps } from "./service.js";

const ok = (teams = 12): CollectResult => ({ ok: true, payload: { teams: Array.from({ length: teams }, (_, i) => ({ id: String(i + 1) })) }, teams });
const fail = (reason: "error" | "timeout" | "captcha" | "signed_out" = "error"): CollectResult => ({ ok: false, reason, detail: `${reason} detail` });

function runner(collect: RunnerDeps["collect"], over: Partial<RunnerDeps> = {}, initial?: AutoImportState) {
  const logs: string[] = [];
  const sleeps: number[] = [];
  const r = new AutoImportRunner(
    {
      collect,
      apply: async (p) => ({ teams: (p.teams as unknown[]).length }),
      isPartial: () => false,
      saveState: async () => undefined,
      log: (l) => logs.push(l),
      sleep: async (ms) => void sleeps.push(ms),
      timeoutMs: 40,
      retryDelayMs: 30_000,
      ...over,
    },
    initial,
  );
  return { r, logs, sleeps };
}

const settle = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => "settled" as const), new Promise<"hung">((r) => setTimeout(() => r("hung"), ms))]);

// ------------------------------------------------------------------ bounded retries, no tight loops
test("every failure reason: at most 2 collector calls per run, one backoff sleep of retryDelayMs, never a 0 ms loop", async () => {
  for (const reason of ["error", "timeout", "captcha", "signed_out"] as const) {
    let calls = 0;
    const { r, sleeps } = runner(async () => (calls++, fail(reason)));
    const t = r.trigger("schedule");
    assert.ok(t.started);
    await t.done;
    assert.ok(calls <= 2, `${reason}: ${calls} calls`);
    assert.ok(sleeps.length <= 1 && sleeps.every((ms) => ms === 30_000), `${reason}: sleeps ${sleeps}`);
    assert.equal(r.state().state, "paused");
    assert.equal(r.state().reason, reason);
  }
});

test("paused → next success clears reason and detail but keeps nothing stale", async () => {
  let n = 0;
  const { r } = runner(async () => (n++ === 0 ? fail("captcha") : ok(12)), {}, { state: "ok", lastSuccessAt: "2026-10-30T13:00:00.000Z" });
  await (r.trigger("schedule") as { done: Promise<void> }).done;
  assert.equal(r.state().state, "paused");
  assert.equal(r.state().lastSuccessAt, "2026-10-30T13:00:00.000Z", "a failure keeps the last success time");
  await (r.trigger("schedule") as { done: Promise<void> }).done;
  const s = r.state();
  assert.equal(s.state, "ok");
  assert.equal(s.reason, undefined);
  assert.equal(s.detail, undefined);
  assert.equal(s.lastTeams, 12);
});

test("a collect that resolves ok AFTER the timeout fired is not imported", async () => {
  let applied = 0;
  const { r } = runner(() => new Promise((res) => setTimeout(() => res(ok(12)), 80)), { apply: async () => (applied++, { teams: 12 }) });
  await (r.trigger("schedule") as { done: Promise<void> }).done;
  assert.equal(applied, 0);
  assert.equal(r.state().reason, "timeout");
});

test("apply throwing a non-Error (string / undefined) still pauses with a safe detail", async () => {
  for (const thrown of ["boom https://x.yahoo.com/a?crumb=SECRET", undefined, null]) {
    const { r, logs } = runner(async () => ok(12), {
      apply: async () => {
        throw thrown;
      },
    });
    await (r.trigger("schedule") as { done: Promise<void> }).done;
    assert.equal(r.state().state, "paused");
    assert.ok(!logs.join("\n").includes("SECRET"));
  }
});

test("saveState failing does not wedge the mutex", async () => {
  const { r, logs } = runner(async () => ok(12), {
    saveState: async () => {
      throw new Error("EACCES");
    },
  });
  await (r.trigger("schedule") as { done: Promise<void> }).done;
  assert.equal(r.isRunning(), false);
  assert.match(logs.join("\n"), /state_save_failed/);
  assert.ok(r.trigger("schedule").started);
});

test(
  "a collector that ignores the abort signal still ends the run (runner-side deadline)",
  { todo: "BUG: runner.attempt() awaits collect() with no race against its own timer; a hung collector holds the mutex forever (every tick 'skipped busy', refresh 409, never paused)" },
  async () => {
    const { r } = runner(() => new Promise<CollectResult>(() => undefined));
    const t = r.trigger("schedule");
    assert.ok(t.started);
    assert.equal(await settle(t.done, 500), "settled", "run still holding the mutex 500 ms after a 40 ms timeout");
  },
);

test(
  "an import (apply) that never returns still ends the run",
  { todo: "BUG: apply() (importPayload → getPlayerDb/nflverse) has no timeout; a hang there holds the mutex forever" },
  async () => {
    const { r } = runner(async () => ok(12), { apply: () => new Promise(() => undefined) });
    const t = r.trigger("schedule");
    assert.ok(t.started);
    assert.equal(await settle(t.done, 500), "settled");
  },
);

// ------------------------------------------------------------------ service: concurrency and rate limit
async function svc(collect: ServiceDeps["collect"], now: { t: number }) {
  const logs: string[] = [];
  const s = await AutoImportService.create(
    { enabled: true, leagueId: "1405188", profileDir: "/nonexistent", schedule: { patterns: DEFAULT_PATTERNS, timezone: DEFAULT_TIMEZONE } },
    {
      collect,
      apply: async (p) => ({ teams: (p.teams as unknown[]).length }),
      isPartial: () => false,
      log: (l) => logs.push(l),
      now: () => new Date(now.t),
      sleep: async () => undefined,
      retryDelayMs: 0,
      noTimers: true,
      loadState: async () => null,
      saveState: async () => undefined,
    },
  );
  return { s, logs };
}

test("scheduled tick and manual refresh at the same moment: exactly one run, the other is busy / skipped", async () => {
  let calls = 0;
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const now = { t: Date.parse("2026-11-02T14:00:00Z") };
  const { s, logs } = await svc(async () => (calls++, await hold, ok(12)), now);
  const tick = s.runner!.trigger("schedule");
  const manual = s.refreshNow();
  const tick2 = s.runner!.trigger("schedule");
  assert.ok(tick.started);
  assert.deepEqual(manual, { ok: false, code: "busy" });
  assert.equal(tick2.started, false);
  release();
  await (tick as { done: Promise<void> }).done;
  assert.equal(calls, 1);
  assert.match(logs.join("\n"), /event=skipped trigger=schedule reason=busy/);
  // A busy answer does not consume the manual budget.
  assert.equal(s.refreshNow().ok, true);
});

test("rate limit: one accepted manual refresh per 2 minutes, global (not per user), boundary exact", async () => {
  const now = { t: Date.parse("2026-11-02T18:00:00Z") };
  const { s } = await svc(async () => ok(12), now);
  const first = s.refreshNow();
  assert.equal(first.ok, true);
  await new Promise((r) => setTimeout(r, 5));
  now.t += MANUAL_MIN_GAP_MS - 1000;
  const r2 = s.refreshNow();
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.equal(r2.code, "rate_limited");
    assert.equal(r2.retryAfterSec, 1);
  }
  now.t += 1000;
  assert.equal(s.refreshNow().ok, true, "allowed again at exactly 2 minutes");
});

test("a scheduled run does not consume the manual budget, and a manual run does not block the next tick", async () => {
  const now = { t: Date.parse("2026-11-02T18:00:00Z") };
  const { s } = await svc(async () => ok(12), now);
  await (s.runner!.trigger("schedule") as { done: Promise<void> }).done;
  const m = s.refreshNow();
  assert.equal(m.ok, true);
  while (s.runner!.isRunning()) await new Promise((r) => setTimeout(r, 2));
  assert.ok(s.runner!.trigger("schedule").started);
});

// ------------------------------------------------------------------ schedule
const LA = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

test("defaults = owner's schedule: Mon–Fri 06/12/18, Sat every 2 h 06–22, Sun 09 only (a full week, LA wall clock)", () => {
  const cfg = scheduleFromEnv({});
  assert.equal(cfg.timezone, "America/Los_Angeles");
  // Mon 2026-10-26 00:00 PDT → Mon 2026-11-02 00:00 PST
  const fires = nextFires(cfg, new Date("2026-10-26T07:00:00Z"), 100).filter((d) => d < new Date("2026-11-02T08:00:00Z"));
  const want = [
    ...["Mon", "Tue", "Wed", "Thu", "Fri"].flatMap((d) => ["06:00", "12:00", "18:00"].map((h) => `${d} ${h}`)),
    ...["06", "08", "10", "12", "14", "16", "18", "20", "22"].map((h) => `Sat ${h}:00`),
    "Sun 09:00",
  ];
  assert.deepEqual(fires.map(LA), want);
});

test("DST end (Sun 2026-11-01 01:00–02:00 repeated): exactly one Sunday run at 09:00 PST, Sat 22:00 PDT, no doubled hour", () => {
  const fires = nextFires(scheduleFromEnv({}), new Date("2026-10-31T19:30:00Z"), 6);
  assert.deepEqual(
    fires.map((d) => d.toISOString()),
    ["2026-10-31T21:00:00.000Z", "2026-10-31T23:00:00.000Z", "2026-11-01T01:00:00.000Z", "2026-11-01T03:00:00.000Z", "2026-11-01T05:00:00.000Z", "2026-11-01T17:00:00.000Z"],
  );
  // An operator cron inside the repeated hour fires once, not twice.
  const odd = nextFires({ patterns: ["30 1 * * *"], timezone: "America/Los_Angeles" }, new Date("2026-11-01T07:00:00Z"), 2);
  assert.equal(odd[0].toISOString(), "2026-11-01T08:30:00.000Z");
  assert.equal(odd[1].toISOString(), "2026-11-02T09:30:00.000Z");
});

test("bad AUTO_IMPORT_CRON / TZ: auto-import stays OFF with a reason (never on with a fallback)", () => {
  const yes = () => true;
  for (const c of ["60 * * * *", "0 25 * * *", "@hourly", "0 6", "*/0 * * * *", "0 6 * * 1-5; nonsense", "0 6 * * * *"]) {
    const cfg = autoImportConfig({ AUTO_IMPORT: "1", AUTO_IMPORT_LEAGUE_ID: "1405188", AUTO_IMPORT_CRON: c }, yes);
    assert.equal(cfg.enabled, false, c);
    assert.match(String(cfg.disabledReason), /bad schedule/, c);
  }
  assert.equal(autoImportConfig({ AUTO_IMPORT: "1", AUTO_IMPORT_LEAGUE_ID: "1405188", AUTO_IMPORT_TZ: "Mars/Base" }, yes).enabled, false);
});

test(
  "AUTO_IMPORT_CRON that can never fire (';', ' ; ', Feb 31) is refused, not 'enabled' with no runs",
  { todo: "BUG: scheduleFromEnv accepts an empty pattern list and never-firing patterns; the service starts enabled=true next=- and silently never runs" },
  () => {
    for (const c of [";", " ; ", "0 6 31 2 *"]) {
      const cfg = autoImportConfig({ AUTO_IMPORT: "1", AUTO_IMPORT_LEAGUE_ID: "1405188", AUTO_IMPORT_CRON: c }, () => true);
      assert.equal(cfg.enabled, false, JSON.stringify(c));
    }
  },
);

test("AUTO_IMPORT unset / not exactly 1 → off; the disabled service has no runner, no timers, and never collects", async () => {
  for (const v of [undefined, "", "0", "true", "yes", " 1x"]) {
    const env: NodeJS.ProcessEnv = { AUTO_IMPORT_LEAGUE_ID: "1405188" };
    if (v !== undefined) env.AUTO_IMPORT = v;
    assert.equal(autoImportConfig(env, () => true).enabled, false, String(v));
  }
  let collected = 0;
  const s = await AutoImportService.create(autoImportConfig({}), {
    collect: async () => (collected++, ok(1)),
    apply: async () => ({ teams: 1 }),
    isPartial: () => false,
    log: () => undefined,
  });
  assert.equal(s.runner, null);
  assert.deepEqual(s.refreshNow(), { ok: false, code: "disabled" });
  assert.equal(collected, 0);
  s.stop();
});

test("the test process itself runs with AUTO_IMPORT off (npm test never launches Chrome via the service)", () => {
  assert.equal(autoImportConfig(process.env).enabled, false);
});

test("a corrupt / unknown saved state starts as ok (the pause is not resurrected from garbage)", async () => {
  for (const saved of [{ state: "weird" }, "x", 42, null]) {
    const s = await AutoImportService.create(
      { enabled: true, leagueId: "1", profileDir: "/x", schedule: { patterns: DEFAULT_PATTERNS, timezone: DEFAULT_TIMEZONE } },
      {
        collect: async () => ok(1),
        apply: async () => ({ teams: 1 }),
        isPartial: () => false,
        log: () => undefined,
        noTimers: true,
        loadState: async () => saved as never,
        saveState: async () => undefined,
      },
    );
    assert.equal(s.status().state, "ok");
  }
});
