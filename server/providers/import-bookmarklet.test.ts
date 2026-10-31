// One-click import (v7/v8): the bundled bookmarklet carries the injected Trade Desk URL and posts only to its origin;
// under the fake browser it opens the app window, sends until the ack, waits for the app's import result (v8) and
// keeps Copy as the fallback.
import assert from "node:assert/strict";
import { test } from "node:test";
import { page, runBookmarklet, type Route } from "./bookmarkletHarness.js";
import { bookmarkletCode, bookmarkletUrl, collectorCode, normaliseAppUrl } from "./import-bookmarklet.js";

const APP = "https://ff.example.test";

test("bundle: injected app URL present, postMessage never targets '*', self-contained", async () => {
  const code = await bookmarkletCode(`${APP}/`);
  assert.ok(code.includes(JSON.stringify(APP)), "app URL injected");
  assert.ok(!/__FTD_APP_URL__/.test(code), "define replaced the global");
  assert.ok(code.includes("postMessage"), "handoff code bundled");
  assert.ok(!/["'`]\*["'`]/.test(code), "no \"*\" string anywhere (so never a postMessage target)");
  assert.ok(code.includes("Trade Desk import v8"));
  assert.ok(!/\bimport\s*[{(*]|\brequire\(/.test(code), "must be self-contained");
  const other = await bookmarkletCode("http://localhost:5173");
  assert.ok(other.includes('"http://localhost:5173"') && !other.includes(APP), "cached per app URL");
  assert.ok((await bookmarkletUrl(APP)).startsWith("javascript:"));
});

test("normaliseAppUrl: origin + path without trailing slash, query/hash dropped, http(s) only", () => {
  assert.equal(normaliseAppUrl("https://ff.example.test/"), APP);
  assert.equal(normaliseAppUrl("https://ff.example.test/desk/?x=1#y"), `${APP}/desk`);
  assert.throws(() => normaliseAppUrl("javascript:alert(1)"));
  assert.throws(() => normaliseAppUrl("not a url"));
});

const oneTeam: Route = (url) =>
  url.pathname === "/f1/1405188/1"
    ? { status: 200, html: page([{ id: "1", name: "Joe Burrow", teamPos: "Cin - QB" }, { id: "2", name: "Ja'Marr Chase", teamPos: "Cin - WR" }]) }
    : { status: 404, html: "" };

test("handoff: opens Trade Desk, sends to its origin until the ack, then stops; Copy stays", async () => {
  const { payload, overlay, handoff } = await runBookmarklet(oneTeam, { appUrl: APP, popup: "ack" });
  assert.equal(handoff.opened.length, 1);
  assert.match(handoff.opened[0].url, /^https:\/\/ff\.example\.test\/\?ftd=\d+#import-handoff$/);
  assert.equal(handoff.opened[0].name, "ftd-import");
  assert.ok(handoff.sent.length >= 1 && handoff.sent.length <= 2, `sent ${handoff.sent.length}x after the ack`);
  for (const s of handoff.sent) {
    assert.equal(s.target, APP, "targetOrigin is exactly the app origin");
    assert.equal(s.data.type, "ftd-import");
    assert.equal(s.data.v, 1);
  }
  assert.deepEqual(handoff.sent[0].data.payload, payload, "the handed-over payload equals the copied JSON");
  assert.equal(payload.teams.length, 1);
  assert.match(overlay, /Import completed: 1 team ✓ — refresh your Trade Desk tab/);
  assert.match(overlay, /Copy to clipboard/);
});

const result = (x: Record<string, unknown>) => ({ data: { type: "ftd-import-result", v: 1, ...x } });

test("v8 result: failure → the error text, nothing completed", async () => {
  const { overlay } = await runBookmarklet(oneTeam, { appUrl: APP, popup: "ack", result: [result({ ok: false, error: "Session expired" })] });
  assert.match(overlay, /Import failed: Session expired/);
  assert.doesNotMatch(overlay, /Import completed/);
});

test("v8 result: the Trade Desk tab closed without a result → says so", async () => {
  const { overlay } = await runBookmarklet(oneTeam, { appUrl: APP, popup: "ack", result: "close" });
  assert.match(overlay, /Trade Desk tab closed — check Trade Desk/);
});

test("v8 result: messages from another origin, another window or with a wrong shape are ignored; only the first valid one counts", async () => {
  const { overlay } = await runBookmarklet(oneTeam, {
    appUrl: APP,
    popup: "ack",
    result: [
      { ...result({ ok: true, teams: 99 }), origin: "https://evil.example" },
      { ...result({ ok: true, teams: 98 }), fromOther: true },
      result({ ok: true, teams: 97, v: 2 }),
      { data: { type: "ftd-import-ack" } },
      result({ ok: true, teams: 12 }),
      result({ ok: false, error: "late second message" }),
    ],
  });
  assert.match(overlay, /Import completed: 12 teams ✓/);
  assert.doesNotMatch(overlay, /Import completed: 9[789]|late second/);
});

test("v8: no teams found → the opened Trade Desk tab is closed, nothing sent", async () => {
  const { overlay, handoff } = await runBookmarklet(() => ({ status: 404, html: "" }), { appUrl: APP, popup: "ack" });
  assert.equal(handoff.sent.length, 0);
  assert.ok(handoff.closedByBookmarklet, "popup.close() called");
  assert.match(overlay, /Nothing sent to Trade Desk: no teams found/);
});

test("handoff: pop-up blocked → one line says so, the copy flow still works", async () => {
  const { payload, overlay, handoff } = await runBookmarklet(oneTeam, { appUrl: APP, popup: "blocked" });
  assert.equal(handoff.opened.length, 1);
  assert.equal(handoff.sent.length, 0);
  assert.match(overlay, /Pop-up blocked/);
  assert.equal(payload.teams.length, 1);
});

test("handoff: an app path is kept in the URL but the target stays the bare origin", async () => {
  const { handoff } = await runBookmarklet(oneTeam, { appUrl: `${APP}/desk`, popup: "ack" });
  assert.match(handoff.opened[0].url, /^https:\/\/ff\.example\.test\/desk\/\?ftd=/);
  assert.ok(handoff.sent.every((s) => s.target === APP));
});

test("no app URL injected (unbundled run) → no window opened, old flow unchanged", async () => {
  const { overlay, handoff } = await runBookmarklet(oneTeam);
  assert.equal(handoff.opened.length, 0);
  assert.doesNotMatch(overlay, /Trade Desk didn't answer|Sent to Trade Desk|Pop-up/);
  assert.match(overlay, /Trade Desk import v8/);
});

test("collector bundle (auto-import): exposes __ftdCollect only — no overlay, no handoff, no auto-run, self-contained", async () => {
  const code = await collectorCode();
  assert.ok(code.includes("__ftdCollect"));
  assert.ok(!code.includes("ftd-import-overlay"), "no overlay UI");
  assert.ok(!code.includes("postMessage") && !code.includes("window.open"), "no handoff");
  assert.ok(!/\bimport\s*[{(*]|\brequire\(/.test(code), "must be self-contained");
  assert.equal(await collectorCode(), code, "built once");
});
