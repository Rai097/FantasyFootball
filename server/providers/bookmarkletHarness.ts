// Shared test harness (not a test file): synthetic Yahoo player-list HTML and the real import bookmarklet run under a
// fake browser (document / location / fetch / clipboard). Moved unchanged from import-html.adversarial.test.ts so the
// available-player projection tests (import-fa-proj.test.ts) reuse it.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ------------------------------------------------------------------ HTML builders
export interface RowSpec {
  id?: string; // Yahoo player id; omitted for a defense (team link)
  teamSlug?: string; // /nfl/teams/<slug> for a defense
  name: string;
  teamPos: string; // "Det - WR"
  owner?: string | null; // owner cell text; null = no owner cell at all
  injury?: string;
  extra?: string[]; // extra cells
  ownerFirst?: boolean; // owner cell before the name cell
}
export function row(r: RowSpec): string {
  const href = r.id ? `https://sports.yahoo.com/nfl/players/${r.id}` : `https://sports.yahoo.com/nfl/teams/${r.teamSlug}/`;
  const name = `<td><div class="ysf-player-name"><a class="Nowrap name" href="${href}">${r.name}</a> <span class="Fz-xxs">${r.teamPos}</span>${
    r.injury ? ` <span class="F-injury">${r.injury}</span>` : ""
  }</div></td>`;
  const owner = r.owner === null || r.owner === undefined ? "" : `<td class="Ta-c">${r.owner}</td>`;
  const extra = (r.extra ?? ["7", "48.2", "12%"]).map((c) => `<td>${c}</td>`).join("");
  return `<tr>${r.ownerFirst ? owner + name : name + owner}${extra}</tr>`;
}
export const page = (rows: RowSpec[]) =>
  `<html><head><title>Players | L | Yahoo! Sports</title></head><body><table><thead><tr><th>Offense</th><th>Owner</th></tr></thead><tbody>${rows
    .map(row)
    .join("\n")}</tbody></table></body></html>`;

// ------------------------------------------------------------------ the bookmarklet under a fake browser
const BOOKMARKLET = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/src/import/bookmarklet.ts")).href;

interface FakeEl {
  tag: string;
  textContent: string;
  children: FakeEl[];
  onclick?: () => unknown;
  id?: string;
  setAttribute: (k: string, v: string) => void;
  appendChild: (c: FakeEl) => FakeEl;
  append: (...c: FakeEl[]) => void;
  remove: () => void;
  select: () => void;
  click: () => void;
}
function fakeEl(tag: string): FakeEl {
  const e: FakeEl = {
    tag,
    textContent: "",
    children: [],
    setAttribute: () => undefined,
    appendChild: (c) => (e.children.push(c), c),
    append: (...c) => void e.children.push(...c),
    remove: () => undefined,
    select: () => undefined,
    click: () => undefined,
  };
  return e;
}
const walk = (e: FakeEl, out: FakeEl[] = []): FakeEl[] => (out.push(e), e.children.forEach((c) => walk(c, out)), out);

export type Route = (url: URL) => { status: number; html: string } | "throw";
let runN = 0;
/** One-click handoff (v7) under test: the injected app URL and how the opened Trade Desk window behaves. */
export interface HandoffOpts {
  appUrl: string;
  /** "ack" = the app answers on the first message; "silent" = never answers; "blocked" = window.open returns null. */
  popup: "ack" | "silent" | "blocked";
}
export interface HandoffLog {
  opened: { url: string; name: string }[];
  sent: { data: any; target: string }[];
}
const HANDOFF_DONE = /Sent to Trade Desk|Pop-up blocked|didn't answer|window was closed|Nothing sent/;

/** Runs the real bookmarklet against `route`; returns the payload it would copy (and the handoff log when `handoff`). */
export async function runBookmarklet(route: Route, handoff?: HandoffOpts): Promise<{ payload: any; diagnostics: any[]; overlay: string; handoff: HandoffLog }> {
  const body = fakeEl("body");
  const g = globalThis as any;
  const saved = { location: g.location, document: g.document, fetch: g.fetch, window: g.window, app: g.__FTD_APP_URL__ };
  let copied = "";
  const log: HandoffLog = { opened: [], sent: [] };
  if (handoff) {
    const listeners = new Set<(e: unknown) => void>();
    const appOrigin = new URL(handoff.appUrl).origin;
    const popup = {
      closed: false,
      postMessage(data: unknown, target: string) {
        log.sent.push({ data, target });
        if (handoff.popup === "ack" && target === appOrigin)
          setTimeout(() => listeners.forEach((l) => l({ source: popup, origin: appOrigin, data: { type: "ftd-import-ack" } })), 0);
      },
    };
    g.__FTD_APP_URL__ = handoff.appUrl;
    g.window = {
      open: (url: string, name: string) => (log.opened.push({ url, name }), handoff.popup === "blocked" ? null : popup),
      addEventListener: (_t: string, l: (e: unknown) => void) => void listeners.add(l),
      removeEventListener: (_t: string, l: (e: unknown) => void) => void listeners.delete(l),
    };
  } else {
    delete g.__FTD_APP_URL__;
    delete g.window;
  }
  g.location = { pathname: "/f1/1405188/players", hostname: "football.fantasysports.yahoo.com", origin: "https://football.fantasysports.yahoo.com" };
  g.document = {
    documentElement: { outerHTML: "<html></html>" },
    body,
    createElement: (t: string) => fakeEl(t),
    getElementById: () => null,
  };
  g.fetch = async (u: string) => {
    const url = new URL(u);
    const r = route(url);
    if (r === "throw") throw new TypeError("Failed to fetch");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, url: u, redirected: false, text: async () => r.html };
  };
  Object.defineProperty(g.navigator, "clipboard", { value: { writeText: async (s: string) => void (copied = s) }, configurable: true });
  try {
    await import(`${BOOKMARKLET}?run=${++runN}`);
    const deadline = Date.now() + 10_000;
    let copy: FakeEl | undefined;
    while (!(copy = walk(body).find((e) => e.textContent === "Copy to clipboard"))) {
      const fail = walk(body).find((e) => /import failed/.test(e.textContent));
      if (fail) throw new Error(fail.textContent);
      if (Date.now() > deadline) throw new Error("bookmarklet did not finish");
      await new Promise((r) => setTimeout(r, 10));
    }
    while (handoff && !walk(body).some((e) => HANDOFF_DONE.test(e.textContent))) {
      if (Date.now() > deadline + 15_000) throw new Error("bookmarklet handoff did not finish");
      await new Promise((r) => setTimeout(r, 10));
    }
    await copy.onclick!();
    const payload = JSON.parse(copied);
    return { payload, diagnostics: payload.diagnostics, overlay: walk(body).map((e) => e.textContent).join("\n"), handoff: log };
  } finally {
    g.location = saved.location;
    g.document = saved.document;
    g.fetch = saved.fetch;
    if (saved.window === undefined) delete g.window;
    else g.window = saved.window;
    if (saved.app === undefined) delete g.__FTD_APP_URL__;
    else g.__FTD_APP_URL__ = saved.app;
  }
}

