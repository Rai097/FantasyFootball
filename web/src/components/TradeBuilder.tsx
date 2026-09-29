import { useMemo, useState } from "react";
import { api, type Active, type Analysis, type VP } from "../api";
import type { ApiError } from "../lib/errors";
import { f1 } from "../lib/format";
import { toApiError } from "../lib/useAsync";
import { ErrorBox, Loading, PosBadge } from "./common";
import { PlayerChip } from "./PlayerChip";
import { TradeCard } from "./TradeCard";

type Result = Awaited<ReturnType<typeof api.evaluateTrade>>;

export function TradeBuilder({ analysis, active }: { analysis: Analysis; active: Active & { team: string } }) {
  const others = analysis.teams.filter((t) => t.team.id !== active.team);
  const [partner, setPartner] = useState(others[0]?.team.id ?? "");
  const [give, setGive] = useState<string[]>([]);
  const [get, setGet] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError>();
  const [result, setResult] = useState<Result>();

  const rosterOf = (teamId: string): VP[] => {
    const t = analysis.league.teams.find((x) => x.id === teamId);
    return (t?.playerIds ?? [])
      .map((id) => analysis.players[id])
      .filter((p): p is VP => !!p)
      .sort((a, b) => b.value - a.value);
  };
  const mine = useMemo(() => rosterOf(active.team), [analysis, active.team]); // eslint-disable-line react-hooks/exhaustive-deps
  const theirs = useMemo(() => rosterOf(partner), [analysis, partner]); // eslint-disable-line react-hooks/exhaustive-deps
  const partnerName = others.find((t) => t.team.id === partner)?.team.name ?? "partner";

  const evaluate = async () => {
    setBusy(true);
    setErr(undefined);
    setResult(undefined);
    try {
      setResult(await api.evaluateTrade(active, partner, give, get));
    } catch (e) {
      setErr(toApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card builder">
      <h2>Trade builder</h2>
      <label className="field">
        <span>Partner</span>
        <select
          value={partner}
          onChange={(e) => {
            setPartner(e.target.value);
            setGet([]);
            setResult(undefined);
          }}
        >
          {others.map((t) => (
            <option key={t.team.id} value={t.team.id}>
              {t.team.name} ({t.team.owner})
            </option>
          ))}
        </select>
      </label>
      <div className="builder-cols">
        <Picker title="You give" roster={mine} selected={give} onChange={(v) => (setGive(v), setResult(undefined))} />
        <Picker title={`You get from ${partnerName}`} roster={theirs} selected={get} onChange={(v) => (setGet(v), setResult(undefined))} />
      </div>
      <div className="row gap">
        <button className="btn primary" disabled={busy || !partner || !give.length || !get.length} onClick={evaluate}>
          {busy ? "Evaluating…" : "Evaluate"}
        </button>
        {(give.length > 0 || get.length > 0) && (
          <button
            className="btn"
            onClick={() => {
              setGive([]);
              setGet([]);
              setResult(undefined);
              setErr(undefined);
            }}
          >
            Reset
          </button>
        )}
      </div>
      {busy && <Loading label="Rebuilding both lineups…" />}
      {err && <ErrorBox error={err} />}
      {result && <TradeCard trade={result} partnerName={partnerName} verdict={result.verdict} defaultOpen />}
    </section>
  );
}

function Picker({ title, roster, selected, onChange }: { title: string; roster: VP[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState("");
  const chosen = selected.map((id) => roster.find((p) => p.id === id)).filter((p): p is VP => !!p);
  const needle = q.trim().toLowerCase();
  const options = roster.filter((p) => !selected.includes(p.id) && (!needle || p.name.toLowerCase().includes(needle) || p.pos.toLowerCase() === needle));
  return (
    <div className="picker">
      <div className="side-title">{title}</div>
      <div className="picked">
        {chosen.length === 0 && <span className="muted small">Nobody yet</span>}
        {chosen.map((p) => (
          <span key={p.id} className="picked-item">
            <PlayerChip player={p} compact />
            <button className="x-btn" aria-label={`Remove ${p.name}`} onClick={() => onChange(selected.filter((x) => x !== p.id))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <input className="search" placeholder="Search roster…" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="pick-list">
        {options.map((p) => (
          <li key={p.id}>
            <button className="pick-btn" onClick={() => onChange([...selected, p.id])} title={p.why}>
              <PosBadge pos={p.pos} />
              <span className="chip-name">{p.name}</span>
              <span className="muted small">{p.team}</span>
              <span className="pick-val">{f1(p.value)}</span>
            </button>
          </li>
        ))}
        {options.length === 0 && <li className="muted small">No matches</li>}
      </ul>
    </div>
  );
}
