// Pure string parsing of Yahoo Fantasy Football *web pages* (not the API).
// Shared by the bookmarklet (web/src/import/bookmarklet.ts, runs on
// football.fantasysports.yahoo.com) and unit tests (server/providers/import-html.test.ts).
// No DOM; the only runtime import is server/data/names.ts (pure, dependency-free), since this file is bundled
// into the bookmarklet.
//
// We have never seen Yahoo's real markup from this project, so every extractor
// is defensive: several strategies, first one that yields something wins, and
// what happened is reported in diagnostics so the parser can be tuned later.

import { normTeam, teamFromDefenseName } from "../../../server/data/names.js";

export const POS_RE = "QB|RB|WR|TE|K|DEF";

export interface ScrapedPlayer {
  yahooId?: string;
  name: string;
  pos: string;
  team?: string;
  status?: string;
  slot?: string;
  /** Player-list "Owner" column: "FA" = free agent, "W" = on waivers ("W (Wed)"). Absent when the column was not found. */
  availability?: "FA" | "W";
  /** The "(Wed)" / "(10/29)" part of a waivers cell: when he clears. */
  waiverUntil?: string;
  /** Yahoo's projected fantasy points for the rest of the season / this week (parseProjectionHtml). */
  yahooProj?: number;
  yahooProjWeekly?: number;
}

export interface RosterParse {
  teamName?: string;
  players: ScrapedPlayer[];
  /** Links found whose row had no recognisable "Team - Pos" text. */
  noPos: string[];
  diag: {
    strategy: string;
    links: number;
    rows: number;
    nameCandidates: string[];
    sampleRows: string[];
    /** Owner-column counts on player-list pages ("FA:12,W:3,none:0"). */
    availability: string;
    /** Set when players were found but no row had an FA / W owner cell. */
    availabilityNote?: string;
  };
}

export interface SettingsParse {
  name?: string;
  numTeams?: number;
  slots?: string[]; // Yahoo tokens mapped to SlotKind names (QB, FLEX, BN …)
  scoring: Partial<Record<ScoringKey, number>>;
  regularSeasonEnd?: number;
  finalWeek?: number;
  diag: { found: string[]; rosterText?: string; sample?: string };
}

export type ScoringKey = "passYd" | "passTd" | "passInt" | "rushYd" | "rushTd" | "rec" | "recYd" | "recTd" | "twoPt" | "fumLost";

// ------------------------------------------------------------------ text helpers
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", ndash: "-", mdash: "-" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (ENTITIES[k] !== undefined) return ENTITIES[k];
    if (k.startsWith("#x")) return String.fromCharCode(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCharCode(parseInt(k.slice(1), 10));
    return m;
  });
}

/** Visible text of an HTML fragment: drops script/style, turns block ends into newlines, cells into tabs. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(tr|li|p|div|h[1-6]|section|table|thead|tbody|dt|dd|ul|ol)>/gi, "\n")
      .replace(/<\/t[dh]>/gi, "\t")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \u00a0]+/g, " ")
    .replace(/ *\t */g, "\t")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const oneLine = (s: string) => htmlToText(s).replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------ position / team
const TEAM_POS = new RegExp(`\\b([A-Za-z]{2,3})\\s*[-\u2013]\\s*((?:${POS_RE})(?:\\s*,\\s*(?:${POS_RE}))*)\\b`);
const POS_TEAM = new RegExp(`\\b(${POS_RE})\\s*[-\u2013]\\s*([A-Za-z]{2,3})\\b`);
const PAREN = new RegExp(`\\(\\s*(${POS_RE})\\s*[-\u2013,]\\s*([A-Za-z]{2,3})\\s*\\)`);
const POS_SET = new Set(POS_RE.split("|"));

/**
 * Find Yahoo's "Team - Pos" (e.g. "KC - WR", "Buf - QB,RB") or "Pos - Team" text.
 * Yahoo shows team first on roster pages; both orders are accepted.
 */
export function parsePosTeam(text: string): { pos: string; team?: string } | undefined {
  const t = text.replace(/\s+/g, " ");
  const a = TEAM_POS.exec(t);
  if (a && !POS_SET.has(a[1].toUpperCase())) return { team: a[1].toUpperCase(), pos: a[2].split(",")[0].trim().toUpperCase() };
  const p = PAREN.exec(t);
  if (p && !POS_SET.has(p[2].toUpperCase())) return { pos: p[1].toUpperCase(), team: p[2].toUpperCase() };
  const b = POS_TEAM.exec(t);
  if (b && !POS_SET.has(b[2].toUpperCase())) return { pos: b[1].toUpperCase(), team: b[2].toUpperCase() };
  return undefined;
}

const SLOT_TOKENS = ["Q/W/R/T", "W/R/T", "W/R", "W/T", "QB", "RB", "WR", "TE", "K", "DEF", "BN", "IR", "IL", "FLEX", "SUPERFLEX", "SFLEX", "OP"];
/** Yahoo roster-slot token → internal SlotKind name (undefined when unknown). */
export function mapSlotToken(tok: string): string | undefined {
  const t = tok.toUpperCase().replace(/\s+/g, "");
  const m: Record<string, string> = {
    QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DEF: "DEF", "D/ST": "DEF", DST: "DEF",
    "W/R/T": "FLEX", FLEX: "FLEX", "W/R": "WRRB", WRRB: "WRRB", "W/T": "RFLEX", RFLEX: "RFLEX",
    "Q/W/R/T": "SFLEX", SFLEX: "SFLEX", SUPERFLEX: "SFLEX", OP: "SFLEX", BN: "BN", BENCH: "BN", IR: "IR", IL: "IR",
  };
  return m[t];
}

const STATUS_RE = /^(Q|D|O|P|IR|IR-R|PUP|PUP-R|PUP-P|NFI|NFI-R|NA|SUSP|COVID-19)$/;

// ------------------------------------------------------------------ players
const PLAYER_LINK = /<a\b([^>]*?)href\s*=\s*["']([^"']*?\/nfl\/players\/(\d+)[^"']*)["']([^>]*)>([\s\S]*?)<\/a>/gi;
const TEAM_LINK = /<a\b([^>]*?)href\s*=\s*["']([^"']*?\/nfl\/teams\/([a-z][a-z-]{1,24})(?=[/"'?#])[^"']*)["']([^>]*)>([\s\S]*?)<\/a>/gi;

/**
 * A defense's team abbreviation from its team link: a short slug (/nfl/teams/kc/) is the abbreviation; a long one
 * (/nfl/teams/kansas-city/) is not, so the row's "KC - DEF" text, else the slug / name read as a city or nickname,
 * decides (server/data/names.ts). Undefined when nothing matches — never a cut slug such as "KANS".
 */
function defenseTeam(slug: string, rowTeam: string | undefined, name: string): string | undefined {
  if (/^[a-z]{2,3}$/i.test(slug)) return normTeam(slug);
  if (rowTeam) return normTeam(rowTeam);
  return teamFromDefenseName(slug.replace(/-/g, " ")) ?? teamFromDefenseName(name);
}
const JUNK_NAME = /^(no new |new )?player notes?$|^notes?$|^video$|^news$|^add$|^drop$|^trade$|^watch$|^\s*$/i;

/** Bounds of the innermost element named `tag` enclosing `at` (string search, tolerant of bad HTML). */
function enclosing(html: string, at: number, tag: string, maxLen = 12000): [number, number] | undefined {
  const lower = html.toLowerCase();
  const open = lower.lastIndexOf(`<${tag}`, at);
  if (open < 0 || at - open > maxLen) return undefined;
  const closeBefore = lower.lastIndexOf(`</${tag}>`, at);
  if (closeBefore > open) return undefined; // the nearest <tag> closed before our link
  const close = lower.indexOf(`</${tag}>`, at);
  if (close < 0 || close - at > maxLen) return undefined;
  return [open, close + tag.length + 3];
}

function rowHtml(html: string, at: number): { html: string; how: string } {
  for (const tag of ["tr", "li"]) {
    const r = enclosing(html, at, tag);
    if (r) return { html: html.slice(r[0], r[1]), how: tag };
  }
  return { html: html.slice(Math.max(0, at - 500), Math.min(html.length, at + 900)), how: "window" };
}

function statusFrom(rowHtmlStr: string): string | undefined {
  const cls = /class\s*=\s*["'][^"']*(?:injury|F-injury|status)[^"']*["'][^>]*>\s*([A-Za-z0-9-]{1,8})\s*</i.exec(rowHtmlStr);
  if (cls && STATUS_RE.test(cls[1].toUpperCase())) return cls[1].toUpperCase();
  const title = /title\s*=\s*["'](Questionable|Doubtful|Out|Injured Reserve|Suspended|Probable|Physically Unable to Perform)["']/i.exec(rowHtmlStr);
  if (title) {
    const m: Record<string, string> = { questionable: "Q", doubtful: "D", out: "O", "injured reserve": "IR", suspended: "SUSP", probable: "P", "physically unable to perform": "PUP" };
    return m[title[1].toLowerCase()];
  }
  return undefined;
}

/**
 * Yahoo's player list (players?status=A) has an "Owner" column: "FA" for a free agent, "W (Wed)" (or a date)
 * for a player on waivers. Any cell of the row whose whole text is one of those counts. A bare "W" cell is NOT
 * waivers (that is how the list shows a last-game win): "W" counts only with its date, "W (Wed)". Absent → undefined.
 */
export function availabilityFrom(rowText: string): { availability: "FA" | "W"; waiverUntil?: string } | undefined {
  for (const raw of rowText.split(/[\t\n]/)) {
    const cell = raw.trim();
    if (/^FA$/.test(cell)) return { availability: "FA" };
    const w = /^(?:W\s*\(\s*([^()]{1,16}?)\s*\)|Waivers?(?:\s*\(\s*([^()]{1,16}?)\s*\))?)$/.exec(cell);
    if (w) {
      const until = w[1] ?? w[2];
      return until ? { availability: "W", waiverUntil: until } : { availability: "W" };
    }
  }
  return undefined;
}

/** Key a scraped player the same way everywhere (defenses have no Yahoo player id). */
export const playerKey = (p: { yahooId?: string; name: string; pos: string }) => p.yahooId ?? `${p.name}|${p.pos}`;

/** Position groups Yahoo's player list is read in: offense ("O"), kickers, defenses. */
export type WaiverGroup = "O" | "K" | "DEF";
export const waiverGroupOf = (pos: string): WaiverGroup => (pos === "K" ? "K" : pos === "DEF" ? "DEF" : "O");

export interface WaiverGroupList {
  /** Keys of the players listed by players?status=W. */
  keys: Set<string>;
  /** false when the list hit the page cap OR a page failed: players not in it are then unknown, not free agents. */
  complete: boolean;
  /** true when Yahoo seemed to ignore status=W (the list matched the status=A list): the list is not used. */
  ignored: boolean;
}

export interface WaiverList extends WaiverGroupList {
  /**
   * The list per position group (the bookmarklet reads one status=W list per group). When given, each group is
   * judged on its own list only and a group without an entry is unknown. Without it, the flat list is judged per
   * group on that group's own evidence (a member of the list, or an owner-column reading, in the group).
   */
  groups?: Partial<Record<WaiverGroup, WaiverGroupList>>;
}

/**
 * Free agent vs on waivers for each free agent: the owner column wins; else membership of the status=W list
 * (when that group's list is usable); else unknown (undefined). Disagreements are counted for diagnostics.
 * Completeness is judged per position group: an empty or failed offense list never makes offense players free
 * agents because the kicker list had a member.
 */
export function waiverStatusOf(
  players: ScrapedPlayer[],
  w: WaiverList | undefined,
): { onWaivers: Map<string, boolean | undefined>; diag: { fromColumn: number; fromList: number; unknown: number; disagree: number; listUsed: boolean } } {
  // An empty W list cannot be told from an unreadable page: when no row of the group had an Owner reading either,
  // trusting it would mark the whole group free agents. Leave them unknown instead (the app then asks for a re-import).
  const usable = new Map<WaiverGroup, WaiverGroupList | undefined>();
  for (const g of ["O", "K", "DEF"] as const) {
    const gl = w ? (w.groups ? w.groups[g] : { keys: w.keys, complete: w.complete, ignored: w.ignored }) : undefined;
    if (!gl || gl.ignored) {
      usable.set(g, undefined);
      continue;
    }
    const mine = players.filter((p) => waiverGroupOf(p.pos) === g);
    const hasColumn = mine.some((p) => p.availability);
    const evidence = w!.groups ? gl.keys.size > 0 : mine.some((p) => gl.keys.has(playerKey(p)));
    usable.set(g, hasColumn || evidence ? gl : undefined);
  }
  const out = new Map<string, boolean | undefined>();
  const diag = { fromColumn: 0, fromList: 0, unknown: 0, disagree: 0, listUsed: [...usable.values()].some(Boolean) };
  for (const p of players) {
    const k = playerKey(p);
    const gl = usable.get(waiverGroupOf(p.pos));
    const inList = gl ? gl.keys.has(k) : undefined;
    if (p.availability) {
      const onW = p.availability === "W";
      out.set(k, onW);
      diag.fromColumn++;
      if (inList !== undefined && gl!.complete && inList !== onW) diag.disagree++;
    } else if (inList === true || (inList === false && gl!.complete)) {
      out.set(k, inList);
      diag.fromList++;
    } else {
      out.set(k, undefined);
      diag.unknown++;
    }
  }
  return { onWaivers: out, diag };
}

function slotFrom(rowText: string, rowHtmlStr: string): string | undefined {
  // Yahoo marks the slot cell with data-pos / class "pos-label"; else take the row's leading token.
  const attr = /(?:data-pos|data-position)\s*=\s*["']([^"']+)["']/i.exec(rowHtmlStr) ?? /class\s*=\s*["'][^"']*pos-label[^"']*["'][^>]*>\s*([^<\s]+)\s*</i.exec(rowHtmlStr);
  if (attr && mapSlotToken(attr[1])) return attr[1].toUpperCase();
  const first = rowText.trim().split(/[\s\t]+/)[0] ?? "";
  if (SLOT_TOKENS.includes(first.toUpperCase())) return first.toUpperCase();
  return undefined;
}

/** Candidate team names: <title> text before " | ", then h1/h2, then og:title. */
export function teamNameCandidates(html: string): string[] {
  const out: string[] = [];
  const push = (s: string | undefined) => {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    if (t && t.length <= 80 && !out.includes(t)) out.push(t);
  };
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) push(decodeEntities(title[1]).split(/\s+\|\s+/)[0]);
  const named = /class\s*=\s*["'][^"']*(?:team-name|Navtarget|TeamName)[^"']*["'][^>]*>([\s\S]{1,300}?)<\//i.exec(html);
  if (named) push(oneLine(named[1]));
  for (const m of html.matchAll(/<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) push(oneLine(m[2]));
  const og = /<meta[^>]+property\s*=\s*["']og:title["'][^>]+content\s*=\s*["']([^"']*)["']/i.exec(html);
  if (og) push(decodeEntities(og[1]).split(/\s+\|\s+/)[0]);
  return out;
}

const GENERIC_NAME = /^(yahoo!?( sports)?|(yahoo )?fantasy( football| sports)?|football|nfl|roster|my team|team|league|players?|home|matchups?)$|fantasy football|yahoo!? sports/i;

/** First candidate that does not look like a generic page heading. */
export function pickTeamName(cands: string[]): string | undefined {
  return cands.find((c) => !GENERIC_NAME.test(c)) ?? cands[0];
}

/**
 * Players on one Yahoo page (roster or player-list): every link to /nfl/players/<id>
 * plus team-defense links (/nfl/teams/<abbr>) whose row says DEF. De-duplicated by id.
 */
export function parsePlayersHtml(html: string): RosterParse {
  const byId = new Map<string, ScrapedPlayer & { at: number }>();
  const noPos: string[] = [];
  const sampleRows: string[] = [];
  const hows = new Map<string, number>();
  let links = 0;

  const consider = (id: string, at: number, text: string, isTeam: boolean, abbr?: string) => {
    links++;
    const name = oneLine(text);
    const prev = byId.get(id);
    if (prev) {
      if ((!prev.name || JUNK_NAME.test(prev.name)) && name && !JUNK_NAME.test(name)) prev.name = name;
      return;
    }
    const row = rowHtml(html, at);
    hows.set(row.how, (hows.get(row.how) ?? 0) + 1);
    const text2 = htmlToText(row.html);
    if (sampleRows.length < 3) sampleRows.push(text2.replace(/\s+/g, " ").slice(0, 200));
    let pt = parsePosTeam(text2);
    if (isTeam) {
      if (!/\bDEF\b/.test(text2)) return; // team links are only defenses when the row says DEF
      pt = { pos: "DEF", team: defenseTeam(abbr ?? "", pt?.team, name) };
    }
    const entry: ScrapedPlayer & { at: number } = { at, name, pos: pt?.pos ?? "" };
    if (!isTeam) entry.yahooId = id;
    if (pt?.team) entry.team = pt.team;
    const st = statusFrom(row.html);
    if (st) entry.status = st;
    const slot = slotFrom(text2, row.html);
    if (slot) entry.slot = slot;
    const av = availabilityFrom(text2);
    if (av) Object.assign(entry, av);
    byId.set(id, entry);
  };

  for (const m of html.matchAll(PLAYER_LINK)) consider(m[3], m.index ?? 0, m[5], false);
  for (const m of html.matchAll(TEAM_LINK)) consider(`team:${m[3].toLowerCase()}`, m.index ?? 0, m[5], true, m[3]);

  const players: ScrapedPlayer[] = [];
  for (const { at: _at, ...p } of byId.values()) {
    if (!p.name || JUNK_NAME.test(p.name)) continue;
    if (!p.pos) {
      noPos.push(p.name);
      continue;
    }
    players.push(p);
  }
  const cands = teamNameCandidates(html);
  const fa = players.filter((p) => p.availability === "FA").length;
  const w = players.filter((p) => p.availability === "W").length;
  const none = players.length - fa - w;
  return {
    teamName: pickTeamName(cands),
    players,
    noPos,
    diag: {
      strategy: [...hows].map(([k, v]) => `${k}:${v}`).join(",") || "none",
      links,
      rows: byId.size,
      nameCandidates: cands.slice(0, 5),
      sampleRows,
      availability: `FA:${fa},W:${w},none:${none}`,
      ...(players.length && !fa && !w ? { availabilityNote: "owner column (FA / W) not found" } : {}),
    },
  };
}

/** Team number of "My Team" from Yahoo's navigation, when a link says so. */
export function parseMyTeamId(html: string, leagueId: string): string | undefined {
  const re = new RegExp(`href\\s*=\\s*["'][^"']*/f1/${leagueId}/(\\d{1,2})/?["'][^>]*>([\\s\\S]{0,200}?)</a>`, "gi");
  for (const m of html.matchAll(re)) if (/my\s*team/i.test(oneLine(m[2]))) return m[1];
  return undefined;
}

// ------------------------------------------------------------------ settings
const SCORING_LABELS: [ScoringKey, RegExp][] = [
  ["passYd", /Passing Yards/i],
  ["passTd", /Passing Touchdowns/i],
  ["passInt", /(?:Passing )?Interceptions?(?! Return)/i],
  ["rushYd", /Rushing Yards/i],
  ["rushTd", /Rushing Touchdowns/i],
  ["rec", /Receptions/i],
  ["recYd", /Receiving Yards/i],
  ["recTd", /Receiving Touchdowns/i],
  ["twoPt", /2-?Point Conversions?/i],
  ["fumLost", /Fumbles Lost/i],
];

/** "25 yards per point" → 0.04; "0.5" → 0.5; "-2" → -2. */
function scoringValue(after: string): number | undefined {
  const per = /^[:\s\t]*(-?\d+(?:\.\d+)?)\s*yards? per point/i.exec(after);
  if (per) return Number(per[1]) ? Math.round((1 / Number(per[1])) * 10000) / 10000 : undefined;
  const n = /^[:\s\t]*(?:\([^)]*\)[\s\t]*)?(-?\d+(?:\.\d+)?)/.exec(after);
  return n ? Number(n[1]) : undefined;
}

export function parseSettingsHtml(html: string): SettingsParse {
  const text = htmlToText(html);
  const found: string[] = [];
  const out: SettingsParse = { scoring: {}, diag: { found } };

  const name = /League Name:?[\t ]*([^\t\n]{2,80})/i.exec(text);
  if (name) (out.name = name[1].trim(), found.push("name"));

  const teams = /(?:Max(?:imum)?(?: Number of)? Teams|Number of Teams)[:\t ]*(\d{1,2})/i.exec(text);
  if (teams) (out.numTeams = Number(teams[1]), found.push("numTeams"));

  const rp = /Roster Positions:?([\s\S]{0,400})/i.exec(text);
  if (rp) {
    // Stop at the next "Label:" that is not a slot token.
    const seg = rp[1].split(/\n[A-Za-z][A-Za-z ]{3,}:/)[0];
    out.diag.rosterText = seg.replace(/\s+/g, " ").slice(0, 200);
    const slots: string[] = [];
    const tokRe = /(Q\/W\/R\/T|W\/R\/T|W\/R|W\/T|D\/ST|QB|RB|WR|TE|DEF|BN|IR|IL|K)(?![A-Za-z/])(?:\s*[x×]\s*(\d+)|\s*\((\d+)\)|[:\s]+(\d+)(?=\s*(?:[,;\n]|$)))?/g;
    for (const m of seg.matchAll(tokRe)) {
      const kind = mapSlotToken(m[1]);
      if (!kind) continue;
      const count = Math.min(15, Number(m[2] ?? m[3] ?? m[4] ?? 1) || 1);
      for (let i = 0; i < count; i++) slots.push(kind);
    }
    if (slots.some((s) => s !== "BN" && s !== "IR")) (out.slots = slots, found.push("slots"));
  }

  // Scoring: search after "Stat Modifiers"/"Scoring" heading when present (offense first).
  const start = text.search(/Stat Modifiers|Scoring Settings|Offense/i);
  const scoringText = start >= 0 ? text.slice(start) : text;
  for (const [key, re] of SCORING_LABELS) {
    const m = re.exec(scoringText);
    if (!m) continue;
    const v = scoringValue(scoringText.slice(m.index + m[0].length, m.index + m[0].length + 60));
    if (v !== undefined && Number.isFinite(v) && Math.abs(v) <= 20) {
      out.scoring[key] = v;
      found.push(key);
    }
  }

  const po = /Playoffs?:?[\t ]*([^\n]{0,80})/i.exec(text);
  if (po) {
    const weeks = [...po[1].matchAll(/\b(1[0-9]|[1-9])\b/g)].map((m) => Number(m[1])).filter((w) => w >= 10 && w <= 18);
    if (weeks.length) {
      out.regularSeasonEnd = Math.min(...weeks) - 1;
      out.finalWeek = Math.max(...weeks);
      found.push("playoffs");
    }
  }
  out.diag.sample = text.slice(0, 300);
  return out;
}

// ------------------------------------------------------------------ standings
/** One team's standings line as read from the page. Fields the page did not show are absent (unknown). */
export interface StandingsRecord {
  wins: number;
  losses: number;
  ties: number;
  pointsFor?: number;
  pointsAgainst?: number;
  rank?: number;
  streak?: string;
  seed?: number;
}
export interface StandingsRow {
  /** Team number from the row's /f1/<league>/<n> link (the same number as the team pages). */
  teamId: string;
  name: string;
  record?: StandingsRecord;
  /** Place in the rolling waiver order (1 = first claim), from a "Waiver" column. */
  waiverRank?: number;
}
export type StandingsColumn = "rank" | "wlt" | "w" | "l" | "t" | "pf" | "pa" | "streak" | "waiver" | "seed";
export interface StandingsParse {
  rows: StandingsRow[];
  diag: {
    /** Tables whose header row named at least two standings columns (divisions = several). */
    tables: number;
    headers: string[];
    columns: StandingsColumn[];
    /** Columns this page did not have (their values stay unknown). */
    missing: string[];
    rows: number;
    /** Team rows whose wins / losses / ties could not be read. */
    noRecord: string[];
    rankFrom?: "header" | "first unlabeled column";
    sampleRows: string[];
    note?: string;
  };
}

const STANDINGS_HEADERS: [StandingsColumn, RegExp][] = [
  ["rank", /^(rank|rk|#|pos)\.?$/i],
  ["wlt", /^(w-l-t|w-l|record|overall)$/i],
  ["w", /^(w|wins?)$/i],
  ["l", /^(l|loss(es)?)$/i],
  ["t", /^(t|ties?)$/i],
  ["pf", /^(pts|points)( for)?$|^pf$|^fan pts$/i],
  ["pa", /^(pts|points) (agst|against|vs)\.?$|^pa$|^opp pts$/i],
  ["streak", /^(streak|strk)$/i],
  ["waiver", /^waivers?( priority| order| rank)?$|^waiver pri\.?$/i],
  ["seed", /^(playoff )?seed$/i],
];

/** Whole number from a cell ("1", "1*", "#2"); undefined when the cell has none. */
const leadInt = (cell: string): number | undefined => {
  const m = /^\s*#?(\d{1,3})\b/.exec(cell);
  return m ? Number(m[1]) : undefined;
};
/** Points cell: "1,043.24" → 1043.24; anything else → undefined. */
const pointsOf = (cell: string): number | undefined => {
  const t = cell.replace(/,/g, "").trim();
  return /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : undefined;
};

function cellsOf(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((m) => oneLine(m[2]));
}

/**
 * Standings table(s) of a Yahoo league page (…/f1/<league>/standings, or the league home page): per team the rank,
 * W-L-T (one "5-1-0" cell or separate W / L / T columns), points for / against, streak, waiver priority and playoff
 * seed. Columns are found by their header text, never by position (the rank may sit in an unlabeled first column);
 * a column the page lacks is listed in diag.missing and its value stays unknown.
 */
export function parseStandingsHtml(html: string, leagueId: string): StandingsParse {
  const rows: StandingsRow[] = [];
  const seen = new Set<string>();
  const noRecord: string[] = [];
  const sampleRows: string[] = [];
  const found = new Set<StandingsColumn>();
  let headers: string[] = [];
  let tables = 0;
  let rankFrom: StandingsParse["diag"]["rankFrom"];
  const teamLink = new RegExp(`<a\\b[^>]*href\\s*=\\s*["'][^"']*/f1/${leagueId}/(\\d{1,2})/?(?:[?#][^"']*)?["'][^>]*>([\\s\\S]*?)</a>`, "gi");
  /** The row's team: number from its first team link, name from the first such link with text (logos come first). */
  const teamOf = (rowHtml: string): { id: string; name: string } | undefined => {
    const links = [...rowHtml.matchAll(teamLink)];
    if (!links.length) return undefined;
    const named = links.find((l) => l[1] === links[0][1] && oneLine(l[2]));
    return { id: links[0][1], name: named ? oneLine(named[2]) : "" };
  };

  for (const t of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    let cols: Partial<Record<StandingsColumn, number>> | undefined;
    for (const r of t[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
      const link = teamOf(r[0]);
      const cells = cellsOf(r[0]);
      if (!link) {
        // A header row: at least two cells name a standings column.
        const map: Partial<Record<StandingsColumn, number>> = {};
        cells.forEach((c, i) => {
          const hit = STANDINGS_HEADERS.find(([, re]) => re.test(c.trim()));
          if (hit && map[hit[0]] === undefined) map[hit[0]] = i;
        });
        if (Object.keys(map).length >= 2) {
          if (map.rank === undefined && cells[0]?.trim() === "") map.rank = -1; // maybe an unlabeled rank column
          cols = map;
          tables++;
          if (!headers.length) headers = cells.slice(0, 14);
        }
        continue;
      }
      if (!cols) continue;
      const teamId = link.id;
      if (seen.has(teamId)) continue;
      seen.add(teamId);
      const name = link.name || `Team ${teamId}`;
      if (sampleRows.length < 2) sampleRows.push(cells.join(" | ").slice(0, 200));
      const cell = (k: StandingsColumn) => (cols![k] !== undefined && cols![k]! >= 0 ? cells[cols![k]!] : undefined);
      for (const k of Object.keys(cols) as StandingsColumn[]) if (cols[k]! >= 0) found.add(k);

      let wlt: [number, number, number] | undefined;
      const wltCell = cell("wlt");
      const m = wltCell !== undefined ? /^\s*(\d{1,2})\s*-\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*$/.exec(wltCell) : null;
      // "5-1" is how Yahoo writes a record without ties: ties = 0 is what the cell says, not a guess.
      if (m) wlt = [Number(m[1]), Number(m[2]), m[3] !== undefined ? Number(m[3]) : 0];
      else {
        const [w, l, tt] = (["w", "l", "t"] as const).map((k) => (cell(k) !== undefined && /^\s*\d{1,2}\s*$/.test(cell(k)!) ? Number(cell(k)) : undefined));
        if (w !== undefined && l !== undefined && tt !== undefined) wlt = [w, l, tt];
      }
      const row: StandingsRow = { teamId, name };
      if (wlt) {
        const rec: StandingsRecord = { wins: wlt[0], losses: wlt[1], ties: wlt[2] };
        const pf = cell("pf") !== undefined ? pointsOf(cell("pf")!) : undefined;
        if (pf !== undefined) rec.pointsFor = pf;
        const pa = cell("pa") !== undefined ? pointsOf(cell("pa")!) : undefined;
        if (pa !== undefined) rec.pointsAgainst = pa;
        let rank = cell("rank") !== undefined ? leadInt(cell("rank")!) : undefined;
        if (rank !== undefined) rankFrom = "header";
        else if (cols.rank === -1 && /^\s*\d{1,2}\s*\*?\s*$/.test(cells[0] ?? "")) {
          rank = leadInt(cells[0]);
          rankFrom ??= "first unlabeled column";
        }
        if (rank) rec.rank = rank;
        const st = /^\s*([WLT])\s*-?\s*(\d{1,2})\s*$/i.exec(cell("streak") ?? "");
        if (st) rec.streak = `${st[1].toUpperCase()}${Number(st[2])}`;
        const seed = cell("seed") !== undefined ? leadInt(cell("seed")!) : undefined;
        if (seed) rec.seed = seed;
        row.record = rec;
      } else noRecord.push(name);
      const wr = cell("waiver") !== undefined ? leadInt(cell("waiver")!) : undefined;
      if (wr) row.waiverRank = wr;
      rows.push(row);
    }
  }
  if (rankFrom === "first unlabeled column") found.add("rank");
  const want: [string, StandingsColumn[]][] = [["rank", ["rank"]], ["W-L-T", ["wlt", "w"]], ["points for", ["pf"]], ["points against", ["pa"]], ["streak", ["streak"]], ["waiver", ["waiver"]], ["seed", ["seed"]]];
  const missing = want.filter(([, ks]) => !ks.some((k) => found.has(k))).map(([label]) => label);
  return {
    rows,
    diag: {
      tables,
      headers,
      columns: [...found],
      missing: rows.length ? missing : want.map(([label]) => label),
      rows: rows.length,
      noRecord: noRecord.slice(0, 20),
      ...(rankFrom ? { rankFrom } : {}),
      sampleRows,
      ...(!tables ? { note: "no standings table (no header row naming W-L-T / Pts For / Waiver …)" } : !rows.length ? { note: "standings header found but no team rows" } : {}),
    },
  };
}

// ------------------------------------------------------------------ projections (release (d))
/**
 * What the projections parser read from one page. `values` maps a Yahoo player id to projected fantasy points.
 * Never guessed: a rest-of-season value needs BOTH a points column and a page-level sign that the projected
 * rest-of-season view is the selected one (a selected <option> / active tab reading "Remaining Season (proj)",
 * "Rest of Season (Proj)" …); otherwise nothing is returned and `diag.note` says why.
 */
export interface ProjectionParse {
  values: Map<string, number>;
  diag: {
    kind: "ros" | "week";
    /** Header cells of the header row the column came from (or the first header row seen). */
    headers: string[];
    column?: string;
    columnIndex?: number;
    /** Text of the selected view control (rest of season only). */
    viewIndicator?: string;
    rows: number;
    read: number;
    note?: string;
  };
}

/** Upper bounds (sanity): a rest-of-season projection ≤ 450 points, one week ≤ 60. */
export const PROJ_MAX = { ros: 450, week: 60 } as const;

const WEEK_PROJ_HEADER = /^proj(?:ected)?\.?(?:\s*(?:fan(?:tasy)?\s*)?(?:pts|points))?$/i;
const PTS_HEADER = /^(?:fan(?:tasy)?\s*)?(?:pts|points)$/i;
const ROS_TEXT = /(?:remaining|rest[\s-]+of[\s-]+(?:the\s+)?season|\bros\b)/i;

/** Text of a selected / active view control that names the projected rest-of-season view (undefined = none). */
export function rosViewIndicator(html: string): string | undefined {
  const isRos = (t: string) => ROS_TEXT.test(t) && /proj/i.test(t);
  for (const m of html.matchAll(/<option\b([^>]*)>([\s\S]{0,120}?)<\/option>/gi)) {
    const t = oneLine(m[2]);
    if (/\bselected\b/i.test(m[1]) && isRos(t)) return t;
  }
  // Tabs / pills / dropdown buttons: an element marked selected / active / current whose text names the view.
  for (const m of html.matchAll(/<(a|li|span|button|div)\b([^>]*(?:class\s*=\s*["'][^"']*\b(?:selected|active|is-selected|current|Selected)\b[^"']*["']|aria-(?:selected|current)\s*=\s*["'](?:true|page)["'])[^>]*)>([\s\S]{0,200}?)<\/\1>/gi)) {
    const t = oneLine(m[3]);
    if (t.length <= 60 && isRos(t)) return t;
  }
  return undefined;
}

/** Cells of a row, each repeated by its colspan, so header and body indexes line up. */
function spanCells(rowHtml: string): { text: string; th: boolean }[] {
  const out: { text: string; th: boolean }[] = [];
  for (const m of rowHtml.matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)) {
    const span = Math.min(10, Math.max(1, Number(/colspan\s*=\s*["']?(\d+)/i.exec(m[2])?.[1] ?? 1)));
    const text = oneLine(m[3]);
    for (let i = 0; i < span; i++) out.push({ text, th: m[1].toLowerCase() === "h" });
  }
  return out;
}

/**
 * Projected fantasy points per player from a Yahoo roster / player-list page.
 *  - "week": a column headed "Proj" / "Proj Pts" / "Projected Points" (the roster page's weekly projection).
 *  - "ros": the page must show the projected rest-of-season view as selected (rosViewIndicator); the points column is
 *    then a "Proj…" column, else "Fan Pts" / "Pts" (which, in that view, holds the projection).
 * Values outside 0..PROJ_MAX or not plain numbers ("-", "") are skipped. Defenses (no player id) are skipped.
 */
export function parseProjectionHtml(html: string, kind: "ros" | "week"): ProjectionParse {
  const values = new Map<string, number>();
  const diag: ProjectionParse["diag"] = { kind, headers: [], rows: 0, read: 0 };
  if (kind === "ros") {
    const vi = rosViewIndicator(html);
    if (vi) diag.viewIndicator = vi;
  }
  const want = kind === "week" ? [WEEK_PROJ_HEADER] : [WEEK_PROJ_HEADER, PTS_HEADER];
  const link = /\/nfl\/players\/(\d+)/;
  for (const t of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    let col: number | undefined;
    for (const r of t[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
      const cells = spanCells(r[0]);
      const id = link.exec(r[0])?.[1];
      if (!id) {
        if (!cells.length) continue;
        if (!diag.headers.length) diag.headers = cells.map((c) => c.text).slice(0, 16);
        for (const re of want) {
          const i = cells.findIndex((c) => re.test(c.text.trim()));
          if (i >= 0) {
            col = i;
            diag.headers = cells.map((c) => c.text).slice(0, 16);
            diag.column = cells[i].text;
            diag.columnIndex = i;
            break;
          }
        }
        continue;
      }
      diag.rows++;
      if (col === undefined) continue;
      const raw = cells[col]?.text.replace(/,/g, "").trim() ?? "";
      if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(raw)) continue;
      const v = Number(raw);
      if (v > PROJ_MAX[kind]) continue;
      if (!values.has(id)) {
        values.set(id, v);
        diag.read++;
      }
    }
  }
  if (diag.column === undefined) diag.note = `no ${kind === "week" ? "Proj" : "projected points"} column`;
  else if (kind === "ros" && !diag.viewIndicator) {
    diag.note = "projected rest-of-season view not shown as selected: values ignored";
    values.clear();
    diag.read = 0;
  } else if (!diag.read) diag.note = "column found but no numeric values";
  return { values, diag };
}
