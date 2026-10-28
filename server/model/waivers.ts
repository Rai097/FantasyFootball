// Free-agent ranking + waiver-priority advice. See docs/DESIGN.md "Waivers" (+ amendments).
import type { Availability, DetailItem, Position, StashRow, ValuedPlayer, WaiverBreakout, WaiverRow, WaiverTarget } from "./types.js";
import { eligible, optimalLineup, slotLabels } from "./lineup.js";
import { irSet, rosterOf } from "./analysis.js";
import type { TradeContext } from "./tradeKit.js";
import { injuryKind, isQuestionable } from "./projection.js";
import { luckText } from "./labels.js";
import { futureStarterBlock, roleItems } from "./roleCheck.js";

export interface FreeAgentInput {
  player: ValuedPlayer;
  onWaivers: boolean;
  /** Omitted = known from onWaivers; "unknown" when the source did not say (old imports). */
  availability?: Availability;
  percentOwned?: number;
}

export interface WaiverResult {
  freeAgents: WaiverTarget[];
  myPriority?: number;
  numTeams: number;
  /** One short line (≤ 255 chars): counts and top names. */
  advice: string;
  /** "How calls work": the claim rules, one item per line (collapsed in the UI). */
  rules: DetailItem[];
  /** false when the source did not say who is a free agent vs on waivers (old import: re-import to see). */
  faStatusKnown: boolean;
  /** Data problems worth a line (e.g. imported free agents we could not match), when any. */
  notes?: string[];
  /** One line per weak starting position where no free agent beats my starter (≤ 255 chars each): "look at trades". */
  gaps?: string[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const toneOfGain = (x: number): DetailItem["tone"] => (x > 0.05 ? "pos" : x < -0.05 ? "neg" : undefined);
const r2 = (x: number) => Math.round(x * 100) / 100;
/** "+1.2" / "−0.4"; a missing number (NaN / undefined) is "—", never "NaN". */
const fmtSigned = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}` : "—");
/** A number with `d` decimals, or "—" when missing (NaN / undefined): unknown, never 0. */
const fmtNum = (x: number | undefined, d: number) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "—");

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

export const REC_ORDER: Record<WaiverTarget["recommendation"], number> = { claim: 0, optional: 1, stash: 2, wait: 3, pass: 4 };

/**
 * Future starter (worth a claim before he starts for you): a strong breakout score, a path at least partly open, and
 * already a flex-level share of the work (expected pts/g over the last 2 weeks). Snap share alone is not enough:
 * blocking tight ends play lots of snaps without targets.
 */
export const FUTURE_STARTER = { score: 55, situation: 0.5, oppLevel: { RB: 10, WR: 9, TE: 8 } as Partial<Record<Position, number>> };
/** A "stash" needs this breakout score and real expected points (blocking TEs rack up snaps, not targets); else "pass". */
export const STASH = { score: 50, oppLevel: 4.5 };

/**
 * K / DEF streaming on Yahoo's week projections (DESIGN "Available-player projections (2026-10-28)"): a free agent is
 * a streaming pick only when Yahoo projects him at least `minGain` points above my best K / DEF this week. One
 * constant gates both the row's call and the named pick, so a named pick never reads "pass".
 */
export const KDEF_STREAM = { minGain: 1.0 };

/** This week's Yahoo projection of one free agent vs my best K / DEF (`mine` null = I have none at the position);
 *  `gain` = proj − mine (mine none → proj); `best` = the named pick at his position (free to add, gain ≥ minGain). */
export type WeekStream = NonNullable<WaiverTarget["weekStream"]>;

const weekProjOf = (p: { yahooProjWeekly?: number }) =>
  typeof p.yahooProjWeekly === "number" && Number.isFinite(p.yahooProjWeekly) ? p.yahooProjWeekly : undefined;

export const isFutureStarter = (b: WaiverBreakout | undefined, pos: Position): boolean =>
  !!b && b.score >= FUTURE_STARTER.score && b.situation >= FUTURE_STARTER.situation && b.oppLevel >= (FUTURE_STARTER.oppLevel[pos] ?? Infinity);

/** Drop-order comparator: lowest value, then lowest ppg, then worst ECR. */
const dropOrder = (a: ValuedPlayer, b: ValuedPlayer) =>
  a.value - b.value || a.ppg - b.ppg || (b.ecrOverall ?? 9999) - (a.ecrOverall ?? 9999) || a.id.localeCompare(b.id);

export function rankWaivers(
  ctx: TradeContext,
  myTeamId: string,
  freeAgents: FreeAgentInput[],
  opts: { myPriority?: number; limit?: number; perPosition?: number; breakouts?: Map<string, WaiverBreakout> } = {},
): WaiverResult {
  const S = ctx.league.settings;
  const n = S.numTeams || ctx.league.teams.length;
  const team = ctx.league.teams.find((t) => t.id === myTeamId);
  if (!team) throw Object.assign(new Error(`Unknown team ${myTeamId}`), { status: 404 });
  const analysis = ctx.teams.find((t) => t.team.id === myTeamId);
  const roster = rosterOf(team, ctx.players);
  const irIds = irSet(team);
  // IR-slotted players never start (they stay on the bench list, never dropped).
  const base = optimalLineup(S.slots, roster, { irIds });
  const rosterLimit = S.slots.filter((s) => s !== "IR").length;
  const activeCount = roster.filter((p) => !irIds.has(p.id)).length;
  const hasOpenSpot = activeCount < rosterLimit;
  const posCount = (pos: Position) => roster.filter((p) => p.pos === pos).length;

  // Droppable: bench, not IR-slotted, never the only K / only DEF.
  const benchDroppable = base.bench
    .filter((p) => !irIds.has(p.id) && !((p.pos === "K" || p.pos === "DEF") && posCount(p.pos) <= 1))
    .sort(dropOrder);
  const labels = slotLabels(base.lineup);

  /**
   * Roster need (DESIGN "Fix: vacated role, spikes, depth and roster need"): my starters fill every slot of his
   * position (FLEX-type starters at his position count too) and a bench player at his position projects at least as
   * well as he does → he adds nothing but a trade chip. Null = he fills a need.
   */
  /** My best bench player at his position when my starters fill every slot of it (else null: a need). */
  const coverAt = (fa: ValuedPlayer): ValuedPlayer | null => {
    if (fa.pos === "K" || fa.pos === "DEF") return null;
    const dedicated = S.slots.filter((x) => x === fa.pos).length;
    const starters = base.lineup.filter((l) => l.player?.pos === fa.pos).length;
    if (starters < dedicated || starters === 0) return null;
    return base.bench.filter((p) => p.pos === fa.pos && !irIds.has(p.id) && p.remainingGames > 0).sort((a, b) => b.ppg - a.ppg)[0] ?? null;
  };
  const coveredBy = (fa: ValuedPlayer): { starters: number; cover: ValuedPlayer } | null => {
    const cover = coverAt(fa);
    return cover && cover.ppg >= fa.ppg ? { starters: base.lineup.filter((l) => l.player?.pos === fa.pos).length, cover } : null;
  };

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
    const lu = optimalLineup(S.slots, after, { irIds });
    const gain = r2(lu.starterPpg - base.starterPpg);
    const benchGain = r1(fa.value - (drop?.value ?? 0));
    const idx = lu.lineup.findIndex((l) => l.player?.id === fa.id);
    return { drop, gain, benchGain, rankScore: Math.max(gain * 3, benchGain / 10), slot: idx >= 0 ? idx : -1, lineup: lu };
  };

  // K / DEF this week: my best one's Yahoo week projection; unknown (undefined) when any of mine lacks one.
  const myWeek = (pos: Position): { mine: number | null } | undefined => {
    const mine = roster.filter((p) => p.pos === pos && !irIds.has(p.id));
    if (!mine.length) return { mine: null };
    const vals = mine.map(weekProjOf);
    return vals.every((v) => v !== undefined) ? { mine: Math.max(...(vals as number[])) } : undefined;
  };
  const myWeekBy = { K: myWeek("K"), DEF: myWeek("DEF") };
  const streamOf = (fa: ValuedPlayer): Omit<WeekStream, "best"> | undefined => {
    if (fa.pos !== "K" && fa.pos !== "DEF") return undefined;
    const proj = weekProjOf(fa);
    const my = myWeekBy[fa.pos];
    if (proj === undefined || !my) return undefined;
    return { proj, mine: my.mine, gain: r2(proj - (my.mine ?? 0)), ...(fa.weekOpponent ? { opponent: fa.weekOpponent } : {}) };
  };
  // The named pick per position: free to add (never a claim), gain ≥ the minimum; highest projection, then gain, then id.
  const bestStream = new Map<Position, string>();
  for (const pos of ["K", "DEF"] as const) {
    const pick = freeAgents
      .filter((f) => f.player.pos === pos && !f.onWaivers)
      .map((f) => ({ id: f.player.id, s: streamOf(f.player) }))
      .filter((x): x is { id: string; s: Omit<WeekStream, "best"> } => !!x.s && x.s.gain >= KDEF_STREAM.minGain)
      .sort((a, b) => b.s.proj - a.s.proj || b.s.gain - a.s.gain || a.id.localeCompare(b.id))[0];
    if (pick) bestStream.set(pos, pick.id);
  }

  const targets: WaiverTarget[] = faSorted.map(({ player: fa, onWaivers, availability, percentOwned }) => {
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
    const { drop, benchGain } = best;
    let { gain, rankScore } = best;

    const bo = opts.breakouts?.get(fa.id);
    const list = posList[fa.pos] ?? [];
    const faRank = list.indexOf(fa) + 1;
    const fifth = list[4];
    const top3AtNeed = faRank > 0 && faRank <= 3 && isNeedPos(fa.pos);
    // ≥1.5× the dropped value, and a real difference (≥3 value points) so 0-vs-1 swaps don't burn priority.
    const MIN_VALUE_JUMP = 3;
    const valueJump = fa.value >= 1.5 * (drop?.value ?? 0) && fa.value - (drop?.value ?? 0) >= MIN_VALUE_JUMP;

    const isKDef = fa.pos === "K" || fa.pos === "DEF";
    // 5th-best comparison on value; when that is 0 (everyone below replacement), compare ppg instead.
    const belowFifth = !!fifth && (fifth.value === 0 ? fa.ppg < fifth.ppg : fa.value < fifth.value);
    const avail: Availability = availability ?? (onWaivers ? "waivers" : "fa");
    const free = !onWaivers;
    const cost = costText(S.usesFaab, team.faabRemaining ?? S.faabBudget, w, n, onWaivers, rankScore);
    const replaced = best.slot >= 0 ? base.lineup[best.slot]?.player : undefined;
    let startsText =
      best.slot >= 0 ? `Starts at ${labels[best.slot]}${replaced && replaced.id !== drop?.id ? ` over ${replaced.name}` : ""}` : "Bench depth";

    let recommendation: WaiverTarget["recommendation"];
    /** A claim on his role (future starter / top-3 at a need), not on this week's lineup gain. */
    let byRole = false;
    /** The rule that produced the call (short, shown in details). */
    let rule: string;
    /** Summary sentences: the most important fact, then what to do. */
    let lead: string;
    let action: string | undefined;
    const ruleItems: DetailItem[] = [];
    const st0 = isKDef ? streamOf(fa) : undefined;
    const stream: WeekStream | undefined = st0 ? { ...st0, best: bestStream.get(fa.pos) === fa.id } : undefined;
    if (isKDef && stream) {
      // This week's Yahoo projections on both sides: the streaming gain is their difference (the lineup gain this week).
      gain = stream.gain;
      rankScore = Math.max(gain * 3, benchGain / 10);
      // Season numbers may bench him (open roster spot); this week he would start when Yahoo projects him higher.
      if (stream.gain > 0) startsText = `Starts at ${fa.pos} this week${stream.mine === null ? "" : " over yours"}`;
      const vs = `Yahoo proj ${stream.proj.toFixed(1)} vs ${stream.mine === null ? `no ${fa.pos} of yours` : `your ${stream.mine.toFixed(1)}`}`;
      const opp = stream.opponent ? ` (${stream.opponent})` : "";
      if (stream.gain >= KDEF_STREAM.minGain && free) {
        recommendation = "optional";
        rule = `Yahoo projects ${fmtSigned(stream.gain)} this week (≥ ${KDEF_STREAM.minGain.toFixed(1)}), free to add`;
        lead = stream.best ? `Best ${fa.pos} stream this week${opp}: ${vs}.` : `Streaming ${fa.pos} this week${opp}: ${vs}.`;
        action = "Free agent, add any time.";
      } else if (stream.gain >= KDEF_STREAM.minGain) {
        recommendation = "pass";
        rule = S.usesFaab ? `${fa.pos} on waivers: never worth a bid` : `${fa.pos} on waivers: never worth priority`;
        lead = `${fa.pos} on waivers (${vs}): ${S.usesFaab ? "not worth a bid" : "not worth your priority"}.`;
        action = "Stream one from free agents after waivers clear.";
      } else {
        recommendation = "pass";
        rule = `Yahoo projects under ${fmtSigned(KDEF_STREAM.minGain)} over your ${fa.pos} this week`;
        lead = `Not a streaming upgrade this week: ${vs}.`;
      }
    } else if (isKDef) {
      // Kickers / defenses are streamed: never spend rolling-list priority (or a bid) on them, and only a real
      // weekly gain makes one worth streaming (value alone, e.g. more games left, is not a streaming upgrade).
      if (!(gain > 0.05)) {
        recommendation = "pass";
        rule = `Not an upgrade on your current ${fa.pos}`;
        lead = `Not an upgrade on your current ${fa.pos} (no weekly projection).`;
      } else if (free) {
        recommendation = "optional";
        rule = `Streaming ${fa.pos} upgrade, free to add`;
        lead = `Streaming ${fa.pos} upgrade: ${fmtSigned(gain)} ppg${drop ? ` over ${drop.name}` : ""}.`;
        action = "Free agent, add any time.";
      } else {
        recommendation = "pass";
        rule = S.usesFaab ? `${fa.pos} on waivers: never worth a bid` : `${fa.pos} on waivers: never worth priority`;
        lead = S.usesFaab ? `${fa.pos} on waivers: not worth a bid.` : `${fa.pos} on waivers: not worth your priority.`;
        action = "Stream one from free agents after waivers clear.";
      }
    } else if (gain >= threshold) {
      recommendation = "claim";
      rule = `Lineup gain ${fmtSigned(gain)} ppg ≥ ${threshold.toFixed(1)} threshold`;
      lead = `${startsText} (${fmtSigned(gain)} ppg).`;
      action = cost;
    } else if (isFutureStarter(bo, fa.pos)) {
      const block = futureStarterBlock(bo!.role, fa.pos);
      if (block) {
        // Spike, borrowed role, below starter level, or too small a share once healthy: watch at most, never a claim.
        recommendation = "stash";
        rule = block.rule;
        lead = `Watch, not a claim: ${block.short} (breakout score ${bo!.score.toFixed(0)}).`;
        action = "Stash only with a spare bench spot.";
      } else {
        recommendation = "claim";
        byRole = true;
        rule = "Future starter: rising role with flex-level work";
        lead = `Rising role: ${bo!.oppLevel.toFixed(1)} expected pts/g, breakout score ${bo!.score.toFixed(0)}.`;
        action = free ? "Free agent: add him before he starts." : "Claim him before he starts.";
      }
    } else if (valueJump && top3AtNeed) {
      recommendation = "claim";
      byRole = true;
      rule = `Top-3 free-agent ${fa.pos} at a need, ≥1.5× your drop's value`;
      lead = `Top-3 free-agent ${fa.pos} at a position you need${drop ? `, worth more than ${drop.name}` : ""}.`;
      action = cost;
    } else if (gain <= 0.05 && benchGain <= 0) {
      const stash = !!bo && bo.score >= STASH.score && bo.oppLevel >= STASH.oppLevel;
      recommendation = stash ? "stash" : "pass";
      const block = stash ? futureStarterBlock(bo!.role, fa.pos) : null;
      if (stash && block) {
        rule = `Watch: ${block.rule[0].toLowerCase()}${block.rule.slice(1)}`;
        lead = `Watch: ${block.short} (breakout score ${bo!.score.toFixed(0)}).`;
        action = "Stash only with a spare bench spot.";
      } else if (stash) {
        rule = `Not an upgrade yet, rising role (breakout score ≥ ${STASH.score})`;
        lead = `Not a starter yet, but his role is rising (breakout score ${bo!.score.toFixed(0)}).`;
        action = "Stash him if you have a spare bench spot.";
      } else {
        rule = "Not an upgrade on your lineup or your worst bench player";
        lead = "Not an upgrade on your lineup or your bench.";
      }
    } else if (onWaivers && fifth && belowFifth) {
      recommendation = "wait";
      rule = `Below the 5th-best free-agent ${fa.pos}`;
      lead = `Below the 5th-best free-agent ${fa.pos} (${fifth.name}).`;
      action = "Similar players will clear waivers.";
      ruleItems.push({ label: "5th-best free agent", value: `${fifth.name}, ${fifth.value === 0 ? `${fifth.ppg.toFixed(1)} ppg` : `value ${fifth.value.toFixed(1)}`}` });
    } else {
      recommendation = "optional";
      rule = `Modest upgrade (gain ${fmtSigned(gain)} < ${threshold.toFixed(1)} ppg)`;
      lead = gain > 0.05 ? `Small upgrade: ${fmtSigned(gain)} ppg in your lineup.` : `Bench upgrade: ${fmtSigned(benchGain)} value${drop ? ` over ${drop.name}` : ""}.`;
      action = free
        ? S.usesFaab
          ? "Free agent, no bid needed."
          : "Free agent, no priority cost."
        : S.usesFaab
          ? "Bid the minimum at most, or add him if he clears waivers."
          : "Not worth priority, so add him only if he clears waivers.";
    }
    // Roster need: a role claim, a stash or a bench-only upgrade at a position I already start and cover → trade chip.
    const benchOnly = recommendation === "optional" && !(gain > 0.05);
    const covered = !isKDef && (byRole || recommendation === "stash" || benchOnly) ? coveredBy(fa) : null;
    const weakerCover = !covered && benchOnly && !isKDef ? coverAt(fa) : null;
    if (weakerCover) {
      lead = `Better ${fa.pos} cover than ${weakerCover.name} (${fa.ppg.toFixed(1)} vs ${weakerCover.ppg.toFixed(1)} ppg)${drop ? `, dropping ${drop.name}` : ""}.`;
      rule = `Bench upgrade: projects above your ${fa.pos} cover ${weakerCover.name}`;
    }
    if (covered) {
      const c = covered.cover;
      recommendation = "pass";
      rule = `Roster need: ${covered.starters} ${fa.pos} starter${covered.starters > 1 ? "s" : ""} + ${c.name} as cover (${c.ppg.toFixed(1)} ppg)`;
      lead = `Trade chip only: you start ${covered.starters} ${fa.pos}${covered.starters > 1 ? "s" : ""} and ${c.name} covers (${c.ppg.toFixed(1)} vs his ${fa.ppg.toFixed(1)} ppg).`;
      action = undefined;
    }
    const injText = fa.injury ? `${fa.injury.status.trim() || "injured"}${fa.injury.detail?.trim() ? ` (${fa.injury.detail.trim()})` : ""}` : "";
    const kind = injuryKind(fa.injury);
    if (kind === "long" && recommendation !== "pass") {
      // Long-term injured (IR, PUP, NFI, NA, "Out (IR)", "Out (ACL)"): never a claim or a bid. Out for the season → pass;
      // else a would-be claim becomes a stash while his return is confirmed.
      if (fa.remainingGames <= 0) {
        recommendation = "pass";
        rule = `${rule}, but out for the season`;
        lead = `Out for the season (${injText}).`;
        action = undefined;
      } else if (recommendation === "claim") {
        recommendation = "stash";
        rule = `${rule}, but on a long-term injury list: confirm his status`;
        lead = `Would be a claim, but he is ${injText}, out long-term.`;
        action = free
          ? "Stash him only if you have a spare bench spot; confirm when he returns."
          : S.usesFaab
            ? "Confirm his status before bidding, or add him after waivers clear."
            : "Confirm his status before spending priority, or add him after waivers clear.";
      }
    }
    // An injured player is never worth rolling-list priority sight unseen: hold him as a stash until his status is known.
    // "DNP" = did not practice, no game status yet: treated like Questionable here.
    const hurt = kind === "out" || kind === "return" || kind === "doubtful" || isQuestionable(fa.injury) || fa.injury?.status.trim().toUpperCase() === "DNP";
    if (recommendation === "claim" && hurt && onWaivers && !S.usesFaab) {
      recommendation = "stash";
      rule = `${rule}, but injured: hold until his status is known`;
      lead = `Would be a claim, but he is ${injText}.`;
      action = "Confirm his status before spending priority, or add him after waivers clear.";
    }

    const snapTrend = snapTrendOf(fa);
    const details: DetailItem[] = [];
    const item = (label: string, value: string, tone?: DetailItem["tone"]) => details.push(tone ? { label, value: clampItem(value), tone } : { label, value: clampItem(value) });
    const toneOf = toneOfGain;
    item("Rule", rule);
    for (const d of ruleItems) item(d.label, d.value);
    if (stream) {
      item("This week (Yahoo)", `proj ${stream.proj.toFixed(1)} vs ${stream.mine === null ? `no ${fa.pos}` : `your ${stream.mine.toFixed(1)}`} (${fmtSigned(stream.gain)})`, toneOfGain(stream.gain));
      if (stream.opponent) item("Opponent", stream.opponent);
    } else if (isKDef) item("This week (Yahoo)", weekProjOf(fa) === undefined ? "No weekly projection: re-import with the latest bookmark" : `No weekly projection for your ${fa.pos}`);
    item("Lineup", startsText);
    item("Lineup gain", stream ? `${fmtSigned(gain)} pts this week` : `${fmtSigned(gain)} ppg`, toneOf(gain));
    item("Drop", drop ? `${drop.name} (value ${drop.value.toFixed(1)})` : "Nobody: open roster spot");
    item("Value change", fmtSigned(benchGain), toneOf(benchGain));
    if (fa.games >= 3) item("Expected points", `${fmtSigned(fa.trend)}/g lately vs his season`, toneOf(fa.trend));
    if (snapTrend !== 0) item("Snaps", `${fmtSigned(snapTrend * 100)}% last week vs earlier weeks`, toneOf(snapTrend));
    if (fa.luck !== undefined) item("Luck", luckText(fa.luck, fa.label ?? null), fa.label === "buy-low" ? "pos" : fa.label === "sell-high" ? "warn" : undefined);
    if (fa.riser) item("Opportunity", "Rising: usage up 3 straight games", "pos");
    if (fa.injury) item("Injury", `${fa.injury.status}${fa.injury.detail ? ` (${fa.injury.detail})` : ""}`, "warn");
    if (bo) {
      // Missing breakout numbers (NaN / undefined) are unknown: "—", never "NaN" or 0.
      item("Breakout score", Number.isFinite(bo.score) ? `${bo.score.toFixed(0)} of 100` : "—");
      item("Path to more work", !Number.isFinite(bo.situation) ? "—" : bo.situation >= 1 ? "Open" : bo.situation > 0 ? "Partly open" : "Blocked");
      item("Expected pts/g, last 2 weeks", fmtNum(bo.oppLevel, 1));
      for (const d of thesisItems(bo.thesis ?? "")) item(d.label, d.value);
      if (bo.role) {
        const block = futureStarterBlock(bo.role, fa.pos);
        // The role check's verdict, unless the Rule line already says it (a watch call).
        if (block && !rule.toLowerCase().includes(block.rule.slice(1).toLowerCase())) item("Not a starter yet", block.rule, "warn");
        for (const d of roleItems(bo.role, fa.pos)) item(d.label, d.value, d.tone);
      }
    }
    // The call pill and the FA / W badge are on the row already; details add the cost, or the status when it costs nothing to know.
    if (ACTIONABLE.has(recommendation)) item("Cost", cost);
    if (avail === "unknown") item("Availability", "Unknown: re-import to see free agents");
    else if (!ACTIONABLE.has(recommendation)) item("Availability", avail === "fa" ? "Free agent" : "On waivers");

    // A 0.0 next to a call reads as nonsense: say why the number is not the point (the UI shows "—" + this tooltip).
    const gainNote =
      !stream && Math.abs(gain) < 0.05
        ? recommendation === "pass"
          ? "No lineup gain: he would not start for you"
          : recommendation === "optional"
            ? "No lineup gain: a bench upgrade, he would not start for you now"
            : "No lineup gain this week: the call is about his role, not today's points"
        : undefined;
    const valueNote = fa.value < 0.05 ? "Below replacement level now: value counts only points above a waiver-level player" : undefined;
    const { why: _valueWhy, ...base0 } = fa;
    return {
      ...base0,
      ...(gainNote ? { gainNote } : {}),
      ...(valueNote ? { valueNote } : {}),
      gain,
      benchGain,
      drop,
      trend: fa.trend,
      snapTrend,
      recommendation,
      summary: makeSummary(lead, action),
      details,
      onWaivers,
      availability: avail,
      percentOwned,
      rankScore: r2(rankScore),
      ...(bo ? { breakout: bo } : {}),
      ...(stream ? { weekStream: stream } : {}),
    };
  });

  // Actionable rows first (claim > optional > wait > pass), then score; ties on vorp
  // (ppg above replacement, may be negative) then value, so 0-value QBs don't float up on raw ppg.
  const vorpOf = (p: Omit<ValuedPlayer, "why">) => {
    const repl = ctx.replacement?.[p.pos];
    return repl === undefined ? p.vorp : p.ppg - repl;
  };
  targets.sort(
    (a, b) =>
      REC_ORDER[a.recommendation] - REC_ORDER[b.recommendation] ||
      b.rankScore - a.rankScore ||
      (b.breakout?.score ?? -1) - (a.breakout?.score ?? -1) ||
      b.gain - a.gain ||
      vorpOf(b) - vorpOf(a) ||
      b.value - a.value ||
      b.ppg - a.ppg ||
      a.id.localeCompare(b.id),
  );
  const limited = capRows(targets, opts.limit ?? 60, opts.perPosition ?? 5);
  const needList = [...needs].join(", ") || "none";
  const rules: DetailItem[] = [];
  const rule = (label: string, value: string) => rules.push({ label, value });
  if (S.usesFaab) rule("Claim", `Bid when he adds ≥ ${threshold.toFixed(1)} ppg to your lineup`);
  else rule("Claim", `He adds ≥ ${threshold.toFixed(1)} ppg to your lineup`);
  rule("Claim", "Or a future starter: rising role, flex-level expected points");
  rule("Claim", `Or a top-3 free agent at a need (${needList})`);
  rule("Optional", S.usesFaab ? "A smaller upgrade: a minimum bid at most" : "A smaller upgrade: add only if it costs no priority");
  rule("Stash", "Not an upgrade yet, but his role is rising");
  rule("Stash", "Injured would-be claims on waivers wait for his status");
  rule("Stash", "Long-term injured (IR, PUP, NA): never a claim, confirm his return");
  rule("Wait", "Similar players will clear waivers soon");
  rule("K / DEF", S.usesFaab ? "Never worth a bid: stream them from free agents" : "Never worth priority: stream them from free agents");
  rule("K / DEF", `Stream when Yahoo's week projection beats yours by ≥ ${KDEF_STREAM.minGain.toFixed(1)} pts`);
  for (const pos of ["DEF", "K"] as const) {
    const t = targets.find((x) => x.id === bestStream.get(pos));
    if (t?.weekStream) rule(`Best ${pos} this week`, clampItem(`${t.name}: Yahoo proj ${t.weekStream.proj.toFixed(1)} vs ${t.weekStream.mine === null ? "none" : `your ${t.weekStream.mine.toFixed(1)}`}`));
  }
  if (!S.usesFaab && w !== undefined) rule("Priority", w >= n ? `You are #${n} of ${n}: claiming costs nothing` : `You are #${w} of ${n}: a claim drops you to #${n}`);
  else if (!S.usesFaab) rule("Priority", "Your waiver priority is unknown");
  rule("Free agents", S.usesFaab ? "No bid needed: add any time" : "No priority cost: add any time");

  const faStatusKnown = !freeAgents.length || freeAgents.some((f) => f.availability !== "unknown");
  const gaps = gapLines(
    weakPositions(analysis, n),
    base.lineup.map((l, i) => ({ player: l.player, label: labels[i] })),
    targets,
    freeAgents.map((f) => f.player),
  );
  return { freeAgents: limited, myPriority: w, numTeams: n, advice: adviceLine(limited, w, n, S.usesFaab), rules, faStatusKnown, ...(gaps.length ? { gaps } : {}) };
}

/** Weak starting positions: the team analysis needs, plus my worst-ranked QB / RB / WR / TE group when it ranks in
 *  the bottom half of the league (the weakest starting spot, even when no "need" threshold is crossed). */
export function weakPositions(analysis: { needs: string[]; groups: Record<string, { rank: number }> } | undefined, numTeams: number): Position[] {
  if (!analysis) return [];
  const OFF: Position[] = ["QB", "RB", "WR", "TE"];
  const out = new Set<Position>(analysis.needs.filter((g): g is Position => (OFF as string[]).includes(g)));
  const worst = OFF.filter((g) => analysis.groups[g]).sort((a, b) => analysis.groups[b].rank - analysis.groups[a].rank)[0];
  if (worst && analysis.groups[worst].rank > numTeams / 2) out.add(worst);
  return [...out];
}

/**
 * Weak starting positions (weakPositions) where no free agent beats my weakest starter there: one line each,
 * "RB: no free agent beats yours (best: X 7.3 this week vs your RB2 9.6). Look at trades." Measured on Yahoo's week
 * projection when both sides have one, else on our projected pts/game. A position where a row already adds lineup
 * points (claim / optional with gain), or the best free agent measures higher, gets no line (the rows answer it).
 */
export function gapLines(
  weak: Position[],
  lineup: { player: ValuedPlayer | null; label: string }[],
  rows: Pick<WaiverTarget, "pos" | "gain" | "recommendation">[],
  pool: ValuedPlayer[],
): string[] {
  const out: string[] = [];
  for (const pos of weak) {
    if (rows.some((t) => t.pos === pos && t.gain > 0.05 && (t.recommendation === "claim" || t.recommendation === "optional"))) continue;
    const mine = lineup.filter((x) => x.player?.pos === pos).sort((a, b) => a.player!.ppg - b.player!.ppg)[0];
    if (!mine) continue;
    const fas = pool.filter((p) => p.pos === pos);
    if (!fas.length) {
      out.push(`${pos}: no free agent at ${pos} to compare. Look at trades.`);
      continue;
    }
    const myWeek = weekProjOf(mine.player!);
    const withWeek = fas.filter((p) => weekProjOf(p) !== undefined).sort((a, b) => weekProjOf(b)! - weekProjOf(a)!);
    let line: string | null = null;
    if (myWeek !== undefined && withWeek.length) {
      const best = withWeek[0];
      if (weekProjOf(best)! <= myWeek)
        line = `${pos}: no free agent beats yours (best: ${best.name} ${weekProjOf(best)!.toFixed(1)} this week vs your ${mine.label} ${myWeek.toFixed(1)}). Look at trades.`;
    } else {
      const best = [...fas].sort((a, b) => b.ppg - a.ppg)[0];
      if (best.ppg <= mine.player!.ppg)
        line = `${pos}: no free agent beats yours (best: ${best.name} ${best.ppg.toFixed(1)} ppg vs your ${mine.label} ${mine.player!.ppg.toFixed(1)}). Look at trades.`;
    }
    if (line) out.push(line.length <= SUMMARY_MAX ? line : `${pos}: no free agent beats your ${mine.label}. Look at trades.`);
  }
  return out;
}

/**
 * The best `limit` rows overall, plus the best `perPosition` rows of every position not already shown that many
 * times, so each position chip (K and DEF streaming options included) has rows. Keeps the sorted order.
 */
export function capRows<T extends { pos: Position }>(sorted: T[], limit: number, perPosition: number): T[] {
  const keep = new Set(sorted.slice(0, limit));
  const shown = new Map<Position, number>();
  for (const t of keep) shown.set(t.pos, (shown.get(t.pos) ?? 0) + 1);
  for (const t of sorted.slice(limit)) {
    const c = shown.get(t.pos) ?? 0;
    if (c >= perPosition) continue;
    keep.add(t);
    shown.set(t.pos, c + 1);
  }
  return sorted.filter((t) => keep.has(t));
}

/** GET /waivers response: the result with slim rows (only what the Waivers tab renders). */
export type WaiversResponse = Omit<WaiverResult, "freeAgents"> & {
  freeAgents: WaiverRow[];
  /** Stash watch (release (c)): unrostered players out now who matter on their return, ≤ 10 rows. */
  stash: StashRow[];
};

export function toWaiverRow(t: WaiverTarget): WaiverRow {
  const row: WaiverRow = {
    id: t.id,
    name: t.name,
    pos: t.pos,
    team: t.team,
    ppg: t.ppg,
    value: t.value,
    gain: t.gain,
    benchGain: t.benchGain,
    recommendation: t.recommendation,
    summary: t.summary,
    details: t.details,
    onWaivers: t.onWaivers,
    availability: t.availability,
    rankScore: t.rankScore,
    drop: t.drop ? { id: t.drop.id, name: t.drop.name, pos: t.drop.pos, value: t.drop.value } : null,
  };
  if (t.gainNote) row.gainNote = t.gainNote;
  if (t.valueNote) row.valueNote = t.valueNote;
  if (t.injury) row.injury = t.injury;
  if (t.percentOwned != null) row.percentOwned = t.percentOwned;
  if (t.breakout) {
    const { thesis: _t, ...b } = t.breakout;
    row.breakout = b;
  }
  if (t.weekStream) row.weekStream = t.weekStream;
  if ((t.pos === "K" || t.pos === "DEF") && t.yahooProjWeekly !== undefined) row.yahooProjWeekly = t.yahooProjWeekly;
  return row;
}

export const toWaiversResponse = (r: WaiverResult, stash: StashRow[] = []): WaiversResponse => ({ ...r, freeAgents: r.freeAgents.map(toWaiverRow), stash });

const ACTIONABLE = new Set<WaiverTarget["recommendation"]>(["claim", "optional", "stash"]);

/** Top advice line, ≤ 255 chars: priority, then counts with up to 2 names each (fewer names when long). */
export function adviceLine(rows: WaiverTarget[], w: number | undefined, n: number, usesFaab?: boolean): string {
  const claims = rows.filter((t) => t.recommendation === "claim" && t.onWaivers);
  const streams = rows.filter((t) => t.weekStream?.best && t.recommendation === "optional");
  const freeAdds = rows.filter((t) => ACTIONABLE.has(t.recommendation) && !t.onWaivers && !streams.includes(t));
  const stashes = rows.filter((t) => t.recommendation === "stash" && t.onWaivers);
  const head = usesFaab ? "FAAB league." : w !== undefined ? `You hold waiver priority #${w} of ${n}.` : "";
  for (const k of [2, 1, 0]) {
    const names = (xs: WaiverTarget[]) => (k && xs.length ? ` (${xs.slice(0, k).map((x) => x.name).join(", ")})` : "");
    const parts: string[] = [];
    if (claims.length) parts.push(`${claims.length} worth a claim${names(claims)}`);
    if (freeAdds.length) parts.push(`${freeAdds.length} free to add now${names(freeAdds)}`);
    if (stashes.length) parts.push(`${stashes.length} to stash${names(stashes)}`);
    if (streams.length) parts.push(k ? `stream ${streams.map((x) => `${x.name} (${x.pos})`).join(", ")} this week` : `${streams.length} K/DEF stream${streams.length === 1 ? "" : "s"} this week`);
    const body = parts.length ? `${parts.join(", ")}.` : "Nobody is worth adding right now.";
    const line = `${head} ${body[0].toUpperCase()}${body.slice(1)}`.trim();
    if (line.length <= SUMMARY_MAX) return line;
  }
  return head || "Nobody is worth adding right now.";
}

export const SUMMARY_MAX = 255;
export const DETAIL_MAX = 90;

/** Lead fact + action, ≤ 255 chars: drops the action sentence (never cuts mid-word) when too long. */
export function makeSummary(leadIn: string, action?: string): string {
  const lead = leadIn.replace(/\.\.$/, "."); // a name ending in "Jr." at the end of the sentence
  const both = action ? `${lead} ${action}` : lead;
  if (both.length <= SUMMARY_MAX) return both;
  if (lead.length <= SUMMARY_MAX) return lead;
  return `${lead.slice(0, SUMMARY_MAX - 1).replace(/\s+\S*$/, "")}…`;
}

function clampItem(v: string): string {
  return v.length <= DETAIL_MAX ? v : `${v.slice(0, DETAIL_MAX - 1).replace(/\s+\S*$/, "")}…`;
}

/** Breakout thesis ("WR3 behind X; snaps 40%→62%; 9.1 expected vs 6.0 actual ppg; value ~0.") → one item per fact. */
export function thesisItems(thesis: string): DetailItem[] {
  const out: DetailItem[] = [];
  for (const raw of thesis.split(/;\s+/)) {
    const part = raw.trim().replace(/\.$/, "");
    if (!part) continue;
    let m: RegExpExecArray | null;
    if ((m = /^snaps (.+)$/i.exec(part))) out.push({ label: "Snaps by week", value: m[1].replace(/→/g, " → ") });
    else if ((m = /^(targets|touch opps) (.+)$/i.exec(part))) out.push({ label: m[1] === "targets" ? "Targets by week" : "Touches by week", value: m[2].replace(/→/g, " → ") });
    else if ((m = /^([\d.]+) expected vs ([\d.]+) actual ppg$/i.exec(part))) out.push({ label: "Production", value: `${m[2]} actual vs ${m[1]} expected ppg` });
    else if (/^(market value|value ~0|our value)/i.test(part)) continue; // price: not a waiver question
    else out.push({ label: "Depth chart", value: part });
  }
  return out.map((d) => ({ ...d, value: clampItem(d.value) }));
}
function costText(usesFaab: boolean | undefined, budget: number | undefined, w: number | undefined, n: number, onWaivers: boolean, rankScore: number): string {
  if (!onWaivers) return usesFaab ? "Free agent: add now, no bid needed." : "Free agent: add now, no priority cost.";
  if (usesFaab) {
    const pct = Math.max(1, Math.min(40, Math.round(rankScore * 4)));
    return budget ? `Bid about $${Math.max(1, Math.round((budget * pct) / 100))} (${pct}% of $${budget}).` : `Bid about ${pct}% of your FAAB.`;
  }
  if (w === undefined) return "Costs your waiver priority.";
  if (w >= n) return "You are last in priority, so claiming costs nothing.";
  return `A claim uses your #${w} priority (you drop to #${n}).`;
}
