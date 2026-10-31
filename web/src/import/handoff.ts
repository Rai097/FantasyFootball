// One-click import (v7): the Yahoo bookmarklet opens Trade Desk in a named window and sends the import payload with
// window.postMessage; the app acks and posts it through the normal POST /api/import (docs/DESIGN.md "One-click
// import (v7)"). v8: the app then reports the result back to the Yahoo tab and closes itself on success
// (docs/DESIGN.md "Trade Desk import v8"). Pure helpers shared by the bookmarklet (web/src/import/bookmarklet.ts) and
// the app (web/src/import/useImportHandoff.ts): message names and both receivers' origin/shape checks. No DOM access.

/** Hash the bookmarklet opens Trade Desk on. */
export const HANDOFF_HASH = "import-handoff";
/** Name of the window the bookmarklet opens (a second run reuses the same tab). */
export const HANDOFF_WINDOW = "ftd-import";
/** Bookmarklet → app: `{ type, v, payload }`. */
export const HANDOFF_TYPE = "ftd-import";
export const HANDOFF_VERSION = 1;
/** App → bookmarklet: `{ type }`. */
export const HANDOFF_ACK = "ftd-import-ack";
/** App → bookmarklet, after the import POST finished: `{ type, v, ok, teams?, error? }`. */
export const RESULT_TYPE = "ftd-import-result";
export const RESULT_VERSION = 1;
/** Longest error text carried back to the Yahoo box. */
const RESULT_ERROR_MAX = 300;

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

export interface ImportResultReport {
  ok: boolean;
  /** Teams in the imported league (success only). */
  teams?: number;
  /** Why the import failed (failure only), at most 300 characters. */
  error?: string;
}

/** The message the app sends back to the Yahoo tab. */
export function resultMessage(r: ImportResultReport): { type: string; v: number } & ImportResultReport {
  const m: { type: string; v: number } & ImportResultReport = { type: RESULT_TYPE, v: RESULT_VERSION, ok: r.ok };
  if (r.teams !== undefined) m.teams = r.teams;
  if (r.error !== undefined) m.error = r.error.slice(0, RESULT_ERROR_MAX);
  return m;
}

/**
 * The import result, when the message came from exactly the window the bookmarklet opened (`source === popup`) on
 * exactly Trade Desk's origin, with the right type/version and shape; else null (ignored silently).
 */
export function parseImportResult(origin: unknown, appOrigin: string, source: unknown, popup: unknown, data: unknown): ImportResultReport | null {
  if (origin !== appOrigin || source == null || source !== popup || !isPlainObject(data)) return null;
  if (data.type !== RESULT_TYPE || data.v !== RESULT_VERSION || typeof data.ok !== "boolean") return null;
  const r: ImportResultReport = { ok: data.ok };
  if (typeof data.teams === "number" && Number.isInteger(data.teams) && data.teams >= 0) r.teams = data.teams;
  if (typeof data.error === "string" && data.error) r.error = data.error.slice(0, RESULT_ERROR_MAX);
  return r;
}

/** Bookmarklet side: accepts only the FIRST valid result from the opened Trade Desk window; later ones are null. */
export function createResultReceiver(appOrigin: string, popup: unknown) {
  let done = false;
  return {
    accept(origin: unknown, source: unknown, data: unknown): ImportResultReport | null {
      if (done) return null;
      const r = parseImportResult(origin, appOrigin, source, popup, data);
      if (r) done = true;
      return r;
    },
  };
}
