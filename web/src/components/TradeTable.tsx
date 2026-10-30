// Trades as a table (owner, 2026-10-30): Partner | You give | You get | Your gain | Accept. Each row is collapsed to
// that key line; tapping opens the shared TradeResult. Used for Trades, Smaller edges, Near misses and Bench upgrades.
import type { Trade } from "../../../server/model/types";
import { deltaClass, signed } from "../lib/format";
import { ExpandableList, ExpandableRow } from "./ExpandableRow";
import { ColumnHelp } from "./HelpTip";
import { TRADE_TIPS, TradeResult } from "./TradeResult";

const names = (ps: { name: string }[]) => ps.map((p) => p.name).join(" + ") || "—";

export function TradeTable({
  trades,
  nameOf,
  label,
  onOpenBuilder,
}: {
  trades: Trade[];
  nameOf: (t: Trade) => string;
  label: string;
  onOpenBuilder: (t: Trade) => void;
}) {
  return (
    <ExpandableList
      className="trade-list"
      label={label}
      header={
        <>
          <span>Partner</span>
          <span>You give</span>
          <span>You get</span>
          <span className="num">
            <ColumnHelp tip={TRADE_TIPS.team}>Your gain</ColumnHelp>
          </span>
          <span className="num">
            <ColumnHelp tip={TRADE_TIPS.accept}>Accept</ColumnHelp>
          </span>
        </>
      }
    >
      {trades.map((t) => (
        <TradeRow key={t.key} trade={t} partnerName={nameOf(t)} onOpenBuilder={() => onOpenBuilder(t)} />
      ))}
    </ExpandableList>
  );
}

function TradeRow({ trade, partnerName, onOpenBuilder }: { trade: Trade; partnerName: string; onOpenBuilder: () => void }) {
  const { me, them } = trade;
  const accCls = trade.acceptance >= 0.6 ? "good" : trade.acceptance >= 0.4 ? "warn" : "bad";
  const gain = me.scoreDelta ?? me.lineupDelta;
  return (
    <ExpandableRow
      className="trade-row"
      label={`Trade with ${partnerName}`}
      head={
        <>
          <span className="tr-partner strong">{partnerName}</span>
          <span className="tr-give" data-label="Give">
            {names(me.gives)}
          </span>
          <span className="tr-get" data-label="Get">
            {names(them.gives)}
          </span>
          <span className={`num tr-gain delta ${deltaClass(gain)}`}>{signed(gain)}</span>
          <span className={`num tr-accept accept-chip ${accCls}`}>{Math.round(trade.acceptance * 100)}%</span>
        </>
      }
    >
      <TradeResult trade={trade} partnerName={partnerName} onOpenBuilder={onOpenBuilder} />
    </ExpandableRow>
  );
}
