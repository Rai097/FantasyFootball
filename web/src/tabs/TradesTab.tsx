import { useState } from "react";
import { api, type Active, type Analysis } from "../api";
import { Empty, ErrorBox, Loading } from "../components/common";
import { TradeBuilder } from "../components/TradeBuilder";
import { TradeCard } from "../components/TradeCard";
import { useAsync } from "../lib/useAsync";

const POSITIONS = ["QB", "RB", "WR", "TE"];

export function TradesTab({ analysis, active }: { analysis: Analysis; active: Active & { team: string } }) {
  const [partner, setPartner] = useState("");
  const [wantPos, setWantPos] = useState("");
  const [size, setSize] = useState(2);
  const [shown, setShown] = useState(10);
  const others = analysis.teams.filter((t) => t.team.id !== active.team);
  const names = new Map(analysis.teams.map((t) => [t.team.id, t.team.name]));
  const me = analysis.teams.find((t) => t.team.id === active.team);

  const trades = useAsync(
    () => api.trades(active, { partner: partner || undefined, wantPos: wantPos || undefined, maxGive: size, maxGet: size }),
    [active.provider, active.id, active.team, partner, wantPos, size],
  );

  const { currentWeek, tradeDeadlineWeek } = analysis.league.settings;
  const pastDeadline = tradeDeadlineWeek != null && currentWeek > tradeDeadlineWeek;

  return (
    <div className="grid-trades">
      <div className="stack">
        {pastDeadline && <div className="notice warn">The trade deadline (week {tradeDeadlineWeek}) has passed — the finder returns no trades.</div>}
        <section className="card filters">
          <label className="field">
            <span>Partner</span>
            <select value={partner} onChange={(e) => (setPartner(e.target.value), setShown(10))}>
              <option value="">All teams</option>
              {others.map((t) => (
                <option key={t.team.id} value={t.team.id}>
                  {t.team.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>I want a</span>
            <select value={wantPos} onChange={(e) => (setWantPos(e.target.value), setShown(10))}>
              <option value="">Any position</option>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                  {me?.needs.includes(p) ? " (need)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Package size</span>
            <select value={size} onChange={(e) => (setSize(Number(e.target.value)), setShown(10))}>
              <option value={1}>1-for-1 only</option>
              <option value={2}>Up to 2 players</option>
            </select>
          </label>
        </section>

        {trades.loading && <Loading label="Searching every package with every team…" />}
        {trades.error && <ErrorBox error={trades.error} onRetry={trades.reload} />}
        {!trades.loading && trades.data && trades.data.length === 0 && (
          <Empty>No trade found that clearly lifts your starting lineup without hurting the other side too much. Try another partner or a larger package.</Empty>
        )}
        {!trades.loading && trades.data && trades.data.length > 0 && (
          <>
            <p className="muted small">
              {trades.data.length} trade{trades.data.length > 1 ? "s" : ""} found, best first (your lineup gain × acceptance chance).
            </p>
            {trades.data.slice(0, shown).map((t) => (
              <TradeCard key={t.key} trade={t} partnerName={names.get(t.them.teamId) ?? t.them.teamId} />
            ))}
            {shown < trades.data.length && (
              <button className="btn" onClick={() => setShown((s) => s + 10)}>
                Show more ({trades.data.length - shown} left)
              </button>
            )}
          </>
        )}
      </div>
      <aside>
        <TradeBuilder analysis={analysis} active={active} />
      </aside>
    </div>
  );
}
