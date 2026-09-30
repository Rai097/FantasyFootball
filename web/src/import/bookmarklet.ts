// "Import from Yahoo" bookmarklet. Compiled by the server (esbuild, IIFE, minified)
// into a javascript: URL — see server/providers/import-bookmarklet.ts and
// GET /api/import/bookmarklet.js. It runs on football.fantasysports.yahoo.com
// pages while the user is logged in, reads the league's own pages with
// same-origin fetches, and shows the result for the user to copy/download.
// It never sends data anywhere else.
import { parseMyTeamId, parsePlayersHtml, parseSettingsHtml, type ScrapedPlayer } from "./yahooHtml";

const DEFAULT_SLOTS = ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR"];
const HALF_PPR = { passYd: 0.04, passTd: 4, passInt: -1, rushYd: 0.1, rushTd: 6, rec: 0.5, recYd: 0.1, recTd: 6, twoPt: 2, fumLost: -2, teRec: 0 };
const MAX_TEAMS = 20;
const MAX_FA = 150;
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
  const teams: { id: string; name: string; players: ScrapedPlayer[] }[] = [];
  let myTeamId: string | undefined = parseMyTeamId(document.documentElement.outerHTML, leagueId);

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
    teams.push({ id: String(n), name: r.teamName ?? `Team ${n}`, players: r.players });
  }

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

  const freeAgents: ScrapedPlayer[] = [];
  const seen = new Set<string>();
  for (const sort of ["AR", "PTS"]) {
    // Yahoo's web player list shows 25 rows per page; `count` is the row offset.
    for (let start = 0; start < 2 * MAX_FA && freeAgents.length < MAX_FA; start += 25) {
      say(`reading free agents (${freeAgents.length})…`);
      const url = `${base}/players?status=A&pos=O&sort=${sort}&count=${start}`;
      let added = 0;
      try {
        const page = await getPage(url);
        const r = page.ok ? parsePlayersHtml(page.html) : undefined;
        for (const p of r?.players ?? []) {
          const k = p.yahooId ?? `${p.name}|${p.pos}`;
          if (seen.has(k) || freeAgents.length >= MAX_FA) continue;
          seen.add(k);
          freeAgents.push({ yahooId: p.yahooId, name: p.name, pos: p.pos, team: p.team, status: p.status });
          added++;
        }
        diagnostics.push({ step: "freeAgents", url, status: page.status, players: r?.players.length ?? 0, added, ...(r?.diag ?? {}) });
      } catch (e) {
        diagnostics.push({ step: "freeAgents", url, note: `fetch failed: ${(e as Error).message}` });
      }
      if (!added) break;
    }
    if (freeAgents.length) break;
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
    ...(freeAgents.length ? { freeAgents } : {}),
    importedAt: new Date().toISOString(),
    diagnostics,
  };
  const json = JSON.stringify(payload);

  // ---- summary
  box.textContent = "";
  box.appendChild(el("div", "Trade Desk import", "font-weight:700;font-size:15px;margin-bottom:6px"));
  const summary = el("div");
  const noPos = diagnostics.reduce((a, d) => a + (Array.isArray(d.noPos) ? d.noPos.length : 0), 0);
  summary.textContent =
    `${teams.length} team${teams.length === 1 ? "" : "s"} found · ${teams.reduce((a, t) => a + t.players.length, 0)} rostered players · ` +
    `${freeAgents.length} free agents · settings: ${settingsSource === "page" ? "read from Yahoo" : settingsSource === "partial" ? "partly read (check them after import)" : "NOT found, Yahoo defaults used (check them after import)"}` +
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
