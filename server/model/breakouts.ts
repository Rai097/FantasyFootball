// Breakout Targets: RB / WR / TE whose ROLE (snaps, expected points) is rising before their
// fantasy points have, and who are cheap now. See docs/DESIGN.md "Breakout Targets".
import type {
  BreakoutAhead,
  BreakoutComponents,
  BreakoutResult,
  BreakoutTarget,
  League,
  Position,
  Scoring,
  TeamAnalysis,
  ValuedPlayer,
  WaiverTarget,
} from "./types.js";
import { score } from "./scoring.js";
import { injuryKind } from "./projection.js";

export const BREAKOUT_POS: Position[] = ["RB", "WR", "TE"];
export const WEIGHTS = { roleTrend: 0.25, oppTrend: 0.25, oppLevel: 0.2, gap: 0.15, situation: 0.15 } as const;
/** "Rising starters": expected pts/g over the last 2 weeks at least this (RB/WR 7, TE 4.5) or latest snaps ≥ 50%. */
export const RISING = { expPts: { RB: 7, WR: 7, TE: 4.5 } as Partial<Record<Position, number>>, snaps: 0.5 };
/** A player ahead who fell under 15% snaps last week after ≥ 50% before most likely left the game hurt (Jefferson wk 3: 100% → 12%). */
export const LEFT_EARLY = { last: 0.15, before: 0.5 };
/** Snaps overrule the depth chart when the player out-snaps someone listed ahead of him by this much. */
export const CHART_OVERRULE = 0.15;
/** Already a weekly starter: at least this snap share AND this actual ppg (league scoring). */
export const ESTABLISHED = { snaps: 0.75, ppg: 14 };
/** Experts already rank him a weekly RB1 / WR1 / TE1 (positional ECR at or better than this). */
export const ECR_STARTER: Partial<Record<Position, number>> = { RB: 12, WR: 12, TE: 6 };
/** Cheap: market value below 15 (when a market source is connected) or our value below 12. */
export const CHEAP = { market: 15, ours: 12 };
/** A starter whose snap share fell this much (0..1 scale) is "slipping". */
export const SLIP = -0.15;
/** Candidate pool: latest snaps ≥ 35% or ≥ 4.5 expected pts/g over the last 2 weeks (or next man up behind a hurt / slipping starter). */
export const RELEVANT = { snaps: 0.35, expPts: 4.5 };

/** Minimal depth-chart shape (server/data/depthCharts.ts `DepthChart` satisfies it). */
export interface DepthLike {
  asOf?: string;
  byPlayer: Map<string, { depth: number }>;
  byTeamPos: Map<string, string[]>;
}

/** Market value (server/data/fantasycalc.ts `getMarketValues()`: #1 player = 100). */
export interface MarketValue {
  value: number;
  trend30?: number;
  tradeFreq?: number;
}

export interface BreakoutInput {
  league: League;
  players: Map<string, ValuedPlayer>;
  teams: TeamAnalysis[];
  myTeamId: string;
  depth?: DepthLike | null;
  market?: Map<string, MarketValue> | null;
  /** Waiver-module rows for free agents (used in the FA "ask"). */
  waivers?: Map<string, Pick<WaiverTarget, "recommendation" | "drop">>;
  pos?: "RB" | "WR" | "TE" | "all";
  /** Per tier. */
  limit?: number;
  /** Only players with market value < 15 (our value < 12 without a market). */
  cheapOnly?: boolean;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Last value minus the mean of the earlier values (0 with fewer than 2). */
export function lastVsEarlier(xs: number[]): number {
  if (xs.length < 2) return 0;
  return xs[xs.length - 1] - mean(xs.slice(0, -1));
}

/** Snap shares in week order. */
export function snapSeries(p: { snapShare: Record<number, number> }): { weeks: number[]; shares: number[] } {
  const weeks = Object.keys(p.snapShare)
    .map(Number)
    .sort((a, b) => a - b);
  return { weeks, shares: weeks.map((w) => p.snapShare[w]) };
}

export interface RoleMetrics {
  weeks: number[];
  snaps: number[];
  expPpg: number[];
  actPpg: number[];
  touches?: number[];
  roleNow: number;
  roleTrend: number;
  oppTrend: number;
  oppLevel: number;
  gap: number;
}

/** Trend / level / gap math for one player under league scoring. */
export function roleMetrics(p: ValuedPlayer, s: Scoring): RoleMetrics {
  const snaps = snapSeries(p);
  const lines = [...p.weeks].sort((a, b) => a.week - b.week);
  const exp = lines.map((w) => score(s, w.expected, p.pos));
  const act = lines.map((w) => score(s, w.actual, p.pos));
  const weeks = [...new Set([...snaps.weeks, ...lines.map((w) => w.week)])].sort((a, b) => a - b);
  const byWeek = new Map(lines.map((w, i) => [w.week, i]));
  const at = <T,>(arr: T[], w: number, d: T) => (byWeek.has(w) ? arr[byWeek.get(w)!] : d);
  const hasOpp = lines.some((w) => w.opp);
  const touchOf = (i: number) => {
    const o = lines[i].opp;
    if (!o) return 0;
    return p.pos === "RB" ? o.carries + o.targets : o.targets;
  };
  return {
    weeks,
    snaps: weeks.map((w) => r2(p.snapShare[w] ?? 0)),
    expPpg: weeks.map((w) => r1(at(exp, w, 0))),
    actPpg: weeks.map((w) => r1(at(act, w, 0))),
    touches: hasOpp ? weeks.map((w) => (byWeek.has(w) ? touchOf(byWeek.get(w)!) : 0)) : undefined,
    roleNow: snaps.shares.length ? snaps.shares[snaps.shares.length - 1] : 0,
    roleTrend: r3(lastVsEarlier(snaps.shares)),
    oppTrend: r2(lastVsEarlier(exp)),
    oppLevel: r2(mean(exp.slice(-2))),
    gap: r2(mean(exp) - mean(act)),
  };
}

/** Robust 0..1 scaling over a pool: clip to the 2nd–98th percentile, then min-max. */
export function normalizer(values: number[]): (x: number) => number {
  const s = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return () => 0;
  const q = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))];
  const lo = q(0.02);
  const hi = q(0.98);
  if (hi - lo < 1e-9) return () => 0;
  return (x) => clamp01((x - lo) / (hi - lo));
}

/** Injury statuses that open a path for the player behind. */
export function isPathStatus(status: string | undefined): boolean {
  return !!status && /^(q|questionable|d|doubtful|o|out|ir|ir-r|pup|pup-r|pup-p|nfi|nfi-r|susp|suspended|injured reserve)$/i.test(status.trim());
}

export interface Situation {
  depth?: number;
  depthLabel?: string;
  /** Depth-chart slot when snaps overruled it ("TE4"). */
  chartSays?: string;
  ahead: BreakoutAhead[];
  tags: string[];
  /** 0 / 0.5 / 1 */
  bonus: number;
  /** The "ahead" player the thesis cites. */
  cite?: BreakoutAhead;
  pathOpen: boolean;
}

/** Latest snap share of a player (0 if none). */
const snapsNow = (p: ValuedPlayer) => {
  const s = snapSeries(p).shares;
  return s.length ? s[s.length - 1] : 0;
};

/**
 * Depth-chart slot, who is ahead (with injury + snap trend), and role tags.
 * `teammates` = every valued player at the same NFL team and position (including `p`).
 */
/** Earlier-weeks mean and latest share; `leftEarly` = latest < 15% after ≥ 50% before. */
function snapShape(t: ValuedPlayer): { now: number; before: number; leftEarly: boolean; role: number; trend: number } {
  const sh = snapSeries(t).shares;
  const now = sh.length ? sh[sh.length - 1] : 0;
  const before = sh.length > 1 ? mean(sh.slice(0, -1)) : now;
  const leftEarly = sh.length > 1 && now < LEFT_EARLY.last && before >= LEFT_EARLY.before;
  // Role for ordering: latest share, except a left-early game keeps his usual share.
  return { now, before, leftEarly, role: leftEarly ? before : now, trend: lastVsEarlier(sh) };
}

export function situationOf(p: ValuedPlayer, teammates: ValuedPlayer[], depth: DepthLike | null | undefined, m: Pick<RoleMetrics, "roleNow" | "roleTrend">): Situation {
  const byId = new Map(teammates.map((t) => [t.id, t]));
  const shape = new Map(teammates.map((t) => [t.id, snapShape(t)]));
  const role = (id: string) => shape.get(id)?.role ?? 0;
  const snapOrder = [...teammates]
    .sort((a, b) => role(b.id) - role(a.id) || (a.ecrPos ?? 999) - (b.ecrPos ?? 999) || a.id.localeCompare(b.id))
    .map((t) => t.id);
  const chart = depth?.byTeamPos.get(`${p.team}|${p.pos}`);
  let order = snapOrder;
  let chartSays: string | undefined;
  if (chart && chart.includes(p.id)) {
    const ci = chart.indexOf(p.id);
    // Trust snaps when he clearly out-snaps someone the chart lists ahead of him.
    const overruled = chart.slice(0, ci).some((id) => byId.has(id) && m.roleNow - role(id) >= CHART_OVERRULE);
    if (overruled) {
      if (snapOrder.indexOf(p.id) !== ci) chartSays = `${p.pos}${ci + 1}`;
    } else order = chart;
  }
  const idx = order.indexOf(p.id);
  const d = idx >= 0 ? idx + 1 : undefined;
  const aheadIds = idx > 0 ? order.slice(Math.max(0, idx - 3), idx) : [];
  const ahead: BreakoutAhead[] = aheadIds.map((id, i) => {
    const a = byId.get(id);
    const sh = shape.get(id);
    return {
      id,
      name: a?.name ?? id,
      depth: Math.max(1, idx - aheadIds.length + i + 1),
      status: a?.injury?.status,
      detail: a?.injury?.detail,
      snapTrend: r2(sh?.trend ?? 0),
      snapsNow: sh ? r2(sh.now) : undefined,
      leftEarly: sh?.leftEarly || undefined,
    };
  });

  const tags: string[] = [];
  let bonus = 0;
  // Only the player(s) directly ahead open a path: the next one for RB / TE, the next two for WR.
  const near = ahead.slice(p.pos === "WR" ? -2 : -1);
  const hurt = near.find((a) => isPathStatus(a.status));
  const leftEarly = near.find((a) => a.leftEarly && a !== hurt);
  const slipping = near.find((a) => a.snapTrend <= SLIP && !a.leftEarly);
  const who = (a: BreakoutAhead) => ((a.depth ?? 99) <= (p.pos === "WR" ? 3 : 1) ? "starter" : "ahead");
  if (hurt) tags.push(`${who(hurt)} hurt`);
  if (slipping && slipping !== hurt) tags.push(`${who(slipping)} slipping`);
  if (leftEarly) tags.push("left early / injury?");
  // Promotion: first now, but a part-timer in every earlier week (< 50% snaps) and rising.
  const earlier = snapSeries(p).shares.slice(0, -1);
  const promoted = d === 1 && earlier.length > 0 && Math.max(...earlier) < 0.5 && m.roleTrend >= 0.1;
  if (promoted) tags.push(`promoted to ${p.pos}1`);
  if (hurt || slipping || promoted) bonus = 1;

  if (p.pos === "RB") {
    const lead = ahead[ahead.length - 1];
    const leadP = lead ? byId.get(lead.id) : undefined;
    if (d === 2 && leadP && (role(leadP.id) >= 0.55 || (leadP.ecrPos ?? 999) <= 24)) tags.push("handcuff");
    if (m.roleNow >= 0.4 && teammates.some((t) => t.id !== p.id && (shape.get(t.id)?.now ?? 0) >= 0.4)) tags.push("committee");
  } else if (p.pos === "WR") {
    if (d === 3 && m.roleTrend >= 0.05) tags.push("WR3 rising");
  } else if (p.pos === "TE") {
    if (d !== undefined && d >= 2 && (m.roleTrend >= 0.05 || m.roleNow >= 0.4)) tags.push("TE1 in waiting");
  }
  if (!bonus && (leftEarly || tags.some((t) => ["handcuff", "committee", "WR3 rising", "TE1 in waiting"].includes(t)))) bonus = 0.5;

  const cite = hurt ?? slipping ?? leftEarly ?? ahead[ahead.length - 1];
  return { depth: d, depthLabel: d ? `${p.pos}${d}` : undefined, chartSays, ahead, tags, bonus, cite, pathOpen: !!(hurt || slipping || promoted) };
}

/** Cheapest bench offer from my team for a target of value v (one player, else two). */
export function suggestAsk(bench: ValuedPlayer[], v: number): string {
  const need = v * 0.9;
  const pool = bench.filter((p) => p.pos !== "K" && p.pos !== "DEF").sort((a, b) => a.value - b.value || a.ppg - b.ppg);
  const one = pool.find((p) => p.value >= need);
  if (one) return `Offer ${one.name} (value ${one.value.toFixed(1)})`;
  let best: [ValuedPlayer, ValuedPlayer] | null = null;
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++) {
      const s = pool[i].value + pool[j].value;
      if (s >= need && (!best || s < best[0].value + best[1].value)) best = [pool[i], pool[j]];
    }
  if (best) return `Offer ${best[0].name} + ${best[1].name} (value ${best[0].value.toFixed(1)} + ${best[1].value.toFixed(1)})`;
  return `No bench offer reaches his value (${v.toFixed(1)}); it would take a starter`;
}

const fmtTrail = (xs: number[], f: (x: number) => string, n = 4) => xs.slice(-n).map(f).join("→");

function aheadText(a: BreakoutAhead): string {
  if (isPathStatus(a.status)) return `${a.name} (${a.status}${a.detail ? `, ${a.detail.toLowerCase()}` : ""})`;
  if (a.leftEarly) return `${a.name} (${Math.round((a.snapsNow ?? 0) * 100)}% snaps last week: left early / injury?)`;
  if (a.snapTrend <= SLIP) return `${a.name} (snaps ${a.snapTrend >= 0 ? "+" : "−"}${Math.abs(Math.round(a.snapTrend * 100))} pts)`;
  return a.name;
}

export function thesisOf(p: ValuedPlayer, m: RoleMetrics, sit: Situation, price: { value: number; market?: number }): string {
  // Price is shown separately (not scored) but kept in the sentence for context.
  const parts: string[] = [];
  if (sit.tags.some((t) => t.startsWith("promoted"))) parts.push(sit.chartSays ? `Now ${p.pos}1 by snaps (depth chart says ${sit.chartSays})` : `Now ${p.pos}1 on the depth chart`);
  else {
    const label = sit.depthLabel && sit.chartSays ? `${sit.depthLabel} by snaps (depth chart says ${sit.chartSays})` : sit.depthLabel;
    if (label && sit.cite) parts.push(`${label} behind ${aheadText(sit.cite)}`);
    else if (label) parts.push(label);
  }
  if (m.snaps.length) parts.push(`snaps ${fmtTrail(m.snaps, pct)}`);
  if (m.touches && m.touches.some((x) => x > 0)) parts.push(`${p.pos === "RB" ? "touch opps" : "targets"} ${fmtTrail(m.touches, (x) => String(x))}`);
  parts.push(`${p.ppgExp26.toFixed(1)} expected vs ${p.ppg26.toFixed(1)} actual ppg`);
  if (price.market !== undefined) parts.push(`market value ${price.market < 0.5 ? "~0" : Math.round(price.market)}`);
  else parts.push(price.value < 0.5 ? "value ~0 (waiver-level)" : `our value ${price.value.toFixed(1)}`);
  return `${parts.join("; ")}.`;
}

export function findBreakouts(input: BreakoutInput): BreakoutResult {
  const { league, players, teams, myTeamId, depth, market, waivers } = input;
  const S = league.settings.scoring;
  const myTeam = league.teams.find((t) => t.id === myTeamId);
  if (!myTeam) throw Object.assign(new Error(`Unknown team ${myTeamId}`), { status: 400 });
  const mine = new Set(myTeam.playerIds);
  const owner = new Map<string, { id: string; name: string }>();
  for (const t of league.teams) for (const id of t.playerIds) owner.set(id, { id: t.id, name: t.name });

  // Teammate groups and production ranks (actual ppg within position, ≥ 1 game).
  const groups = new Map<string, ValuedPlayer[]>();
  const prodRank = new Map<string, number>();
  for (const pos of BREAKOUT_POS) {
    const list = [...players.values()].filter((p) => p.pos === pos && p.games >= 1).sort((a, b) => b.ppg26 - a.ppg26);
    list.forEach((p, i) => prodRank.set(p.id, i + 1));
  }
  for (const p of players.values()) {
    if (!BREAKOUT_POS.includes(p.pos) || p.team === "FA") continue;
    const k = `${p.team}|${p.pos}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
  }

  interface Cand {
    p: ValuedPlayer;
    m: RoleMetrics;
    sit: Situation;
    cheap: boolean;
    market?: number;
  }
  const cands: Cand[] = [];
  let established = 0;
  for (const p of players.values()) {
    if (!BREAKOUT_POS.includes(p.pos) || p.games < 1 || p.team === "FA" || mine.has(p.id)) continue;
    const kind = injuryKind(p.injury);
    if (kind === "long" || kind === "return" || p.remainingGames <= 0) continue;
    const m = roleMetrics(p, S);
    const ecrStar = p.ecrPos !== undefined && p.ecrPos <= (ECR_STARTER[p.pos] ?? 0);
    if ((m.roleNow >= ESTABLISHED.snaps && p.ppg26 >= ESTABLISHED.ppg) || ecrStar) {
      established++;
      continue;
    }
    const sit = situationOf(p, groups.get(`${p.team}|${p.pos}`) ?? [p], depth, m);
    // Relevance: a real role now, real expected points, or the next man up with a door opening.
    if (m.roleNow < RELEVANT.snaps && m.oppLevel < RELEVANT.expPts && !(sit.pathOpen && (sit.depth ?? 99) <= 2)) continue;
    // With a market connected, a player outside its list has ~0 market value.
    const mv = market ? (market.get(p.id)?.value ?? 0) : undefined;
    const cheap = mv !== undefined ? mv < CHEAP.market : p.value < CHEAP.ours;
    cands.push({ p, m, sit, cheap, market: mv });
  }

  // Normalise within position (RB, WR and TE usage live on different scales).
  const byPosNorm = (f: (c: Cand) => number) => {
    const m = new Map<Position, (x: number) => number>();
    for (const pos of BREAKOUT_POS) m.set(pos, normalizer(cands.filter((c) => c.p.pos === pos).map(f)));
    return (c: Cand) => m.get(c.p.pos)!(f(c));
  };
  const nRole = byPosNorm((c) => c.m.roleTrend);
  const nOpp = byPosNorm((c) => c.m.oppTrend);
  const nLvl = byPosNorm((c) => c.m.oppLevel);
  const nGap = byPosNorm((c) => c.m.gap);
  const myBench = teams.find((t) => t.team.id === myTeamId)?.bench.filter((p) => !(myTeam.irPlayerIds ?? []).includes(p.id)) ?? [];

  const out: BreakoutTarget[] = cands.map((c) => {
    const { p, m, sit, cheap, market: mv } = c;
    const nr = nRole(c);
    const no = nOpp(c);
    const nl = nLvl(c);
    const ng = nGap(c);
    const parts = {
      roleTrend: r3(WEIGHTS.roleTrend * nr),
      oppTrend: r3(WEIGHTS.oppTrend * no),
      oppLevel: r3(WEIGHTS.oppLevel * nl),
      gap: r3(WEIGHTS.gap * ng),
      situation: r3(WEIGHTS.situation * sit.bonus),
    };
    const total = parts.roleTrend + parts.oppTrend + parts.oppLevel + parts.gap + parts.situation;
    const tier: BreakoutTarget["tier"] = m.oppLevel >= (RISING.expPts[p.pos] ?? 7) || m.roleNow >= RISING.snaps ? "rising" : "stash";
    const pr = prodRank.get(p.id) ?? 999;
    const ecrEdge = p.ecrPos !== undefined ? Math.round(pr - p.ecrPos) : undefined;
    const young = p.age !== undefined && p.age <= 26;
    const upside = r2(0.7 * clamp01((ecrEdge ?? 0) / 24) + (young ? 0.3 : 0));
    const tags = [...sit.tags];
    if (m.gap >= 2) tags.push("usage > output");
    if (ecrEdge !== undefined && ecrEdge >= 12) tags.push("experts higher");
    if (young) tags.push("young");
    if (cheap) tags.push("cheap");
    const components: BreakoutComponents = {
      roleNow: r2(m.roleNow),
      roleTrend: m.roleTrend,
      oppTrend: m.oppTrend,
      oppLevel: m.oppLevel,
      gap: m.gap,
      situation: sit.bonus,
      cheap,
      value: p.value,
      marketValue: mv,
      prodRank: pr,
      ecrPos: p.ecrPos,
      ecrEdge,
      age: p.age,
      upside,
      nRoleTrend: r2(nr),
      nOppTrend: r2(no),
      nOppLevel: r2(nl),
      nGap: r2(ng),
      parts,
    };
    const own = owner.get(p.id);
    let ask: string;
    if (own) ask = suggestAsk(myBench, p.value);
    else {
      const w = waivers?.get(p.id);
      ask = "Free agent — claim/add";
      if (w?.recommendation === "pass") ask += " (waivers model: pass, his projection is not above your bench yet: a speculative add)";
      else if (w) ask += ` (waivers: ${w.recommendation}${w.drop && (w.recommendation === "claim" || w.recommendation === "optional") ? `, drop ${w.drop.name}` : ""})`;
    }
    return {
      player: p,
      where: own ? { type: "roster", teamId: own.id, teamName: own.name } : { type: "fa" },
      tier,
      score: r1(100 * total),
      components,
      weeks: m.weeks,
      snaps: m.snaps,
      expPpg: m.expPpg,
      actPpg: m.actPpg,
      touches: m.touches,
      depthLabel: sit.depthLabel,
      chartSays: sit.chartSays,
      ahead: sit.ahead,
      tags,
      thesis: thesisOf(p, m, sit, { value: p.value, market: mv }),
      ask,
    };
  });

  const want = input.pos && input.pos !== "all" ? input.pos : null;
  const limit = Math.max(1, input.limit ?? 30);
  const sorted = out
    .filter((t) => (!want || t.player.pos === want) && (!input.cheapOnly || t.components.cheap))
    .sort((a, b) => b.score - a.score || b.components.upside - a.components.upside || b.components.oppLevel - a.components.oppLevel || a.player.id.localeCompare(b.player.id));
  // Rising starters first, then deep stashes; `limit` applies to each tier.
  const targets = [...sorted.filter((t) => t.tier === "rising").slice(0, limit), ...sorted.filter((t) => t.tier === "stash").slice(0, limit)];

  const notes: string[] = [];
  notes.push(
    `Score = 25% snap trend + 25% expected-points trend + 20% expected pts/g last 2 weeks + 15% usage-vs-output gap (each scaled 0–1 within position over ${cands.length} candidates) + 15% situation. Price is not scored. Rising starters: ≥ 7 expected pts/g last 2 weeks (TE 4.5) or ≥ 50% snaps; the rest are deep stashes. Excludes your roster, ${established} established starters (≥ ${pct(ESTABLISHED.snaps)} snaps and ≥ ${ESTABLISHED.ppg} ppg, or ECR RB/WR top 12, TE top 6) and long-term injuries.`,
  );
  notes.push(depth ? `Depth chart: nflverse/ESPN${depth.asOf ? ` as of ${depth.asOf.slice(0, 10)}` : ""}.` : "Depth chart unavailable: “ahead of him” uses snap-share order.");
  notes.push(market ? "Price = FantasyCalc market value (#1 = 100) and our value; cheap = market < 15." : `No market values connected: cheap = our value < ${CHEAP.ours}.`);
  return { targets, notes };
}
