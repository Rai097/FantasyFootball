// One-click import (v7), app side: when Trade Desk was opened by the Yahoo bookmarklet (#import-handoff), listen for
// its postMessage, ack it, and hold the payload IN MEMORY ONLY (never localStorage) until the signed-in desk posts it
// through the normal POST /api/import. Validation lives in ./handoff (pure, tested). docs/DESIGN.md "One-click import (v7)".
// v8 ("Trade Desk import v8"): reportImportResult() tells the Yahoo tab how the import went and closes this tab on success.
import { useCallback, useEffect, useState } from "react";
import { createHandoffReceiver, HANDOFF_ACK, HANDOFF_HASH, resultMessage, type ImportResultReport } from "./handoff";

type Payload = Record<string, unknown>;

const receiver = createHandoffReceiver(); // one per page load: only the first valid message is used
let started = false;
let opened = false;
let pending: Payload | undefined;
/** No payload within WAIT_MS of this page load: the UI shows "Nothing received…" (a late payload still imports). */
let expired = false;
let received = false;
/** The Yahoo tab that sent the payload, and its exact origin: where the result goes (never "*"). */
let sender: { source: MessageEventSource; origin: string } | undefined;
let reported = false;
const WAIT_MS = 60_000;
const CLOSE_AFTER_MS = 800;
const subs = new Set<() => void>();

/** Call once before the first render. Does nothing unless the page was opened on #import-handoff. */
export function startImportHandoff(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  if (window.location.hash !== `#${HANDOFF_HASH}`) return;
  opened = true;
  // Drop the bookmarklet's cache-buster (?ftd=…) from the address bar.
  const params = new URLSearchParams(window.location.search);
  if (params.has("ftd")) {
    params.delete("ftd");
    const q = params.toString();
    history.replaceState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`);
  }
  window.addEventListener("message", (e: MessageEvent) => {
    const payload = receiver.accept(e.origin, e.data);
    if (!payload) return; // not Yahoo, wrong shape, or a repeat: ignored silently
    try {
      (e.source as Window | null)?.postMessage({ type: HANDOFF_ACK }, e.origin);
    } catch {
      /* the Yahoo tab is gone: nothing to tell it */
    }
    if (e.source) sender = { source: e.source, origin: e.origin };
    received = true;
    expired = false;
    pending = payload;
    subs.forEach((f) => f());
  });
  setTimeout(() => {
    if (received) return;
    expired = true;
    subs.forEach((f) => f());
  }, WAIT_MS);
}

/**
 * Tells the Yahoo tab how the import went (once per page load; later calls do nothing) and, on success, closes this
 * tab after CLOSE_AFTER_MS: the bookmarklet opened it, so the browser allows window.close(). The tab stays open when
 * the Yahoo tab can't be told (it is gone), so the result is never silently lost.
 */
export function reportImportResult(r: ImportResultReport): void {
  if (reported || !sender) return;
  reported = true;
  try {
    (sender.source as Window).postMessage(resultMessage(r), sender.origin);
  } catch {
    return; // the Yahoo tab is gone: keep this tab open with its own result on screen
  }
  if (r.ok) setTimeout(() => window.close(), CLOSE_AFTER_MS);
}

/**
 * `opened`: this page load came from the bookmarklet. `expired`: nothing arrived within 60 s. `payload`: the received
 * import, until `take()` claims it.
 */
export function useImportHandoff(): { opened: boolean; expired: boolean; payload?: Payload; take: () => Payload | undefined } {
  const [payload, setPayload] = useState(pending);
  const [isExpired, setExpired] = useState(expired);
  useEffect(() => {
    const f = () => {
      setPayload(pending);
      setExpired(expired);
    };
    subs.add(f);
    f();
    return () => void subs.delete(f);
  }, []);
  const take = useCallback(() => {
    const p = pending;
    pending = undefined;
    subs.forEach((f) => f());
    return p;
  }, []);
  return { opened, expired: isExpired, payload, take };
}
