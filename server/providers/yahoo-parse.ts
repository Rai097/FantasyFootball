// Pure (no I/O) helpers for the Yahoo Fantasy Sports JSON API: flatten() for
// Yahoo's numeric-key / array-of-single-key-object encoding, and parsers that
// turn flattened responses into our League model. Unit-tested against the
// hand-written fixtures in ./fixtures (server/providers/yahoo.test.ts).
import type { LeagueSettings, Player, Position, Scoring, SlotKind, Team } from "../model/types.js";
import type { PlayerDb } from "../data/players.js";
import { normPos, normTeam } from "../data/names.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

// ---------------------------------------------------------------------------
// flatten()
// ---------------------------------------------------------------------------

/**
 * Wrapper keys that mark list items. `{"0": {team: …}, "1": {team: …}, count: 2}`
 * and `[{position: "QB"}]` are lists of these even when they hold one element.
 */
const ITEM_KEYS = new Set([
  "user", "game", "league", "team", "player", "transaction", "matchup", "draft_result",
  "position", "roster_position", "stat", "manager", "team_logo", "bonus", "stat_position_type",
]);

const isNumKey = (k: string) => /^\d+$/.test(k);
const isPlainObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const singleKey = (x: unknown): string | null => {
  if (!isPlainObj(x)) return null;
  const ks = Object.keys(x);
  return ks.length === 1 ? ks[0] : null;
};

/**
 * Normalise Yahoo's JSON into plain objects and arrays:
 *  - `{ "0": {team: A}, "1": {team: B}, count: 2 }` → `[A', B']` (collections)
 *  - `[ [ {team_key}, {name}, [] ], {team_standings} ]` → `{team_key, name, team_standings}` (records;
 *    nested arrays and empty `[]` placeholders are merged / dropped recursively)
 *  - `[ {position: "QB"}, {position: "WR"} ]` → `["QB", "WR"]` (wrapped lists)
 *  - `{ coverage_type, week, "0": {players: …} }` → `{ coverage_type, week, players: … }`
 */
export function flatten(node: unknown): any {
  if (Array.isArray(node)) return flattenArray(node);
  if (isPlainObj(node)) return flattenObject(node);
  return node;
}

function flattenArray(arr: unknown[]): any {
  if (arr.length === 0) return [];
  if (arr.every((x) => x === null || typeof x !== "object")) return arr.slice();
  const keys = arr.map(singleKey);
  const k0 = keys[0];
  if (k0 !== null && keys.every((k) => k === k0) && (arr.length >= 2 || ITEM_KEYS.has(k0))) {
    return arr.map((x) => flatten((x as Obj)[k0]));
  }
  // Several multi-key objects with identical keys: a plain list, not a record.
  if (arr.length >= 2 && arr.every((x) => isPlainObj(x) && Object.keys(x).length > 1)) {
    const sig = (x: Obj) => Object.keys(x).sort().join("|");
    const s0 = sig(arr[0] as Obj);
    if (arr.every((x) => sig(x as Obj) === s0)) return arr.map(flatten);
  }
  const out: Obj = {};
  mergeInto(out, arr);
  return out;
}

function mergeInto(out: Obj, items: unknown[]): void {
  for (const el of items) {
    if (Array.isArray(el)) mergeInto(out, el);
    else if (isPlainObj(el)) {
      for (const [k, v] of Object.entries(el)) if (!(k in out)) out[k] = flatten(v);
    }
  }
}

function flattenObject(obj: Obj): any {
  const keys = Object.keys(obj);
  const numKeys = keys.filter(isNumKey).sort((a, b) => Number(a) - Number(b));
  if (numKeys.length === 0) {
    const out: Obj = {};
    for (const k of keys) out[k] = flatten(obj[k]);
    return out;
  }
  const others = keys.filter((k) => !isNumKey(k) && k !== "count");
  const children = numKeys.map((k) => obj[k]);
  const wraps = children.map(singleKey);
  const w0 = wraps[0];
  const sameWrap = w0 !== null && wraps.every((w) => w === w0);
  if (others.length === 0) {
    if (sameWrap && (children.length >= 2 || ITEM_KEYS.has(w0!))) return children.map((c) => flatten(c[w0!]));
    if (!sameWrap) return children.map(flatten);
  }
  const out: Obj = {};
  for (const k of others) out[k] = flatten(obj[k]);
  mergeInto(out, children);
  return out;
}

// ---------------------------------------------------------------------------
// small accessors
// ---------------------------------------------------------------------------

export function asArray<T = any>(x: unknown): T[] {
  if (x === undefined || x === null || x === "") return [];
  return (Array.isArray(x) ? x : [x]) as T[];
}
const str = (x: unknown): string | undefined => (x === undefined || x === null || x === "" ? undefined : String(x));
const numOr = (x: unknown, d: number): number => {
  const n = Number(x);
  return x === undefined || x === null || x === "" || !Number.isFinite(n) ? d : n;
};
const truthy = (x: unknown) => x === true || x === 1 || x === "1" || x === "true";

/** Flattened `fantasy_content`, or throws. */
export function content(json: unknown): Obj {
  const fc = isPlainObj(json) ? (json as Obj).fantasy_content : undefined;
  if (!fc) throw new Error("response has no fantasy_content");
  const f = flatten(fc);
  if (!isPlainObj(f)) throw new Error("fantasy_content is not an object after flatten");
  return f;
}

function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`missing ${what}`);
  return v;
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/** Yahoo NFL stat_id → our Scoring field. Everything else is ignored. */
export const STAT_MAP: Record<number, keyof Scoring> = {
  4: "passYd",
  5: "passTd",
  6: "passInt",
  9: "rushYd",
  10: "rushTd",
  11: "rec",
  12: "recYd",
  13: "recTd",
  16: "twoPt",
  18: "fumLost",
};

export const emptyScoring = (): Scoring => ({
  passYd: 0, passTd: 0, passInt: 0, rushYd: 0, rushTd: 0, rec: 0, recYd: 0, recTd: 0, twoPt: 0, fumLost: 0, teRec: 0,
});

/** stat_modifiers list → Scoring, plus ids we ignored (returned so the caller can log them once). */
export function mapStatModifiers(stats: Obj[]): { scoring: Scoring; ignored: Record<string, number> } {
  const scoring = emptyScoring();
  const ignored: Record<string, number> = {};
  for (const s of stats) {
    const id = Number(s?.stat_id);
    const value = numOr(s?.value, NaN);
    if (!Number.isFinite(id) || !Number.isFinite(value)) continue;
    const field = STAT_MAP[id];
    if (field) scoring[field] = value;
    else ignored[String(id)] = value;
  }
  return { scoring, ignored };
}

const SLOT_MAP: Record<string, SlotKind> = {
  QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DEF: "DEF",
  "W/R/T": "FLEX", "W/R": "WRRB", "W/T": "RFLEX", "Q/W/R/T": "SFLEX",
  BN: "BN", IR: "IR", IL: "IR",
};
export function mapSlot(position: string): SlotKind | undefined {
  return SLOT_MAP[position.toUpperCase().trim()];
}

export interface ParsedSettings {
  leagueKey: string;
  settings: LeagueSettings & { usesFaab?: boolean; faabBudget?: number; tradeDeadlineWeek?: number };
  startWeek: number;
  waiverType?: string;
  waiverRule?: string;
  tradeEndDate?: string;
  unknownSlots: string[];
  ignoredStats: Record<string, number>;
}

/** Week number containing `date` given the week-1 start date (Yahoo weeks run Tuesday–Monday). */
export function weekOfDate(date: string, startDate: string, startWeek = 1): number | undefined {
  const d = Date.parse(`${date}T12:00:00Z`);
  const s = Date.parse(`${startDate}T12:00:00Z`);
  if (!Number.isFinite(d) || !Number.isFinite(s)) return undefined;
  const dow = new Date(s).getUTCDay();
  const tuesday = s - ((dow - 2 + 7) % 7) * 864e5;
  return startWeek + Math.floor((d - tuesday) / (7 * 864e5));
}

/** `/league/{key}/settings` → LeagueSettings. */
export function parseSettings(json: unknown): ParsedSettings {
  const league = need(content(json).league, "league") as Obj;
  const s = need(league.settings, "league.settings") as Obj;
  const leagueKey = need(str(league.league_key), "league.league_key");

  const unknownSlots: string[] = [];
  const slots: SlotKind[] = [];
  const rps = asArray<Obj>(need(s.roster_positions, "settings.roster_positions"));
  if (rps.length === 0) throw new Error("settings.roster_positions is empty");
  for (const rp of rps) {
    const pos = str(rp?.position);
    if (!pos) throw new Error(`roster_position without position: ${JSON.stringify(rp)}`);
    const slot = mapSlot(pos);
    const count = numOr(rp.count, 1);
    if (!slot) {
      unknownSlots.push(pos);
      continue;
    }
    for (let i = 0; i < count; i++) slots.push(slot);
  }

  const mods = asArray<Obj>(need(s.stat_modifiers, "settings.stat_modifiers")?.stats);
  if (mods.length === 0) throw new Error("settings.stat_modifiers.stats is empty");
  const { scoring, ignored } = mapStatModifiers(mods);

  const startWeek = numOr(league.start_week, 1);
  const finalWeek = numOr(league.end_week, 17);
  const usesPlayoff = s.uses_playoff === undefined ? true : truthy(s.uses_playoff);
  const playoffStart = numOr(s.playoff_start_week, NaN);
  const regularSeasonEnd = usesPlayoff && Number.isFinite(playoffStart) ? playoffStart - 1 : finalWeek;
  const currentWeek = Math.min(Math.max(numOr(league.current_week, startWeek), startWeek), finalWeek);
  const isDynasty = truthy(s.is_keeper) || truthy(s.uses_keeper) || numOr(s.max_keepers, 0) > 0 || truthy(league.is_keeper);

  const tradeEndDate = str(s.trade_end_date);
  const startDate = str(league.start_date);
  const tradeDeadlineWeek = tradeEndDate && startDate && /^\d{4}-\d{2}-\d{2}$/.test(tradeEndDate) ? weekOfDate(tradeEndDate, startDate, startWeek) : undefined;
  const usesFaab = s.uses_faab === undefined ? undefined : truthy(s.uses_faab);
  const faabRaw = s.faab_budget ?? s.faab_amount;
  const faabBudget = usesFaab ? numOr(faabRaw, 100) : undefined;

  return {
    leagueKey,
    settings: {
      name: str(league.name) ?? leagueKey,
      season: numOr(league.season, new Date().getFullYear()),
      currentWeek,
      regularSeasonEnd,
      finalWeek,
      numTeams: numOr(league.num_teams, numOr(s.max_teams, 12)),
      slots,
      scoring,
      isDynasty,
      ...(usesFaab !== undefined ? { usesFaab } : {}),
      ...(faabBudget !== undefined ? { faabBudget } : {}),
      ...(tradeDeadlineWeek !== undefined ? { tradeDeadlineWeek } : {}),
    },
    startWeek,
    waiverType: str(s.waiver_type),
    waiverRule: str(s.waiver_rule),
    tradeEndDate,
    unknownSlots: [...new Set(unknownSlots)],
    ignoredStats: ignored,
  };
}

// ---------------------------------------------------------------------------
// teams / standings
// ---------------------------------------------------------------------------

export interface YahooPlayerEntry {
  yahooId: string;
  name: string;
  pos: string; // normalised (QB/RB/WR/TE/K/DEF or Yahoo's own for IDP)
  team: string; // normalised NFL abbreviation
  status?: string; // raw Yahoo status (Q, D, O, IR, PUP-R, NA, SUSP …)
  injuryNote?: string;
  selectedPosition?: string;
  percentOwned?: number;
  ownershipType?: string; // freeagents | waivers | team
  waiverDate?: string;
  bye?: number;
  eligible?: Position[]; // fantasy positions only (QB/RB/WR/TE/K/DEF), no flex/BN/IR
}

export interface YahooTeamRaw {
  key: string;
  name: string;
  owner: string;
  waiverPriority?: number;
  faabBalance?: number;
  isMine: boolean;
  record?: Team["record"];
  players: YahooPlayerEntry[];
}

/** One flattened Yahoo team record (from standings, users/teams or league/teams). */
export function parseTeamRecord(t: Obj): YahooTeamRaw {
  const key = need(str(t?.team_key), "team.team_key");
  const managers = asArray<Obj>(t.managers);
  const owner = managers.map((m) => str(m?.nickname)).filter(Boolean).join(" & ") || "—";
  const isMine = truthy(t.is_owned_by_current_login) || managers.some((m) => truthy(m?.is_current_login));
  const ts = t.team_standings as Obj | undefined;
  const ot = ts?.outcome_totals as Obj | undefined;
  const record = ot
    ? {
        wins: numOr(ot.wins, 0),
        losses: numOr(ot.losses, 0),
        ties: numOr(ot.ties, 0),
        ...(ts?.points_for !== undefined ? { pointsFor: numOr(ts.points_for, 0) } : {}),
      }
    : undefined;
  const wp = numOr(t.waiver_priority, NaN);
  const faab = numOr(t.faab_balance, NaN);
  return {
    key,
    name: str(t.name) ?? key,
    owner,
    waiverPriority: Number.isFinite(wp) ? wp : undefined,
    faabBalance: Number.isFinite(faab) ? faab : undefined,
    isMine,
    record,
    players: [],
  };
}

/** `/league/{key}/standings` → teams (without players). */
export function parseStandings(json: unknown): YahooTeamRaw[] {
  const league = need(content(json).league, "league") as Obj;
  const standings = need(league.standings, "league.standings") as Obj;
  const teams = asArray<Obj>(need(standings.teams, "league.standings.teams"));
  if (teams.length === 0) throw new Error("standings has no teams");
  return teams.map(parseTeamRecord);
}

// ---------------------------------------------------------------------------
// players
// ---------------------------------------------------------------------------

const FANTASY_POS: Position[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

function firstPosition(x: unknown): string | undefined {
  if (Array.isArray(x)) return firstPosition(x[x.length - 1]);
  if (isPlainObj(x)) return str(x.position);
  return str(x);
}

export function parsePlayerRecord(p: Obj): YahooPlayerEntry {
  const yahooId = str(p?.player_id) ?? str(p?.player_key)?.split(".p.")[1];
  if (!yahooId) throw new Error(`player without player_id: ${JSON.stringify(p).slice(0, 200)}`);
  const name = isPlainObj(p.name) ? str(p.name.full) ?? [p.name.first, p.name.last].filter(Boolean).join(" ") : str(p.name);
  const display = str(p.display_position)?.split(",")[0]?.trim();
  const pos = normPos(display ?? str(p.primary_position));
  const po = p.percent_owned;
  const pctRaw = isPlainObj(po) ? po.value : po;
  const pct = numOr(pctRaw, NaN);
  const own = isPlainObj(p.ownership) ? p.ownership : undefined;
  const byeRaw = isPlainObj(p.bye_weeks) ? p.bye_weeks.week : Array.isArray(p.bye_weeks) ? p.bye_weeks[0] : p.bye_weeks;
  const bye = numOr(byeRaw, NaN);
  const eligible = [
    ...new Set(
      asArray(p.eligible_positions)
        .map((x) => normPos(isPlainObj(x) ? str(x.position) : str(x)))
        .filter((x): x is Position => (FANTASY_POS as string[]).includes(x)),
    ),
  ];
  return {
    yahooId,
    name: name || `Yahoo player ${yahooId}`,
    pos,
    team: normTeam(str(p.editorial_team_abbr)),
    status: str(p.status),
    injuryNote: str(p.injury_note),
    selectedPosition: firstPosition(p.selected_position),
    percentOwned: Number.isFinite(pct) ? pct : undefined,
    ownershipType: str(own?.ownership_type),
    waiverDate: str(own?.waiver_date),
    ...(Number.isFinite(bye) && bye > 0 ? { bye } : {}),
    ...(eligible.length ? { eligible } : {}),
  };
}

/** `/team/{key}/roster/players` → roster entries. */
export function parseRoster(json: unknown): YahooPlayerEntry[] {
  const team = need(content(json).team, "team") as Obj;
  const roster = need(team.roster, "team.roster") as Obj;
  return asArray<Obj>(roster.players).map(parsePlayerRecord);
}

/** `/league/{key}/players;…` → player entries (an empty page is `players: []`). */
export function parseLeaguePlayers(json: unknown): YahooPlayerEntry[] {
  const league = need(content(json).league, "league") as Obj;
  return asArray<Obj>(league.players).map(parsePlayerRecord);
}

// ---------------------------------------------------------------------------
// users / games
// ---------------------------------------------------------------------------

export interface UserLeague {
  key: string;
  name: string;
  season: number;
  numTeams: number;
  currentWeek: number;
  myTeamKey?: string;
}

/**
 * `/users;use_login=1/games;game_keys=nfl/leagues[/teams]` → leagues, and
 * `/users;use_login=1/games;game_keys=nfl/teams` → my teams. Accepts either shape.
 */
export function parseUserGames(json: unknown): { leagues: UserLeague[]; myTeamKeys: string[] } {
  const users = asArray<Obj>(need(content(json).users, "users"));
  const leagues: UserLeague[] = [];
  const myTeamKeys: string[] = [];
  for (const u of users) {
    for (const g of asArray<Obj>(u?.games)) {
      for (const t of asArray<Obj>(g?.teams)) {
        const k = str(t?.team_key);
        if (k) myTeamKeys.push(k);
      }
      for (const l of asArray<Obj>(g?.leagues)) {
        const key = str(l?.league_key);
        if (!key) continue;
        const teams = asArray<Obj>(l.teams).filter((t) => str(t?.team_key)).map(parseTeamRecord);
        const mine = teams.find((t) => t.isMine);
        leagues.push({
          key,
          name: str(l.name) ?? key,
          season: numOr(l.season ?? g.season, 0),
          numTeams: numOr(l.num_teams, teams.length || 0),
          currentWeek: numOr(l.current_week, 1),
          ...(mine ? { myTeamKey: mine.key } : {}),
        });
        if (mine) myTeamKeys.push(mine.key);
      }
    }
  }
  // Teams from a /teams call: attach to leagues by key prefix.
  for (const l of leagues) {
    const k = l.myTeamKey ?? myTeamKeys.find((t) => leagueKeyOfTeam(t) === l.key);
    if (k) l.myTeamKey = k;
  }
  return { leagues, myTeamKeys: [...new Set(myTeamKeys)] };
}

export function leagueKeyOfTeam(teamKey: string): string {
  return teamKey.split(".t.")[0];
}

/** `/game/nfl` → game_key (e.g. "461"). */
export function parseGameKey(json: unknown): string {
  const g = need(content(json).game, "game") as Obj;
  return need(str(g.game_key), "game.game_key");
}

// ---------------------------------------------------------------------------
// resolution against our PlayerDb
// ---------------------------------------------------------------------------

/**
 * Map a Yahoo status to our Player.injury. Undefined when healthy / empty.
 *  - Q / D / O / P → Questionable / Doubtful / Out / Probable (detail = injury note)
 *  - "-R" designations (IR-R, PUP-R, NFI-R: designated to return) → Out, detail = note or "return designation" (short-term)
 *  - IR, IR-LT, PUP(-P), NFI(-A) and "O" parked in an IR slot → Out, detail "IR…" (long-term)
 *  - NA (not on an active NFL roster) → Out, detail "NA…" (long-term, same as IR)
 *  - SUSP → Out, detail "Suspended…"
 */
export function yahooInjury(status: string | undefined, note: string | undefined, week: number, selectedPosition?: string): Player["injury"] | undefined {
  const s = (status ?? "").toUpperCase().trim();
  if (!s) return undefined;
  const withNote = (tag: string) => (note ? `${tag} (${note})` : tag);
  const mk = (st: string, detail?: string): Player["injury"] => (detail ? { status: st, detail, week } : { status: st, week });
  if (s === "Q") return mk("Questionable", note);
  if (s === "D") return mk("Doubtful", note);
  if (s === "P") return mk("Probable", note);
  if (s === "O") return selectedPosition?.toUpperCase() === "IR" || selectedPosition?.toUpperCase() === "IL" ? mk("Out", withNote("IR")) : mk("Out", note);
  if (/^(IR|PUP|NFI)-R$/.test(s)) return mk("Out", note ?? "return designation");
  if (/^(IR|PUP|NFI)\b/.test(s)) return mk("Out", withNote("IR"));
  if (s === "NA") return mk("Out", withNote("NA"));
  if (s === "SUSP") return mk("Out", withNote("Suspended"));
  return mk(s, note);
}

/** Minimal PlayerDb surface we use (lets tests pass a fake). */
export type PlayerFinder = Pick<PlayerDb, "find">;

export function findPlayer(db: PlayerFinder, e: YahooPlayerEntry): Player | undefined {
  if (e.pos === "DEF") {
    // Yahoo's DEF name.full is a city ("Buffalo"); resolve via team abbreviation.
    return db.find({ name: e.name, pos: "DEF", team: e.team });
  }
  return db.find({ yahoo: e.yahooId, name: e.name, pos: e.pos, team: e.team });
}

/**
 * Copy of `p` with Yahoo's injury status, bye week and eligible positions applied
 * (never mutates the shared db entry). Undefined when Yahoo adds nothing new.
 * With no Yahoo status the PlayerDb (nflverse) injury is kept.
 */
export function withYahooStatus(p: Player, e: YahooPlayerEntry, week: number): Player | undefined {
  const inj = yahooInjury(e.status, e.injuryNote, week, e.selectedPosition);
  const byeChanged = e.bye !== undefined && e.bye !== p.bye;
  const eligChanged = e.eligible !== undefined && e.eligible.join(",") !== (p.eligible ?? []).join(",");
  if (!inj && !byeChanged && !eligChanged) return undefined;
  return {
    ...p,
    ...(inj ? { injury: inj } : {}),
    ...(byeChanged ? { bye: e.bye } : {}),
    ...(eligChanged ? { eligible: e.eligible } : {}),
  };
}

export function resolveTeam(db: PlayerFinder, raw: YahooTeamRaw, week: number, opts: { usesFaab?: boolean } = {}): { team: Team; overrides: Record<string, Player> } {
  const playerIds: string[] = [];
  const irPlayerIds: string[] = [];
  const unmatched: string[] = [];
  const overrides: Record<string, Player> = {};
  for (const e of raw.players) {
    const p = findPlayer(db, e);
    if (!p) {
      unmatched.push(`${e.name} (${e.pos}, ${e.team})`);
      continue;
    }
    if (!playerIds.includes(p.id)) playerIds.push(p.id);
    const sel = e.selectedPosition?.toUpperCase();
    if ((sel === "IR" || sel === "IL") && !irPlayerIds.includes(p.id)) irPlayerIds.push(p.id);
    const copy = withYahooStatus(p, e, week);
    if (copy) overrides[p.id] = copy;
  }
  return {
    team: {
      id: raw.key,
      name: raw.name,
      owner: raw.owner,
      playerIds,
      unmatched,
      ...(raw.record ? { record: raw.record } : {}),
      ...(irPlayerIds.length ? { irPlayerIds } : {}),
      ...(opts.usesFaab && raw.faabBalance !== undefined ? { faabRemaining: raw.faabBalance } : {}),
    },
    overrides,
  };
}
