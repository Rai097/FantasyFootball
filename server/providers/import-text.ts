// Paste mode: turn the plain text of one or more copied Yahoo roster pages into
// raw import teams. Pure (no db); resolution to internal players happens in import.ts.
//
// Recognised player lines (anything else is ignored):
//   "<Name> <Team> - <Pos>"        e.g. "Patrick Mahomes KC - QB"   (Yahoo roster rows)
//   "<Name>" then next line "<Team> - <Pos>"                           (Yahoo when copied cell by cell)
//   "<Name> (<Pos> - <Team>)"      e.g. "Josh Allen (QB - BUF)"
// Leading slot tokens (QB, W/R/T, BN, IR …) and trailing injury tags (Q, O, IR …) are stripped.
// Teams are separated by lines like "=== Team Name ===".
import type { ImportPlayerRaw, ImportTeamRaw } from "./import.js";

const POS = "QB|RB|WR|TE|K|DEF|D/ST|DST";
const SLOT_PREFIX = /^(?:Q\/W\/R\/T|W\/R\/T|W\/R|W\/T|QB|RB|WR|TE|K|DEF|BN|IR|IL|FLEX)\b[\s:]*/;
const TEAM_POS_LINE = new RegExp(`^(.*?)\\s*\\b([A-Za-z]{2,3})\\s*[-–]\\s*((?:${POS})(?:\\s*,\\s*(?:${POS}))*)\\b(.*)$`);
const PAREN_LINE = new RegExp(`^(.*?)\\s*\\(\\s*(${POS})\\s*[-–,]\\s*([A-Za-z]{2,3})\\s*\\)(.*)$`);
const STATUS = /^(Q|D|O|P|IR|IR-R|PUP|PUP-R|NFI|NA|SUSP)$/;
const NOISE = /\b(no new player notes?|new player notes?|player notes?|video|news)\b/gi;
const POS_WORDS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

function cleanName(raw: string): { name: string; slot?: string; status?: string } {
  let s = raw.replace(NOISE, " ").replace(/[\t|]+/g, " ").replace(/\s+/g, " ").trim();
  let slot: string | undefined;
  const sm = SLOT_PREFIX.exec(s);
  // Only strip a slot token when something name-like follows it.
  if (sm && /[A-Za-z]{2,}/.test(s.slice(sm[0].length))) {
    slot = sm[0].trim().replace(/:$/, "").toUpperCase();
    s = s.slice(sm[0].length).trim();
  }
  let status: string | undefined;
  const parts = s.split(" ");
  while (parts.length > 1 && STATUS.test(parts[parts.length - 1])) status = parts.pop();
  return { name: parts.join(" ").replace(/^[^A-Za-z]+|[^A-Za-z.')]+$/g, ""), slot, status };
}

const looksLikeName = (s: string) => /^[A-Z][A-Za-z.'-]+(?: [A-Za-z.'-]+){1,3}$/.test(s) || /^[A-Z][a-z]+(?: [A-Z][a-z]+)?$/.test(s);

function statusAfter(rest: string): string | undefined {
  const tok = rest.trim().split(/\s+/)[0] ?? "";
  return STATUS.test(tok) ? tok : undefined;
}

export interface TextParse {
  teams: ImportTeamRaw[];
  skippedLines: number;
}

/** Parse pasted roster text. Players go to `defaultTeamName` until a "=== Name ===" header appears. */
export function parseRosterText(text: string, defaultTeamName = "My Team"): TextParse {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/ /g, " ").trim());
  const teams: ImportTeamRaw[] = [];
  let cur: ImportTeamRaw | undefined;
  let skipped = 0;
  let prev = "";
  const team = () => {
    if (!cur) {
      cur = { id: "1", name: defaultTeamName, players: [] };
      teams.push(cur);
    }
    return cur;
  };
  const add = (p: ImportPlayerRaw) => {
    const t = team();
    const k = `${p.name.toLowerCase()}|${p.pos}`;
    if (!t.players.some((q) => `${q.name.toLowerCase()}|${q.pos}` === k)) t.players.push(p);
  };

  for (const line of lines) {
    if (!line) continue;
    const header = /^={2,}\s*(.+?)\s*={2,}$/.exec(line);
    if (header) {
      cur = { id: String(teams.length + 1), name: header[1].slice(0, 80), players: [] };
      teams.push(cur);
      prev = "";
      continue;
    }
    const paren = PAREN_LINE.exec(line);
    const tp = paren ? undefined : TEAM_POS_LINE.exec(line);
    if (paren || (tp && !POS_WORDS.has(tp[2].toUpperCase()))) {
      const [namePart, pos, teamAbbr, rest] = paren ? [paren[1], paren[2], paren[3], paren[4]] : [tp![1], tp![3].split(",")[0], tp![2], tp![4]];
      let c = cleanName(namePart);
      if (!c.name || !/[A-Za-z]{2,}/.test(c.name)) {
        const pc = cleanName(prev);
        c = { ...pc, status: c.status ?? pc.status };
      }
      if (c.name && /[A-Za-z]{2,}/.test(c.name)) {
        const p: ImportPlayerRaw = { name: c.name, pos: pos.toUpperCase().replace(/^(D\/ST|DST)$/, "DEF"), team: teamAbbr.toUpperCase() };
        const st = c.status ?? statusAfter(rest);
        if (st) p.status = st;
        if (c.slot) p.slot = c.slot;
        add(p);
      } else skipped++;
      prev = "";
      continue;
    }
    if (looksLikeName(cleanName(line).name)) prev = line;
    else skipped++;
  }
  return { teams: teams.filter((t) => t.players.length > 0), skippedLines: skipped };
}
