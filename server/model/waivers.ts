// Free-agent ranking + waiver-priority advice. See docs/DESIGN.md "Waivers" (+ amendments).
import type { Position, ValuedPlayer, WaiverTarget } from "./types.js";
import { eligible, optimalLineup, slotLabels } from "./lineup.js";
import { rosterOf } from "./analysis.js";
import type { TradeContext } from "./trades.js";

export interface FreeAgentInput {
  player: ValuedPlayer;
  onWaivers: boolean;
  percentOwned?: number;
}

export interface WaiverResult {
  freeAgents: WaiverTarget[];
  myPriority?: number;
  numTeams: number;
  advice: string;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const fmtSigned = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;

/** Lineup gain needed to spend priority w of N on a rolling list (#1 needs 2.5, #N needs 1.0). */
export function claimThreshold(w: number | undefined, n: number): number {
  if (w === undefined || n <= 1) return 2.0;
  const wc = Math.max(1, Math.min(n, w));
  return 1.0 + (1.5 * (n - wc)) / (n - 1);
}

export function snapTrendOf(p: { snapShare: Record<number, number> }): number {
  const weeks = Object.keys(p.snapShare)
    .map(Number)
    .sort((a, b) => a - b);
  if (weeks.length < 2) return 0;
  const last = p.snapShare[weeks[weeks.length - 1]];
  const earlier = weeks.slice(0, -1).map((w) => p.snapShare[w]);
  return r2(last - earlier.reduce((a, b) => a + b, 0) / earlier.length);
}

export const REC_ORDER: Record<WaiverTarget["recommendation"], number> = { claim: 0, optional: 1, wait: 2, pass: 3 };

/** Drop-order comparator: lowest value, then lowest ppg, then worst ECR. */
const dropOrder = (a: ValuedPlayer, b: ValuedPlayer) =>
  a.value - b.value || a.ppg - b.ppg || (b.ecrOverall ?? 9999) - (a.ecrOverall ?? 9999) || a.id.localeCompare(b.id);

export function rankWaivers(
  ctx: TradeContext,
  myTeamId: string,
  freeAgents: FreeAgentInput[],
  opts: { myPriority?: number; limit?: number } = {},
): WaiverResult {
  const S = ctx.league.settings;
  const n = S.numTeams || ctx.league.teams.length;
  const team = ctx.league.teams.find((t) => t.id === myTeamId);
  if (!team) throw Object.assign(new Error(`Unknown team ${myTeamId}`), { status: 404 });
  const analysis = ctx.teams.find((t) => t.team.id === myTeamId);
  const roster = rosterOf(team, ctx.players);
  const base = optimalLineup(S.slots, roster);
  const irIds = new Set(team.irPlayerIds ?? []);
  const rosterLimit = S.slots.filter((s) => s !== "IR").length;
  const activeCount = roster.filter((p) => !irIds.has(p.id)).length;
  const hasOpenSpot = activeCount < rosterLimit;
  const posCount = (pos: Position) => roster.filter((p) => p.pos === pos).length;

  // Droppable: bench, not IR-slotted, never the only K / only DEF.
  const benchDroppable = base.bench
    .filter((p) => !irIds.has(p.id) && !((p.pos === "K" || p.pos === "DEF") && posCount(p.pos) <= 1))
    .sort(dropOrder);
  const labels = slotLabels(base.lineup);

  const needs = new Set(analysis?.needs ?? []);
  const isNeedPos = (pos: Position) => needs.has(pos) || (needs.has("FLEX") && eligible("FLEX", pos));

  const threshold = S.usesFaab ? 1.5 : claimThreshold(opts.myPriority, n);
  const w = opts.myPriority;

  // Per-position FA ordering by value.
  const faSorted = [...freeAgents].sort((a, b) => b.player.value - a.player.value || b.player.ppg - a.player.ppg);
  const posList: Record<string, ValuedPlayer[]> = {};
  for (const fa of faSorted) (posList[fa.player.pos] ??= []).push(fa.player);

  const evalWith = (fa: ValuedPlayer, drop: ValuedPlayer | null) => {
    const after = roster.filter((p) => p.id !== drop?.id).concat(fa);
    const lu = optimalLineup(S.slots, after);
    const gain = r2(lu.starterPpg - base.starterPpg);
    const benchGain = r1(fa.value - (drop?.value ?? 0));
    const idx = lu.lineup.findIndex((l) => l.player?.id === fa.id);
    return { drop, gain, benchGain, rankScore: Math.max(gain * 3, benchGain / 10), slot: idx >= 0 ? idx : -1, lineup: lu };
  };

  const targets: WaiverTarget[] = faSorted.map(({ player: fa, onWaivers, percentOwned }) => {
    const options: (ValuedPlayer | null)[] = [];
    if (hasOpenSpot) options.push(null);
    else {
      // Kicker / defense streaming: a second K/DEF is useless, so swap out my current one.
      const mine = fa.pos === "K" || fa.pos === "DEF" ? roster.filter((p) => p.pos === fa.pos && !irIds.has(p.id)).sort(dropOrder)[0] : undefined;
      if (mine) options.push(mine);
      else if (benchDroppable[0]) options.push(benchDroppable[0]);
      if (!options.length) options.push(null);
    }
    const best = options.map((d) => evalWith(fa, d)).sort((a, b) => b.rankScore - a.rankScore)[0];
    const { drop, gain, benchGain, rankScore } = best;

    const list = posList[fa.pos] ?? [];
    const faRank = list.indexOf(fa) + 1;
    const fifth = list[4];
    const top3AtNeed = faRank > 0 && faRank <= 3 && isNeedPos(fa.pos);
    // ≥1.5× the dropped value, and a real difference (≥3 value points) so 0-vs-1 swaps don't burn priority.
    const MIN_VALUE_JUMP = 3;
    const valueJump = fa.value >= 1.5 * (drop?.value ?? 0) && fa.value - (drop?.value ?? 0) >= MIN_VALUE_JUMP;

    let recommendation: WaiverTarget["recommendation"];
    const reasons: string[] = [];
    const isKDef = fa.pos === "K" || fa.pos === "DEF";
    // 5th-best comparison on value; when that is 0 (everyone below replacement), compare ppg instead.
    const belowFifth = !!fifth && (fifth.value === 0 ? fa.ppg < fifth.ppg : fa.value < fifth.value);
    if (isKDef) {
      // Kickers / defenses are streamed: never spend rolling-list priority on them.
      if (gain <= 0.05 && benchGain <= 0) {
        recommendation = "pass";
        reasons.push("not an upgrade on your current " + fa.pos);
      } else if (!onWaivers) {
        recommendation = "optional";
        reasons.push(`streaming ${fa.pos} upgrade (${fmtSigned(gain)} ppg), free to add`);
      } else {
        recommendation = "pass";
        reasons.push(`${fa.pos} on waivers: not worth priority, stream one from free agents after waivers clear`);
      }
    } else if (gain >= threshold) {
      recommendation = "claim";
      reasons.push(`lineup gain ${fmtSigned(gain)} ≥ ${threshold.toFixed(1)} threshold`);
    } else if (valueJump && top3AtNeed) {
      recommendation = "claim";
      reasons.push(`top-3 FA ${fa.pos} at a need position and ≥1.5× the value of your drop`);
    } else if (gain <= 0.05 && benchGain <= 0) {
      recommendation = "pass";
      reasons.push("not an upgrade on your lineup or your worst bench player");
    } else if (onWaivers && fifth && belowFifth) {
      recommendation = "wait";
      const cmp = fifth.value === 0 ? `${fifth.ppg.toFixed(1)} ppg` : fifth.value.toFixed(1);
      reasons.push(`below the 5th-best FA ${fa.pos} (${fifth!.name}, ${cmp}): similar players will clear waivers`);
    } else {
      recommendation = "optional";
      reasons.push(`modest upgrade (gain ${fmtSigned(gain)} < ${threshold.toFixed(1)})`);
    }

    const parts: string[] = [];
    if (best.slot >= 0) {
      const replaced = base.lineup[best.slot]?.player;
      parts.push(`Starts at ${labels[best.slot]}${replaced && replaced.id !== drop?.id ? ` over ${replaced.name}` : ""} (${fmtSigned(gain)} ppg)`);
    } else parts.push(`Bench depth (${fmtSigned(gain)} ppg to lineup)`);
    parts.push(drop ? `drop ${drop.name} (value ${drop.value.toFixed(1)}) → ${fmtSigned(benchGain)} value` : `open roster spot → ${fmtSigned(benchGain)} value`);
    const snapTrend = snapTrendOf(fa);
    const trendBits: string[] = [];
    if (fa.games >= 3) trendBits.push(`exp pts trend ${fmtSigned(fa.trend)}/g`);
    if (snapTrend !== 0) trendBits.push(`snaps ${fmtSigned(snapTrend * 100)}%`);
    if (fa.injury) trendBits.push(`${fa.injury.status}${fa.injury.detail ? ` (${fa.injury.detail})` : ""}`);
    let why = `${parts.join("; ")}.${trendBits.length ? ` ${trendBits.join(", ")}.` : ""} ${recommendation[0].toUpperCase()}${recommendation.slice(1)}: ${reasons.join("; ")}.`;
    if (recommendation === "claim" || recommendation === "optional") why += ` ${costText(S.usesFaab, team.faabRemaining ?? S.faabBudget, w, n, onWaivers, rankScore)}`;

    return {
      ...fa,
      gain,
      benchGain,
      drop,
      trend: fa.trend,
      snapTrend,
      recommendation,
      why,
      onWaivers,
      percentOwned,
      rankScore: r2(rankScore),
    };
  });

  // Actionable rows first (claim > optional > wait > pass), then score; ties on vorp
  // (ppg above replacement, may be negative) then value, so 0-value QBs don't float up on raw ppg.
  const vorpOf = (p: ValuedPlayer) => {
    const repl = ctx.replacement?.[p.pos];
    return repl === undefined ? p.vorp : p.ppg - repl;
  };
  targets.sort(
    (a, b) =>
      REC_ORDER[a.recommendation] - REC_ORDER[b.recommendation] ||
      b.rankScore - a.rankScore ||
      b.gain - a.gain ||
      vorpOf(b) - vorpOf(a) ||
      b.value - a.value ||
      b.ppg - a.ppg ||
      a.id.localeCompare(b.id),
  );
  const limited = targets.slice(0, opts.limit ?? 60);
  const claims = limited.filter((t) => t.recommendation === "claim");
  const needList = [...needs].join(", ") || "none";
  let advice: string;
  if (S.usesFaab) {
    advice = `FAAB league: bid on lineup gains ≥ ${threshold.toFixed(1)} ppg or top-3 FAs at a need (${needList}).`;
  } else if (w !== undefined) {
    advice = `You hold waiver priority #${w} of ${n} (rolling list): claim for a lineup gain ≥ ${threshold.toFixed(1)} ppg or a top-3 FA at a need (${needList}); ${w === n ? "you are already last, so claiming costs nothing." : `using it drops you to #${n}.`}`;
  } else {
    advice = `Claim for a lineup gain ≥ ${threshold.toFixed(1)} ppg or a top-3 FA at a need (${needList}).`;
  }
  advice += claims.length ? ` ${claims.length} claim-worthy: ${claims.slice(0, 3).map((c) => c.name).join(", ")}.` : " Nobody is worth a claim right now.";
  return { freeAgents: limited, myPriority: w, numTeams: n, advice };
}

function costText(usesFaab: boolean | undefined, budget: number | undefined, w: number | undefined, n: number, onWaivers: boolean, rankScore: number): string {
  if (!onWaivers) return "Free agent: add now, no priority cost.";
  if (usesFaab) {
    const pct = Math.max(1, Math.min(40, Math.round(rankScore * 4)));
    return budget ? `Suggested bid ~$${Math.max(1, Math.round((budget * pct) / 100))} (${pct}% of $${budget}).` : `Suggested bid ~${pct}% of your FAAB.`;
  }
  if (w === undefined) return "Costs your waiver priority (rolling list).";
  if (w >= n) return `You are already #${n}; claiming costs nothing.`;
  return `Using your #${w} priority drops you to #${n}.`;
}
