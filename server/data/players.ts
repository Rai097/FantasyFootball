import { fetchCached } from "./cache.js";
import { sources } from "./sources.js";
import { parseCsv, num, opt } from "./csv.js";
import { normTeam, normName, normPos, NFL_TEAM_NAMES } from "./names.js";
import { getNflState } from "./nfl.js";
import type { Player, Position, StatLine, WeekLine } from "../model/types.js";

export interface PlayerDb {
  season: number;
  builtAt: string;
  players: Map<string, Player>;
  byYahoo: Map<string, string>;
  bySleeper: Map<string, string>;
  byEspn: Map<string, string>;
  byFp: Map<string, string>;
  byName: Map<string, string[]>; // normName+pos -> ids
  find(opts: { yahoo?: string; sleeper?: string; espn?: string; name?: string; pos?: string; team?: string }): Player | undefined;
  search(q: string, limit?: number): Player[];
}

const VALID: Position[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

function lineFrom(r: Record<string, string>, suffix: "" | "_exp"): StatLine {
  return {
    passYd: num(r[`pass_yards_gained${suffix}`]),
    passTd: num(r[`pass_touchdown${suffix}`]),
    passInt: num(r[`pass_interception${suffix}`]),
    rushYd: num(r[`rush_yards_gained${suffix}`]),
    rushTd: num(r[`rush_touchdown${suffix}`]),
    rec: num(r[`receptions${suffix}`]),
    recYd: num(r[`rec_yards_gained${suffix}`]),
    recTd: num(r[`rec_touchdown${suffix}`]),
    twoPt: num(r[`pass_two_point_conv${suffix}`]) + num(r[`rush_two_point_conv${suffix}`]) + num(r[`rec_two_point_conv${suffix}`]),
    // fumbles have no expected counterpart in the dataset
    fumLost: num(r["rec_fumble_lost"]) + num(r["rush_fumble_lost"]),
  };
}

export function addLines(a: StatLine, b: StatLine): StatLine {
  const o = { ...a };
  for (const k of Object.keys(o) as (keyof StatLine)[]) o[k] = a[k] + b[k];
  return o;
}
export const emptyLine = (): StatLine => ({ passYd: 0, passTd: 0, passInt: 0, rushYd: 0, rushTd: 0, rec: 0, recYd: 0, recTd: 0, twoPt: 0, fumLost: 0 });

let dbPromise: Promise<PlayerDb> | null = null;
let dbBuiltAt = 0;

export function getPlayerDb(): Promise<PlayerDb> {
  const STALE_MS = 6 * 36e5;
  if (!dbPromise || Date.now() - dbBuiltAt > STALE_MS) {
    dbBuiltAt = Date.now();
    dbPromise = buildPlayerDb().catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

async function buildPlayerDb(): Promise<PlayerDb> {
  const t0 = Date.now();
  const state = await getNflState();
  const season = state.season;
  const [idsCsv, rosterCsv, ecrCsv, weeklyCsv, epCsv, epPriorCsv, injCsv, snapCsv, dynCsv] = await Promise.all([
    fetchCached(sources.playerIds, 24),
    fetchCached(sources.roster(season), 12),
    fetchCached(sources.ecr, 6),
    fetchCached(sources.ecrWeekly, 3),
    fetchCached(sources.epWeekly(season), 3).catch(() => ""),
    fetchCached(sources.epWeekly(season - 1), 24 * 7).catch(() => ""),
    fetchCached(sources.injuries(season), 3).catch(() => ""),
    fetchCached(sources.snaps(season), 6).catch(() => ""),
    fetchCached(sources.dynastyValues, 24).catch(() => ""),
  ]);

  const players = new Map<string, Player>();
  const byYahoo = new Map<string, string>();
  const bySleeper = new Map<string, string>();
  const byEspn = new Map<string, string>();
  const byFp = new Map<string, string>();
  const byPfr = new Map<string, string>();
  const byName = new Map<string, string[]>();

  const nameKey = (name: string, pos: string) => `${normName(name)}|${pos}`;
  const index = (p: Player) => {
    players.set(p.id, p);
    if (p.ids.yahoo) byYahoo.set(p.ids.yahoo, p.id);
    if (p.ids.sleeper) bySleeper.set(p.ids.sleeper, p.id);
    if (p.ids.espn) byEspn.set(p.ids.espn, p.id);
    if (p.ids.fantasypros) byFp.set(p.ids.fantasypros, p.id);
    const k = nameKey(p.name, p.pos);
    const arr = byName.get(k) ?? [];
    if (!arr.includes(p.id)) arr.push(p.id);
    byName.set(k, arr);
  };

  // 1. Current NFL rosters give us the base population.
  for (const r of parseCsv(rosterCsv)) {
    const pos = normPos(r.position) as Position;
    if (!VALID.includes(pos) || pos === "DEF") continue;
    const gsis = opt(r.gsis_id);
    const id = gsis ?? `roster:${r.esb_id || r.full_name}`;
    if (players.has(id)) continue;
    const birth = opt(r.birth_date);
    const age = birth ? (Date.now() - new Date(birth).getTime()) / (365.25 * 864e5) : undefined;
    index({
      id,
      name: r.full_name,
      pos,
      team: normTeam(r.team),
      age: age ? Math.round(age * 10) / 10 : undefined,
      ids: { gsis, yahoo: opt(r.yahoo_id), espn: opt(r.espn_id), sleeper: opt(r.sleeper_id) },
      bye: state.byes[normTeam(r.team)],
      snapShare: {},
      weeks: [],
      prior: null,
      headshot: opt(r.headshot_url),
    });
  }
  // Team defenses
  for (const [abbr, full] of Object.entries(NFL_TEAM_NAMES)) {
    index({ id: `DEF:${abbr}`, name: full, pos: "DEF", team: abbr, ids: {}, bye: state.byes[abbr], snapShare: {}, weeks: [], prior: null });
  }

  // 2. Cross-platform id map fills in missing ids (and players not on a roster file yet).
  for (const r of parseCsv(idsCsv)) {
    const pos = normPos(r.position) as Position;
    if (!VALID.includes(pos) || pos === "DEF") continue;
    const gsis = opt(r.gsis_id);
    let p = gsis ? players.get(gsis) : undefined;
    if (!p) {
      const cands = byName.get(nameKey(r.name, pos)) ?? [];
      p = cands.length === 1 ? players.get(cands[0]) : cands.map((c) => players.get(c)!).find((c) => c.team === normTeam(r.team));
    }
    if (!p) {
      // Not on an active roster: still index (free agents, retired). Skip very old entries.
      if (Number(r.db_season) < season - 1) continue;
      p = {
        id: gsis ?? `mfl:${r.mfl_id}`,
        name: r.name,
        pos,
        team: normTeam(r.team),
        age: opt(r.age) ? num(r.age) : undefined,
        ids: { gsis },
        bye: state.byes[normTeam(r.team)],
        snapShare: {},
        weeks: [],
        prior: null,
      };
    }
    p.ids.yahoo ??= opt(r.yahoo_id);
    p.ids.sleeper ??= opt(r.sleeper_id);
    p.ids.espn ??= opt(r.espn_id);
    p.ids.fantasypros ??= opt(r.fantasypros_id);
    p.age ??= opt(r.age) ? num(r.age) : undefined;
    if (opt(r.pfr_id)) byPfr.set(r.pfr_id, p.id);
    index(p);
  }

  const findByFpOrName = (fpId: string | undefined, name: string, pos: string, team: string): Player | undefined => {
    if (fpId && byFp.has(fpId)) return players.get(byFp.get(fpId)!);
    if (pos === "DEF") {
      const abbr = normTeam(team);
      return players.get(`DEF:${abbr}`);
    }
    const cands = (byName.get(nameKey(name, pos)) ?? []).map((c) => players.get(c)!);
    if (cands.length === 1) return cands[0];
    return cands.find((c) => c.team === normTeam(team)) ?? cands[0];
  };

  // 3. Rest-of-season expert consensus ranks (FantasyPros via DynastyProcess).
  for (const r of parseCsv(ecrCsv)) {
    if (!r.page_type.startsWith("redraft-")) continue;
    const pos = normPos(r.pos);
    if (!VALID.includes(pos as Position)) continue;
    const p = findByFpOrName(opt(r.id), r.player, pos, r.team);
    if (!p) continue;
    if (!p.ids.fantasypros && opt(r.id)) {
      p.ids.fantasypros = r.id;
      byFp.set(r.id, p.id);
    }
    if (r.page_type === "redraft-overall") p.ecrOverall = num(r.ecr);
    else p.ecrPos = num(r.ecr);
    if (opt(r.bye) && !p.bye) p.bye = num(r.bye);
  }

  // 4. This week's consensus projections.
  for (const r of parseCsv(weeklyCsv)) {
    const pos = normPos(r.pos);
    if (!VALID.includes(pos as Position)) continue;
    if (!/^(ppr-|qb|k|dst)/.test(r.page)) continue;
    const p = findByFpOrName(opt(r.fantasypros_id), r.player_name, pos, r.team);
    if (!p) continue;
    p.weekProj = num(r.r2p_pts);
    p.weekOpponent = opt(r.player_opponent);
  }

  // 5. Weekly actual + expected production (ffopportunity), current and prior season.
  const applyEp = (csv: string, isPrior: boolean) => {
    if (!csv) return;
    const priorAgg = new Map<string, { games: number; line: StatLine }>();
    for (const r of parseCsv(csv)) {
      const p = players.get(r.player_id);
      if (!p) continue;
      const line: WeekLine = { season: num(r.season), week: num(r.week), team: normTeam(r.posteam), actual: lineFrom(r, ""), expected: lineFrom(r, "_exp") };
      if (isPrior) {
        const agg = priorAgg.get(p.id) ?? { games: 0, line: emptyLine() };
        agg.games += 1;
        agg.line = addLines(agg.line, line.actual);
        priorAgg.set(p.id, agg);
      } else p.weeks.push(line);
    }
    for (const [id, agg] of priorAgg) players.get(id)!.prior = agg;
  };
  applyEp(epCsv, false);
  applyEp(epPriorCsv, true);

  // 6. Injury report: latest week we have for each player.
  if (injCsv) {
    for (const r of parseCsv(injCsv)) {
      const p = players.get(r.gsis_id);
      if (!p) continue;
      const week = num(r.week);
      const status = opt(r.report_status) ?? (r.practice_status?.includes("Did Not") ? "DNP" : undefined);
      if (!p.injury || week >= p.injury.week) {
        if (status) p.injury = { status, detail: opt(r.report_primary_injury), week };
        else if (p.injury && week > p.injury.week) p.injury = undefined;
      }
    }
    // Only keep injuries reported for the most recent week or the current week.
    for (const p of players.values()) if (p.injury && p.injury.week < state.currentWeek - 1) p.injury = undefined;
  }

  // 7. Snap shares.
  if (snapCsv) {
    for (const r of parseCsv(snapCsv)) {
      const id = byPfr.get(r.pfr_player_id);
      const p = id ? players.get(id) : undefined;
      if (!p) continue;
      p.snapShare[num(r.week)] = num(r.offense_pct);
    }
  }

  // 8. Dynasty values.
  if (dynCsv) {
    for (const r of parseCsv(dynCsv)) {
      const pos = normPos(r.pos);
      const p = findByFpOrName(opt(r.fp_id), r.player, pos, r.team);
      if (p) p.dynasty = { value1qb: num(r.value_1qb), value2qb: num(r.value_2qb) };
    }
  }

  const db: PlayerDb = {
    season,
    builtAt: new Date().toISOString(),
    players,
    byYahoo,
    bySleeper,
    byEspn,
    byFp,
    byName,
    find(o) {
      const hit = (o.yahoo && byYahoo.get(o.yahoo)) || (o.sleeper && bySleeper.get(o.sleeper)) || (o.espn && byEspn.get(o.espn));
      if (hit) return players.get(hit);
      if (!o.name) return undefined;
      const pos = normPos(o.pos);
      if (pos === "DEF") {
        const abbr = normTeam(o.team);
        return players.get(`DEF:${abbr}`) ?? [...players.values()].find((p) => p.pos === "DEF" && normName(p.name) === normName(o.name!));
      }
      const cands = (pos ? byName.get(nameKey(o.name, pos)) : undefined) ?? [];
      if (cands.length === 0) {
        // try any position
        const n = normName(o.name);
        const any = [...players.values()].filter((p) => normName(p.name) === n);
        return any.find((p) => p.team === normTeam(o.team)) ?? any[0];
      }
      const list = cands.map((c) => players.get(c)!);
      return list.find((p) => p.team === normTeam(o.team)) ?? list[0];
    },
    search(q, limit = 20) {
      const n = normName(q);
      if (!n) return [];
      return [...players.values()]
        .filter((p) => normName(p.name).includes(n))
        .sort((a, b) => (a.ecrOverall ?? 999) - (b.ecrOverall ?? 999))
        .slice(0, limit);
    },
  };
  console.log(`[players] built ${players.size} players for ${season} in ${Date.now() - t0}ms`);
  return db;
}
