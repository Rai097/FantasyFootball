// Unit tests for the Yahoo provider's pure parsing, against hand-written fixtures
// (server/providers/fixtures/yahoo-*.json approximate Yahoo's documented shapes).
// Run: npx tsx --test server/providers/yahoo.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Player } from "../model/types.js";
import {
  flatten,
  mapSlot,
  mapStatModifiers,
  parseGameKey,
  parseLeaguePlayers,
  parseRoster,
  parseSettings,
  parseStandings,
  parseUserGames,
  resolveTeam,
  weekOfDate,
  yahooInjury,
  STAT_MAP,
  type PlayerFinder,
} from "./yahoo-parse.js";
import { describeYahooBody, normalizeLeagueKey } from "./yahoo.js";
import { normName, normTeam } from "../data/names.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): any => JSON.parse(readFileSync(path.join(dir, name), "utf8"));

// A tiny fake PlayerDb: yahoo id first, then name+pos+team (mirrors the real find()).
function mkPlayer(id: string, name: string, pos: Player["pos"], team: string, yahoo?: string, injury?: Player["injury"]): Player {
  return { id, name, pos, team, ids: { yahoo }, snapShare: {}, weeks: [], prior: null, ...(injury ? { injury } : {}) };
}
function fakeDb(players: Player[]): PlayerFinder & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    find(o) {
      calls.push(o);
      if (o.yahoo) {
        const hit = players.find((p) => p.ids.yahoo === o.yahoo);
        if (hit) return hit;
      }
      if (o.pos === "DEF") return players.find((p) => p.id === `DEF:${normTeam(o.team)}`);
      return players.find((p) => normName(p.name) === normName(o.name ?? "") && p.pos === o.pos && p.team === normTeam(o.team));
    },
  };
}

test("flatten: numeric-key collections become arrays, records merge, wrapped lists unwrap", () => {
  const raw = {
    teams: {
      "0": { team: [[{ team_key: "a" }, { name: "A" }, [], { managers: [{ manager: { nickname: "x" } }] }], { team_standings: { rank: 1 } }] },
      "1": { team: [[{ team_key: "b" }, [], { name: "B" }]] },
      count: 2,
    },
  };
  assert.deepEqual(flatten(raw), {
    teams: [
      { team_key: "a", name: "A", managers: [{ nickname: "x" }], team_standings: { rank: 1 } },
      { team_key: "b", name: "B" },
    ],
  });
  // single-element wrapped list stays a list
  assert.deepEqual(flatten({ eligible_positions: [{ position: "QB" }] }), { eligible_positions: ["QB"] });
  assert.deepEqual(flatten({ eligible_positions: [{ position: "WR" }, { position: "RB" }] }), { eligible_positions: ["WR", "RB"] });
  // mixed record arrays merge
  assert.deepEqual(flatten({ selected_position: [{ coverage_type: "week", week: "4" }, { position: "RB" }] }), {
    selected_position: { coverage_type: "week", week: "4", position: "RB" },
  });
  assert.deepEqual(flatten({ percent_owned: [{ coverage_type: "week", week: "4" }, { value: "45" }, { delta: "3" }] }), {
    percent_owned: { coverage_type: "week", week: "4", value: "45", delta: "3" },
  });
  // collection with extra keys (roster) merges children
  assert.deepEqual(flatten({ roster: { week: "4", "0": { players: { "0": { player: [[{ player_id: "1" }]] }, count: 1 } } } }), {
    roster: { week: "4", players: [{ player_id: "1" }] },
  });
  // single-item collection of a known item key is still a list
  assert.deepEqual(flatten({ users: { "0": { user: [{ guid: "g" }] }, count: 1 } }), { users: [{ guid: "g" }] });
  // empty page, primitives untouched
  assert.deepEqual(flatten({ players: [], n: 3, s: "x", b: false }), { players: [], n: 3, s: "x", b: false });
});

test("flatten: fixtures flatten to the expected structure", () => {
  const league = flatten(fixture("yahoo-settings.json").fantasy_content).league;
  assert.equal(league.league_key, "461.l.1405188");
  assert.equal(league.current_week, 4);
  assert.equal(league.settings.playoff_start_week, "15");
  assert.equal(league.settings.roster_positions.length, 9);
  assert.deepEqual(league.settings.roster_positions[1], { position: "WR", position_type: "O", count: 2, is_starting_position: 1 });
  assert.deepEqual(league.settings.stat_modifiers.stats[0], { stat_id: 4, value: "0.04", bonuses: [{ target: "300", points: "3" }] });
  assert.deepEqual(league.settings.stat_categories.stats[0].stat_position_types, [{ position_type: "O" }]);

  const team = flatten(fixture("yahoo-roster.json").fantasy_content).team;
  assert.equal(team.team_key, "461.l.1405188.t.3");
  assert.equal(team.roster.players.length, 7);
  const p0 = team.roster.players[0];
  assert.equal(p0.name.full, "Josh Allen");
  assert.deepEqual(p0.eligible_positions, ["QB"]);
  assert.equal(p0.selected_position.position, "QB");
  assert.equal(p0.bye_weeks.week, "7");
});

test("settings → LeagueSettings: slots, scoring, weeks", () => {
  const ps = parseSettings(fixture("yahoo-settings.json"));
  assert.equal(ps.leagueKey, "461.l.1405188");
  const s = ps.settings;
  assert.deepEqual(s.slots, ["QB", "WR", "WR", "RB", "RB", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR"]);
  assert.deepEqual(s.scoring, {
    passYd: 0.04, passTd: 4, passInt: -1, rushYd: 0.1, rushTd: 6, rec: 0.5, recYd: 0.1, recTd: 6, twoPt: 2, fumLost: -2, teRec: 0,
  });
  assert.deepEqual(ps.ignoredStats, { "15": 6, "57": 6 });
  assert.equal(s.name, "Sunday Funday");
  assert.equal(s.season, 2026);
  assert.equal(s.currentWeek, 4);
  assert.equal(s.regularSeasonEnd, 14);
  assert.equal(s.finalWeek, 17);
  assert.equal(s.numTeams, 12);
  assert.equal(s.isDynasty, false);
  assert.equal(s.usesFaab, false);
  assert.equal(s.faabBudget, undefined);
  assert.equal(s.tradeDeadlineWeek, 12); // Nov 28 2026 falls in week 12 (Thanksgiving week)
  assert.equal(ps.waiverType, "R");
  assert.equal(ps.tradeEndDate, "2026-11-28");
  assert.deepEqual(ps.unknownSlots, []);
});

test("settings: flex variants, unknown IDP slots, keepers, FAAB", () => {
  const json = fixture("yahoo-settings.json");
  const settings = json.fantasy_content.league[1].settings[0];
  settings.roster_positions.push(
    { roster_position: { position: "Q/W/R/T", count: 1 } },
    { roster_position: { position: "W/R", count: "1" } },
    { roster_position: { position: "W/T", count: 1 } },
    { roster_position: { position: "DB", count: 2 } },
    { roster_position: { position: "DB", count: 1 } },
  );
  settings.max_keepers = "2";
  settings.uses_faab = "1";
  settings.waiver_type = "FR";
  const ps = parseSettings(json);
  assert.deepEqual(ps.settings.slots.slice(-3), ["SFLEX", "WRRB", "RFLEX"]);
  assert.deepEqual(ps.unknownSlots, ["DB"]);
  assert.equal(ps.settings.isDynasty, true);
  assert.equal(ps.settings.usesFaab, true);
  assert.equal(ps.settings.faabBudget, 100);
});

test("settings: missing pieces throw", () => {
  const json = fixture("yahoo-settings.json");
  delete json.fantasy_content.league[1].settings[0].roster_positions;
  assert.throws(() => parseSettings(json), /roster_positions/);
  assert.throws(() => parseSettings({ error: "nope" }), /fantasy_content/);
});

test("stat id mapping", () => {
  assert.deepEqual(STAT_MAP, { 4: "passYd", 5: "passTd", 6: "passInt", 9: "rushYd", 10: "rushTd", 11: "rec", 12: "recYd", 13: "recTd", 16: "twoPt", 18: "fumLost" });
  const { scoring, ignored } = mapStatModifiers([
    { stat_id: "11", value: "1" },
    { stat_id: 18, value: "-1" },
    { stat_id: 78, value: "0.1" },
    { stat_id: 4, value: "bogus" },
  ]);
  assert.equal(scoring.rec, 1);
  assert.equal(scoring.fumLost, -1);
  assert.equal(scoring.passYd, 0);
  assert.deepEqual(ignored, { "78": 0.1 });
  assert.equal(mapSlot("w/r/t"), "FLEX");
  assert.equal(mapSlot("IL"), "IR");
  assert.equal(mapSlot("LB"), undefined);
});

test("standings → teams with records, owners, waiver priority, my team", () => {
  const teams = parseStandings(fixture("yahoo-standings.json"));
  assert.equal(teams.length, 3);
  assert.deepEqual(
    teams.map((t) => [t.key, t.name, t.owner, t.waiverPriority, t.isMine]),
    [
      ["461.l.1405188.t.1", "Gridiron Gang", "Alex", 7, false],
      ["461.l.1405188.t.2", "Two Managers FC", "Blair & Casey", 12, false],
      ["461.l.1405188.t.3", "My Squad", "Me", 3, true],
    ],
  );
  assert.deepEqual(teams[0].record, { wins: 3, losses: 0, ties: 0, pointsFor: 362.44 });
  assert.deepEqual(teams[1].record, { wins: 1, losses: 1, ties: 1, pointsFor: 300.1 });
  assert.deepEqual(teams[2].record, { wins: 1, losses: 2, ties: 0, pointsFor: 288.9 });
});

test("roster → entries → player ids (yahoo id first, name+pos+team fallback, unmatched kept)", () => {
  const entries = parseRoster(fixture("yahoo-roster.json"));
  assert.equal(entries.length, 7);
  assert.deepEqual(entries[2], {
    yahooId: "31883", name: "Deebo Samuel", pos: "WR", team: "WAS", status: undefined, injuryNote: undefined,
    selectedPosition: "W/R/T", percentOwned: undefined, ownershipType: undefined, waiverDate: undefined,
    bye: 7, eligible: ["WR", "RB"],
  });
  assert.equal(entries[1].bye, 5);
  assert.deepEqual(entries[3].eligible, ["WR"]); // IR slot eligibility is not a fantasy position
  assert.equal(entries[4].pos, "DEF");
  assert.equal(entries[4].team, "JAX");

  const kirkShared = mkPlayer("00-kirk", "Christian Kirk", "WR", "HOU", undefined, { status: "Questionable", week: 3 });
  const db = fakeDb([
    mkPlayer("00-allen", "Josh Allen", "QB", "BUF", "30977"),
    mkPlayer("00-bijan", "Bijan Robinson", "RB", "ATL", "40889"),
    mkPlayer("00-deebo", "Deebo Samuel", "WR", "WAS"), // no yahoo id → name fallback
    kirkShared,
    mkPlayer("DEF:JAX", "Jacksonville Jaguars", "DEF", "JAX"),
    mkPlayer("00-ghost", "Ghost Player", "RB", "NYJ", "40000"),
  ]);
  const { team, overrides } = resolveTeam(db, { key: "461.l.1405188.t.3", name: "My Squad", owner: "Me", isMine: true, players: entries, record: { wins: 1, losses: 2, ties: 0 } }, 4);
  assert.deepEqual(team.playerIds, ["00-allen", "00-bijan", "00-deebo", "00-kirk", "DEF:JAX", "00-ghost"]);
  assert.deepEqual(team.unmatched, ["Obscure Rookie (TE, LAR)"]);
  assert.deepEqual(team.irPlayerIds, ["00-kirk", "00-ghost"]);
  assert.equal(team.id, "461.l.1405188.t.3");
  assert.deepEqual(team.record, { wins: 1, losses: 2, ties: 0 });
  // DEF resolved by team abbreviation, not the city name
  assert.deepEqual(db.calls[4], { name: "Jacksonville", pos: "DEF", team: "JAX" });
  // Yahoo status applied to copies only
  assert.deepEqual(overrides["00-bijan"].injury, { status: "Questionable", detail: "Hamstring", week: 4 });
  assert.deepEqual(overrides["00-kirk"].injury, { status: "Out", detail: "IR (Groin)", week: 4 });
  assert.deepEqual(overrides["00-ghost"].injury, { status: "Out", detail: "IR (Knee)", week: 4 });
  // bye + eligible positions carried on the copy; no Yahoo status keeps the db injury
  assert.deepEqual([overrides["00-allen"].bye, overrides["00-allen"].eligible, overrides["00-allen"].injury], [7, ["QB"], undefined]);
  assert.deepEqual(overrides["00-deebo"].eligible, ["WR", "RB"]);
  assert.notEqual(overrides["00-kirk"], kirkShared);
  assert.deepEqual(kirkShared.injury, { status: "Questionable", week: 3 }, "shared PlayerDb entry must not be mutated");
});

test("free agents page: ownership, percent owned, empty page", () => {
  const fa = parseLeaguePlayers(fixture("yahoo-free-agents.json"));
  assert.deepEqual(
    fa.map((e) => [e.yahooId, e.pos, e.team, e.ownershipType, e.percentOwned, e.waiverDate, e.status]),
    [
      ["33000", "RB", "JAX", "waivers", 41, "2026-09-30", undefined],
      ["33001", "WR", "LV", "freeagents", 12, undefined, "D"],
      ["33470", "TE", "LAR", "freeagents", 0, undefined, undefined],
    ],
  );
  const empty = { fantasy_content: { league: [{ league_key: "461.l.1" }, { players: [] }] } };
  assert.deepEqual(parseLeaguePlayers(empty), []);
});

test("users/leagues/teams and users/teams → leagues + my team keys", () => {
  const a = parseUserGames(fixture("yahoo-user-leagues.json"));
  assert.deepEqual(a.leagues, [
    { key: "461.l.1405188", name: "Sunday Funday", season: 2026, numTeams: 12, currentWeek: 4, myTeamKey: "461.l.1405188.t.3" },
    { key: "461.l.999999", name: "Work League", season: 2026, numTeams: 10, currentWeek: 4 },
  ]);
  const b = parseUserGames(fixture("yahoo-user-teams.json"));
  assert.deepEqual(b.myTeamKeys, ["461.l.1405188.t.3", "461.l.999999.t.7"]);
  assert.equal(parseGameKey({ fantasy_content: { game: [{ game_key: "461", code: "nfl", season: "2026" }] } }), "461");
});

test("yahoo status → injury mapping", () => {
  assert.deepEqual(yahooInjury("Q", undefined, 4), { status: "Questionable", week: 4 });
  assert.deepEqual(yahooInjury("D", "Ankle", 4), { status: "Doubtful", detail: "Ankle", week: 4 });
  assert.deepEqual(yahooInjury("O", "Knee", 4), { status: "Out", detail: "Knee", week: 4 });
  // designated to return: short-term, never "IR"
  assert.deepEqual(yahooInjury("IR-R", undefined, 4), { status: "Out", detail: "return designation", week: 4 });
  assert.deepEqual(yahooInjury("PUP-R", "Knee", 4), { status: "Out", detail: "Knee (return designation)", week: 4 });
  assert.deepEqual(yahooInjury("NFI-R", undefined, 4, "IR"), { status: "Out", detail: "return designation", week: 4 });
  // long-term
  assert.deepEqual(yahooInjury("IR", "ACL", 4), { status: "Out", detail: "IR (ACL)", week: 4 });
  assert.deepEqual(yahooInjury("IR-LT", undefined, 4), { status: "Out", detail: "IR", week: 4 });
  assert.deepEqual(yahooInjury("PUP-P", undefined, 4), { status: "Out", detail: "IR", week: 4 });
  assert.deepEqual(yahooInjury("NA", undefined, 4), { status: "Out", detail: "NA", week: 4 });
  assert.deepEqual(yahooInjury("SUSP", undefined, 4), { status: "Out", detail: "Suspended", week: 4 });
  assert.deepEqual(yahooInjury("O", undefined, 4, "IR"), { status: "Out", detail: "IR", week: 4 });
  assert.equal(yahooInjury("", undefined, 4), undefined);
  assert.equal(yahooInjury(undefined, "x", 4), undefined);
});

test("misc: team abbreviations, trade deadline week, error bodies", () => {
  assert.equal(normTeam("Jax"), "JAX");
  assert.equal(normTeam("Was"), "WAS");
  assert.equal(normTeam("LAR"), "LAR");
  assert.equal(weekOfDate("2026-09-15", "2026-09-10"), 2); // Tuesday after week 1
  assert.equal(weekOfDate("2026-09-14", "2026-09-10"), 1); // Monday night of week 1
  assert.equal(
    describeYahooBody('<?xml version="1.0"?><yahoo:error xmlns:yahoo="x"><yahoo:description>Please provide valid credentials. OAuth oauth_problem="token_expired"</yahoo:description></yahoo:error>'),
    'Please provide valid credentials. OAuth oauth_problem="token_expired"',
  );
  assert.equal(describeYahooBody('{"error":{"description":"League not found"}}'), "League not found");
  assert.equal(describeYahooBody('{"error":"invalid_grant","error_description":"Invalid authorization code"}'), "Invalid authorization code");
  assert.equal(describeYahooBody("<html><body><h1>Request denied</h1></body></html>"), "Request denied");
});

test("league key normalisation strips a team suffix", async () => {
  assert.equal(await normalizeLeagueKey("461.l.1405188.t.3"), "461.l.1405188");
  assert.equal(await normalizeLeagueKey(" 461.l.1405188 "), "461.l.1405188");
  await assert.rejects(normalizeLeagueKey("not-a-key"), /Not a Yahoo league key/);
});
