// Pure string parsing of Yahoo Fantasy Football *web pages* (not the API).
// Shared by the bookmarklet (web/src/import/bookmarklet.ts, runs on
// football.fantasysports.yahoo.com) and unit tests (server/providers/import-html.test.ts).
// No DOM, no imports with runtime code: this file is bundled into the bookmarklet.
//
// We have never seen Yahoo's real markup from this project, so every extractor
// is defensive: several strategies, first one that yields something wins, and
// what happened is reported in diagnostics so the parser can be tuned later.

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
const TEAM_LINK = /<a\b([^>]*?)href\s*=\s*["']([^"']*?\/nfl\/teams\/([a-z]{2,4})\/?[^"']*)["']([^>]*)>([\s\S]*?)<\/a>/gi;
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
 * for a player on waivers. Any cell of the row whose whole text is one of those counts. Defensive: absent → undefined.
 */
export function availabilityFrom(rowText: string): { availability: "FA" | "W"; waiverUntil?: string } | undefined {
  for (const raw of rowText.split(/[\t\n]/)) {
    const cell = raw.trim();
    if (/^FA$/.test(cell)) return { availability: "FA" };
    const w = /^(?:W|Waivers?)(?:\s*\(\s*([^()]{1,16}?)\s*\))?$/.exec(cell);
    if (w) return w[1] ? { availability: "W", waiverUntil: w[1] } : { availability: "W" };
  }
  return undefined;
}

/** Key a scraped player the same way everywhere (defenses have no Yahoo player id). */
export const playerKey = (p: { yahooId?: string; name: string; pos: string }) => p.yahooId ?? `${p.name}|${p.pos}`;

export interface WaiverList {
  /** Keys of players listed by players?status=W (all positions fetched). */
  keys: Set<string>;
  /** false when the list hit the page cap (players not in it are then unknown, not free agents). */
  complete: boolean;
  /** true when Yahoo seemed to ignore status=W (the list matched the status=A list): the list is not used. */
  ignored: boolean;
}

/**
 * Free agent vs on waivers for each free agent: the owner column wins; else membership of the status=W list
 * (when that list is usable); else unknown (undefined). Disagreements are counted for diagnostics.
 */
export function waiverStatusOf(
  players: ScrapedPlayer[],
  w: WaiverList | undefined,
): { onWaivers: Map<string, boolean | undefined>; diag: { fromColumn: number; fromList: number; unknown: number; disagree: number; listUsed: boolean } } {
  const listUsed = !!w && !w.ignored;
  const out = new Map<string, boolean | undefined>();
  const diag = { fromColumn: 0, fromList: 0, unknown: 0, disagree: 0, listUsed };
  for (const p of players) {
    const k = playerKey(p);
    const inList = listUsed ? w!.keys.has(k) : undefined;
    if (p.availability) {
      const onW = p.availability === "W";
      out.set(k, onW);
      diag.fromColumn++;
      if (inList !== undefined && w!.complete && inList !== onW) diag.disagree++;
    } else if (inList === true || (inList === false && w!.complete)) {
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
      pt = { pos: "DEF", team: (abbr ?? pt?.team ?? "").toUpperCase() };
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
