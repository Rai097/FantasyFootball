import { useState } from "react";
import { api, type Active, type Analysis, type TradeMode } from "../api";
import type { Trade } from "../../../server/model/types";
import { Empty, ErrorBox, Loading } from "../components/common";
import { TradeBuilder } from "../components/TradeBuilder";
import { TradeCard } from "../components/TradeCard";
import { useAsync } from "../lib/useAsync";
import { f1 } from "../lib/format";

const POSITIONS = ["QB", "RB", "WR", "TE"];

const MODES: { id: TradeMode; label: string; blurb: string }[] = [
  { id: "now", label: "Win now", blurb: "This week's starting lineup, with a little credit for bench depth." },
  { id: "balanced", label: "Balanced", blurb: "This week, the rest of the season (byes and injuries included), the playoffs and bench depth." },
  { id: "playoffs", label: "Playoffs", blurb: "Your lineup in the playoff weeks first, then the rest of the season and depth." },
];

const MODE_KEY = "ftd.tradeMode";
function loadMode(): TradeMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === "now" || m === "playoffs" || m === "balanced" ? m : "balanced";
  } catch {
    return "balanced";
  }
}

export function TradesTab({ analysis, active }: { analysis: Analysis; active: Active & { team: string } }) {
  const [mode, setModeState] = useState<TradeMode>(loadMode);
  const [partner, setPartner] = useState("");
  const [wantPos, setWantPos] = useState("");
  const [size, setSize] = useState(2);
  const [shown, setShown] = useState(10);
  const others = analysis.teams.filter((t) => t.team.id !== active.team);
  const names = new Map(analysis.teams.map((t) => [t.team.id, t.team.name]));
  const me = analysis.teams.find((t) => t.team.id === active.team);
  const nameOf = (t: Trade) => names.get(t.them.teamId) ?? t.them.teamId;
  const setMode = (m: TradeMode) => {
    setModeState(m);
    setShown(10);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private mode: not remembered */
    }
  };

  const res = useAsync(
    () => api.trades2(active, { mode, partner: partner || undefined, wantPos: wantPos || undefined, maxGive: size, maxGet: size }),
    [active.provider, active.id, active.team, mode, partner, wantPos, size],
  );
  const bench = useAsync(() => api.benchUpgrades(active, mode), [active.provider, active.id, active.team, mode]);

  const { currentWeek, tradeDeadlineWeek } = analysis.league.settings;
  const pastDeadline = tradeDeadlineWeek != null && currentWeek > tradeDeadlineWeek;
  const data = res.data;
  const blurb = MODES.find((m) => m.id === mode)!.blurb;

  return (
    <div className="grid-trades">
      <div className="stack">
        {pastDeadline && <div className="notice warn">The trade deadline (week {tradeDeadlineWeek}) has passed — the finder returns no trades.</div>}
        <section className="card stack-sm">
          <div className="mode-picker">
            <div className="seg" role="radiogroup" aria-label="What to optimise for">
              {MODES.map((m) => (
                <button key={m.id} role="radio" aria-checked={mode === m.id} className={`seg-btn ${mode === m.id ? "active" : ""}`} onClick={() => setMode(m.id)} title={m.blurb}>
                  {m.label}
                </button>
              ))}
            </div>
            <span className="muted small">{blurb}</span>
          </div>
          <div className="filters">
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
                <option value={2}>Up to 2 (3-for-1 to struggling teams)</option>
              </select>
            </label>
          </div>
        </section>

        {res.loading && <Loading label="Scoring every package against every team…" />}
        {res.error && <ErrorBox error={res.error} onRetry={res.reload} />}
        {!res.loading && data && (
          <>
            {data.valueSource === "model" && (
              <div className="notice warn small">Market values (FantasyCalc) are unavailable right now, so "what the other manager thinks" uses our own values: fairness and acceptance are rougher, and buy-low / sell-high edges are not shown.</div>
            )}
            {data.trades.length === 0 ? (
              <section className="card stack-sm empty-finder">
                <div className="notice warn finder-summary strong-summary">{data.summary}</div>
                {(data.partners?.length ?? 0) > 0 && (
                  <>
                    <h3>Best-fit partners — where a plausible ask starts</h3>
                    <ol className="partner-list">
                      {data.partners!.slice(0, 3).map((p) => (
                        <li key={p.teamId}>
                          <span className="strong">{names.get(p.teamId) ?? p.teamId}</span> <span className="muted small">fit {f1(p.complementarity)}</span>
                          <div className="small">{p.pitch}</div>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
                {data.nearMisses.length > 0 && (
                  <>
                    <h3>Closest near misses</h3>
                    {data.nearMisses.slice(0, 3).map((t) => (
                      <TradeCard key={t.key} trade={t} partnerName={nameOf(t)} defaultOpen />
                    ))}
                  </>
                )}
                <p className="muted small">Also check the smaller edges and bench upgrades below, or try another mode.</p>
              </section>
            ) : (
              <>
                <div className="notice finder-summary">{data.summary}</div>
                <p className="muted small">
                  {data.trades.length} trade{data.trades.length > 1 ? "s" : ""} a manager would plausibly accept (your team +1.0 or more, fair or better for them by market value, their lineup not worse), best first by min(your gain, theirs + 2) × acceptance.
                </p>
                {data.trades.slice(0, shown).map((t) => (
                  <TradeCard key={t.key} trade={t} partnerName={nameOf(t)} />
                ))}
                {shown < data.trades.length && (
                  <button className="btn" onClick={() => setShown((s) => s + 10)}>
                    Show more ({data.trades.length - shown} left)
                  </button>
                )}
              </>
            )}
            <Fold title="Best-fit partners" count={data.partners?.length ?? 0} hint="ranked by how their needs match your surplus (and vice versa)">
              <ol className="partner-list">
                {data.partners?.map((p) => (
                  <li key={p.teamId}>
                    <span className="strong">{names.get(p.teamId) ?? p.teamId}</span> <span className="muted small">fit {f1(p.complementarity)}</span>
                    <div className="muted small">{p.pitch}</div>
                  </li>
                ))}
              </ol>
            </Fold>
            <Fold title="Smaller edges" count={data.smallerEdges.length} hint="smaller gains for you (or small-value deals), still fair to them">
              {data.smallerEdges.map((t) => (
                <TradeCard key={t.key} trade={t} partnerName={nameOf(t)} />
              ))}
            </Fold>
            <Fold
              title={data.trades.length === 0 ? "More near misses" : "Near misses"}
              count={data.trades.length === 0 ? Math.max(0, data.nearMisses.length - 3) : data.nearMisses.length}
              hint="good for you, but they'd likely refuse — or only marginal for you"
            >
              {data.nearMisses.slice(data.trades.length === 0 ? 3 : 0).map((t) => (
                <TradeCard key={t.key} trade={t} partnerName={nameOf(t)} />
              ))}
            </Fold>
          </>
        )}

        <h2 className="section-title">Bench upgrades</h2>
        <p className="muted small">1-for-1 swaps of a bench player (or your weakest starter) for someone else's bench player that add 0.8+ pts/week to your rest-of-season lineup; same eligibility and QB rule as the finder; both players worth 3+ by market and by our value, and the one you get is a real asset (market 8+ or our value 5+).</p>
        {bench.loading && <Loading label="Looking for bench upgrades…" />}
        {bench.error && <ErrorBox error={bench.error} onRetry={bench.reload} />}
        {!bench.loading && bench.data && bench.data.length === 0 && <Empty>No bench swap raises your season or playoff lineup at a price the other side would take.</Empty>}
        {!bench.loading && bench.data?.map((t) => <TradeCard key={t.key} trade={t} partnerName={nameOf(t)} />)}
      </div>
      <aside>
        <TradeBuilder analysis={analysis} active={active} />
      </aside>
    </div>
  );
}

function Fold({ title, count, hint, children }: { title: string; count: number; hint: string; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <details className="fold">
      <summary>
        {title} ({count}) <span className="muted small">— {hint}</span>
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}
