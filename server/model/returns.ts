// Return estimator (docs/DESIGN.md "Model v4" section 4 + "Release (c) implemented"). Pure: no I/O.
// For a player who is absent (reserve list, designated to return, ruled out, suspended) it answers "back ~week N?"
// with a confidence and evidence bullets, or "return unconfirmed" (week null) — it never guesses a week.
//
// Data reality (2026 nflverse cache): the injuries file has ONE row per player-week (the week's final practice
// participation + game status), so a practice trend is read week over week, not day by day. Players on IR do not
// appear in the injury report until their practice window opens; roster code R48 = injured, designated to return.
import type { DetailItem } from "./types.js";
import type { StatusWeek } from "./signals/types.js";

/** Evidence bullets ≤ 90 chars (a local builder: details.ts → waivers.ts would make an import cycle with projectionV4). */
function detailBuilder() {
  const items: DetailItem[] = [];
  const add = (label: string, value: string, tone?: DetailItem["tone"]) => {
    const v = value.length <= 90 ? value : `${value.slice(0, 89).replace(/\s+\S*$/, "")}…`;
    items.push(tone ? { label, value: v, tone } : { label, value: v });
  };
  return { items, add };
}

export type ReturnConfidence = "high" | "medium" | "low" | "unknown";

/** Why he is absent (projection v4 availability, refined). */
export type Absence = "reserve" | "dtr" | "out" | "suspended" | "seasonOver";

/** Calibration values (documented in DESIGN). */
export const RETURNS = {
  /** NFL IR / PUP: a player must miss at least this many games. */
  irMinGames: 4,
  /** Designated to return: 21-day practice window = 3 weeks; activation typically after 2 weeks of practice. */
  dtrWindowWeeks: 3,
  dtrTypicalWeeks: 2,
  /** First game back counts × this (snap ramp after a multi-week absence). */
  ramp: 0.85,
  /** Unknown return: value assumed from (current week + this) and weighted × unknownWeight. */
  unknownOffset: 4,
  unknownWeight: 0.5,
} as const;

export interface ReturnInput {
  absence: Absence;
  /** nflverse roster status (ACT / RES / …) and transaction code (R01 / R48 / R04 …). */
  rosterStatus?: string;
  rosterCode?: string;
  /** On IR / PUP per the league source (Yahoo "IR", "PUP-…") even when nflverse has not caught up. */
  onIr?: boolean;
  /** Injury report + practice participation per week (any order). */
  status: StatusWeek[];
  /** The week whose games are next (league settings). */
  currentWeek: number;
  /** Weeks of his team's remaining unplayed games, ascending ("next game" = the first one, never a bye). */
  gameWeeks: number[];
  /** His team's games played since his last game; null = unknown. */
  gamesMissed: number | null;
  /** Week of his last game this season (undefined = none this season). */
  lastGameWeek?: number;
}

export interface ReturnEstimate {
  returnWeek: number | null;
  confidence: ReturnConfidence;
  /** Short evidence bullets (≤ 90 chars each). */
  reasons: DetailItem[];
  /** Practice participation improved this week (about to become a waiver fight). */
  practiceUp: boolean;
  /** Earliest possible week under the IR minimum, when it binds. */
  earliestWeek?: number;
}

/** Practice participation level: 3 full, 2 limited, 1 did not participate, 0 unknown / blank. */
export function practiceLevel(s: string | undefined): number {
  if (!s) return 0;
  if (/^full/i.test(s)) return 3;
  if (/^limited/i.test(s)) return 2;
  if (/^did not/i.test(s)) return 1;
  return 0;
}

const LEVEL_TEXT = ["no practice listed", "did not practice", "limited", "full"];

export function estimateReturn(x: ReturnInput): ReturnEstimate {
  const { items: reasons, add } = detailBuilder();
  const sorted = [...x.status].sort((a, b) => a.week - b.week);
  const thisWeek = sorted.find((s) => s.week === x.currentWeek);
  const prevWeek = sorted.find((s) => s.week === x.currentWeek - 1);
  const lvl = practiceLevel(thisWeek?.practice);
  // A practice row from before his last game belongs to the old injury, not this absence.
  const prevLvl = prevWeek && (x.lastGameWeek === undefined || prevWeek.week > x.lastGameWeek) ? practiceLevel(prevWeek.practice) : 1;
  // Only an upgrade after a real absence: a player hurt in last week's game who practises limited this week is
  // trending down, not about to return.
  const wasOut = x.lastGameWeek === undefined || x.lastGameWeek < x.currentWeek - 1 || (x.gamesMissed ?? 0) >= 1;
  const practiceUp = wasOut && lvl >= 2 && lvl > Math.max(1, prevLvl);
  const unknown = (why: string): ReturnEstimate => {
    add("Return", why, "warn");
    return { returnWeek: null, confidence: "unknown", reasons, practiceUp };
  };

  if (x.absence === "seasonOver") return unknown("out for the season per the report");
  if (x.absence === "suspended") return unknown("suspended: length unknown, return unconfirmed");

  const dtr = x.absence === "dtr" || x.rosterCode === "R48";
  const ir = x.onIr || x.rosterStatus === "RES";
  // IR minimum: games he still has to miss (a floor, never an estimate on its own).
  const irLeft = ir && x.gamesMissed !== null && x.gamesMissed < RETURNS.irMinGames ? RETURNS.irMinGames - x.gamesMissed : 0;
  const earliestWeek = irLeft ? x.gameWeeks[irLeft] : undefined;
  if (irLeft) add("IR minimum", `${RETURNS.irMinGames} games: missed ${x.gamesMissed}, eligible from wk ${earliestWeek ?? "—"}`);
  if (x.gamesMissed !== null && x.gamesMissed > 0 && !irLeft)
    add("Missed", x.lastGameWeek === undefined ? `all ${x.gamesMissed} of his team's games this season` : `${x.gamesMissed} of his team's games since his last game`);
  if (thisWeek && lvl > 0) {
    const trend = prevWeek && prevLvl !== lvl && prevWeek.week > (x.lastGameWeek ?? 0) ? `${LEVEL_TEXT[prevLvl]} → ` : "";
    add("Practice", `wk ${x.currentWeek}: ${trend}${LEVEL_TEXT[lvl]}${thisWeek.report ? `, game status ${thisWeek.report}` : ""}`, lvl >= 2 ? "pos" : undefined);
  }

  // Index into gameWeeks of his first game back, and the confidence.
  let idx: number | null = null;
  let conf: ReturnConfidence = "unknown";
  const ruledOut = thisWeek?.report === "Out" || x.absence === "out";
  if (lvl >= 2) {
    // Practising this week (any absence): full and not ruled out ⇒ next game (high); limited ⇒ medium.
    idx = ruledOut ? 1 : 0;
    conf = lvl === 3 && !ruledOut ? "high" : "medium";
    add("Read", `${lvl === 3 ? "full" : "limited"} practice${ruledOut ? " but ruled out" : ""}: back ${idx ? "the game after next" : "next game"}`);
  } else if (dtr) {
    // Designated to return: back within the 21-day window; window start = first practice row of this absence.
    const first = sorted.find((s) => s.week > (x.lastGameWeek ?? 0) && practiceLevel(s.practice) >= 2);
    const start = Math.min(first?.week ?? x.currentWeek, x.currentWeek);
    const end = start + RETURNS.dtrWindowWeeks;
    const target = Math.max(x.currentWeek, start + RETURNS.dtrTypicalWeeks);
    let i = x.gameWeeks.findIndex((w) => w >= target);
    if (i < 0 || x.gameWeeks[i] > end) i = Math.max(0, x.gameWeeks.filter((w) => w <= end).length - 1);
    idx = x.gameWeeks.length ? i : null;
    conf = lvl === 1 ? "low" : "medium";
    add("Designated to return", `21-day practice window wk ${start}–${end}`);
  } else if (x.absence === "out") {
    // Ruled out of his next game only (not on a reserve list): back the game after.
    idx = 1;
    conf = x.gamesMissed !== null && x.gamesMissed >= 2 ? "low" : "medium";
    add("Read", "ruled out of his next game, not on IR");
  } else {
    return { ...unknown("on a reserve list, not practising: return unconfirmed"), ...(earliestWeek !== undefined ? { earliestWeek } : {}) };
  }

  if (idx !== null && idx < irLeft) {
    idx = irLeft;
    if (conf === "high") conf = "medium";
  }
  const returnWeek = idx !== null ? x.gameWeeks[idx] : undefined;
  if (returnWeek === undefined) return unknown("no games left after the earliest return");
  return { returnWeek, confidence: conf, reasons, practiceUp, ...(earliestWeek !== undefined ? { earliestWeek } : {}) };
}

/** "back ~wk 10 (high)" / "return unconfirmed" — the one wording every view uses. */
export function returnText(week: number | null, confidence: ReturnConfidence): string {
  return week === null ? "return unconfirmed" : `back ~wk ${week} (${confidence})`;
}
