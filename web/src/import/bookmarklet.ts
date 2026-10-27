// "Import from Yahoo" bookmarklet. Compiled by the server (esbuild, IIFE, minified)
// into a javascript: URL — see server/providers/import-bookmarklet.ts and
// GET /api/import/bookmarklet.js. It runs on football.fantasysports.yahoo.com
// pages while the user is logged in, reads the league's own pages with
// same-origin fetches, and shows the result for the user to copy/download.
// It never sends data anywhere else.
import { NAV_TEXT, navLink, parseMyTeamId, parsePlayersHtml, parseProjectionHtml, parseSettingsHtml, parseStandingsHtml, playerKey, waiverGroupOf, waiverStatusOf, type ScrapedPlayer, type StandingsRecord, type WaiverGroup, type WaiverGroupList, type WaiverList } from "./yahooHtml";

const DEFAULT_SLOTS = ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR"];
const HALF_PPR = { passYd: 0.04, passTd: 4, passInt: -1, rushYd: 0.1, rushTd: 6, rec: 0.5, recYd: 0.1, recTd: 6, twoPt: 2, fumLost: -2, teRec: 0 };
const MAX_TEAMS = 20;
const MAX_FA = 150;
/** Kickers and defenses: streamed, so a short list each is enough. */
const MAX_KDEF = 25;
/** Pages of players?status=W read per position group to tell waivers from free agents. */
const MAX_W_PAGES = 6;
const OVERLAY_ID = "ftd-import-overlay";

interface Diag {
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

const BTN = "font:inherit;font-weight:600;margin:8px 8px 0 0;padding:6px 12px;border-radius:6px;border:1px solid #3b82f6;cursor:pointer;";

async function run(): Promise<void> {
  const box = overlay();
  const status = el("div", "Trade Desk import: starting…");
  box.appendChild(status);
  const say = (s: string) => (status.textContent = `Trade Desk import: ${s}`);

  const m = /\/f1\/(\d+)/.exec(location.pathname);
  if (!/fantasysports\.yahoo\.com$/.test(location.hostname) || !m) {
    say("open any page of your league on football.fantasysports.yahoo.com (the URL contains /f1/<league number>/) and click the bookmark again.");
    return;
  }
  const leagueId = m[1];
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
    say(`reading team page ${n}…`);
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
      const v = p.yahooId ? wk.values.get(p.yahooId) : undefined;
      if (v !== undefined) p.yahooProjWeekly = v;
    }
    if (n === 1 || !wk.diag.read) diagnostics.push({ step: "projections", url, ...wk.diag });
    say(`reading Yahoo projections (team ${n})…`);
    await readRos(url, page.html, r.players);
    teams.push({ id: String(n), name: r.teamName ?? `Team ${n}`, players: r.players });
  }

  const rostered = teams.reduce((a, t) => a + t.players.length, 0);
  const projRos = teams.reduce((a, t) => a + t.players.filter((p) => p.yahooProj !== undefined).length, 0);
  const projWeek = teams.reduce((a, t) => a + t.players.filter((p) => p.yahooProjWeekly !== undefined).length, 0);
  diagnostics.push({ step: "projections", note: projRos ? `rest of season via team pages (${NAV_TEXT.projected} → ${NAV_TEXT.remaining})` : "no projected rest-of-season view found: yahooProj not captured", rostered, ros: projRos, week: projWeek });

  say("reading league settings…");
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
  let standingsTeams = 0;
  let waiverRanks = 0;
  for (const url of [`${base}/standings`, base]) {
    say("reading standings…");
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
  standingsTeams = teams.filter((t) => t.record).length;
  waiverRanks = teams.filter((t) => t.waiverRank).length;

  // Free agents: players?status=A lists everyone available (free agents AND players on waivers). The "Owner" column
  // says which ("FA" / "W (Wed)"); a separate status=W list is read too, as a fallback and a cross-check.
  const freeAgents: ScrapedPlayer[] = [];
  /** What goes into the payload: one entry per free agent, `onWaivers` only when known. */
  const faOut: (Pick<ScrapedPlayer, "yahooId" | "name" | "pos" | "team" | "status"> & { onWaivers?: boolean })[] = [];
  const seen = new Set<string>();
  /**
   * Read up to `max` players of one list into `into` (de-duplicated by `seenSet`). `failed` = a page did not load
   * (HTTP error or network error): the list is then partial and must not be trusted as complete.
   */
  const readList = async (status: "A" | "W", pos: string, sort: string, max: number, into: ScrapedPlayer[], seenSet: Set<string>, step: string) => {
    let total = 0;
    let full = false;
    let failed = false;
    for (let start = 0; start < 2 * max + 25; start += 25) {
      const url = `${base}/players?status=${status}&pos=${pos}&sort=${sort}&count=${start}`;
      let added = 0;
      try {
        const page = await getPage(url);
        if (!page.ok) failed = true;
        const r = page.ok ? parsePlayersHtml(page.html) : undefined;
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
    return { total, full: full || total >= max, failed };
  };

  let sortUsed = "AR";
  for (const sort of ["AR", "PTS"]) {
    say(`reading free agents…`);
    await readList("A", "O", sort, MAX_FA, freeAgents, seen, "freeAgents");
    if (freeAgents.length) {
      sortUsed = sort;
      break;
    }
  }
  if (freeAgents.length) {
    for (const pos of ["K", "DEF"]) {
      say(`reading free agents (${pos})…`);
      await readList("A", pos, sortUsed, MAX_KDEF, freeAgents, seen, `freeAgents ${pos}`);
    }
    // Waivers lists, one per position group (fallback + cross-check for the owner column). Each group is judged on
    // its own: a failed or truncated page makes that group's list partial (non-members unknown, never free agents).
    const groups: Partial<Record<WaiverGroup, WaiverGroupList>> = {};
    const groupDiag: Record<string, unknown> = {};
    for (const [pos, max] of [["O", MAX_W_PAGES * 25], ["K", 25], ["DEF", 25]] as const) {
      say(`reading players on waivers (${pos})…`);
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
      faOut.push({ yahooId: p.yahooId, name: p.name, pos: p.pos, team: p.team, status: p.status, ...(onWaivers !== undefined ? { onWaivers } : {}) });
    }
  }

  const payload = {
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
  const json = JSON.stringify(payload);

  // ---- summary
  box.textContent = "";
  box.appendChild(el("div", "Trade Desk import v5", "font-weight:700;font-size:15px;margin-bottom:6px"));
  const summary = el("div");
  const noPos = diagnostics.reduce((a, d) => a + (Array.isArray(d.noPos) ? d.noPos.length : 0), 0);
  summary.textContent =
    `${teams.length} team${teams.length === 1 ? "" : "s"} found · ${teams.reduce((a, t) => a + t.players.length, 0)} rostered players · ` +
    `standings: ${standingsTeams ? `${standingsTeams} of ${teams.length} teams` : "NOT found"} · waiver order: ${waiverRanks ? `${waiverRanks} of ${teams.length} teams` : "NOT found"} · ` +
    `Yahoo projections: ${projRos ? `${projRos} of ${rostered} players rest of season` : "rest of season NOT found"}, ${projWeek} this week · ` +
    `${faOut.length} available players (${faOut.filter((f) => f.onWaivers === true).length} on waivers, ${faOut.filter((f) => f.onWaivers === undefined).length} unknown) · settings: ${settingsSource === "page" ? "read from Yahoo" : settingsSource === "partial" ? "partly read (check them after import)" : "NOT found, Yahoo defaults used (check them after import)"}` +
    (noPos ? ` · ${noPos} player link(s) without a position were skipped` : "");
  box.appendChild(summary);
  const list = el("ol", undefined, "margin:8px 0;padding-left:20px;max-height:180px;overflow:auto");
  for (const t of teams) list.appendChild(el("li", `${t.name}: ${t.players.length} players${t.id === myTeamId ? " (you)" : ""}`));
  box.appendChild(list);
  if (!teams.length)
    box.appendChild(el("div", "No teams found. Please copy the diagnostics (button below) and send them to whoever maintains your Trade Desk.", "color:#ffb3b3"));

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
}

run().catch((e: Error) => {
  const box = document.getElementById(OVERLAY_ID) ?? overlay();
  box.textContent = `Trade Desk import failed: ${e.message}`;
});
