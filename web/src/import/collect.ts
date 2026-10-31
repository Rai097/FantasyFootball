// Yahoo league collector shared by the "Import from Yahoo" bookmarklet (bookmarklet.ts: overlay + one-click handoff)
// and the server's scheduled auto-import (server/autoimport, headless Chrome via page.evaluate of the bundle built from
// collectEntry.ts). It runs on a football.fantasysports.yahoo.com league page while the user is signed in, reads the
// league's own pages with same-origin fetches and returns the import payload. No UI, no handoff, never sends data
// anywhere. Progress goes to `log` (the bookmarklet's status line).
import { LIST_VIEW, NAV_TEXT, findStatsView, navLink, parseListProjectionHtml, parseMyTeamId, parsePlayersHtml, parseProjectionHtml, parseSettingsHtml, parseStandingsHtml, playerKey, waiverGroupOf, waiverStatusOf, type ScrapedPlayer, type StandingsRecord, type WaiverGroup, type WaiverGroupList, type WaiverList } from "./yahooHtml";

const DEFAULT_SLOTS = ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR"];
const HALF_PPR = { passYd: 0.04, passTd: 4, passInt: -1, rushYd: 0.1, rushTd: 6, rec: 0.5, recYd: 0.1, recTd: 6, twoPt: 2, fumLost: -2, teRec: 0 };
const MAX_TEAMS = 20;
const MAX_FA = 150;
/** Kickers and defenses: streamed, so a short list each is enough. */
const MAX_KDEF = 25;
/** Pages of players?status=W read per position group to tell waivers from free agents. */
const MAX_W_PAGES = 6;

export interface Diag {
  step: string;
  url?: string;
  status?: number;
  note?: string;
  [k: string]: unknown;
}

async function getPage(url: string): Promise<{ ok: boolean; status: number; html: string; finalUrl: string; redirected: boolean }> {
  const res = await fetch(url, { credentials: "include", redirect: "follow" });
  const html = res.ok ? await res.text() : "";
  return { ok: res.ok, status: res.status, html, finalUrl: res.url, redirected: res.redirected };
}

/** One team as the collector read it. */
export interface CollectedTeam {
  id: string;
  name: string;
  players: ScrapedPlayer[];
  record?: StandingsRecord;
  waiverRank?: number;
}

/** An available player in the payload: `onWaivers` only when known. */
export type CollectedFreeAgent = Pick<ScrapedPlayer, "yahooId" | "name" | "pos" | "team" | "status" | "yahooProj" | "yahooProjWeekly"> & { onWaivers?: boolean };

/** What the collector returns: the JSON the bookmarklet copies and POST /api/import accepts. */
export interface Payload {
  source: "yahoo-bookmarklet";
  id: string;
  leagueId: string;
  name: string;
  numTeams: number;
  slots: string[];
  scoring: Record<string, number>;
  regularSeasonEnd: number;
  finalWeek: number;
  myTeamId?: string;
  settingsSource: "page" | "partial" | "default";
  teams: CollectedTeam[];
  freeAgents?: CollectedFreeAgent[];
  importedAt: string;
  diagnostics: Diag[];
}

/** The league id of a Yahoo league page URL, or undefined when `loc` is not one. */
export function leagueIdOf(loc: { hostname: string; pathname: string }): string | undefined {
  const m = /\/f1\/(\d+)/.exec(loc.pathname);
  return /fantasysports\.yahoo\.com$/.test(loc.hostname) && m ? m[1] : undefined;
}

/** Reads the whole league from the current Yahoo league page. Throws when the page is not a league page. */
export async function collect(log: (s: string) => void = () => undefined): Promise<Payload> {
  const leagueId = leagueIdOf(location);
  if (!leagueId) throw new Error("not a Yahoo Fantasy league page (the URL must contain /f1/<league number>/)");
  const base = `${location.origin}/f1/${leagueId}`;
  const diagnostics: Diag[] = [];
  const teams: { id: string; name: string; players: ScrapedPlayer[]; record?: StandingsRecord; waiverRank?: number }[] = [];
  let myTeamId: string | undefined = parseMyTeamId(document.documentElement.outerHTML, leagueId);

  /**
   * Rest-of-season projections (what other managers see in Yahoo's trade evaluator) for one team: the team page's
   * "Projected Stats" link, then that page's "Remaining Games" link — both found by anchor text, never by guessed
   * query params; at most 2 fetches per team. A value counts only when that view shows as selected and a "Fan Pts"
   * column is found (parseProjectionHtml). Any missing step is a diagnostics note naming it; yahooProj stays absent.
   * Assumption: Yahoo's "Remaining Games" runs from the first week with an unplayed game (the server's projWeek stamp)
   * through week 17 (the fantasy season's end); the valuation spreads it over that span.
   */
  const readRos = async (teamUrl: string, teamHtml: string, players: ScrapedPlayer[]) => {
    const fail = (url: string | undefined, note: string, extra: Record<string, unknown> = {}) =>
      diagnostics.push({ step: "projections", kind: "ros", url: url ?? teamUrl, note, ...extra });
    const projUrl = navLink(teamHtml, NAV_TEXT.projected, teamUrl);
    if (!projUrl) return fail(teamUrl, `no "${NAV_TEXT.projected}" link on the team page`);
    let rosUrl: string | undefined;
    try {
      const proj = await getPage(projUrl);
      if (!proj.ok) return fail(projUrl, `"${NAV_TEXT.projected}" page not ok`, { status: proj.status });
      rosUrl = navLink(proj.html, NAV_TEXT.remaining, proj.finalUrl || projUrl);
      if (!rosUrl) return fail(projUrl, `no "${NAV_TEXT.remaining}" link on the ${NAV_TEXT.projected} page`);
      const ros = await getPage(rosUrl);
      if (!ros.ok) return fail(rosUrl, `"${NAV_TEXT.remaining}" page not ok`, { status: ros.status });
      const r = parseProjectionHtml(ros.html, "ros");
      let set = 0;
      for (const p of players) {
        const v = p.yahooId ? r.values.get(p.yahooId) : p.pos === "DEF" && p.team ? r.defValues.get(p.team) : undefined;
        if (v !== undefined) (p.yahooProj = v), set++;
      }
      diagnostics.push({ step: "projections", url: rosUrl, status: ros.status, ...r.diag, set });
    } catch (e) {
      fail(rosUrl ?? projUrl, `fetch failed: ${(e as Error).message}`);
    }
  };

  for (let n = 1; n <= MAX_TEAMS; n++) {
    log(`reading team page ${n}…`);
    const url = `${base}/${n}`;
    let page;
    try {
      page = await getPage(url);
    } catch (e) {
      diagnostics.push({ step: "team", url, note: `fetch failed: ${(e as Error).message}` });
      break;
    }
    const landedElsewhere = page.redirected && !new RegExp(`/f1/${leagueId}/${n}(?:[/?#]|$)`).test(page.finalUrl);
    if (!page.ok || landedElsewhere) {
      diagnostics.push({ step: "team", url, status: page.status, note: landedElsewhere ? `redirected to ${page.finalUrl}` : "not ok" });
      break;
    }
    const r = parsePlayersHtml(page.html);
    myTeamId ??= parseMyTeamId(page.html, leagueId);
    diagnostics.push({ step: "team", url, status: page.status, players: r.players.length, noPos: r.noPos.slice(0, 5), ...r.diag });
    if (!r.players.length) break;
    // This week's Yahoo projection: the roster page's "Proj" column (header-matched, never guessed).
    const wk = parseProjectionHtml(page.html, "week");
    for (const p of r.players) {
      const v = p.yahooId ? wk.values.get(p.yahooId) : p.pos === "DEF" && p.team ? wk.defValues.get(p.team) : undefined;
      if (v !== undefined) p.yahooProjWeekly = v;
    }
    if (n === 1 || !wk.diag.read) diagnostics.push({ step: "projections", url, ...wk.diag });
    log(`reading Yahoo projections (team ${n})…`);
    await readRos(url, page.html, r.players);
    teams.push({ id: String(n), name: r.teamName ?? `Team ${n}`, players: r.players });
  }

  const rostered = teams.reduce((a, t) => a + t.players.length, 0);
  const projRos = teams.reduce((a, t) => a + t.players.filter((p) => p.yahooProj !== undefined).length, 0);
  const projWeek = teams.reduce((a, t) => a + t.players.filter((p) => p.yahooProjWeekly !== undefined).length, 0);
  diagnostics.push({ step: "projections", note: projRos ? `rest of season via team pages (${NAV_TEXT.projected} → ${NAV_TEXT.remaining})` : "no projected rest-of-season view found: yahooProj not captured", rostered, ros: projRos, week: projWeek });

  log("reading league settings…");
  let settingsSource: "page" | "partial" | "default" = "default";
  let settings: ReturnType<typeof parseSettingsHtml> | undefined;
  try {
    const page = await getPage(`${base}/settings`);
    if (page.ok) settings = parseSettingsHtml(page.html);
    diagnostics.push({ step: "settings", url: `${base}/settings`, status: page.status, ...(settings?.diag ?? {}) });
  } catch (e) {
    diagnostics.push({ step: "settings", note: `fetch failed: ${(e as Error).message}` });
  }
  const sc = settings?.scoring ?? {};
  const haveScoring = sc.rec !== undefined && sc.passTd !== undefined;
  if (settings?.slots && haveScoring) settingsSource = "page";
  else if (settings?.slots || haveScoring || settings?.numTeams) settingsSource = "partial";

  // Standings (record, points, rank, streak) and the waiver order: the standings page, else the league home page,
  // which also shows a standings table. Matched to the team pages by team number; nothing is guessed.
  for (const url of [`${base}/standings`, base]) {
    log("reading standings…");
    try {
      const page = await getPage(url);
      const landedElsewhere = page.redirected && !page.finalUrl.startsWith(url);
      if (!page.ok || landedElsewhere) {
        diagnostics.push({ step: "standings", url, status: page.status, note: landedElsewhere ? `redirected to ${page.finalUrl}` : "not ok" });
        continue;
      }
      const r = parseStandingsHtml(page.html, leagueId);
      let matched = 0;
      for (const row of r.rows) {
        const t = teams.find((x) => x.id === row.teamId);
        if (!t) continue;
        matched++;
        if (row.record) t.record = row.record;
        if (row.waiverRank) t.waiverRank = row.waiverRank;
      }
      diagnostics.push({ step: "standings", url, status: page.status, matched, ...r.diag });
      if (teams.some((t) => t.record)) break;
    } catch (e) {
      diagnostics.push({ step: "standings", url, note: `fetch failed: ${(e as Error).message}` });
    }
  }

  // Free agents: players?status=A lists everyone available (free agents AND players on waivers). The "Owner" column
  // says which ("FA" / "W (Wed)"); a separate status=W list is read too, as a fallback and a cross-check.
  const freeAgents: ScrapedPlayer[] = [];
  /** What goes into the payload: one entry per free agent, `onWaivers` only when known. */
  const faOut: (Pick<ScrapedPlayer, "yahooId" | "name" | "pos" | "team" | "status" | "yahooProj" | "yahooProjWeekly"> & { onWaivers?: boolean })[] = [];
  const seen = new Set<string>();
  /**
   * Read up to `max` players of one list into `into` (de-duplicated by `seenSet`). `failed` = a page did not load
   * (HTTP error or network error): the list is then partial and must not be trusted as complete.
   */
  const readList = async (status: "A" | "W", pos: string, sort: string, max: number, into: ScrapedPlayer[], seenSet: Set<string>, step: string) => {
    let total = 0;
    let full = false;
    let failed = false;
    /** Pages that listed players (the projected-view pass reads at most this many), and the first page's markup. */
    let pages = 0;
    let first: { url: string; html: string } | undefined;
    for (let start = 0; start < 2 * max + 25; start += 25) {
      const url = `${base}/players?status=${status}&pos=${pos}&sort=${sort}&count=${start}`;
      let added = 0;
      try {
        const page = await getPage(url);
        if (!page.ok) failed = true;
        const r = page.ok ? parsePlayersHtml(page.html) : undefined;
        if (page.ok) first ??= { url: page.finalUrl || url, html: page.html };
        if (r?.players.length) pages++;
        for (const p of r?.players ?? []) {
          const k = playerKey(p);
          if (seenSet.has(k)) continue;
          if (total >= max) {
            full = true;
            break;
          }
          seenSet.add(k);
          into.push(p);
          added++;
          total++;
        }
        diagnostics.push({ step, url, status: page.status, players: r?.players.length ?? 0, added, ...(r?.diag ?? {}), ...(page.ok ? {} : { note: "not ok: list partial" }) });
      } catch (e) {
        failed = true;
        diagnostics.push({ step, url, note: `fetch failed: ${(e as Error).message}` });
      }
      if (!added || full || total >= max) break;
    }
    return { total, full: full || total >= max, failed, pages, first };
  };

  /**
   * Yahoo's projected points for the available players of one list (offense / K / DEF): the players page's Stats
   * control "Week N (proj)" (and a rest-of-season projected view when the control has one), found by its visible text
   * in that list's first page (findStatsView: link, option URL or GET form — never a guessed param), then the same
   * pages again in that view (`count` as the list itself used), at most as many pages as the list read. A value counts
   * only when the fetched page shows that view as selected and has a "Fan Pts" column (parseListProjectionHtml). Each
   * failed step is a "faProjections" diagnostics entry naming it; the projection then stays absent, never 0.
   */
  const readListProj = async (pos: string, list: Awaited<ReturnType<typeof readList>>, players: ScrapedPlayer[]) => {
    if (!list.first || !players.length) return;
    for (const kind of ["week", "ros"] as const) {
      const found = findStatsView(list.first.html, LIST_VIEW[kind], list.first.url);
      const base = { step: "faProjections", kind, pos, candidates: found.candidates.slice(0, 8) };
      if (!found.view) {
        diagnostics.push({ ...base, url: list.first.url, note: found.note });
        continue;
      }
      const { view } = found;
      for (let i = 0; i < list.pages; i++) {
        const u = new URL(view.url);
        u.searchParams.set("count", String(i * 25));
        const url = u.href;
        try {
          const page = await getPage(url);
          if (!page.ok) {
            diagnostics.push({ ...base, url, status: page.status, view: view.text, how: view.how, note: "projected view page not ok" });
            break;
          }
          const r = parseListProjectionHtml(page.html, kind, view.text);
          let added = 0;
          for (const p of players) {
            const v = p.yahooId ? r.values.get(p.yahooId) : p.pos === "DEF" && p.team ? r.defValues.get(p.team) : undefined;
            if (v === undefined) continue;
            if (kind === "week" ? p.yahooProjWeekly === undefined : p.yahooProj === undefined) added++;
            if (kind === "week") p.yahooProjWeekly ??= v;
            else p.yahooProj ??= v;
          }
          diagnostics.push({ ...base, url, status: page.status, view: view.text, how: view.how, ...(view.field ? { field: view.field, value: view.value } : {}), ...r.diag, set: added });
          if (!r.diag.read) break;
        } catch (e) {
          diagnostics.push({ ...base, url, view: view.text, note: `fetch failed: ${(e as Error).message}` });
          break;
        }
      }
      if (kind === "week") faWeekView ??= view.text;
    }
  };
  let faWeekView: string | undefined;

  let sortUsed = "AR";
  const aLists: { pos: string; list: Awaited<ReturnType<typeof readList>>; players: ScrapedPlayer[] }[] = [];
  for (const sort of ["AR", "PTS"]) {
    log(`reading free agents…`);
    const from = freeAgents.length;
    const list = await readList("A", "O", sort, MAX_FA, freeAgents, seen, "freeAgents");
    if (freeAgents.length) {
      sortUsed = sort;
      aLists.push({ pos: "O", list, players: freeAgents.slice(from) });
      break;
    }
  }
  if (freeAgents.length) {
    for (const pos of ["K", "DEF"]) {
      log(`reading free agents (${pos})…`);
      const from = freeAgents.length;
      const list = await readList("A", pos, sortUsed, MAX_KDEF, freeAgents, seen, `freeAgents ${pos}`);
      aLists.push({ pos, list, players: freeAgents.slice(from) });
    }
    // Yahoo projections for available players: K and DEF first (weekly streaming), then offense.
    for (const pos of ["K", "DEF", "O"]) {
      const a = aLists.find((x) => x.pos === pos);
      if (!a) continue;
      log(`reading Yahoo projections for available players (${pos === "O" ? "offense" : pos})…`);
      await readListProj(pos, a.list, a.players);
    }
    // Waivers lists, one per position group (fallback + cross-check for the owner column). Each group is judged on
    // its own: a failed or truncated page makes that group's list partial (non-members unknown, never free agents).
    const groups: Partial<Record<WaiverGroup, WaiverGroupList>> = {};
    const groupDiag: Record<string, unknown> = {};
    for (const [pos, max] of [["O", MAX_W_PAGES * 25], ["K", 25], ["DEF", 25]] as const) {
      log(`reading players on waivers (${pos})…`);
      const wPlayers: ScrapedPlayer[] = [];
      const wSeen = new Set<string>();
      const r = await readList("W", pos, sortUsed, max, wPlayers, wSeen, `waivers ${pos}`);
      // Yahoo ignored the filter when the W list holds a row whose owner cell says FA, or when it holds every
      // available player read for the group (compared as sets, not page order).
      const aKeys = freeAgents.filter((p) => waiverGroupOf(p.pos) === pos).map(playerKey);
      const ignored = wPlayers.some((p) => p.availability === "FA") || (aKeys.length >= 5 && aKeys.every((k) => wSeen.has(k)));
      groups[pos] = { keys: wSeen, complete: !r.full && !r.failed, ignored };
      groupDiag[pos] = { size: wSeen.size, complete: !r.full && !r.failed, failed: r.failed, ignored };
    }
    const all = new Set(Object.values(groups).flatMap((g) => [...g.keys]));
    const wList: WaiverList = { keys: all, complete: Object.values(groups).every((g) => g.complete), ignored: Object.values(groups).every((g) => g.ignored), groups };
    const ws = waiverStatusOf(freeAgents, wList);
    diagnostics.push({ step: "waiverStatus", ...ws.diag, listSize: all.size, lists: groupDiag });
    for (const p of freeAgents) {
      const onWaivers = ws.onWaivers.get(playerKey(p));
      faOut.push({
        yahooId: p.yahooId,
        name: p.name,
        pos: p.pos,
        team: p.team,
        status: p.status,
        ...(onWaivers !== undefined ? { onWaivers } : {}),
        ...(p.yahooProjWeekly !== undefined ? { yahooProjWeekly: p.yahooProjWeekly } : {}),
        ...(p.yahooProj !== undefined ? { yahooProj: p.yahooProj } : {}),
      });
    }
  }
  const faWeek = faOut.filter((f) => f.yahooProjWeekly !== undefined).length;
  const faRos = faOut.filter((f) => f.yahooProj !== undefined).length;
  diagnostics.push({
    step: "faProjections",
    note: faWeek ? `this week via the players page Stats view "${faWeekView}"` : "no projected week view read: available players' yahooProjWeekly not captured",
    available: faOut.length,
    week: faWeek,
    ros: faRos,
    ...(faWeekView ? { view: faWeekView } : {}),
  });

  const payload: Payload = {
    source: "yahoo-bookmarklet",
    id: `y${leagueId}`,
    leagueId,
    name: settings?.name ?? `Yahoo league ${leagueId}`,
    numTeams: settings?.numTeams && settings.numTeams >= teams.length ? settings.numTeams : teams.length,
    slots: settings?.slots ?? DEFAULT_SLOTS,
    scoring: { ...HALF_PPR, ...sc },
    regularSeasonEnd: settings?.regularSeasonEnd ?? 14,
    finalWeek: settings?.finalWeek ?? 17,
    ...(myTeamId && teams.some((t) => t.id === myTeamId) ? { myTeamId } : {}),
    settingsSource,
    teams,
    ...(faOut.length ? { freeAgents: faOut } : {}),
    importedAt: new Date().toISOString(),
    diagnostics,
  };
  return payload;
}
