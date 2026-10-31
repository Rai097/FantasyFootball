// One-click import (v7), app side: when Trade Desk was opened by the Yahoo bookmarklet (#import-handoff), listen for
// its postMessage, ack it, and hold the payload IN MEMORY ONLY (never localStorage) until the signed-in desk posts it
// through the normal POST /api/import. Validation lives in ./handoff (pure, tested). docs/DESIGN.md "One-click import (v7)".
import { useCallback, useEffect, useState } from "react";
import { createHandoffReceiver, HANDOFF_ACK, HANDOFF_HASH } from "./handoff";

type Payload = Record<string, unknown>;

const receiver = createHandoffReceiver(); // one per page load: only the first valid message is used
let started = false;
let opened = false;
let pending: Payload | undefined;
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
    pending = payload;
    subs.forEach((f) => f());
  });
}

/** `opened`: this page load came from the bookmarklet. `payload`: the received import, until `take()` claims it. */
export function useImportHandoff(): { opened: boolean; payload?: Payload; take: () => Payload | undefined } {
  const [payload, setPayload] = useState(pending);
  useEffect(() => {
    const f = () => setPayload(pending);
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
  return { opened, payload, take };
}
