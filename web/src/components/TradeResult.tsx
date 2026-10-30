// One trade, laid out to dissect (owner, 2026-10-30): verdict bar, four KPI tiles, the players on each side, the
// lineup changes as small tables, then the checks table behind "Why this verdict". Shared by the Trade builder's
// Evaluate result and by every suggestion row, so a trade reads the same wherever it opens.
import { useState } from "react";
import type { DetailItem, Trade } from "../../../server/model/types";
import type { VP } from "../api";
import { deltaClass, f1, signed } from "../lib/format";
import { groupChecks, lineupTotal, parseLineupChange, toneIcon, verdictClass, verdictReason } from "../lib/tradeView";
import { Disclosure } from "./ExpandableRow";
import { ColumnHelp, HelpTip } from "./HelpTip";
import { PlayerChip } from "./PlayerChip";

export const TRADE_TIPS = {
  team: "Your weighted roster score change for the chosen mode (this week, rest of season, playoffs, bench depth).",
  accept: "Chance the other manager accepts, judged from his side: mostly what Yahoo's evaluator shows his lineup, lower if he gives a player right after a big game.",
  playoffGain: "Your lineup's change per week in the playoff weeks (15–17), by our projections. The verdict uses the selected mode's bar (Playoffs: this plus 0.25 × bench cover).",
  theirLineup: "Their weekly lineup points over the rest of the season, by our projections.",
  marketValue: "FantasyCalc trade-market value they get vs give. It matters only a little: managers judge by Yahoo's lineup numbers.",
  yahoo: "Lineup change Yahoo's trade evaluator would show, next week through the final week (Yahoo projections), you / them in total points. 'Estimate' = not captured yet: FantasyPros rank.",
  market: "Market value (FantasyCalc, from real trades; #1 = 100): what the other manager thinks he is worth.",
  ours: "Our projected points per game for the rest of the season, league scoring, games missed to injury or bye averaged in.",
  deltaCol: "Points per game gained (+) or lost (−) in that lineup slot.",
  checks: "Each check the verdict used, grouped by whose side it is. ✓ passes, ✗ fails, ! look at it, · information.",
};

const MODE_NAME = { now: "Win now", balanced: "Balanced", playoffs: "Playoffs" } as const;

const Num = ({ v, unit = "" }: { v: number | null | undefined; unit?: string }) => (
  <span className={`delta ${deltaClass(v)}`}>
    {signed(v)}
    {v == null ? "" : unit}
  </span>
);

export function TradeResult({
  trade,
  partnerName,
  verdict,
  onOpenBuilder,
}: {
  trade: Trade;
  partnerName: string;
  verdict?: string;
  /** Suggestion rows only: send this trade to the builder, prefilled. */
  onOpenBuilder?: () => void;
}) {
  const { me, them } = trade;
  const accCls = trade.acceptance >= 0.6 ? "good" : trade.acceptance >= 0.4 ? "warn" : "bad";
  const reason = verdict ? verdictReason(trade) : (trade.reason ?? trade.summary);
  const groups = groupChecks(withLabels(trade));
  return (
    <div className="tres">
      <div className="verdict-bar">
        {verdict && <span className={`verdict ${verdictClass(verdict)}`}>{verdict}</span>}
        <span className="verdict-reason">{reason}</span>
        {trade.mode && <span className="tag">{MODE_NAME[trade.mode]} mode</span>}
        {onOpenBuilder && (
          <button type="button" className="btn small-btn" onClick={onOpenBuilder}>
            Open in builder
          </button>
        )}
      </div>

      <div className="kpis">
        <Kpi label="Your playoff gain" tip={TRADE_TIPS.playoffGain}>
          <Num v={me.playoffDelta} unit=" /wk" />
        </Kpi>
        <Kpi label="Their lineup" tip={TRADE_TIPS.theirLineup}>
          <Num v={them.seasonDelta ?? them.lineupDelta} unit=" /wk" />
        </Kpi>
        <Kpi label="Acceptance" tip={TRADE_TIPS.accept}>
          <span className={`accept-chip ${accCls}`}>{Math.round(trade.acceptance * 100)}%</span>
        </Kpi>
        <Kpi label="Yahoo shows them" tip={TRADE_TIPS.yahoo}>
          {trade.yahooView ? (
            <>
              <Num v={trade.yahooView.you} /> / <Num v={trade.yahooView.them} />
              <span className="muted small kpi-sub">you / them{trade.yahooView.source === "estimate" ? ", est." : ""}</span>
            </>
          ) : (
            "—"
          )}
        </Kpi>
      </div>

      <div className="tscroll">
        <table className="rtable players-table">
          <thead>
            <tr>
              <th>Player</th>
              <th className="num">
                <ColumnHelp tip={TRADE_TIPS.ours}>Our pts/g</ColumnHelp>
              </th>
              <th className="num">
                <ColumnHelp tip={TRADE_TIPS.market}>Market</ColumnHelp>
              </th>
              <th className="labels-col">Labels</th>
            </tr>
          </thead>
          <PlayerBlock title="You give" players={me.gives} />
          <PlayerBlock title="You get" players={them.gives} />
        </table>
      </div>

      <div className="lineup-tables">
        <LineupTable title="Your lineup" lines={me.lineupChanges} />
        <LineupTable title={`${partnerName}'s lineup`} lines={them.lineupChanges} />
      </div>

      {trade.tags.length > 0 && (
        <div className="tags">
          {trade.tags.map((t) => (
            <span key={t} className={`tag${/^(buy-low|market undervalues)/.test(t) ? " tag-good" : /^(sell-high|market overvalues)/.test(t) ? " tag-warn" : ""}`}>
              {t}
            </span>
          ))}
        </div>
      )}

      {groups.length > 0 && (
        <Disclosure title="Why this verdict">
          <div className="tscroll">
            <table className="rtable checks-table">
              <thead>
                <tr>
                  <th>
                    <ColumnHelp tip={TRADE_TIPS.checks}>Check</ColumnHelp>
                  </th>
                  <th>Result</th>
                  <th className="icon-col">
                    <span className="sr-only">Status</span>
                  </th>
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.group}>
                  <tr className="group-row">
                    <th colSpan={3}>{g.group}</th>
                  </tr>
                  {g.items.map((d, i) => {
                    const t = toneIcon(d.tone);
                    return (
                      <tr key={`${d.label}-${i}`}>
                        <td className="muted">{d.label}</td>
                        <td className={d.tone ?? ""}>{d.value}</td>
                        <td className={`icon-col ${d.tone ?? ""}`} title={t.label} aria-label={t.label}>
                          {t.icon}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        </Disclosure>
      )}

      {trade.pitch && (
        <Disclosure title="Message to send">
          <Pitch text={trade.pitch} />
        </Disclosure>
      )}
    </div>
  );
}

/** The trade-level sentences (Yahoo view, lineup impact, market) join the server's checks, so none is dropped. */
function withLabels(trade: Trade): DetailItem[] {
  const extra: DetailItem[] = [];
  if (trade.yahooView) extra.push({ label: "Their view (Yahoo)", value: trade.yahooView.label, ...(trade.yahooView.them < 0 ? { tone: "neg" as const } : {}) });
  if (trade.lineupLabel) extra.push({ label: "Your lineup impact", value: trade.lineupLabel });
  if (trade.marketLabel) extra.push({ label: "Market value", value: trade.marketLabel });
  return [...(trade.details ?? []), ...extra];
}

function Kpi({ label, tip, children }: { label: string; tip: string; children: React.ReactNode }) {
  return (
    <div className="kpi">
      <span className="kpi-label">
        <ColumnHelp tip={tip}>{label}</ColumnHelp>
      </span>
      <span className="kpi-value">{children}</span>
    </div>
  );
}

function PlayerBlock({ title, players }: { title: string; players: VP[] }) {
  return (
    <tbody>
      <tr className="group-row">
        <th colSpan={4}>{title}</th>
      </tr>
      {players.map((p) => {
        const labels = (
          <>
            {p.riser && <span className="tag small-tag tag-good">riser</span>}
            {p.injury?.status && <span className="tag small-tag tag-warn">{p.injury.status}</span>}
            {p.marketEstimated && <span className="tag small-tag">market est.</span>}
          </>
        );
        return (
          <tr key={p.id}>
            <td>
              <PlayerChip player={p} showValue={false} compact />
              <div className="labels-inline">{labels}</div>
            </td>
            <td className="num">
              {f1(p.ppg)} <HelpTip items={p.whyItems} label={`How ${p.name} is valued`} />
            </td>
            <td className="num">
              {p.market !== undefined ? f1(p.market) : "—"}
              {p.marketEstimated ? "*" : ""}
            </td>
            <td className="labels-col">{labels}</td>
          </tr>
        );
      })}
    </tbody>
  );
}

function LineupTable({ title, lines }: { title: string; lines: string[] }) {
  const rows = lines.map(parseLineupChange);
  const total = lineupTotal(rows);
  return (
    <div className="tscroll">
      <table className="rtable lineup-change">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Slot</th>
            <th>Out</th>
            <th>In</th>
            <th className="num">
              <ColumnHelp tip={TRADE_TIPS.deltaCol}>Δ pts/g</ColumnHelp>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No starter changes (bench only).
              </td>
            </tr>
          )}
          {rows.map((r, i) =>
            r.note !== undefined ? (
              <tr key={i}>
                <td colSpan={4} className="muted">
                  {r.note}
                </td>
              </tr>
            ) : (
              <tr key={i}>
                <td className="strong">{r.slot}</td>
                <td>
                  {r.out ?? "empty"} <span className="muted small">{r.outPts !== undefined ? f1(r.outPts) : ""}</span>
                </td>
                <td>
                  {r.inn ?? "empty"} <span className="muted small">{r.inPts !== undefined ? f1(r.inPts) : ""}</span>
                </td>
                <td className="num">
                  <Num v={r.delta} />
                </td>
              </tr>
            ),
          )}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={3}>Total</td>
              <td className="num">
                <Num v={total} />
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function Pitch({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  };
  return (
    <div className="pitch">
      <span className="pitch-text">“{text}”</span>
      <button className="btn small-btn" onClick={copy} title="Copy this message to send to the other manager">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
