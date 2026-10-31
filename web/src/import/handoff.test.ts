import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandoffReceiver, createResultReceiver, HANDOFF_TYPE, isYahooOrigin, parseHandoff, parseImportResult, RESULT_TYPE, resultMessage } from "./handoff";

const msg = (...a: unknown[]) => ({ type: HANDOFF_TYPE, v: 1, payload: a.length ? a[0] : { source: "yahoo-bookmarklet", teams: [] } });
const YAHOO = "https://football.fantasysports.yahoo.com";

test("Yahoo Fantasy https origins are accepted", () => {
  for (const o of [YAHOO, "https://fantasysports.yahoo.com", "https://basketball.fantasysports.yahoo.com", "https://a-b.c.fantasysports.yahoo.com"])
    assert.ok(isYahooOrigin(o), o);
});

test("http, lookalike hosts, ports, paths and non-strings are rejected", () => {
  for (const o of [
    "http://football.fantasysports.yahoo.com",
    "https://football.fantasysports.yahoo.com.evil.com",
    "https://evilfantasysports.yahoo.com",
    "https://fantasysports.yahoo.com.evil.com",
    "https://football.fantasysports.yahoo.com:8443",
    "https://football.fantasysports.yahoo.com/",
    "https://sports.yahoo.com",
    "https://evil.com/fantasysports.yahoo.com",
    "https://FOOTBALL.fantasysports.yahoo.com.evil.com",
    "null",
    "",
    null,
    undefined,
    42,
  ])
    assert.ok(!isYahooOrigin(o), String(o));
});

test("parseHandoff returns the payload of a valid message only", () => {
  const p = { source: "yahoo-bookmarklet", id: "y1" };
  assert.deepEqual(parseHandoff(YAHOO, msg(p)), p);
  assert.equal(parseHandoff("https://football.fantasysports.yahoo.com.evil.com", msg(p)), null, "lookalike host");
  assert.equal(parseHandoff("http://football.fantasysports.yahoo.com", msg(p)), null, "http");
  assert.equal(parseHandoff(YAHOO, { ...msg(p), type: "ftd-import-ack" }), null, "wrong type");
  assert.equal(parseHandoff(YAHOO, { ...msg(p), type: "other" }), null, "wrong type");
  assert.equal(parseHandoff(YAHOO, { ...msg(p), v: 2 }), null, "unknown version");
  for (const bad of [null, undefined, "x", 1, [p], { not: "it" }]) assert.equal(parseHandoff(YAHOO, bad), null, `data ${JSON.stringify(bad)}`);
  for (const bad of [null, undefined, "{}", 7, [1, 2], true]) assert.equal(parseHandoff(YAHOO, msg(bad)), null, `payload ${JSON.stringify(bad)}`);
});

test("a receiver accepts only the first valid message; invalid ones do not use it up", () => {
  const r = createHandoffReceiver();
  assert.equal(r.accept("https://evil.com", msg()), null);
  assert.equal(r.accept(YAHOO, { type: "nope" }), null);
  const first = { n: 1 };
  assert.deepEqual(r.accept(YAHOO, msg(first)), first);
  assert.equal(r.accept(YAHOO, msg({ n: 2 })), null, "second message ignored");
  assert.equal(r.accept(YAHOO, msg(first)), null, "a resend of the same message is ignored too");
  assert.deepEqual(createHandoffReceiver().accept(YAHOO, msg(first)), first, "a new page load gets a new receiver");
});

// ---- v8: the app's import result back to the bookmarklet
const APP = "https://ff.example.test";
const popup = { name: "the opened Trade Desk tab" };
const res = (x: Record<string, unknown> = {}) => ({ type: RESULT_TYPE, v: 1, ok: true, teams: 12, ...x });

test("resultMessage: type/version, error capped at 300 chars, no undefined keys", () => {
  assert.deepEqual(resultMessage({ ok: true, teams: 12 }), { type: "ftd-import-result", v: 1, ok: true, teams: 12 });
  const m = resultMessage({ ok: false, error: "x".repeat(500) });
  assert.equal(m.error!.length, 300);
  assert.ok(!("teams" in m));
  assert.deepEqual(parseImportResult(APP, APP, popup, popup, resultMessage({ ok: true, teams: 3 })), { ok: true, teams: 3 }, "round trip");
});

test("parseImportResult: only the app's exact origin, only the opened window, right type/version/shape", () => {
  assert.deepEqual(parseImportResult(APP, APP, popup, popup, res()), { ok: true, teams: 12 });
  assert.deepEqual(parseImportResult(APP, APP, popup, popup, res({ ok: false, teams: undefined, error: "Session expired" })), { ok: false, error: "Session expired" });
  for (const o of ["https://evil.example", "http://ff.example.test", "https://ff.example.test:8443", `${APP}/`, "https://ff.example.test.evil.com", "null", undefined])
    assert.equal(parseImportResult(o, APP, popup, popup, res()), null, `origin ${o}`);
  assert.equal(parseImportResult(APP, APP, { other: true }, popup, res()), null, "another window");
  assert.equal(parseImportResult(APP, APP, null, popup, res()), null, "no source");
  assert.equal(parseImportResult(APP, APP, null, null, res()), null, "no source and no popup");
  assert.equal(parseImportResult(APP, APP, popup, popup, res({ type: "ftd-import-ack" })), null, "ack is not a result");
  assert.equal(parseImportResult(APP, APP, popup, popup, res({ type: HANDOFF_TYPE })), null, "wrong type");
  assert.equal(parseImportResult(APP, APP, popup, popup, res({ v: 2 })), null, "unknown version");
  assert.equal(parseImportResult(APP, APP, popup, popup, res({ ok: "yes" })), null, "ok must be boolean");
  for (const bad of [null, undefined, "x", 1, [res()]]) assert.equal(parseImportResult(APP, APP, popup, popup, bad), null, `data ${JSON.stringify(bad)}`);
  for (const t of [-1, 1.5, "12", NaN]) assert.deepEqual(parseImportResult(APP, APP, popup, popup, res({ teams: t })), { ok: true }, `teams ${t} dropped`);
  assert.equal(parseImportResult(APP, APP, popup, popup, res({ ok: false, error: "e".repeat(999) }))!.error!.length, 300);
});

test("a result receiver accepts only the first valid result; invalid ones do not use it up", () => {
  const r = createResultReceiver(APP, popup);
  assert.equal(r.accept("https://evil.example", popup, res()), null);
  assert.equal(r.accept(APP, {}, res()), null, "wrong source");
  assert.equal(r.accept(APP, popup, { type: "nope" }), null);
  assert.deepEqual(r.accept(APP, popup, res({ teams: 10 })), { ok: true, teams: 10 });
  assert.equal(r.accept(APP, popup, res({ ok: false, error: "second" })), null, "second message ignored");
});
