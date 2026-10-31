import assert from "node:assert/strict";
import { test } from "node:test";
import { createHandoffReceiver, HANDOFF_TYPE, isYahooOrigin, parseHandoff } from "./handoff";

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
