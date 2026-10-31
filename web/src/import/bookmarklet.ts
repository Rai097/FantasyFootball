// "Import from Yahoo" bookmarklet. Compiled by the server (esbuild, IIFE, minified)
// into a javascript: URL — see server/providers/import-bookmarklet.ts and
// GET /api/import/bookmarklet.js. It runs on football.fantasysports.yahoo.com
// pages while the user is logged in, reads the league's own pages with
// same-origin fetches, and shows the result for the user to copy/download.
// One-click (v7): it also opens Trade Desk (APP_URL, injected by the server's esbuild `define`) in a named window and
// hands the result over with postMessage to exactly that origin (never "*"); the app then imports it through its own
// signed-in POST /api/import. It never sends data anywhere else. See docs/DESIGN.md "One-click import (v7)".
// v8: after the ack it waits for the app's result (from that window and origin only) and shows "Import completed";
// the app tab closes itself on success. See docs/DESIGN.md "Trade Desk import v8".
import { collect, leagueIdOf } from "./collect";
import { createResultReceiver, HANDOFF_ACK, HANDOFF_HASH, HANDOFF_TYPE, HANDOFF_VERSION, HANDOFF_WINDOW, type ImportResultReport } from "./handoff";

declare const __FTD_APP_URL__: string | undefined;
/** Trade Desk's URL (origin + optional path), injected at bundle time; "" = no one-click handoff (unbundled runs). */
const APP_URL: string = typeof __FTD_APP_URL__ === "string" ? __FTD_APP_URL__ : "";
/** How long the result is re-sent while waiting for Trade Desk's ack. */
const SEND_MS = 10_000;
const SEND_EVERY_MS = 400;
/** How long to wait for the app's import result after its ack, and how often to check that its tab is still open. */
const RESULT_MS = 60_000;
const RESULT_POLL_MS = 500;
const OVERLAY_ID = "ftd-import-overlay";

function overlay(): HTMLDivElement {
  document.getElementById(OVERLAY_ID)?.remove();
  const box = document.createElement("div");
  box.id = OVERLAY_ID;
  box.setAttribute(
    "style",
    "position:fixed;z-index:2147483647;top:16px;right:16px;width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;" +
      "background:#10151f;color:#e8edf5;border:1px solid #3b82f6;border-radius:10px;padding:14px 16px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)",
  );
  document.body.appendChild(box);
  return box;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, style?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (style) e.setAttribute("style", style);
  return e;
}

/**
 * Opens Trade Desk in the named import window. Must run before the first await so the click still counts as a user
 * gesture (pop-up blockers). undefined = no handoff configured; null = the browser blocked the pop-up.
 */
function openApp(): Window | null | undefined {
  if (!APP_URL || typeof window === "undefined" || typeof window.open !== "function") return undefined;
  try {
    // A fresh query string forces a real page load when the named tab is already open on Trade Desk (a hash-only
    // change would not reload it, and the app accepts one message per page load).
    return window.open(`${APP_URL}/?ftd=${Date.now()}#${HANDOFF_HASH}`, HANDOFF_WINDOW);
  } catch {
    return null;
  }
}

/** Sends the result to the Trade Desk window until it acks, the window closes, or SEND_MS passes. */
function sendToApp(popup: Window, payload: unknown): Promise<"acked" | "closed" | "timeout"> {
  const origin = new URL(APP_URL).origin;
  return new Promise((resolve) => {
    const started = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (r: "acked" | "closed" | "timeout") => {
      clearInterval(timer);
      window.removeEventListener("message", onMessage);
      resolve(r);
    };
    function onMessage(e: MessageEvent) {
      if (e.source === popup && e.origin === origin && (e.data as { type?: unknown } | null)?.type === HANDOFF_ACK) finish("acked");
    }
    const send = () => {
      if (popup.closed) return finish("closed");
      if (Date.now() - started > SEND_MS) return finish("timeout");
      try {
        // targetOrigin = Trade Desk's origin: a window that navigated anywhere else gets nothing.
        popup.postMessage({ type: HANDOFF_TYPE, v: HANDOFF_VERSION, payload }, origin);
      } catch {
        /* retried on the next tick */
      }
    };
    window.addEventListener("message", onMessage);
    timer = setInterval(send, SEND_EVERY_MS);
    send();
  });
}

/** After the ack: the app's import result, or "closed" (its tab went away without one), or "timeout". */
function waitForResult(popup: Window): Promise<ImportResultReport | "closed" | "timeout"> {
  const receiver = createResultReceiver(new URL(APP_URL).origin, popup);
  return new Promise((resolve) => {
    const started = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (r: ImportResultReport | "closed" | "timeout") => {
      clearInterval(timer);
      window.removeEventListener("message", onMessage);
      resolve(r);
    };
    function onMessage(e: MessageEvent) {
      const r = receiver.accept(e.origin, e.source, e.data);
      if (r) finish(r);
    }
    window.addEventListener("message", onMessage);
    timer = setInterval(() => {
      if (popup.closed) finish("closed");
      else if (Date.now() - started > RESULT_MS) finish("timeout");
    }, RESULT_POLL_MS);
  });
}

function resultLine(r: ImportResultReport | "closed" | "timeout"): string {
  if (r === "closed") return "Trade Desk tab closed — check Trade Desk.";
  if (r === "timeout") return "Trade Desk didn't report back within 60 s — check the Trade Desk tab.";
  if (r.ok) return `Import completed${r.teams !== undefined ? `: ${r.teams} team${r.teams === 1 ? "" : "s"}` : ""} ✓ — refresh your Trade Desk tab.`;
  return `Import failed: ${r.error ?? "Trade Desk gave no reason"}. Copy the result and paste it in Trade Desk → Connect.`;
}

const BTN = "font:inherit;font-weight:600;margin:8px 8px 0 0;padding:6px 12px;border-radius:6px;border:1px solid #3b82f6;cursor:pointer;";

async function run(): Promise<void> {
  const box = overlay();
  const status = el("div", "Trade Desk import: starting…");
  box.appendChild(status);
  const say = (s: string) => (status.textContent = `Trade Desk import: ${s}`);

  const leagueId = leagueIdOf(location);
  if (!leagueId) {
    say("open any page of your league on football.fantasysports.yahoo.com (the URL contains /f1/<league number>/) and click the bookmark again.");
    return;
  }
  const popup = openApp();
  const payload = await collect(say);
  const { teams, diagnostics, settingsSource } = payload;
  const myTeamId = payload.myTeamId;
  const faOut = payload.freeAgents ?? [];
  const rostered = teams.reduce((a, t) => a + t.players.length, 0);
  const projRos = teams.reduce((a, t) => a + t.players.filter((p) => p.yahooProj !== undefined).length, 0);
  const projWeek = teams.reduce((a, t) => a + t.players.filter((p) => p.yahooProjWeekly !== undefined).length, 0);
  const standingsTeams = teams.filter((t) => t.record).length;
  const waiverRanks = teams.filter((t) => t.waiverRank).length;
  const faWeek = faOut.filter((f) => f.yahooProjWeekly !== undefined).length;
  const faRos = faOut.filter((f) => f.yahooProj !== undefined).length;
  const json = JSON.stringify(payload);

  // ---- summary
  box.textContent = "";
  box.appendChild(el("div", "Trade Desk import v8", "font-weight:700;font-size:15px;margin-bottom:6px"));
  const summary = el("div");
  const noPos = diagnostics.reduce((a, d) => a + (Array.isArray(d.noPos) ? d.noPos.length : 0), 0);
  summary.textContent =
    `${teams.length} team${teams.length === 1 ? "" : "s"} found · ${teams.reduce((a, t) => a + t.players.length, 0)} rostered players · ` +
    `standings: ${standingsTeams ? `${standingsTeams} of ${teams.length} teams` : "NOT found"} · waiver order: ${waiverRanks ? `${waiverRanks} of ${teams.length} teams` : "NOT found"} · ` +
    `Yahoo projections: ${projRos ? `${projRos} of ${rostered} players rest of season` : "rest of season NOT found"}, ${projWeek} this week · ` +
    `${faOut.length} available players (${faOut.filter((f) => f.onWaivers === true).length} on waivers, ${faOut.filter((f) => f.onWaivers === undefined).length} unknown) · ` +
    `${faWeek} available player${faWeek === 1 ? "" : "s"} with this week's projection${faRos ? `, ${faRos} rest of season` : ""} · settings: ${settingsSource === "page" ? "read from Yahoo" : settingsSource === "partial" ? "partly read (check them after import)" : "NOT found, Yahoo defaults used (check them after import)"}` +
    (noPos ? ` · ${noPos} player link(s) without a position were skipped` : "");
  box.appendChild(summary);
  const list = el("ol", undefined, "margin:8px 0;padding-left:20px;max-height:180px;overflow:auto");
  for (const t of teams) list.appendChild(el("li", `${t.name}: ${t.players.length} players${t.id === myTeamId ? " (you)" : ""}`));
  box.appendChild(list);
  if (!teams.length)
    box.appendChild(el("div", "No teams found. Please copy the diagnostics (button below) and send them to whoever maintains your Trade Desk.", "color:#ffb3b3"));

  // One-click handoff line: the Copy / Download buttons below stay as the fallback.
  const handoff = el("div", "", "margin-top:8px;font-weight:600");
  if (popup !== undefined) box.appendChild(handoff);
  const out = el("div", "", "margin-top:6px;color:#9fb0c8");
  const copy = el("button", "Copy to clipboard", BTN + "background:#3b82f6;color:#fff");
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(json);
      out.textContent = "Copied. Now paste it into Trade Desk → Connect → Import.";
    } catch {
      const ta = el("textarea", json, "width:100%;height:120px;margin-top:6px");
      box.appendChild(ta);
      ta.select();
      out.textContent = "Clipboard blocked: select the text below and copy it (Ctrl/Cmd+C).";
    }
  };
  const dl = el("button", "Download JSON", BTN + "background:transparent;color:#e8edf5");
  dl.onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    a.download = `yahoo-league-${leagueId}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const diag = el("button", "Copy diagnostics", BTN + "background:transparent;color:#9fb0c8;border-color:#445");
  diag.onclick = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 1));
      out.textContent = "Diagnostics copied.";
    } catch {
      out.textContent = "Clipboard blocked.";
    }
  };
  const close = el("button", "Close", BTN + "background:transparent;color:#9fb0c8;border-color:#445");
  close.onclick = () => box.remove();
  box.append(copy, dl, diag, close, out);

  if (popup === null) handoff.textContent = "Pop-up blocked: Trade Desk could not open. Copy the result and paste it in Trade Desk → Connect.";
  else if (popup && teams.length) {
    handoff.textContent = "Sending to Trade Desk…";
    const r = await sendToApp(popup, payload);
    if (r === "acked") {
      handoff.textContent = "Trade Desk received it; importing…";
      handoff.textContent = resultLine(await waitForResult(popup));
    } else
      handoff.textContent =
        r === "closed"
          ? "The Trade Desk window was closed (or Yahoo cut it off). Copy the result and paste it in Trade Desk → Connect."
          : "Trade Desk didn't answer. Sign in there and click the bookmark again, or copy the result and paste it.";
  } else if (popup) {
    // Nothing to import: close the tab we opened rather than leave it waiting.
    try {
      popup.close();
    } catch {
      /* already gone */
    }
    handoff.textContent = "Nothing sent to Trade Desk: no teams found.";
  }
}

run().catch((e: Error) => {
  const box = document.getElementById(OVERLAY_ID) ?? overlay();
  box.textContent = `Trade Desk import failed: ${e.message}`;
});
