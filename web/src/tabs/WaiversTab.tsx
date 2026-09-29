import { useState } from "react";
import { api, type Active, type Analysis } from "../api";
import { Empty, ErrorBox, Loading, PosBadge, Why } from "../components/common";
import { InjuryDot } from "../components/PlayerChip";
import { deltaClass, f1, signed } from "../lib/format";
import { useAsync } from "../lib/useAsync";

const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

export function WaiversTab({ analysis, active }: { analysis: Analysis; active: Active & { team: string } }) {
  const [pos, setPos] = useState("");
  const res = useAsync(() => api.waivers(active), [active.provider, active.id, active.team]);

  if (res.error) return <ErrorBox error={res.error} onRetry={res.reload} />;
  if (!res.data) return <Loading label="Ranking free agents…" />;
  const { freeAgents, myPriority, numTeams, advice } = res.data;
  const rows = freeAgents.filter((p) => !pos || p.pos === pos);
  const showOwned = freeAgents.some((p) => p.percentOwned != null);
  const { usesFaab, faabBudget } = analysis.league.settings;
  const faabLeft = analysis.league.teams.find((t) => t.id === active.team)?.faabRemaining;

  return (
    <div className="stack">
      <section className="card waiver-head">
        <div className="row gap wrap">
          {myPriority != null ? (
            <span className="pill big">
              Waiver priority <b>#{myPriority}</b> of {numTeams}
            </span>
          ) : (
            <span className="pill big muted">Waiver priority unknown</span>
          )}
          {usesFaab && (
            <span className="pill big">
              FAAB <b>${faabLeft ?? "?"}</b>
              {faabBudget != null ? ` of $${faabBudget}` : ""} left
            </span>
          )}
          <PosFilter value={pos} onChange={setPos} options={POSITIONS} />
        </div>
        <p className="advice">{advice}</p>
      </section>

      {rows.length === 0 ? (
        <Empty>No free agents{pos ? ` at ${pos}` : ""}.</Empty>
      ) : (
        <div className="table-wrap card flush">
          <table className="table waivers">
            <thead>
              <tr>
                <th>Player</th>
                <th className="num">PPG</th>
                <th className="num">Value</th>
                <th className="num" title="Starting-lineup ppg change if you add him and drop your weakest bench player">
                  Gain
                </th>
                <th className="hide-sm">Drop</th>
                <th className="num" title="Expected points last 2 weeks vs season average">
                  Trend
                </th>
                {showOwned && <th className="num hide-sm">% own</th>}
                <th>Call</th>
                <th className="hide-sm why-col">Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="player-td">
                    <div className="player-cell">
                      <PosBadge pos={p.pos} />
                      <span className="strong">{p.name}</span>
                      <span className="muted small">{p.team}</span>
                      <InjuryDot player={p} />
                      {p.onWaivers && (
                        <span className="tag small-tag" title="On waivers: needs a claim">
                          W
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="num" data-label="PPG">{f1(p.ppg)}</td>
                  <td className="num" data-label="Value">{f1(p.value)}</td>
                  <td className="num" data-label="Gain">
                    <span className={`delta ${deltaClass(p.gain)}`}>{signed(p.gain)}</span>
                    <div className={`small delta ${deltaClass(p.benchGain)}`} title="Value gained vs the player you'd drop">
                      {signed(p.benchGain)} val
                    </div>
                  </td>
                  <td className="hide-sm small">{p.drop ? `${p.drop.name} (${f1(p.drop.value)})` : "–"}</td>
                  <td className="num" data-label="Trend">
                    <Trend value={p.trend} />
                    {p.snapTrend != null && Number.isFinite(p.snapTrend) && Math.abs(p.snapTrend) >= 0.05 && (
                      <div className={`small delta ${p.snapTrend > 0 ? "pos" : "neg"}`} title="Last-week snap share vs earlier weeks">
                        {p.snapTrend > 0 ? "+" : ""}
                        {f1(p.snapTrend * 100)}% snaps
                      </div>
                    )}
                  </td>
                  {showOwned && <td className="num hide-sm">{p.percentOwned != null ? `${f1(p.percentOwned)}%` : "–"}</td>}
                  <td className="call-td">
                    <span className={`rec rec-${p.recommendation}`}>{p.recommendation}</span>
                    <span className="show-sm">
                      <Why text={p.why} />
                    </span>
                  </td>
                  <td className="hide-sm why-col small muted">{p.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Trend({ value }: { value: number | undefined }) {
  if (value == null || !Number.isFinite(value)) return <span className="muted">–</span>;
  const cls = deltaClass(value, 0.5);
  const arrow = cls === "pos" ? "▲" : cls === "neg" ? "▼" : "▬";
  return (
    <span className={`trend delta ${cls}`} title={`${signed(value)} expected pts vs season average`}>
      {arrow} {signed(value)}
    </span>
  );
}

export function PosFilter({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <div className="seg" role="group" aria-label="Position filter">
      {["", ...options].map((o) => (
        <button key={o || "all"} className={`seg-btn${value === o ? " active" : ""}`} onClick={() => onChange(o)} aria-pressed={value === o}>
          {o || "All"}
        </button>
      ))}
    </div>
  );
}
