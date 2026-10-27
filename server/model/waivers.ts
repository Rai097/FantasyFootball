// Free-agent ranking + waiver-priority advice. See docs/DESIGN.md "Waivers" (+ amendments).
import type { Availability, DetailItem, Position, StashRow, ValuedPlayer, WaiverBreakout, WaiverRow, WaiverTarget } from "./types.js";
import { eligible, optimalLineup, slotLabels } from "./lineup.js";
import { irSet, rosterOf } from "./analysis.js";
import type { TradeContext } from "./tradeKit.js";
import { injuryKind, isQuestionable } from "./projection.js";
import { luckText } from "./labels.js";

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
}

const r1 = (x: number) => Math.round(x * 10) / 10;
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
    const { drop, gain, benchGain, rankScore } = best;

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
    const startsText =
      best.slot >= 0 ? `Starts at ${labels[best.slot]}${replaced && replaced.id !== drop?.id ? ` over ${replaced.name}` : ""}` : "Bench depth";

    let recommendation: WaiverTarget["recommendation"];
    /** The rule that produced the call (short, shown in details). */
    let rule: string;
    /** Summary sentences: the most important fact, then what to do. */
    let lead: string;
    let action: string | undefined;
    const ruleItems: DetailItem[] = [];
    if (isKDef) {
      // Kickers / defenses are streamed: never spend rolling-list priority (or a bid) on them, and only a real
      // weekly gain makes one worth streaming (value alone, e.g. more games left, is not a streaming upgrade).
      if (!(gain > 0.05)) {
        recommendation = "pass";
        rule = `Not an upgrade on your current ${fa.pos}`;
        lead = `Not an upgrade on your current ${fa.pos}.`;
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
      recommendation = "claim";
      rule = "Future starter: rising role with flex-level work";
      lead = `Rising role: ${bo!.oppLevel.toFixed(1)} expected pts/g, breakout score ${bo!.score.toFixed(0)}.`;
      action = free ? "Free agent: add him before he starts." : "Claim him before he starts.";
    } else if (valueJump && top3AtNeed) {
      recommendation = "claim";
      rule = `Top-3 free-agent ${fa.pos} at a need, ≥1.5× your drop's value`;
      lead = `Top-3 free-agent ${fa.pos} at a position you need${drop ? `, worth more than ${drop.name}` : ""}.`;
      action = cost;
    } else if (gain <= 0.05 && benchGain <= 0) {
      const stash = !!bo && bo.score >= STASH.score && bo.oppLevel >= STASH.oppLevel;
      recommendation = stash ? "stash" : "pass";
      if (stash) {
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
    const toneOf = (x: number) => (x > 0.05 ? "pos" : x < -0.05 ? "neg" : undefined);
    item("Rule", rule);
    for (const d of ruleItems) item(d.label, d.value);
    item("Lineup", startsText);
    item("Lineup gain", `${fmtSigned(gain)} ppg`, toneOf(gain));
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
    }
    // The call pill and the FA / W badge are on the row already; details add the cost, or the status when it costs nothing to know.
    if (ACTIONABLE.has(recommendation)) item("Cost", cost);
    if (avail === "unknown") item("Availability", "Unknown: re-import to see free agents");
    else if (!ACTIONABLE.has(recommendation)) item("Availability", avail === "fa" ? "Free agent" : "On waivers");

    const { why: _valueWhy, ...base0 } = fa;
    return {
      ...base0,
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
  if (!S.usesFaab && w !== undefined) rule("Priority", w >= n ? `You are #${n} of ${n}: claiming costs nothing` : `You are #${w} of ${n}: a claim drops you to #${n}`);
  else if (!S.usesFaab) rule("Priority", "Your waiver priority is unknown");
  rule("Free agents", S.usesFaab ? "No bid needed: add any time" : "No priority cost: add any time");

  const faStatusKnown = !freeAgents.length || freeAgents.some((f) => f.availability !== "unknown");
  return { freeAgents: limited, myPriority: w, numTeams: n, advice: adviceLine(limited, w, n, S.usesFaab), rules, faStatusKnown };
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
  if (t.injury) row.injury = t.injury;
  if (t.percentOwned != null) row.percentOwned = t.percentOwned;
  if (t.breakout) {
    const { thesis: _t, ...b } = t.breakout;
    row.breakout = b;
  }
  return row;
}

export const toWaiversResponse = (r: WaiverResult, stash: StashRow[] = []): WaiversResponse => ({ ...r, freeAgents: r.freeAgents.map(toWaiverRow), stash });

const ACTIONABLE = new Set<WaiverTarget["recommendation"]>(["claim", "optional", "stash"]);

/** Top advice line, ≤ 255 chars: priority, then counts with up to 2 names each (fewer names when long). */
export function adviceLine(rows: WaiverTarget[], w: number | undefined, n: number, usesFaab?: boolean): string {
  const claims = rows.filter((t) => t.recommendation === "claim" && t.onWaivers);
  const freeAdds = rows.filter((t) => ACTIONABLE.has(t.recommendation) && !t.onWaivers);
  const stashes = rows.filter((t) => t.recommendation === "stash" && t.onWaivers);
  const head = usesFaab ? "FAAB league." : w !== undefined ? `You hold waiver priority #${w} of ${n}.` : "";
  for (const k of [2, 1, 0]) {
    const names = (xs: WaiverTarget[]) => (k && xs.length ? ` (${xs.slice(0, k).map((x) => x.name).join(", ")})` : "");
    const parts: string[] = [];
    if (claims.length) parts.push(`${claims.length} worth a claim${names(claims)}`);
    if (freeAdds.length) parts.push(`${freeAdds.length} free to add now${names(freeAdds)}`);
    if (stashes.length) parts.push(`${stashes.length} to stash${names(stashes)}`);
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
