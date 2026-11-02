// Matchup numbers (docs/DESIGN.md "Matchups and results log (2026-10-31)"). Pure: both teams' projections for a week
// (ours = Σ starters, each a LOCKED projlog value once his game started, today's projection before; a starter with no
// projection makes the total incomplete, never a 0), Yahoo's locked total, Yahoo's points, the pre-game win chance and
// the track record (winner calls, MAE and bias over the SAME team-weeks). I/O (league, logs, calendar) lives in api.ts.
// The web app imports MatchupResponse from here (GET /api/league/import/:id/matchup?week=W).
import type { GameState, MatchLog, MatchRow, MatchStatus, MatchWeek } from "./matchLog.js";
import type { ProjEntry } from "./projLog.js";
import type { SlotKind } from "./types.js";

/** Calibration: SD of a weekly margin between two teams (each team's weekly SD ≈ 25 pts → √2 × 25 ≈ 35). Refit from the
 *  log once ≥ 30 final matchups are recorded. */
export const MATCHUP = { marginSd: 35 } as const;

/** Standard normal CDF Φ (Abramowitz–Stegun 7.1.26 erf, |error| < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Pre-game win chance of the side projected `margin` points ahead (0–1, 2 decimals). */
export function winChance(margin: number, sd: number = MATCHUP.marginSd): number {
  return Math.round(normCdf(margin / sd) * 100) / 100;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

// ------------------------------------------------------------------ inputs
/** A player as the model knows him. */
export interface PlayerRef {
  id: string;
  name: string;
  pos: string;
  nflTeam: string;
  /** Yahoo injury tag at the latest import (Q / D / O / IR …). */
  status?: string;
}
/** One slot of a team's lineup at the latest import (Yahoo slots). `player` null = unmatched or empty slot. */
export interface LineupSlot {
  kind: SlotKind;
  player: PlayerRef | null;
  /** Unmatched Yahoo name (shown, never projected). */
  rawName?: string;
  /** Yahoo's weekly projection captured with the import (only when it is for this week). */
  yahoo?: number;
}
export interface MatchupContext {
  week: number;
  /** Yahoo's current matchup week (latest capture), else the calendar's. */
  currentWeek: number;
  now: number;
  log: MatchLog | null;
  /** Projection log entries of `week` (player id → latest pre-kickoff capture). */
  proj: Record<string, ProjEntry> | undefined;
  teams: { id: string; name: string; record?: string }[];
  myTeamId: string;
  /** The latest import's lineups (team id → slots in league slot order) and the week they are for (projWeek). */
  lineups: Map<string, LineupSlot[]>;
  lineupWeek: number | undefined;
  /** A matchup-page row → the model's player (by Yahoo id; a defense by its team). */
  resolveRow: (r: MatchRow) => PlayerRef | undefined;
  /** Today's projection for `week` (projection v4 weekly), undefined when the model has none for that week. */
  today: (id: string) => number | undefined;
  /** The player's NFL team's game in `week`: undefined = no game (bye); kickoff ms when known. */
  gameOf: (nflTeam: string) => { kickoff?: number } | undefined;
  /** The week's first kickoff (ms): the cut-off for a team whose own kickoff is unknown. */
  firstKickoff?: number;
  /** The league's starting slots per team (not BN / IR): a projlog lineup with fewer captured starters is incomplete. */
  starterCount?: number;
}

// ------------------------------------------------------------------ response
export type StatusChip = "Q" | "D" | "O" | "IR";
export interface MatchupCell {
  /** Model player id; null = not matched (a name Yahoo shows that the player database does not know). */
  id: string | null;
  name: string;
  pos: string | null;
  nflTeam: string | null;
  /** Our projection (locked once his game started); null = no projection (never 0). Bye = a real 0. */
  ours: number | null;
  /** Yahoo's projection for him this week; null = not captured. */
  yahoo: number | null;
  /** Yahoo's fantasy points; null = not played yet / not captured. */
  points: number | null;
  status: StatusChip | null;
  /** His game has started: `ours` is the value captured before kickoff. */
  locked: boolean;
  /** His NFL game per Yahoo's matchup page; absent = not read (other pairings, older captures). */
  game?: GameState;
}
export interface MatchupSideView {
  teamId: string;
  name: string;
  record: string | null;
  /** Σ starters' projections; null when incomplete or not recorded. */
  ours: number | null;
  /** Starters without a projection (0 = complete). */
  oursIncomplete: number;
  /** Display only (never the record): Σ the starters that DO have a projection; equals `ours` when complete, null when
   *  no starter has one. Shown as "98.2 + 3 not projected", never as a silent sum. */
  oursPartial: number | null;
  /** Yahoo's pre-game projected total (locked); null = none captured. */
  yahoo: number | null;
  /** Yahoo's "Proj" total from its pages as of the latest capture (Orig Proj: Σ starters' projections, no live points). */
  yahooOrig: number | null;
  /** Yahoo's "Live Proj" (points so far + what is left): the matchup page's header, else the league page's number
   *  while the week is in progress; null = not captured. */
  yahooLive: number | null;
  /** Ours, live: finished games at their points, unplayed at our projection, in progress at the higher of the two;
   *  null when any starter lacks a number or the page has no game states (only my own matchup's page is read). */
  oursLive: number | null;
  /** Yahoo's points (live or final); null = not captured. */
  points: number | null;
  /** Pre-game win chance from our projections (0–1); null when either total is unknown. */
  winPct: number | null;
}
export type LineupSource = "page" | "import" | "log";
export interface MatchupSlotRow {
  slot: string;
  a: MatchupCell | null;
  b: MatchupCell | null;
}
/** One pairing of the week, mine or another (one shape, one builder: `pairingView`). */
export interface MatchupPairing {
  sides: [MatchupSideView, MatchupSideView];
  /** Where the starters come from: Yahoo's matchup page, the latest import's slots, or the projection log's captures;
   *  null = no lineup for either team. */
  lineupSource: LineupSource | null;
  rows: MatchupSlotRow[];
  bench: MatchupSlotRow[];
}
export interface RecordGame {
  /** [left, right] team ids; `mine` = the request team plays. */
  teams: [string, string];
  mine: boolean;
  /** Σ the final starters' LOCKED projlog values (app); null = incomplete or not recorded. */
  ours: [number | null, number | null];
  /** Recorded week: Σ the same starters' LOCKED Yahoo values (projlog), null = incomplete. Week never captured: Yahoo's
   *  own pre-game total (= `yahooPage`), shown but never compared. */
  yahoo: [number | null, number | null];
  /** Yahoo's own pre-game total from its module / matchup page (locked); display only, never in the metrics. */
  yahooPage: [number | null, number | null];
  /** Final starters without a locked value of ours / Yahoo's ("n starters not projected"); 0 = complete. */
  oursMissing: [number, number];
  yahooMissing: [number, number];
  points: [number | null, number | null];
  /** The projected winner won; null = no call (not compared, a tie projection, or a tied final). */
  oursCall: boolean | null;
  yahooCall: boolean | null;
}
export interface RecordWeek {
  week: number;
  /** The projection log holds the week (weeks before the first capture: Yahoo's page totals only). */
  recorded: boolean;
  games: RecordGame[];
}
export interface RecordSummary {
  /** Games where both sources had complete projections for both teams and a final score. */
  games: number;
  oursCalls: number;
  yahooCalls: number;
  /** Team-weeks with ours, Yahoo's and the final points (the same set for both). */
  teamWeeks: number;
  oursMae: number | null;
  yahooMae: number | null;
  /** Mean (actual − projected): positive = the projection ran low. */
  oursBias: number | null;
  yahooBias: number | null;
}
export interface MatchupResponse {
  week: number;
  currentWeek: number;
  /** Selectable weeks: recorded weeks + the current one. */
  weeks: number[];
  status: MatchStatus;
  /** Time of the capture the points come from; null = nothing captured for the week. */
  asOf: string | null;
  /** Team id → name (record games carry ids only). */
  teams: Record<string, string>;
  mine: MatchupPairing | null;
  others: MatchupPairing[];
  record: { weeks: RecordWeek[]; summary: RecordSummary };
}

// ------------------------------------------------------------------ projections
const chip = (s: string | undefined): StatusChip | null => {
  const t = (s ?? "").toUpperCase();
  if (t === "Q" || t === "D" || t === "O") return t;
  if (t.startsWith("IR") || t === "PUP" || t === "NFI" || t === "SUSP") return "IR";
  return null;
};

/** One starter's projection: a bye = a real 0; started → the locked projlog value; before → today's (else the log's). */
export function starterProjection(ctx: Pick<MatchupContext, "now" | "proj" | "today" | "gameOf" | "firstKickoff">, p: PlayerRef): { ours: number | null; locked: boolean } {
  const game = ctx.gameOf(p.nflTeam);
  if (!game) return { ours: 0, locked: false };
  const kick = game.kickoff ?? ctx.firstKickoff;
  const locked = kick !== undefined && ctx.now >= kick;
  const logged = ctx.proj?.[p.id]?.app;
  if (locked) return { ours: logged ?? null, locked };
  const t = ctx.today(p.id);
  return { ours: t ?? logged ?? null, locked };
}

/** Σ starters; incomplete (null) when any starter has no projection. An empty slot is a real 0. `partial` (display
 *  only) = Σ the projected starters; null when none is projected. */
export function teamTotal(cells: (MatchupCell | null)[]): { ours: number | null; partial: number | null; missing: number } {
  let sum = 0;
  let missing = 0;
  let projected = 0;
  for (const c of cells) {
    if (!c) continue;
    if (c.ours === null) missing++;
    else {
      sum += c.ours;
      projected++;
    }
  }
  return { ours: missing ? null : r1(sum), partial: projected || !missing ? r1(sum) : null, missing };
}

/** Ours, live (see `MatchupSideView.oursLive`); null = unknown, never a partial sum. */
export function liveTotal(cells: (MatchupCell | null)[]): number | null {
  if (!cells.some((c) => c?.game)) return null;
  let sum = 0;
  for (const c of cells) {
    if (!c) continue;
    const v = c.game === "final" ? c.points : c.points === null ? c.ours : c.ours === null ? null : Math.max(c.points, c.ours);
    if (v === null) return null;
    sum += v;
  }
  return r1(sum);
}

function cellOf(ctx: MatchupContext, p: PlayerRef | undefined, fallbackName: string | undefined, yahoo: number | null, points: number | null, status?: string, game?: GameState): MatchupCell | null {
  const g = game ? { game } : {};
  if (!p) return fallbackName ? { id: null, name: fallbackName, pos: null, nflTeam: null, ours: null, yahoo, points, status: chip(status), locked: false, ...g } : null;
  const pr = starterProjection(ctx, p);
  return { id: p.id, name: p.name, pos: p.pos, nflTeam: p.nflTeam, ours: pr.ours === null ? null : r1(pr.ours), yahoo, points, status: chip(status ?? p.status), locked: pr.locked, ...g };
}

const isBench = (slot: string) => /^(BN|IR|IL)$/i.test(slot);

interface TeamLineup {
  source: LineupSource;
  starters: { slot: string; cell: MatchupCell | null }[];
  bench: { slot: string; cell: MatchupCell | null }[];
  /** Starting slots the source cannot see (log source only): counted as unprojected for both sources. */
  unseen?: number;
}

/** A team's lineup for the week: Yahoo's matchup page (when read), else the latest import's slots (that week only), else the projection log's starters. */
function lineupOf(ctx: MatchupContext, wk: MatchWeek | undefined, teamId: string): TeamLineup | undefined {
  for (const page of Object.values(wk?.pages ?? {})) {
    const side = page.sides.find((s) => s.teamId === teamId);
    if (!side) continue;
    const out: TeamLineup = { source: "page", starters: [], bench: [] };
    for (const r of side.rows) {
      const cell = cellOf(ctx, r.name || r.yahooId ? ctx.resolveRow(r) : undefined, r.name, r.yahooProj, r.points, r.status, r.game);
      (isBench(r.slot) ? out.bench : out.starters).push({ slot: r.slot, cell });
    }
    return out;
  }
  const lineup = ctx.lineups.get(teamId);
  if (lineup && ctx.lineupWeek === ctx.week && wk?.status !== "final") {
    const out: TeamLineup = { source: "import", starters: [], bench: [] };
    for (const s of lineup) {
      const cell = cellOf(ctx, s.player ?? undefined, s.rawName, s.yahoo ?? null, null);
      (s.kind === "BN" || s.kind === "IR" ? out.bench : out.starters).push({ slot: slotLabel(s.kind), cell });
    }
    return out;
  }
  const logged = Object.values(ctx.proj ?? {}).filter((e) => e.teamId === teamId && e.starter);
  if (!logged.length) return undefined;
  const order = ["QB", "RB", "WR", "TE", "K", "DEF"];
  logged.sort((a, b) => order.indexOf(a.pos) - order.indexOf(b.pos) || a.name.localeCompare(b.name));
  return {
    source: "log",
    starters: logged.map((e) => ({
      slot: e.pos,
      cell: { id: e.id, name: e.name, pos: e.pos, nflTeam: e.team, ours: r1(e.app), yahoo: e.yahoo ?? null, points: null, status: null, locked: true },
    })),
    bench: [],
    // The log only holds starters captured before their kickoff: the league's other starting slots are unseen (a
    // Thursday starter added late, a bye starter, an empty slot). More captured starters than slots = lineup unclear.
    unseen: ctx.starterCount !== undefined ? Math.abs(ctx.starterCount - logged.length) : 0,
  };
}

const SLOT_LABEL: Partial<Record<SlotKind, string>> = { FLEX: "W/R/T", SFLEX: "Q/W/R/T", RFLEX: "W/T", WRRB: "W/R" };
const slotLabel = (k: SlotKind) => SLOT_LABEL[k] ?? k;

function sideView(ctx: MatchupContext, wk: MatchWeek | undefined, teamId: string, lu: TeamLineup | undefined): MatchupSideView {
  const team = ctx.teams.find((t) => t.id === teamId);
  const mod = wk?.pairings.flatMap((p) => p.sides).find((s) => s.teamId === teamId);
  const page = Object.values(wk?.pages ?? {})
    .flatMap((p) => p.sides)
    .find((s) => s.teamId === teamId);
  const tot = lu ? teamTotal(lu.starters.map((s) => s.cell)) : { ours: null, partial: null, missing: 0 };
  const missing = tot.missing + (lu?.unseen ?? 0);
  const partial = !lu || (missing && !lu.starters.some((s) => s.cell && s.cell.ours !== null)) ? null : tot.partial;
  return {
    teamId,
    name: team?.name ?? mod?.name ?? `Team ${teamId}`,
    record: mod?.record ?? team?.record ?? null,
    ours: missing ? null : tot.ours,
    oursIncomplete: missing,
    oursPartial: partial,
    yahoo: wk?.yahooLock[teamId]?.proj ?? null,
    // The league page's per-team number is Yahoo's Live Proj while the week is in progress (2026-11-02: 165.54 =
    // the matchup page's Live Proj) and its Orig Proj before kickoff / once final (week 7 fixture): it fills the
    // field it matches, never the other; an unknown status fills neither.
    yahooOrig: page?.totalProj ?? (wk?.status === "pre" || wk?.status === "final" ? (mod?.yahooProj ?? null) : null),
    yahooLive: page?.liveProj ?? (wk?.status === "live" ? (mod?.yahooProj ?? null) : null),
    oursLive: lu?.source === "page" && !lu.unseen ? liveTotal(lu.starters.map((s) => s.cell)) : null,
    points: mod?.points ?? page?.totalPts ?? null,
    winPct: null,
  };
}

function withWin(a: MatchupSideView, b: MatchupSideView): [MatchupSideView, MatchupSideView] {
  if (a.ours === null || b.ours === null) return [a, b];
  const p = winChance(a.ours - b.ours);
  return [{ ...a, winPct: p }, { ...b, winPct: r2(1 - p) }];
}

/** One pairing (mine or another): both sides' totals and the mirrored starters / bench, side a = `ids[0]`. */
export function pairingView(ctx: MatchupContext, wk: MatchWeek | undefined, ids: [string, string]): MatchupPairing {
  const la = lineupOf(ctx, wk, ids[0]);
  const lb = lineupOf(ctx, wk, ids[1]);
  const sides = withWin(sideView(ctx, wk, ids[0], la), sideView(ctx, wk, ids[1], lb));
  const pair = (xa: TeamLineup["starters"] = [], xb: TeamLineup["starters"] = []): MatchupSlotRow[] =>
    Array.from({ length: Math.max(xa.length, xb.length) }, (_, i) => ({ slot: xa[i]?.slot ?? xb[i]?.slot ?? "", a: xa[i]?.cell ?? null, b: xb[i]?.cell ?? null }));
  return { sides, lineupSource: la?.source ?? lb?.source ?? null, rows: pair(la?.starters, lb?.starters), bench: pair(la?.bench, lb?.bench) };
}

// ------------------------------------------------------------------ record
/** The projected winner won; null = no call (a total missing, a tie projection, or a tied final). */
export const call = (proj: [number | null, number | null], pts: [number | null, number | null]): boolean | null => {
  if (proj[0] === null || proj[1] === null || pts[0] === null || pts[1] === null || proj[0] === proj[1] || pts[0] === pts[1]) return null;
  return proj[0] > proj[1] === pts[0] > pts[1];
};

/** One team-week of the record: Σ over the team's FINAL starters of each starter's LOCKED projlog value, ours and
 *  Yahoo's alike (symmetry). Starters: Yahoo's final matchup page when read, else the projlog's starter flags at each
 *  player's last capture before his kickoff (a starter never captured is unseen: counted missing). A bye = a real 0
 *  for both; an unmatched Yahoo name or a starter without a locked value = missing (never 0). */
export function recordSide(ctx: MatchupContext, wk: MatchWeek, teamId: string): { ours: number | null; oursMissing: number; yahoo: number | null; yahooMissing: number } {
  const lu = lineupOf(ctx, wk, teamId);
  const unseen = lu ? lu.unseen ?? 0 : ctx.starterCount ?? 0;
  let ours = 0;
  let yahoo = 0;
  let oursMissing = unseen;
  let yahooMissing = unseen;
  for (const { cell } of lu?.starters ?? []) {
    if (!cell) continue; // an empty slot: nothing
    if (cell.id === null) {
      oursMissing++;
      yahooMissing++;
      continue;
    }
    if (cell.nflTeam !== null && !ctx.gameOf(cell.nflTeam)) continue; // bye: a real 0 for both
    const e = ctx.proj?.[cell.id];
    if (e?.app === undefined) oursMissing++;
    else ours += e.app;
    if (e?.yahoo === undefined) yahooMissing++;
    else yahoo += e.yahoo;
  }
  // No lineup at all and no starting-slot count: nothing seen → unknown, never a 0.
  if (!lu && ctx.starterCount === undefined) return { ours: null, oursMissing: 0, yahoo: null, yahooMissing: 0 };
  return { ours: oursMissing ? null : r1(ours), oursMissing, yahoo: yahooMissing ? null : r1(yahoo), yahooMissing };
}

/** Track record over the final weeks of the log. */
export function trackRecord(ctxFor: (week: number) => MatchupContext | undefined, log: MatchLog | null, myTeamId: string): { weeks: RecordWeek[]; summary: RecordSummary } {
  const weeks: RecordWeek[] = [];
  let games = 0;
  let oursCalls = 0;
  let yahooCalls = 0;
  const errs: { ours: number; yahoo: number }[] = [];
  const finals = Object.entries(log?.weeks ?? {})
    .filter(([, w]) => w.status === "final")
    .map(([k]) => Number(k))
    .sort((a, b) => b - a);
  for (const week of finals) {
    const wk = log!.weeks[String(week)];
    const ctx = ctxFor(week);
    // Recorded = the projection log holds the week; else (weeks before the first capture) Yahoo's page totals only.
    const recorded = !!ctx && Object.keys(ctx.proj ?? {}).length > 0;
    const out: RecordWeek = { week, recorded, games: [] };
    for (const p of wk.pairings) {
      const ids: [string, string] = [p.sides[0].teamId, p.sides[1].teamId];
      const yahooPage = ids.map((t) => wk.yahooLock[t]?.proj ?? null) as [number | null, number | null];
      const points: [number | null, number | null] = [p.sides[0].points, p.sides[1].points];
      const base = { teams: ids, mine: ids.includes(myTeamId), yahooPage, points };
      if (!recorded) {
        out.games.push({ ...base, ours: [null, null], yahoo: yahooPage, oursMissing: [0, 0], yahooMissing: [0, 0], oursCall: null, yahooCall: call(yahooPage, points) });
        continue;
      }
      const [a, b] = ids.map((t) => recordSide(ctx!, wk, t));
      const ours: [number | null, number | null] = [a.ours, b.ours];
      const yahoo: [number | null, number | null] = [a.yahoo, b.yahoo];
      // Same team-weeks for both sources: a game is compared only when all four totals are complete.
      const compared = [...ours, ...yahoo].every((x) => x !== null);
      const g: RecordGame = {
        ...base,
        ours,
        yahoo,
        oursMissing: [a.oursMissing, b.oursMissing],
        yahooMissing: [a.yahooMissing, b.yahooMissing],
        oursCall: compared ? call(ours, points) : null,
        yahooCall: compared ? call(yahoo, points) : null,
      };
      if (compared && points[0] !== null && points[1] !== null && points[0] !== points[1]) {
        games++;
        if (g.oursCall) oursCalls++;
        if (g.yahooCall) yahooCalls++;
      }
      for (const k of [0, 1] as const) if (ours[k] !== null && yahoo[k] !== null && points[k] !== null) errs.push({ ours: points[k]! - ours[k]!, yahoo: points[k]! - yahoo[k]! });
      out.games.push(g);
    }
    out.games.sort((a, b) => Number(b.mine) - Number(a.mine));
    weeks.push(out);
  }
  const n = errs.length;
  const mean = (f: (e: { ours: number; yahoo: number }) => number) => (n ? r1(errs.reduce((s, e) => s + f(e), 0) / n) : null);
  return {
    weeks,
    summary: {
      games,
      oursCalls,
      yahooCalls,
      teamWeeks: n,
      oursMae: mean((e) => Math.abs(e.ours)),
      yahooMae: mean((e) => Math.abs(e.yahoo)),
      oursBias: mean((e) => e.ours),
      yahooBias: mean((e) => e.yahoo),
    },
  };
}

// ------------------------------------------------------------------ the response
export function buildMatchup(ctx: MatchupContext, ctxFor: (week: number) => MatchupContext | undefined): MatchupResponse {
  const wk = ctx.log?.weeks[String(ctx.week)];
  const teams: Record<string, string> = {};
  for (const t of ctx.teams) teams[t.id] = t.name;
  let mine: MatchupPairing | null = null;
  const others: MatchupPairing[] = [];
  for (const p of wk?.pairings ?? []) {
    const ids: [string, string] = [p.sides[0].teamId, p.sides[1].teamId];
    for (const s of p.sides) teams[s.teamId] ??= s.name ?? `Team ${s.teamId}`;
    // The request team is always side a of its own pairing.
    if (ids[1] === ctx.myTeamId) mine = pairingView(ctx, wk, [ids[1], ids[0]]);
    else if (ids[0] === ctx.myTeamId) mine = pairingView(ctx, wk, ids);
    else others.push(pairingView(ctx, wk, ids));
  }
  const weeks = [...new Set([...Object.keys(ctx.log?.weeks ?? {}).map(Number), ctx.currentWeek])].filter((w) => w >= 1 && w <= 18).sort((a, b) => a - b);
  return {
    week: ctx.week,
    currentWeek: ctx.currentWeek,
    weeks,
    status: wk?.status ?? "unknown",
    asOf: wk?.fetchedAt ?? null,
    teams,
    mine,
    others,
    record: trackRecord(ctxFor, ctx.log, ctx.myTeamId),
  };
}
