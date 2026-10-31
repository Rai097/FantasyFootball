import assert from "node:assert/strict";
import { test } from "node:test";
import type { AutoImportStatus } from "../api";
import { autoImportLine, reasonText, shortTime } from "./autoImport";

const TZ = "America/Los_Angeles";
const now = new Date("2026-11-02T23:30:00Z"); // Mon 3:30 PM PST
const base: AutoImportStatus = { enabled: true, state: "ok", running: false, lastSuccessAt: "2026-11-02T22:00:00Z", nextRunAt: "2026-11-03T02:00:00Z" };

test("ok: one line 'last … · next …' with times in the viewer's zone", () => {
  const l = autoImportLine(base, now, TZ)!;
  assert.equal(l.text, "Auto-import: last 2:00 PM · next 6:00 PM");
  assert.equal(l.warn, false);
  assert.ok(l.items.length >= 2);
});

test("paused signed out: the owner's warning line, reasoning behind the tap", () => {
  const l = autoImportLine({ ...base, state: "paused", reason: "signed_out", detail: "landed on login.yahoo.com/" }, now, TZ)!;
  assert.equal(l.text, "Auto-import paused: Yahoo signed out — use the bookmark");
  assert.equal(l.warn, true);
  assert.ok(l.items.some((i) => i.label === "Detail" && i.value.includes("login.yahoo.com")));
  assert.ok(l.text.length < 80);
});

test("off: nothing; missing times are a dash, never a made-up value", () => {
  assert.equal(autoImportLine({ enabled: false, state: "ok", running: false }), null);
  assert.equal(autoImportLine(null), null);
  assert.equal(autoImportLine({ enabled: true, state: "ok", running: false }, now, TZ)!.text, "Auto-import: last — · next —");
  assert.equal(shortTime(undefined), "—");
});

test("running, other days and unknown reasons", () => {
  assert.match(autoImportLine({ ...base, running: true }, now, TZ)!.text, /reading Yahoo now/);
  assert.equal(shortTime("2026-10-31T21:00:00Z", now, TZ), "Sat 2:00 PM");
  assert.equal(shortTime("2026-10-01T21:00:00Z", now, TZ), "Oct 1, 2:00 PM");
  assert.equal(reasonText("weird"), "weird");
});
