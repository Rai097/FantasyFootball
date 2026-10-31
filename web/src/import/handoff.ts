// One-click import (v7): the Yahoo bookmarklet opens Trade Desk in a named window and sends the import payload with
// window.postMessage; the app acks and posts it through the normal POST /api/import (docs/DESIGN.md "One-click
// import (v7)"). Pure helpers shared by the bookmarklet (web/src/import/bookmarklet.ts) and the app
// (web/src/import/useImportHandoff.ts): message names and the receiver's origin/shape checks. No DOM access here.

/** Hash the bookmarklet opens Trade Desk on. */
export const HANDOFF_HASH = "import-handoff";
/** Name of the window the bookmarklet opens (a second run reuses the same tab). */
export const HANDOFF_WINDOW = "ftd-import";
/** Bookmarklet → app: `{ type, v, payload }`. */
export const HANDOFF_TYPE = "ftd-import";
export const HANDOFF_VERSION = 1;
/** App → bookmarklet: `{ type }`. */
export const HANDOFF_ACK = "ftd-import-ack";

/** Yahoo Fantasy pages only, https only, no lookalike hosts (…yahoo.com.evil.com, evilfantasysports.yahoo.com). */
const YAHOO_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*fantasysports\.yahoo\.com$/;

export function isYahooOrigin(origin: unknown): boolean {
  return typeof origin === "string" && YAHOO_ORIGIN.test(origin);
}

const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The payload of a valid handoff message from a Yahoo origin, else null (the caller ignores it silently). */
export function parseHandoff(origin: unknown, data: unknown): Record<string, unknown> | null {
  if (!isYahooOrigin(origin) || !isPlainObject(data)) return null;
  if (data.type !== HANDOFF_TYPE || data.v !== HANDOFF_VERSION) return null;
  return isPlainObject(data.payload) ? data.payload : null;
}

/** Accepts only the FIRST valid message per receiver (one receiver per page load); later ones are null. */
export function createHandoffReceiver() {
  let done = false;
  return {
    accept(origin: unknown, data: unknown): Record<string, unknown> | null {
      if (done) return null;
      const p = parseHandoff(origin, data);
      if (p) done = true;
      return p;
    },
  };
}
