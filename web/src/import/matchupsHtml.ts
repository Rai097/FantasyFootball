// Pure string parsing of Yahoo's matchup pages (docs/DESIGN.md "Matchups and results log (2026-10-31)"): the league
// home page's Matchups module (week selector, pairings, per side points and Yahoo's projected total) and one matchup
// page (both teams' starters and bench by slot: Yahoo's projection and fantasy points per player, the Total rows).
// Markup verified on the owner's league 2026-10-31 (anonymized fixtures: server/providers/fixtures/matchups/). No DOM,
// like yahooHtml.ts: bundled into the bookmarklet / auto-import collector and unit-tested in node.
// Missing numbers ("–" = not played yet, an empty cell) are null, never 0; Yahoo's own "0.00" stays 0.
import { decodeEntities, htmlToText, parsePosTeam, stripMarkupAttrs } from "./yahooHtml";

export type MatchupStatus = "final" | "live" | "pre" | "unknown";

export interface ModuleSide {
  teamId: string;
  name?: string;
  /** "6-1-0" as Yahoo shows it next to the team. */
  record?: string;
  /** Yahoo's score for the week (live or final); null = not shown. */
  points: number | null;
  /** Yahoo's projected total for the week; null = not shown. */
  yahooProj: number | null;
}
export interface ModulePairing {
  /** The matchup page's ids (mid1 = the left side of the matchup page). */
  mid1: string;
  mid2: string;
  sides: [ModuleSide, ModuleSide];
}
export interface ModuleParse {
  /** Week selected in the module's week picker (Yahoo's week for this module). */
  week?: number;
  /** Week named in the module's own header ("Week 8 Matchups"). */
  headerWeek?: number;
  status: MatchupStatus;
  statusText?: string;
  pairings: ModulePairing[];
  diag: { found: boolean; options: number; items: number; skipped: number; sample?: string };
}

export interface PageRow {
  /** Yahoo's slot label ("QB", "W/R/T", "BN", "IR", …). */
  slot: string;
  yahooId?: string;
  name?: string;
  pos?: string;
  /** NFL team as Yahoo shows it ("CIN"); normalised on the server. */
  team?: string;
  /** Injury chip (Q / D / O / IR …). */
  status?: string;
  /** Yahoo's projection for the player this week; null = not shown. */
  yahooProj: number | null;
  /** Yahoo's fantasy points; null = "–" (not played yet) or empty. */
  points: number | null;
}
export interface PageSide {
  teamId: string;
  /** Starters' Total row: Yahoo's projected total and points. */
  totalProj: number | null;
  totalPts: number | null;
  /** Starters then bench / IR, in page order; an "(Empty)" slot has no player. */
  rows: PageRow[];
}
export interface PageParse {
  sides: [PageSide, PageSide] | undefined;
  diag: { tables: number; rows: number; columns?: string; note?: string };
}

const NUM = /^-?\d+(?:\.\d+)?$/;
/** A cell's number: a strict full match after decoding ("–", "", "Bye" → null), never a digit picked out of text. */
export function cellNumber(cellHtml: string | undefined): number | null {
  if (cellHtml === undefined) return null;
  const t = htmlToText(cellHtml).replace(/\s+/g, "").replace(/,/g, "");
  return NUM.test(t) ? Number(t) : null;
}

const text1 = (h: string) => htmlToText(h).replace(/\s+/g, " ").trim();

/** `matchup?week=W&mid1=A&mid2=B` (plain or &amp;-encoded) → its numbers. */
export function matchupIds(url: string): { week: number; mid1: string; mid2: string } | undefined {
  const u = decodeEntities(url);
  const w = /[?&]week=(\d{1,2})(?:&|$)/.exec(u);
  const a = /[?&]mid1=(\d{1,2})(?:&|$)/.exec(u);
  const b = /[?&]mid2=(\d{1,2})(?:&|$)/.exec(u);
  return w && a && b ? { week: Number(w[1]), mid1: a[1], mid2: b[1] } : undefined;
}

function statusOf(text: string | undefined): MatchupStatus {
  if (!text) return "unknown";
  if (/final/i.test(text)) return "final";
  if (/in progress|live/i.test(text)) return "live";
  if (/preview|upcoming|not started|projected/i.test(text)) return "pre";
  return "unknown";
}

/**
 * The Matchups module (league home page `<base>` or `<base>?matchup_week=N&module=matchups`): read from the element
 * `id="matchupweek"` wherever it sits (full page or fragment). Pairings come from `li[data-target*="matchup?week="]`;
 * each side's team id from its team link, points = the large number, projection = the shaded number.
 */
export function parseMatchupModule(rawHtml: string, leagueId: string): ModuleParse {
  const html = stripMarkupAttrs(rawHtml);
  const at = html.search(/id\s*=\s*["']matchupweek["']/i);
  const out: ModuleParse = { status: "unknown", pairings: [], diag: { found: at >= 0, options: 0, items: 0, skipped: 0 } };
  if (at < 0) {
    out.diag.sample = text1(html.slice(0, 4000)).slice(0, 200);
    return out;
  }
  const mod = html.slice(at);
  // Week picker: the <option selected> whose value carries matchup_week=N.
  const sel = /<select\b[^>]*>([\s\S]*?)<\/select>/i.exec(mod);
  if (sel) {
    for (const m of sel[1].matchAll(/<option\b([^>]*)>/gi)) {
      out.diag.options++;
      const wk = /matchup_week=(\d{1,2})/.exec(m[1]);
      if (wk && /(?:^|\s)selected(?:\s|=|$)/i.test(m[1])) out.week = Number(wk[1]);
    }
  }
  const hw = /Week\s+(\d{1,2})\s+Matchups/i.exec(text1(mod.slice(0, 20000)));
  if (hw) out.headerWeek = Number(hw[1]);
  // Status: the header row's text after "Week N Matchups", before the first pairing.
  const firstLi = mod.search(/<li\b[^>]*data-target\s*=\s*["'][^"']*matchup\?/i);
  const head = text1(mod.slice(0, firstLi > 0 ? firstLi : Math.min(mod.length, 20000)));
  const st = /Week\s+\d{1,2}\s+Matchups\s+(.{1,40}?)(?:\s+View Matchup|$)/i.exec(head);
  if (st) out.statusText = st[1].trim();
  out.status = statusOf(out.statusText);

  const items = [...mod.matchAll(/<li\b[^>]*data-target\s*=\s*["']([^"']*matchup\?[^"']*)["'][^>]*>/gi)];
  out.diag.items = items.length;
  for (let i = 0; i < items.length; i++) {
    const ids = matchupIds(items[i][1]);
    const start = items[i].index! + items[i][0].length;
    const end = i + 1 < items.length ? items[i + 1].index! : mod.indexOf("</ul>", start) > 0 ? mod.indexOf("</ul>", start) : mod.length;
    const seg = mod.slice(start, end);
    const teamLink = new RegExp(`<a\\b[^>]*class\\s*=\\s*["'][^"']*F-link[^"']*["'][^>]*href\\s*=\\s*["'][^"']*/f1/${leagueId}/(\\d{1,2})["'][^>]*>([\\s\\S]*?)</a>`, "gi");
    const teams = [...seg.matchAll(teamLink)].map((m) => ({ id: m[1], name: text1(m[2]) }));
    const records = [...seg.matchAll(/class\s*=\s*["'][^"']*Fz-xxs[^"']*F-shade[^"']*["'][^>]*>([^<]*)</gi)]
      .map((m) => /^\s*(\d+-\d+-\d+)\b/.exec(decodeEntities(m[1]))?.[1])
      .filter((x): x is string => x !== undefined);
    const points = [...seg.matchAll(/<div\b[^>]*class\s*=\s*["'][^"']*\bFz-lg\b[^"']*["'][^>]*>([^<]*)<\/div>/gi)].map((m) => cellNumber(m[1]));
    const projs = [...seg.matchAll(/<div\b[^>]*class\s*=\s*["'][^"']*\bF-shade\b[^"']*["'][^>]*>([^<]*)<\/div>/gi)].map((m) => cellNumber(m[1])).filter((x) => x !== null);
    const left = teams[0]?.id ?? ids?.mid1;
    const right = teams[1]?.id ?? ids?.mid2;
    if (!ids || !left || !right || left === right || points.length !== 2) {
      out.diag.skipped++;
      continue;
    }
    const side = (k: 0 | 1, teamId: string): ModuleSide => ({
      teamId,
      ...(teams[k]?.name ? { name: teams[k].name.slice(0, 80) } : {}),
      ...(records.length === 2 ? { record: records[k] } : {}),
      points: points[k],
      yahooProj: projs.length === 2 ? projs[k] : null,
    });
    out.pairings.push({ mid1: ids.mid1, mid2: ids.mid2, sides: [side(0, left), side(1, right)] });
  }
  return out;
}

// ------------------------------------------------------------------ matchup page
/** Removes every nested table that is not a stat table (weather pop-ups inside player cells), innermost first. */
function dropNestedTables(html: string): string {
  const inner = /<table\b(?![^>]*\bid\s*=\s*["']statTable)[^>]*>(?:(?!<table\b)[\s\S])*?<\/table>/gi;
  let prev = "";
  let s = html;
  for (let i = 0; i < 20 && s !== prev; i++) ((prev = s), (s = s.replace(inner, "")));
  return s;
}
const cellsOf = (rowHtml: string): { html: string; attrs: string }[] => [...rowHtml.matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)].map((m) => ({ attrs: m[2], html: m[3] }));

interface Columns {
  player: [number, number];
  proj: [number, number];
  pts: [number, number];
  slot: number;
}
function columnsOf(head: { html: string; attrs: string }[]): Columns | undefined {
  const idx = (want: RegExp, titleWant: RegExp) =>
    head.map((c, i) => ({ i, t: text1(c.html), title: /title\s*=\s*["']([^"']*)["']/i.exec(c.attrs)?.[1] ?? "" })).filter((c) => titleWant.test(c.title) || want.test(c.t)).map((c) => c.i);
  const player = idx(/^player$/i, /^player$/i);
  const proj = idx(/^proj(?:ected)?\.?$/i, /^projected points$/i);
  const pts = idx(/^fan(?:tasy)? pts$/i, /^fantasy points$/i);
  const slot = head.findIndex((c) => /^pos$/i.test(text1(c.html)) && !/\bHidden\b/.test(c.attrs));
  if (player.length !== 2 || proj.length !== 2 || pts.length !== 2 || slot < 0) return undefined;
  return { player: [player[0], player[1]], proj: [proj[0], proj[1]], pts: [pts[0], pts[1]], slot };
}

function playerOf(cellHtml: string): Omit<PageRow, "slot" | "yahooProj" | "points"> {
  const id = /data-ys-playerid\s*=\s*["'](\d+)["']/i.exec(cellHtml)?.[1];
  const named = /<a\b[^>]*class\s*=\s*["'][^"']*\bname\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(cellHtml);
  const name = named ? text1(named[1]) : undefined;
  const pt = [...cellHtml.matchAll(/<span\b[^>]*class\s*=\s*["'][^"']*\bFz-xxs\b[^"']*["'][^>]*>([^<]*)<\/span>/gi)].map((m) => parsePosTeam(decodeEntities(m[1]))).find(Boolean);
  const inj = /class\s*=\s*["'][^"']*\bF-injury\b[^"']*["'][^>]*>\s*(?:<span\b[^>]*>)?\s*([A-Za-z0-9-]{1,8})\s*</i.exec(cellHtml)?.[1];
  const out: Omit<PageRow, "slot" | "yahooProj" | "points"> = {};
  if (id) out.yahooId = id;
  if (name && !/^\(?empty\)?$/i.test(name)) out.name = name.slice(0, 80);
  if (pt?.pos) out.pos = pt.pos;
  if (pt?.team) out.team = pt.team;
  if (inj) out.status = inj.toUpperCase();
  return out;
}

/**
 * One matchup page (`<base>/matchup?week=W&mid1=A&mid2=B`): the starters table and the bench table (`id="statTableN"`,
 * same markup), columns found by their headers (Player / Proj / Fan Pts on each side, the visible Pos column between).
 * The left side is mid1 (verified: week 7, mid1 = the team whose module total matches the left Total).
 */
export function parseMatchupPage(rawHtml: string, ids: { mid1: string; mid2: string }): PageParse {
  const html = dropNestedTables(stripMarkupAttrs(rawHtml));
  // Each stat table runs to its own </table>, else to the next stat table (Yahoo's markup is not always balanced:
  // the real week-8 page leaves one weather tooltip table unclosed).
  const starts = [...html.matchAll(/<table\b[^>]*\bid\s*=\s*["']statTable\d+["'][^>]*>/gi)].map((m) => m.index! + m[0].length);
  const tables = starts.map((s, i) => {
    const seg = html.slice(s, i + 1 < starts.length ? starts[i + 1] : html.length);
    const end = seg.search(/<\/table>/i);
    return end >= 0 ? seg.slice(0, end) : seg;
  });
  const diag: PageParse["diag"] = { tables: tables.length, rows: 0 };
  if (!tables.length) return { sides: undefined, diag: { ...diag, note: 'no table id="statTableN"' } };
  const sides: [PageSide, PageSide] = [
    { teamId: ids.mid1, totalProj: null, totalPts: null, rows: [] },
    { teamId: ids.mid2, totalProj: null, totalPts: null, rows: [] },
  ];
  let starters = true;
  let anyCols = false;
  for (const t of tables) {
    const rows = [...t.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => cellsOf(m[1]));
    const headAt = rows.findIndex((cs) => cs.some((c) => /^player$/i.test(text1(c.html))));
    const cols = headAt >= 0 ? columnsOf(rows[headAt]) : undefined;
    if (!cols) {
      diag.note = "a stat table without Player / Proj / Fan Pts headers";
      continue;
    }
    anyCols = true;
    diag.columns ??= `player ${cols.player} proj ${cols.proj} pts ${cols.pts} slot ${cols.slot}`;
    for (const cs of rows.slice(headAt + 1)) {
      const slot = cs[cols.slot] ? text1(cs[cols.slot].html) : "";
      if (!slot) continue;
      if (/^total$/i.test(slot)) {
        // The bench table has its own Total row (points only): the side totals are the starters' Total.
        if (starters)
          for (const k of [0, 1] as const) {
            sides[k].totalProj = cellNumber(cs[cols.proj[k]]?.html);
            sides[k].totalPts = cellNumber(cs[cols.pts[k]]?.html);
          }
        continue;
      }
      diag.rows++;
      for (const k of [0, 1] as const) {
        const cell = cs[cols.player[k]]?.html ?? "";
        sides[k].rows.push({ slot: slot.slice(0, 12), ...playerOf(cell), yahooProj: cellNumber(cs[cols.proj[k]]?.html), points: cellNumber(cs[cols.pts[k]]?.html) });
      }
    }
    starters = false;
  }
  return anyCols ? { sides, diag } : { sides: undefined, diag };
}
