// Hand-made fixtures for UI work without the server. Enabled only with `?mock=1`.
// Shapes follow docs/DESIGN.md "HTTP API contract" exactly; the numbers are
// invented (roughly plausible half-PPR values), and the model maths here is a
// simplified stand-in for server/model/* so the screens behave realistically.
import type { League, LineupSlot, Position, SlotKind, TeamAnalysis, Team, Trade, TradeSide, WaiverTarget } from "../../server/model/types";
import type { Analysis, AppState, PlayerLite, ValueRow, VP, WaiversResponse, YahooLeague } from "./api";
import { ApiError } from "./lib/errors";

type Row = [name: string, pos: Position, team: string, ppg: number, bye: number, owner: number, injury?: string];

// owner: team index 0..3, -1 = free agent
const ROWS: Row[] = [
  // Team 1 (me)
  ["Jalen Hurts", "QB", "PHI", 20.2, 9, 0],
  ["Bijan Robinson", "RB", "ATL", 18.9, 5, 0],
  ["Kenneth Walker III", "RB", "SEA", 12.1, 8, 0, "Q"],
  ["Tony Pollard", "RB", "TEN", 9.8, 10, 0],
  ["Rhamondre Stevenson", "RB", "NE", 8.4, 14, 0],
  ["Justin Jefferson", "WR", "MIN", 17.5, 6, 0],
  ["Garrett Wilson", "WR", "NYJ", 13.2, 9, 0],
  ["DK Metcalf", "WR", "PIT", 11.0, 5, 0],
  ["Jakobi Meyers", "WR", "LV", 10.2, 8, 0],
  ["Rashee Rice", "WR", "KC", 12.5, 10, 0, "Out|Knee"],
  ["Evan Engram", "TE", "DEN", 8.1, 12, 0],
  ["Brandon Aubrey", "K", "DAL", 9.0, 10, 0],
  ["Steelers D/ST", "DEF", "PIT", 7.8, 5, 0],
  // Team 2
  ["Josh Allen", "QB", "BUF", 23.1, 7, 1],
  ["Saquon Barkley", "RB", "PHI", 19.5, 9, 1],
  ["James Cook", "RB", "BUF", 14.2, 7, 1],
  ["Chuba Hubbard", "RB", "CAR", 11.3, 14, 1],
  ["Tyjae Spears", "RB", "TEN", 7.1, 10, 1],
  ["Ja'Marr Chase", "WR", "CIN", 20.1, 10, 1],
  ["Nico Collins", "WR", "HOU", 14.8, 6, 1],
  ["Terry McLaurin", "WR", "WAS", 11.8, 12, 1],
  ["Courtland Sutton", "WR", "DEN", 10.9, 12, 1],
  ["Trey McBride", "TE", "ARI", 12.9, 8, 1],
  ["Dalton Kincaid", "TE", "BUF", 8.8, 7, 1],
  ["Jake Bates", "K", "DET", 8.2, 8, 1],
  ["Broncos D/ST", "DEF", "DEN", 8.0, 12, 1],
  // Team 3
  ["Lamar Jackson", "QB", "BAL", 22.4, 7, 2],
  ["Joe Burrow", "QB", "CIN", 19.8, 10, 2],
  ["Jahmyr Gibbs", "RB", "DET", 19.0, 8, 2],
  ["Derrick Henry", "RB", "BAL", 15.6, 7, 2],
  ["Kyren Williams", "RB", "LAR", 13.5, 8, 2],
  ["Breece Hall", "RB", "NYJ", 12.2, 9, 2],
  ["CeeDee Lamb", "WR", "DAL", 17.0, 10, 2],
  ["Puka Nacua", "WR", "LAR", 16.1, 8, 2],
  ["Tee Higgins", "WR", "CIN", 12.4, 10, 2, "Q|Hamstring"],
  ["Jordan Addison", "WR", "MIN", 10.1, 6, 2],
  ["George Kittle", "TE", "SF", 11.6, 14, 2],
  ["Cameron Dicker", "K", "LAC", 8.6, 12, 2],
  ["Ravens D/ST", "DEF", "BAL", 7.5, 7, 2],
  // Team 4
  ["Jayden Daniels", "QB", "WAS", 21.0, 12, 3],
  ["Jonathan Taylor", "RB", "IND", 16.9, 11, 3],
  ["De'Von Achane", "RB", "MIA", 16.0, 12, 3],
  ["Alvin Kamara", "RB", "NO", 12.8, 11, 3],
  ["David Montgomery", "RB", "DET", 11.1, 8, 3],
  ["Amon-Ra St. Brown", "WR", "DET", 16.8, 8, 3],
  ["Malik Nabers", "WR", "NYG", 15.9, 14, 3],
  ["Drake London", "WR", "ATL", 14.1, 5, 3],
  ["Brian Thomas Jr.", "WR", "JAX", 13.0, 8, 3],
  ["Brock Bowers", "TE", "LV", 13.8, 8, 3],
  ["Sam LaPorta", "TE", "DET", 10.4, 8, 3, "D|Back"],
  ["Ka'imi Fairbairn", "K", "HOU", 8.4, 6, 3],
  ["Eagles D/ST", "DEF", "PHI", 8.3, 9, 3],
  // Free agents
  ["Bo Nix", "QB", "DEN", 16.5, 12, -1],
  ["C.J. Stroud", "QB", "HOU", 15.1, 6, -1],
  ["Jaylen Warren", "RB", "PIT", 9.2, 5, -1],
  ["Tank Bigsby", "RB", "JAX", 8.8, 8, -1],
  ["Braelon Allen", "RB", "NYJ", 7.4, 9, -1],
  ["Khalil Shakir", "WR", "BUF", 9.9, 7, -1],
  ["Romeo Doubs", "WR", "GB", 8.7, 5, -1],
  ["Jalen McMillan", "WR", "TB", 8.1, 9, -1, "Q|Neck"],
  ["Jake Ferguson", "TE", "DAL", 8.9, 10, -1],
  ["Hunter Henry", "TE", "NE", 8.3, 14, -1],
  ["Chris Boswell", "K", "PIT", 8.0, 5, -1],
  ["Texans D/ST", "DEF", "HOU", 7.9, 6, -1],
];

const CURRENT_WEEK = 4;
const FINAL_WEEK = 17;
const SLOTS: SlotKind[] = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "IR"];
const TEAM_META = [
  { name: "Gridiron Gurus", owner: "You", w: 2, l: 1 },
  { name: "Bills Mafia Bros", owner: "Dana", w: 3, l: 0 },
  { name: "Lamarvelous", owner: "Priya", w: 1, l: 2 },
  { name: "Dak to the Future", owner: "Marco", w: 0, l: 3 },
];

/** Deterministic noise in [-1, 1) so the fixtures never change between reloads. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const emptyLine = { passYd: 0, passTd: 0, passInt: 0, rushYd: 0, rushTd: 0, rec: 0, recYd: 0, recTd: 0, twoPt: 0, fumLost: 0 };

const PLAYERS: VP[] = ROWS.map(([name, pos, team, ppg, bye, , inj], i) => {
  const [status, detail] = inj ? inj.split("|") : [];
  const ppg26 = r1(ppg * (1 + 0.18 * noise(i + 1)));
  const ppgExp26 = r1(ppg * (1 + 0.12 * noise(i + 101)));
  let remaining = FINAL_WEEK - CURRENT_WEEK + 1 - (bye >= CURRENT_WEEK ? 1 : 0);
  if (status === "Out") remaining -= 1;
  if (status === "D") remaining -= 0.5;
  return {
    id: `m${i + 1}`,
    name,
    pos,
    team,
    ids: {},
    bye,
    injury: status ? { status: status === "Q" ? "Questionable" : status === "D" ? "Doubtful" : status, detail, week: CURRENT_WEEK } : undefined,
    ecrOverall: 0,
    ecrPos: 0,
    snapShare: { 1: 0.7, 2: 0.72, 3: 0.75 },
    weeks: [],
    prior: { games: 17, line: emptyLine },
    ppg,
    ppg26,
    ppgExp26,
    ppg25: r1(ppg * (1 + 0.2 * noise(i + 201))),
    games: status === "Out" ? 2 : 3,
    vorp: 0,
    value: 0,
    posRank: 0,
    remainingGames: remaining,
    trend: r1(3 * noise(i + 301)),
    why: "",
  };
});
const BY_ID = new Map(PLAYERS.map((p) => [p.id, p]));

// Replacement level + value per the spec (4-team league, 1 FLEX).
const REPL_RANK: Record<Position, number> = { QB: 6, RB: 12, WR: 12, TE: 6, K: 6, DEF: 6 };
const replacement: Record<string, number> = {};
for (const pos of Object.keys(REPL_RANK) as Position[]) {
  const sorted = PLAYERS.filter((p) => p.pos === pos).sort((a, b) => b.ppg - a.ppg);
  sorted.forEach((p, i) => (p.posRank = i + 1));
  replacement[pos] = sorted[Math.min(REPL_RANK[pos], sorted.length) - 1].ppg;
}
for (const p of PLAYERS) p.vorp = r1(Math.max(0, p.ppg - replacement[p.pos]));
const maxRaw = Math.max(...PLAYERS.map((p) => p.vorp * p.remainingGames));
PLAYERS.sort((a, b) => b.vorp * b.remainingGames - a.vorp * a.remainingGames).forEach((p, i) => {
  p.value = r1(100 * Math.pow((p.vorp * p.remainingGames) / maxRaw, 1.15));
  p.ecrOverall = i + 1;
  p.ecrPos = p.posRank;
  p.why =
    `Proj ${p.ppg.toFixed(1)} ppg = ECR ${p.pos}${p.posRank} · 2026 exp ${p.ppgExp26.toFixed(1)} / act ${p.ppg26.toFixed(1)} · 2025 ${p.ppg25.toFixed(1)}. ` +
    `${p.pos} replacement ${replacement[p.pos].toFixed(1)} → +${p.vorp.toFixed(1)}/g × ${p.remainingGames} games.`;
});

const TEAMS: Team[] = TEAM_META.map((m, t) => ({
  id: String(t + 1),
  name: m.name,
  owner: m.owner,
  playerIds: ROWS.map((r, i) => (r[5] === t ? `m${i + 1}` : "")).filter(Boolean),
  unmatched: t === 0 ? ["Some Rookie (unmatched)"] : [],
  record: { wins: m.w, losses: m.l, ties: 0, pointsFor: r1(300 + 40 * noise(t + 7)) },
}));
const FREE_AGENTS = ROWS.map((r, i) => (r[5] === -1 ? BY_ID.get(`m${i + 1}`)! : null)).filter((p): p is VP => !!p);

function makeLeague(provider: League["provider"], id: string): League {
  return {
    provider,
    id,
    settings: {
      name: provider === "demo" ? "Demo League (mock)" : "Sunday Funday (mock Yahoo)",
      season: 2026,
      currentWeek: CURRENT_WEEK,
      regularSeasonEnd: 14,
      finalWeek: FINAL_WEEK,
      numTeams: TEAMS.length,
      slots: SLOTS,
      scoring: { passYd: 0.04, passTd: 4, passInt: -1, rushYd: 0.1, rushTd: 6, rec: 0.5, recYd: 0.1, recTd: 6, twoPt: 2, fumLost: -2, teRec: 0 },
      isDynasty: false,
    },
    teams: TEAMS,
    myTeamId: "1",
    fetchedAt: new Date(Date.now() - 12 * 60000).toISOString(),
  };
}

// ---------- lineup / analysis ----------
const ELIG: Record<SlotKind, Position[]> = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"], WRRB: ["RB", "WR"], RFLEX: ["WR", "TE"], SFLEX: ["QB", "RB", "WR", "TE"], BN: [], IR: [],
};
const FILL_ORDER: SlotKind[] = ["QB", "RB", "WR", "TE", "K", "DEF", "WRRB", "RFLEX", "FLEX", "SFLEX"];
const GROUP_OF: Partial<Record<SlotKind, string>> = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", K: "K", DEF: "DEF", FLEX: "FLEX", WRRB: "FLEX", RFLEX: "FLEX", SFLEX: "FLEX" };

function optimal(roster: VP[]): { lineup: LineupSlot[]; bench: VP[]; starterPpg: number } {
  const pool = [...roster].sort((a, b) => (b.remainingGames > 0 ? b.ppg : 0) - (a.remainingGames > 0 ? a.ppg : 0));
  const used = new Set<string>();
  const starters = SLOTS.filter((s) => s !== "BN" && s !== "IR");
  const filled: (VP | null)[] = starters.map(() => null);
  for (const kind of FILL_ORDER) {
    starters.forEach((s, i) => {
      if (s !== kind) return;
      const pick = pool.find((p) => !used.has(p.id) && ELIG[s].includes(p.pos));
      if (pick) {
        used.add(pick.id);
        filled[i] = pick;
      }
    });
  }
  const lineup = starters.map((slot, i) => ({ slot, player: filled[i] }));
  const bench = roster.filter((p) => !used.has(p.id)).sort((a, b) => b.value - a.value);
  const starterPpg = r1(filled.reduce((s, p) => s + (p && p.remainingGames > 0 ? p.ppg : 0), 0));
  return { lineup, bench, starterPpg };
}

function rosterOf(teamId: string): VP[] {
  return TEAMS.find((t) => t.id === teamId)!.playerIds.map((id) => BY_ID.get(id)!);
}

function byeExposure(lineup: LineupSlot[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (let w = CURRENT_WEEK; w <= FINAL_WEEK; w++) out[w] = lineup.filter((s) => s.player?.bye === w).length;
  return out;
}

function analyse(): TeamAnalysis[] {
  const base = TEAMS.map((team) => {
    const o = optimal(rosterOf(team.id));
    const groups: Record<string, number[]> = {};
    for (const s of o.lineup) {
      const g = GROUP_OF[s.slot]!;
      (groups[g] ??= []).push(s.player?.ppg ?? 0);
    }
    const benchValue = r1(o.bench.reduce((s, p) => s + p.value, 0));
    const totalValue = r1(rosterOf(team.id).reduce((s, p) => s + p.value, 0));
    return { team, ...o, benchValue, totalValue, raw: groups };
  });
  const groupNames = Object.keys(base[0].raw);
  const result: TeamAnalysis[] = base.map((b) => ({
    team: b.team,
    lineup: b.lineup,
    bench: b.bench,
    starterPpg: b.starterPpg,
    benchValue: b.benchValue,
    totalValue: b.totalValue,
    groups: {},
    needs: [],
    surplus: [],
    powerRank: 0,
    powerScore: r1(0.7 * b.starterPpg + 0.3 * b.bench.slice(0, 3).reduce((s, p) => s + p.vorp, 0)),
    byeExposure: byeExposure(b.lineup),
    injuryFlags: rosterOf(b.team.id)
      .filter((p) => p.injury)
      .map((p) => `${p.name} (${p.pos}) – ${p.injury!.status}${p.injury!.detail ? `: ${p.injury!.detail}` : ""}`),
  }));
  for (const g of groupNames) {
    const sums = base.map((b) => r1(b.raw[g].reduce((s, x) => s + x, 0)));
    const avg = r1(sums.reduce((s, x) => s + x, 0) / sums.length);
    const order = [...sums].sort((a, b) => b - a);
    result.forEach((r, i) => {
      const rank = order.indexOf(sums[i]) + 1;
      r.groups[g] = { ppg: sums[i], rank, count: base[i].raw[g].length, leagueAvg: avg };
      if (rank === TEAMS.length && g !== "K" && g !== "DEF") r.needs.push(g);
    });
  }
  result.forEach((r) => {
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      const avgStarter = r.groups[pos].leagueAvg / r.groups[pos].count;
      if (r.bench.some((p) => p.pos === pos && p.ppg >= avgStarter)) r.surplus.push(pos);
    }
  });
  const ranked = [...result].sort((a, b) => b.powerScore - a.powerScore || (b.team.record?.wins ?? 0) - (a.team.record?.wins ?? 0));
  ranked.forEach((r, i) => (r.powerRank = i + 1));
  return result;
}

// ---------- trades ----------
function applyTrade(roster: VP[], out: VP[], inn: VP[], drops: VP[] = []): VP[] {
  let next = roster.filter((p) => !out.some((o) => o.id === p.id)).concat(inn);
  let extra = inn.length - out.length;
  while (extra-- > 0) {
    const bench = optimal(next).bench.filter((p) => !inn.some((i) => i.id === p.id));
    const drop = bench[bench.length - 1];
    if (drop) {
      drops.push(drop);
      next = next.filter((p) => p.id !== drop.id);
    }
  }
  return next;
}

function changes(before: LineupSlot[], after: LineupSlot[]): string[] {
  const out: string[] = [];
  const counts: Record<string, number> = {};
  before.forEach((s, i) => {
    counts[s.slot] = (counts[s.slot] ?? 0) + 1;
    const a = after[i].player;
    const b = s.player;
    if (a?.id !== b?.id) {
      const label = SLOTS.filter((x) => x === s.slot).length > 1 ? `${s.slot}${counts[s.slot]}` : s.slot;
      out.push(`${label}: ${b ? `${b.name} ${b.ppg.toFixed(1)}` : "empty"} → ${a ? `${a.name} ${a.ppg.toFixed(1)}` : "empty"}`);
    }
  });
  return out;
}

function buildTrade(myId: string, partnerId: string, give: VP[], get: VP[]): Trade {
  const mine = rosterOf(myId);
  const theirs = rosterOf(partnerId);
  const m0 = optimal(mine);
  const t0 = optimal(theirs);
  const myDrops: VP[] = [];
  const theirDrops: VP[] = [];
  const m1 = optimal(applyTrade(mine, give, get, myDrops));
  const t1 = optimal(applyTrade(theirs, get, give, theirDrops));
  const valueGive = r1(give.reduce((s, p) => s + p.value, 0));
  const valueGet = r1(get.reduce((s, p) => s + p.value, 0));
  const me: TradeSide = { teamId: myId, gives: give, valueGiven: valueGive, lineupDelta: r1(m1.starterPpg - m0.starterPpg), lineupChanges: changes(m0.lineup, m1.lineup), drops: myDrops };
  const them: TradeSide = { teamId: partnerId, gives: get, valueGiven: valueGet, lineupDelta: r1(t1.starterPpg - t0.starterPpg), lineupChanges: changes(t0.lineup, t1.lineup), drops: theirDrops };
  const fairness = valueGet > 0 ? valueGive / valueGet : 0;
  const acceptance = Math.min(1, Math.max(0, 0.5 + 0.35 * Math.tanh(2 * (fairness - 1)) + 0.15 * Math.tanh(them.lineupDelta / 2)));
  const tags: string[] = [];
  if (give.length > get.length) tags.push(`${give.length}-for-${get.length} consolidation`);
  if (get.length > give.length) tags.push(`${give.length}-for-${get.length} depth`);
  const myNeeds = analyse().find((a) => a.team.id === myId)!.needs;
  for (const p of get) if (myNeeds.includes(p.pos)) tags.push(`fills ${p.pos} need`);
  for (const p of get) if (p.ppgExp26 - p.ppg26 >= 3) tags.push(`buy-low: ${p.name.split(" ").slice(-1)[0]} exp > act`);
  for (const p of get) if (p.injury) tags.push("injury-discount");
  const partner = TEAMS.find((t) => t.id === partnerId)!;
  return {
    key: [...give.map((p) => p.id).sort(), "|", ...get.map((p) => p.id).sort()].join(","),
    me,
    them,
    fairness: r1(fairness * 100) / 100,
    acceptance,
    score: me.lineupDelta * acceptance,
    summary: `Send ${give.map((p) => p.name).join(" + ")} to ${partner.name} for ${get.map((p) => p.name).join(" + ")}: your starters ${me.lineupDelta >= 0 ? "+" : ""}${me.lineupDelta.toFixed(1)} ppg, theirs ${them.lineupDelta >= 0 ? "+" : ""}${them.lineupDelta.toFixed(1)}.`,
    tags: [...new Set(tags)],
    why: `Fairness ${fairness.toFixed(2)} = value they get ${valueGive.toFixed(1)} ÷ value they give ${valueGet.toFixed(1)}; acceptance blends fairness with their lineup change (${them.lineupDelta.toFixed(1)} ppg).`,
  };
}

function findTrades(myId: string, partner?: string, wantPos?: string, maxGive = 2, maxGet = 2): Trade[] {
  const tradeable = (p: VP) => p.pos !== "K" && p.pos !== "DEF" && p.remainingGames > 0;
  const packs = (ps: VP[], max: number) => {
    const out: VP[][] = ps.map((p) => [p]);
    if (max >= 2) for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) out.push([ps[i], ps[j]]);
    return out;
  };
  const mine = rosterOf(myId).filter(tradeable).sort((a, b) => b.value - a.value).slice(0, 8);
  const trades: Trade[] = [];
  for (const t of TEAMS) {
    if (t.id === myId || (partner && t.id !== partner)) continue;
    const theirs = rosterOf(t.id).filter(tradeable).sort((a, b) => b.value - a.value).slice(0, 8);
    for (const give of packs(mine, maxGive))
      for (const get of packs(theirs, maxGet)) {
        if (wantPos && !get.some((p) => p.pos === wantPos)) continue;
        const tr = buildTrade(myId, t.id, give, get);
        if (tr.me.lineupDelta >= 0.75 && (tr.them.lineupDelta >= -0.25 || tr.fairness >= 1)) trades.push(tr);
      }
  }
  return trades.sort((a, b) => b.score - a.score).slice(0, 40);
}

// ---------- waivers ----------
function waivers(myId: string): WaiversResponse {
  const mine = rosterOf(myId);
  const base = optimal(mine);
  const droppable = base.bench.filter((p) => p.pos !== "K" && p.pos !== "DEF");
  const drop = droppable[droppable.length - 1] ?? null;
  const needs = analyse().find((a) => a.team.id === myId)!.needs;
  const byPos = (pos: Position) => FREE_AGENTS.filter((p) => p.pos === pos).sort((a, b) => b.value - a.value);
  const rows: WaiverTarget[] = FREE_AGENTS.map((fa, i) => {
    const after = optimal(mine.filter((p) => p.id !== drop?.id).concat(fa));
    const gain = r1(after.starterPpg - base.starterPpg);
    const benchGain = r1(fa.value - (drop?.value ?? 0));
    const posList = byPos(fa.pos);
    const posIdx = posList.findIndex((p) => p.id === fa.id);
    let recommendation: WaiverTarget["recommendation"] = "optional";
    if (gain >= 2 || (fa.value >= 1.5 * (drop?.value ?? 0) && fa.value > 0 && posIdx < 3 && needs.includes(fa.pos))) recommendation = "claim";
    else if (posList[4] && fa.value < posList[4].value) recommendation = "wait";
    else if (gain <= 0 && benchGain <= 0) recommendation = "pass";
    return {
      ...fa,
      gain,
      benchGain,
      drop,
      trend: fa.trend ?? 0,
      recommendation,
      snapTrend: r1(0.1 * noise(i + 501) * 10) / 10,
      rankScore: Math.max(gain * 3, benchGain / 10),
      onWaivers: i % 3 === 0,
      percentOwned: r1(5 + 40 * Math.abs(noise(i + 401))),
      why:
        gain > 0
          ? `Starts over your current ${fa.pos === "TE" ? "TE" : "flex"} for +${gain.toFixed(1)} ppg; drop ${drop?.name ?? "nobody"} (${(drop?.value ?? 0).toFixed(1)}).`
          : `Would sit on your bench; value ${fa.value.toFixed(1)} vs ${drop?.name ?? "drop"} ${(drop?.value ?? 0).toFixed(1)}.`,
    };
  }).sort((a, b) => Math.max(b.gain * 3, b.benchGain / 10) - Math.max(a.gain * 3, a.benchGain / 10));
  return {
    freeAgents: rows,
    myPriority: 3,
    numTeams: TEAMS.length,
    advice: "Rolling list: using your #3 priority drops you to #4. Only claim if the gain is worth more than a future top-2 spot; otherwise wait for free agency Wednesday.",
  };
}

// ---------- router ----------
let yahooConnected = false;

function state(): AppState {
  return {
    season: 2026,
    currentWeek: CURRENT_WEEK,
    lastRegularWeek: 14,
    dbBuiltAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    playerCount: PLAYERS.length,
    yahooConfigured: new URLSearchParams(window.location.search).get("yahoo") !== "0",
    yahooConnected,
  };
}

function route(method: string, url: URL, body: unknown): unknown {
  const p = url.pathname;
  const team = url.searchParams.get("team") || "1";
  if (method === "GET" && p === "/api/state") return state();
  if (method === "GET" && p === "/api/players/search") {
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    return PLAYERS.filter((x) => x.name.toLowerCase().includes(q))
      .slice(0, 20)
      .map((x): PlayerLite => ({ id: x.id, name: x.name, pos: x.pos, team: x.team, ecrOverall: x.ecrOverall }));
  }
  if (method === "GET" && p === "/auth/yahoo/start") return { url: "https://api.login.yahoo.com/oauth2/request_auth?client_id=MOCK&redirect_uri=oob&response_type=code" };
  if (method === "POST" && p === "/auth/yahoo/code") {
    if (!(body as { code?: string })?.code) throw new ApiError("Missing code", 400, "Paste the code Yahoo showed you.");
    yahooConnected = true;
    return { ok: true };
  }
  if (method === "POST" && p === "/auth/yahoo/disconnect") {
    yahooConnected = false;
    return { ok: true };
  }
  if (method === "GET" && p === "/api/yahoo/leagues") {
    if (!yahooConnected) throw new ApiError("Not connected to Yahoo", 401, "Click Connect Yahoo first.");
    return [
      { key: "461.l.1405188", name: "Sunday Funday (mock Yahoo)", season: 2026, numTeams: 4, currentWeek: 4, myTeamKey: "1" },
      { key: "461.l.99999", name: "Office League (mock Yahoo)", season: 2026, numTeams: 4, currentWeek: 4 },
    ] satisfies YahooLeague[];
  }
  const m = p.match(/^\/api\/league\/(demo|yahoo)\/([^/]+)(?:\/(analysis|trades|trade\/evaluate|waivers|values))?$/);
  if (!m) throw new ApiError(`Mock has no route for ${method} ${p}`, 404);
  const [, provider, id, sub] = m;
  if (provider === "yahoo" && !yahooConnected) throw new ApiError("Not connected to Yahoo", 401, "Reconnect on the Connect tab.");
  const league = makeLeague(provider as League["provider"], decodeURIComponent(id));
  if (!sub) return league;
  if (sub === "analysis") {
    const players: Record<string, VP> = {};
    for (const x of PLAYERS) players[x.id] = x;
    return { league, players, teams: analyse(), replacement, myTeamId: team } satisfies Analysis;
  }
  if (sub === "trades") {
    const n = (k: string) => Number(url.searchParams.get(k) ?? 2) || 2;
    return findTrades(team, url.searchParams.get("partner") || undefined, url.searchParams.get("wantPos") || undefined, n("maxGive"), n("maxGet"));
  }
  if (sub === "trade/evaluate") {
    const b = body as { team?: string; partner: string; give: string[]; get: string[] };
    if (!b?.partner || !b.give?.length || !b.get?.length) throw new ApiError("Pick a partner and at least one player each side", 400);
    const tr = buildTrade(b.team || "1", b.partner, b.give.map((x) => BY_ID.get(x)!), b.get.map((x) => BY_ID.get(x)!));
    const verdict = tr.me.lineupDelta >= 0.75 && tr.fairness >= 0.9 ? "Accept" : tr.me.lineupDelta >= 0 && tr.fairness >= 0.8 ? "Fair, lean accept" : "Decline";
    return { ...tr, verdict };
  }
  if (sub === "waivers") return waivers(team);
  if (sub === "values") {
    const owner = new Map<string, string>();
    for (const t of TEAMS) for (const pid of t.playerIds) owner.set(pid, t.id);
    return [...PLAYERS].sort((a, b) => b.value - a.value).map((x): ValueRow => ({ ...x, ownerTeamId: owner.get(x.id) }));
  }
  throw new ApiError("Unknown mock route", 404);
}

export async function mockRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 150));
  // Deep-copy so UI code can never mutate the fixtures.
  return JSON.parse(JSON.stringify(route(method, new URL(path, window.location.origin), body)));
}
