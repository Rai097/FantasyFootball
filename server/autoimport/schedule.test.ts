import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PATTERNS, DEFAULT_TIMEZONE, nextFire, nextFires, scheduleFromEnv } from "./schedule.js";

const cfg = { patterns: DEFAULT_PATTERNS, timezone: DEFAULT_TIMEZONE };
const iso = (d: Date | null) => d?.toISOString();

test("Sat Oct 31 2026 (PDT): every 2 h 06:00–22:00, nothing at 23:00", () => {
  // 2026-10-31 05:00 PDT = 12:00Z
  const fires = nextFires(cfg, new Date("2026-10-31T12:00:00Z"), 9).map(iso);
  assert.deepEqual(fires, [
    "2026-10-31T13:00:00.000Z", // 06:00 PDT
    "2026-10-31T15:00:00.000Z",
    "2026-10-31T17:00:00.000Z",
    "2026-10-31T19:00:00.000Z",
    "2026-10-31T21:00:00.000Z",
    "2026-10-31T23:00:00.000Z",
    "2026-11-01T01:00:00.000Z",
    "2026-11-01T03:00:00.000Z",
    "2026-11-01T05:00:00.000Z", // 22:00 PDT
  ]);
});

test("DST end (Nov 1 2026): after Sat 22:00 PDT the next run is Sun 09:00 PST (17:00Z), then Mon 06:00 PST", () => {
  const after22 = new Date("2026-11-01T05:00:00Z"); // Sat 22:00 PDT
  assert.equal(iso(nextFire(cfg, after22)), "2026-11-01T17:00:00.000Z"); // Sun 09:00 PST, not 16:00Z
  assert.equal(iso(nextFire(cfg, new Date("2026-11-01T06:00:00Z"))), "2026-11-01T17:00:00.000Z"); // Sat 23:00 PDT: nothing
  assert.equal(iso(nextFire(cfg, new Date("2026-11-01T17:00:00Z"))), "2026-11-02T14:00:00.000Z"); // Mon 06:00 PST
});

test("Sunday: 09:00 only", () => {
  // Sun Nov 8 2026 00:00 PST = 08:00Z
  const fires = nextFires(cfg, new Date("2026-11-08T08:00:00Z"), 2).map(iso);
  assert.deepEqual(fires, ["2026-11-08T17:00:00.000Z", "2026-11-09T14:00:00.000Z"]);
});

test("weekdays: 06:00, 12:00, 18:00 only", () => {
  // Tue Nov 3 2026 00:00 PST = 08:00Z
  const fires = nextFires(cfg, new Date("2026-11-03T08:00:00Z"), 4).map(iso);
  assert.deepEqual(fires, ["2026-11-03T14:00:00.000Z", "2026-11-03T20:00:00.000Z", "2026-11-04T02:00:00.000Z", "2026-11-04T14:00:00.000Z"]);
});

test("DST start (Mar 14 2027): Sun 09:00 PDT = 16:00Z, Mon 06:00 PDT = 13:00Z", () => {
  assert.equal(iso(nextFire(cfg, new Date("2027-03-14T08:00:00Z"))), "2027-03-14T16:00:00.000Z");
  assert.equal(iso(nextFire(cfg, new Date("2027-03-14T16:00:00Z"))), "2027-03-15T13:00:00.000Z");
});

test("scheduleFromEnv: defaults, override, and fail closed on bad input", () => {
  assert.deepEqual(scheduleFromEnv({}), cfg);
  assert.deepEqual(scheduleFromEnv({ AUTO_IMPORT_CRON: "0 7 * * *; 30 19 * * 0", AUTO_IMPORT_TZ: "UTC" }), { patterns: ["0 7 * * *", "30 19 * * 0"], timezone: "UTC" });
  assert.throws(() => scheduleFromEnv({ AUTO_IMPORT_CRON: "0 0 7 * * *" }), /5 fields/);
  assert.throws(() => scheduleFromEnv({ AUTO_IMPORT_CRON: "99 7 * * *" }));
  assert.throws(() => scheduleFromEnv({ AUTO_IMPORT_TZ: "Mars/Olympus" }));
});
