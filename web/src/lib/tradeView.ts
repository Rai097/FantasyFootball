// Pure helpers behind the Trade Finder result view (no React): parse the server's lineup-change strings into
// table rows, sort the "label: value" details into check groups, and pick the verdict chip + its one-line reason.
import type { DetailItem, Trade } from "../../../server/model/types";

/** One starting-slot change: "RB1: A 12.3 → B 14.0" becomes slot RB1, out A (12.3), in B (14.0), delta +1.7. */
export interface LineupRow {
  slot: string;
  out?: string;
  outPts?: number;
  inn?: string;
  inPts?: number;
  /** In minus out; undefined when either side is unknown (never 0). */
  delta?: number;
  /** A line that is not a slot change (e.g. "Drop: X (value 3.2)"): shown as-is. */
  note?: string;
}

const PLAYER_PTS = /^(.*\S)\s+(-?\d+(?:\.\d+)?)$/;

function side(s: string): { name?: string; pts?: number } {
  const t = s.trim();
  if (!t || t === "empty") return {};
  const m = PLAYER_PTS.exec(t);
  return m ? { name: m[1], pts: Number(m[2]) } : { name: t };
}

export function parseLineupChange(line: string): LineupRow {
  const colon = line.indexOf(": ");
  const arrow = line.indexOf(" → ");
  if (colon < 0 || arrow < colon || /^drop:/i.test(line)) return { slot: "", note: line };
  const slot = line.slice(0, colon);
  const o = side(line.slice(colon + 2, arrow));
  const i = side(line.slice(arrow + 3));
  // An empty slot scores 0 points; only a side we could not read leaves the delta unknown.
  const outPts = o.name === undefined ? 0 : o.pts;
  const inPts = i.name === undefined ? 0 : i.pts;
  const delta = outPts !== undefined && inPts !== undefined ? inPts - outPts : undefined;
  return { slot, out: o.name, outPts: o.pts, inn: i.name, inPts: i.pts, delta };
}

/** Sum of the known deltas; undefined when no row has one. */
export function lineupTotal(rows: LineupRow[]): number | undefined {
  const known = rows.filter((r) => r.delta !== undefined);
  return known.length ? known.reduce((s, r) => s + (r.delta as number), 0) : undefined;
}

export type CheckGroup = "Your side" | "Their side" | "Market" | "Other";
export const CHECK_GROUPS: CheckGroup[] = ["Your side", "Their side", "Market", "Other"];

const GROUP_RULES: [RegExp, CheckGroup][] = [
  [/^market/i, "Market"],
  [/^(their|they|acceptance|just spiked|perception gap|extra players|fixes their|for them|riser you get)/i, "Their side"],
  [
    /(\bbar$|^true value|^bye|^playoff|^your|^you |^now$|^season$|^depth$|^riser you give|^slot loss|^thin$|^core player|^for you|^injured|^outside the rules|^qb rule|^deadline)/i,
    "Your side",
  ],
];

export function checkGroupOf(label: string): CheckGroup {
  for (const [re, g] of GROUP_RULES) if (re.test(label)) return g;
  return "Other";
}

/** Every detail lands in exactly one group, in the server's order; the verdict item is shown in the verdict bar. */
export function groupChecks(items: DetailItem[]): { group: CheckGroup; items: DetailItem[] }[] {
  const out = CHECK_GROUPS.map((group) => ({ group, items: [] as DetailItem[] }));
  for (const d of items) {
    if (d.label === "Verdict") continue;
    out[CHECK_GROUPS.indexOf(checkGroupOf(d.label))].items.push(d);
  }
  return out.filter((g) => g.items.length > 0);
}

export function verdictClass(v: string): "good" | "bad" | "warn" {
  if (/lean/i.test(v)) return "warn";
  if (/^accept/i.test(v) && !/if they/i.test(v)) return "good";
  if (/decline|reject|won't accept/i.test(v)) return "bad";
  return "warn";
}

/** The deciding check, as one short line: the failing side if any, else the mode bar, else the server summary. */
export function verdictReason(trade: Pick<Trade, "details" | "summary" | "reason">): string {
  const d = trade.details ?? [];
  const pick = (re: RegExp) => d.find((x) => re.test(x.label))?.value;
  return pick(/^for you$/i) ?? pick(/^for them$/i) ?? pick(/^outside the rules$/i) ?? trade.reason ?? pick(/\bbar$/i) ?? trade.summary;
}

/** Check-row icon from the server's tone: pos = pass, neg = fail, warn = look at it, none = information. */
export function toneIcon(tone: DetailItem["tone"]): { icon: string; label: string } {
  if (tone === "pos") return { icon: "✓", label: "passes" };
  if (tone === "neg") return { icon: "✗", label: "fails" };
  if (tone === "warn") return { icon: "!", label: "check this" };
  return { icon: "·", label: "information" };
}

/** The Trade Finder's opening mode follows the app's value mode (playoffs for a team holding a playoff spot). */
export function initialTradeMode(valueMode: "playoffs" | "balanced" | undefined): "playoffs" | "balanced" {
  return valueMode === "playoffs" ? "playoffs" : "balanced";
}

/** One column of the Yahoo week strip. */
export interface WeekCol {
  week: number;
  you: number;
  them: number;
  playoff: boolean;
}

/** The Yahoo week strip's columns, playoff weeks flagged; empty when the payload has no weeks (never invented). */
export function weekStrip(trade: Pick<Trade, "yahooView" | "playoffWeeks">): { cols: WeekCol[]; playoffCount: number } {
  const from = trade.playoffWeeks?.from;
  const cols = (trade.yahooView?.weeks ?? []).map((w) => ({ ...w, playoff: from !== undefined && w.week >= from }));
  return { cols, playoffCount: cols.filter((c) => c.playoff).length };
}

/** "Your gain, weeks 15–17" (the playoff KPI); without the league's playoff weeks: "Your playoff gain". */
export function playoffGainLabel(pw: Trade["playoffWeeks"]): string {
  if (!pw) return "Your playoff gain";
  return pw.from === pw.to ? `Your gain, week ${pw.from}` : `Your gain, weeks ${pw.from}–${pw.to}`;
}
