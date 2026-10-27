// One trade as a collapsed row (owner rule: key line visible, everything else on tap as bullets).
// Row: partner + the ≤ 255-char summary ("A for B: your team +x …"), your-team delta and acceptance.
// Details: both sides' players (value bullets behind "?"), the pasteable pitch, the three lineup numbers,
// lineup changes per side, then one "label: value" item per fact from the server.
import { useState } from "react";
import type { Trade } from "../../../server/model/types";
import type { VP } from "../api";
import { deltaClass, f1, signed } from "../lib/format";
import { DetailList, ExpandableRow } from "./ExpandableRow";
import { ColumnHelp, HelpTip } from "./HelpTip";
import { PlayerChip } from "./PlayerChip";

function verdictClass(v: string): string {
  if (/^accept/i.test(v)) return "good";
  if (/decline|reject/i.test(v)) return "bad";
  return "warn";
}

export const TRADE_TIPS = {
  team: "Your weighted roster score change for the chosen mode (this week, rest of season, playoffs, bench depth).",
  accept: "Chance the other manager accepts, judged from his side: mostly what Yahoo's evaluator shows his lineup, lower if he gives a player right after a big game.",
  yourLineup: "Your weekly lineup points over the rest of the season, byes and injuries included.",
  theirLineup: "Their weekly lineup points over the rest of the season, by our projections.",
  lineup: "Lineup change per week over the rest of the season by our projections (usage, matchups, injuries), for you and for them.",
  marketValue: "FantasyCalc trade-market value they get vs give. It matters only a little: managers judge by Yahoo's lineup numbers.",
  yahoo: "Rest-of-season lineup change Yahoo's trade evaluator would show (Yahoo projections). 'Estimate' = not captured yet: FantasyPros rank + last 3 games.",
  market: "Market value (FantasyCalc, from real trades; #1 = 100): what the other manager thinks he is worth.",
  ours: "Our 0–100 rest-of-season value from projected points above replacement and games left.",
};

/** The row's key line: who goes where ("Colston Loveland → Jameson Williams"); the full sentence opens with the details. */
function swapLine(trade: Trade): string {
  const names = (ps: { name: string }[]) => ps.map((p) => p.name).join(" + ");
  return `${names(trade.me.gives)} → ${names(trade.them.gives)}`;
}

export function TradeCard({ trade, partnerName, verdict, defaultOpen = false }: { trade: Trade; partnerName: string; verdict?: string; defaultOpen?: boolean }) {
  const { me, them } = trade;
  const accCls = trade.acceptance >= 0.6 ? "good" : trade.acceptance >= 0.4 ? "warn" : "bad";
  const head = (
    <>
      <div className="tr-main">
        <div className="tr-eyebrow muted">
          with {partnerName}
          {verdict && <span className={`verdict ${verdictClass(verdict)}`}>{verdict}</span>}
        </div>
        <div className="tr-summary">{swapLine(trade)}</div>
      </div>
      <span className={`num tr-team delta ${deltaClass(me.scoreDelta)}`}>{signed(me.scoreDelta ?? me.lineupDelta)}</span>
      <span className={`num tr-accept accept-chip ${accCls}`}>{Math.round(trade.acceptance * 100)}%</span>
    </>
  );
  return (
    <ExpandableRow className="trade-row" head={head} defaultOpen={defaultOpen} label={`Trade with ${partnerName}`}>
      <div className="one-line">{trade.summary}</div>
      {trade.reason && <div className="notice warn small one-line">{trade.reason}</div>}
      <div className="trade-cols">
        <Side title="You give" players={me.gives} total={me.valueGiven} drops={me.drops} market={!!trade.marketLabel} />
        <Side title="You get" players={them.gives} total={them.valueGiven} market={!!trade.marketLabel} />
      </div>
      {trade.pitch && <Pitch text={trade.pitch} />}
      <div className="trade-metrics">
        <Metric label="Your lineup" value={me.seasonDelta ?? me.lineupDelta} unit=" /wk" tip={TRADE_TIPS.yourLineup} />
        <Metric label="Their lineup" value={them.seasonDelta ?? them.lineupDelta} unit=" /wk" tip={TRADE_TIPS.theirLineup} />
        <Metric label="Your team" value={me.scoreDelta ?? me.lineupDelta} unit="" tip={TRADE_TIPS.team} />
      </div>
      {(trade.yahooView || trade.lineupLabel || trade.marketLabel) && (
        <ul className="trade-labels">
          {trade.yahooView && (
            <li className={trade.yahooView.them < 0 ? "neg" : undefined}>
              {trade.yahooView.label} <HelpTip text={TRADE_TIPS.yahoo} />
            </li>
          )}
          {trade.lineupLabel && (
            <li>
              {trade.lineupLabel} <HelpTip text={TRADE_TIPS.lineup} />
            </li>
          )}
          {trade.marketLabel && (
            <li className="muted">
              {trade.marketLabel} <HelpTip text={TRADE_TIPS.marketValue} />
            </li>
          )}
        </ul>
      )}
      <div className="trade-cols">
        <Changes title="Your lineup" lines={me.lineupChanges} />
        <Changes title={`${partnerName}'s lineup`} lines={them.lineupChanges} />
      </div>
      <DetailList items={trade.details ?? []} />
      {trade.tags.length > 0 && (
        <div className="tags">
          {trade.tags.map((t) => (
            <span key={t} className={`tag${/^(buy-low|market undervalues)/.test(t) ? " tag-good" : /^(sell-high|market overvalues)/.test(t) ? " tag-warn" : ""}`}>
              {t}
            </span>
          ))}
        </div>
      )}
    </ExpandableRow>
  );
}

function Side({ title, players, total, drops, market: marketTotals }: { title: string; players: VP[]; total: number; drops?: VP[]; market?: boolean }) {
  // Per-player market + our value whenever market values exist (bench-upgrade cards too), not only on v3 cards.
  const market = marketTotals || players.some((p) => p.market !== undefined);
  return (
    <div className="trade-side">
      <div className="side-title">
        {title}{" "}
        <span className="muted small">
          {marketTotals ? "market" : "value"} {f1(total)}
        </span>
        <HelpTip text={marketTotals ? "Market package value: best player + 85% of the 2nd + 70% of the 3rd." : "Sum of our values."} />
      </div>
      <ul className="side-players">
        {players.map((p) => (
          <li key={p.id} className="side-player">
            <PlayerChip player={p} showValue={!market} compact />
            <span className="muted small side-meta">
              {p.pos}
              {p.posRank} {f1(p.ppg)} ppg
            </span>
            {market && (
              <span className="muted small side-meta">
                mkt {f1(p.market ?? p.value)}
                {p.marketEstimated ? "*" : ""} ours {f1(p.value)}
              </span>
            )}
            {p.riser && <span className="tag small-tag">riser</span>}
            <HelpTip items={p.whyItems} label={`How ${p.name} is valued`} />
          </li>
        ))}
      </ul>
      {drops && drops.length > 0 && (
        <div className="muted small drop-note">
          + you drop {drops.map((p) => `${p.name} (${f1(p.value)})`).join(", ")}
        </div>
      )}
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
      <button className="link-btn small" onClick={copy} title="Copy this message to send to the other manager">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Metric({ label, value, unit, tip }: { label: string; value: number; unit: string; tip: string }) {
  return (
    <div className="metric">
      <span className="metric-label">
        <ColumnHelp tip={tip}>{label}</ColumnHelp>
      </span>
      <span className={`metric-value delta ${deltaClass(value)}`}>
        {signed(value)}
        {unit}
      </span>
    </div>
  );
}

function Changes({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div>
      <div className="side-title">{title}</div>
      {lines.length ? (
        <ul className="changes">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No starter changes (bench only).</p>
      )}
    </div>
  );
}
