import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Active, type Analysis, type TradeMode, type VP } from "../api";
import type { ApiError } from "../lib/errors";
import { f1 } from "../lib/format";
import { toApiError } from "../lib/useAsync";
import { ErrorBox, Loading, PosBadge } from "./common";
import { PlayerChip } from "./PlayerChip";
import { TradeResult } from "./TradeResult";

type Result = Awaited<ReturnType<typeof api.evaluateTrade>>;

/** A suggestion sent to the builder: the nonce makes sending the same trade twice work. */
export interface BuilderPrefill {
  nonce: number;
  partner: string;
  give: string[];
  get: string[];
}

export function TradeBuilder({ analysis, active, mode, prefill }: { analysis: Analysis; active: Active & { team: string }; mode: TradeMode; prefill?: BuilderPrefill }) {
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

  const evaluate = async (p = partner, g = give, t = get) => {
    setBusy(true);
    setErr(undefined);
    setResult(undefined);
    try {
      setResult(await api.evaluateTrade(active, p, g, t, mode));
    } catch (e) {
      setErr(toApiError(e));
    } finally {
      setBusy(false);
    }
  };

  // A new mode makes the shown verdict stale.
  const firstMode = useRef(true);
  useEffect(() => {
    if (firstMode.current) firstMode.current = false;
    else setResult(undefined);
  }, [mode]);

  // "Open in builder" on a suggestion: prefill both sides and evaluate at once.
  const lastNonce = useRef(0);
  useEffect(() => {
    if (!prefill || prefill.nonce === lastNonce.current) return;
    lastNonce.current = prefill.nonce;
    setPartner(prefill.partner);
    setGive(prefill.give);
    setGet(prefill.get);
    void evaluate(prefill.partner, prefill.give, prefill.get);
  }, [prefill]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card builder">
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
              {t.team.name}
              {t.team.owner ? ` (${t.team.owner})` : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="builder-cols">
        <Picker title="You give" roster={mine} selected={give} onChange={(v) => (setGive(v), setResult(undefined))} />
        <Picker title={`You get from ${partnerName}`} roster={theirs} selected={get} onChange={(v) => (setGet(v), setResult(undefined))} />
      </div>
      <div className="row gap">
        <button className="btn primary" disabled={busy || !partner || !give.length || !get.length} onClick={() => evaluate()}>
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
      {result && (
        <TradeResult trade={result} partnerName={partnerName} verdict={result.verdict} />
      )}
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
