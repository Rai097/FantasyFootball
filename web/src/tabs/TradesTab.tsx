import { useState } from "react";
import { api, type Active, type Analysis, type TradeMode } from "../api";
import type { Trade } from "../../../server/model/types";
import { Empty, ErrorBox, Loading } from "../components/common";
import { TradeBuilder } from "../components/TradeBuilder";
import { TradeCard } from "../components/TradeCard";
import { useAsync } from "../lib/useAsync";

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
                <option value={2}>Up to 2 (3-for-1 outside Win now)</option>
              </select>
            </label>
          </div>
        </section>

        {res.loading && <Loading label="Scoring every package against every team…" />}
        {res.error && <ErrorBox error={res.error} onRetry={res.reload} />}
        {!res.loading && data && (
          <>
            <div className="notice finder-summary">{data.summary}</div>
            {data.trades.length === 0 ? (
              <Empty>No clear win right now. Check the smaller edges, near misses and bench upgrades below, or try another mode.</Empty>
            ) : (
              <>
                <p className="muted small">
                  {data.trades.length} clear win{data.trades.length > 1 ? "s" : ""} (your team +1.0 or more, ≥ 45% likely accepted), best first by your gain × acceptance.
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
            <Fold title="Smaller edges" count={data.smallerEdges.length} hint="+0.5 to +1.0 for you, still fair to them">
              {data.smallerEdges.map((t) => (
                <TradeCard key={t.key} trade={t} partnerName={nameOf(t)} />
              ))}
            </Fold>
            <Fold title="Near misses" count={data.nearMisses.length} hint="good for you, but they'd likely refuse — or only marginal for you">
              {data.nearMisses.map((t) => (
                <TradeCard key={t.key} trade={t} partnerName={nameOf(t)} />
              ))}
            </Fold>
          </>
        )}

        <h2 className="section-title">Bench upgrades</h2>
        <p className="muted small">1-for-1 swaps of a bench player (or your weakest starter) for someone else's bench player that raise your rest-of-season or playoff lineup.</p>
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
