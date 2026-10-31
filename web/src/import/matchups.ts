// Matchups collector (docs/DESIGN.md "Matchups and results log (2026-10-31)"): runs AFTER the shared collect() (which
// stays unchanged) in both the bookmarklet and the auto-import entry, and adds Yahoo's current matchup week and the
// matchups of that week and the week before to the payload. Read-only same-origin fetches, at most
// MAX_MATCHUP_FETCHES pages: the league home page (week picker + this week's pairings), the module for week W−1, and
// the owner's matchup page for W and W−1. Any failure is a diagnostics entry (step "matchups"); it never fails the
// import. Pure parsing lives in matchupsHtml.ts.
import type { Diag, Payload } from "./collect";
import { parseMatchupModule, parseMatchupPage, type MatchupStatus, type ModulePairing, type PageSide } from "./matchupsHtml";

/** Yahoo page reads one import may add for matchups (owner's league ≈ 1 MB each). */
export const MAX_MATCHUP_FETCHES = 4;
/** Time limits (fix round 1): one page read aborts after `fetchMs`; the whole matchups step stops reading after
 *  `budgetMs`. A timeout is a diagnostics note; collect()'s payload is never held or changed by it. */
export const MATCHUP_TIMEOUTS = { fetchMs: 20_000, budgetMs: 60_000 } as const;

export interface MatchupPageWire {
  mid1: string;
  mid2: string;
  sides: [PageSide, PageSide];
}
export interface MatchupWeekWire {
  week: number;
  status: MatchupStatus;
  statusText?: string;
  pairings: ModulePairing[];
  /** Matchup pages read this run (the owner's pairing). */
  pages: MatchupPageWire[];
}
/** What the payload carries: `matchupWeek` = Yahoo's current matchup week; `matchups.weeks` = W and W−1. */
export interface MatchupsWire {
  weeks: MatchupWeekWire[];
}
export type PayloadWithMatchups = Payload & { matchupWeek?: number; matchups?: MatchupsWire };

/** `signal` aborts the read when its time is up (the collector also stops waiting on its own). */
export type GetPage = (url: string, signal?: AbortSignal) => Promise<{ ok: boolean; status: number; html: string }>;

const defaultGetPage: GetPage = async (url, signal) => {
  const res = await fetch(url, { credentials: "include", redirect: "follow", ...(signal ? { signal } : {}) });
  return { ok: res.ok, status: res.status, html: res.ok ? await res.text() : "" };
};

/** A module response may be HTML or JSON wrapping the HTML: the first string that holds the module. */
export function moduleHtml(body: string): string {
  const t = body.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return body;
  try {
    const stack: unknown[] = [JSON.parse(t)];
    while (stack.length) {
      const v = stack.pop();
      if (typeof v === "string" && /matchupweek/i.test(v)) return v;
      if (v && typeof v === "object") stack.push(...Object.values(v as Record<string, unknown>));
    }
  } catch {
    /* not JSON: parse as HTML */
  }
  return body;
}

export interface MatchupsResult {
  matchupWeek?: number;
  matchups?: MatchupsWire;
  diagnostics: Diag[];
  fetches: number;
}

/** Reads the matchups of Yahoo's current week W and of W−1. Throws only on a programming error (caught by the caller). */
export async function collectMatchups(o: {
  base: string;
  leagueId: string;
  myTeamId?: string;
  getPage?: GetPage;
  log?: (s: string) => void;
  fetchTimeoutMs?: number;
  budgetMs?: number;
}): Promise<MatchupsResult> {
  const get = o.getPage ?? defaultGetPage;
  const diagnostics: Diag[] = [];
  let fetches = 0;
  const fetchMs = o.fetchTimeoutMs ?? MATCHUP_TIMEOUTS.fetchMs;
  const deadline = Date.now() + (o.budgetMs ?? MATCHUP_TIMEOUTS.budgetMs);
  /** One page read: aborted, and no longer awaited, after min(fetchMs, what is left of the budget). */
  const timed = async (url: string) => {
    const left = Math.max(0, Math.min(fetchMs, deadline - Date.now()));
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error(`timed out after ${Math.round(left / 100) / 10} s`));
      }, left);
    });
    try {
      return await Promise.race([get(url, ac.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  const read = async (url: string, what: string): Promise<string | undefined> => {
    if (fetches >= MAX_MATCHUP_FETCHES) {
      diagnostics.push({ step: "matchups", url, note: `skipped ${what}: ${MAX_MATCHUP_FETCHES}-page limit reached` });
      return undefined;
    }
    if (Date.now() >= deadline) {
      diagnostics.push({ step: "matchups", url, note: `skipped ${what}: matchups time budget spent` });
      return undefined;
    }
    fetches++;
    try {
      const p = await timed(url);
      if (!p.ok) {
        diagnostics.push({ step: "matchups", url, status: p.status, note: `${what} not ok` });
        return undefined;
      }
      return p.html;
    } catch (e) {
      diagnostics.push({ step: "matchups", url, note: `${what} fetch failed: ${(e as Error | null)?.message ?? String(e)}` });
      return undefined;
    }
  };
  const weeks: MatchupWeekWire[] = [];
  const readPage = async (wk: MatchupWeekWire) => {
    const mine = o.myTeamId ? wk.pairings.find((p) => p.mid1 === o.myTeamId || p.mid2 === o.myTeamId) : undefined;
    if (!mine) {
      diagnostics.push({ step: "matchups", week: wk.week, note: o.myTeamId ? `team ${o.myTeamId} not in week ${wk.week}'s pairings` : "my team unknown: no matchup page read" });
      return;
    }
    const url = `${o.base}/matchup?week=${wk.week}&mid1=${mine.mid1}&mid2=${mine.mid2}`;
    o.log?.(`reading matchup week ${wk.week}…`);
    const html = await read(url, `matchup page week ${wk.week}`);
    if (html === undefined) return;
    const r = parseMatchupPage(html, mine);
    diagnostics.push({ step: "matchups", url, kind: "page", week: wk.week, ...r.diag });
    if (r.sides) wk.pages.push({ mid1: mine.mid1, mid2: mine.mid2, sides: r.sides });
  };
  const moduleWeek = (html: string, want: number | undefined, url: string): MatchupWeekWire | undefined => {
    const m = parseMatchupModule(moduleHtml(html), o.leagueId);
    const week = m.headerWeek ?? m.week;
    diagnostics.push({ step: "matchups", url, kind: "module", week, selected: m.week, state: m.status, statusText: m.statusText, pairings: m.pairings.length, ...m.diag });
    if (!week || !m.pairings.length) return undefined;
    if (want !== undefined && week !== want) {
      diagnostics.push({ step: "matchups", url, note: `module showed week ${week}, expected ${want}: not used` });
      return undefined;
    }
    return { week, status: m.status, ...(m.statusText ? { statusText: m.statusText.slice(0, 40) } : {}), pairings: m.pairings, pages: [] };
  };

  // 1. League home page: Yahoo's current matchup week (the picker's selected week) and that week's pairings.
  o.log?.("reading matchups…");
  const home = await read(o.base, "league home page");
  if (home === undefined) return { diagnostics, fetches };
  const hm = parseMatchupModule(home, o.leagueId);
  const W = hm.week;
  if (!W) {
    diagnostics.push({ step: "matchups", url: o.base, note: "no selected week in the Matchups module (#matchupweek)", ...hm.diag });
    return { diagnostics, fetches };
  }
  let current = hm.headerWeek === W ? moduleWeek(home, W, o.base) : undefined;
  if (!current) current = await read(`${o.base}?matchup_week=${W}&module=matchups`, `module week ${W}`).then((h) => (h === undefined ? undefined : moduleWeek(h, W, `${o.base}?matchup_week=${W}&module=matchups`)));
  // 2. The owner's matchup page this week (live points as of the import).
  if (current) {
    weeks.push(current);
    await readPage(current);
  }
  // 3. Week W−1: module (final results) and the owner's matchup page (final lineup, points, Yahoo's pre-game projection).
  if (W > 1) {
    const url = `${o.base}?matchup_week=${W - 1}&module=matchups`;
    const h = await read(url, `module week ${W - 1}`);
    const prev = h === undefined ? undefined : moduleWeek(h, W - 1, url);
    if (prev) {
      weeks.push(prev);
      await readPage(prev);
    }
  }
  diagnostics.push({ step: "matchups", note: "summary", matchupWeek: W, weeks: weeks.map((w) => `${w.week}:${w.status}:${w.pairings.length}p/${w.pages.length}pg`), fetches });
  return { matchupWeek: W, ...(weeks.length ? { matchups: { weeks } } : {}), diagnostics, fetches };
}

/**
 * The payload of collect() plus the matchups: called right after collect() by the bookmarklet and the auto-import
 * entry. Never throws; an error becomes a "matchups" diagnostics entry and the payload is returned as collect() made it.
 */
export async function withMatchups(payload: Payload, log: (s: string) => void = () => undefined, deps: { origin?: string; getPage?: GetPage; fetchTimeoutMs?: number; budgetMs?: number } = {}): Promise<PayloadWithMatchups> {
  const out: PayloadWithMatchups = payload;
  try {
    const origin = deps.origin ?? location.origin;
    const r = await collectMatchups({ base: `${origin}/f1/${payload.leagueId}`, leagueId: payload.leagueId, myTeamId: payload.myTeamId, getPage: deps.getPage, log, fetchTimeoutMs: deps.fetchTimeoutMs, budgetMs: deps.budgetMs });
    payload.diagnostics.push(...r.diagnostics);
    if (r.matchupWeek !== undefined) out.matchupWeek = r.matchupWeek;
    if (r.matchups) out.matchups = r.matchups;
  } catch (e) {
    payload.diagnostics.push({ step: "matchups", note: `matchups not read: ${(e as Error)?.message ?? String(e)}`.slice(0, 300) });
  }
  return out;
}
