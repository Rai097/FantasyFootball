import { useState } from "react";
import type { Trade } from "../../../server/model/types";
import type { VP } from "../api";
import { deltaClass, f1, pct, signed } from "../lib/format";
import { Why } from "./common";
import { PlayerChip } from "./PlayerChip";

function verdictClass(v: string): string {
  if (/^accept/i.test(v)) return "good";
  if (/decline|reject/i.test(v)) return "bad";
  return "warn";
}

export function TradeCard({ trade, partnerName, verdict, defaultOpen = false }: { trade: Trade; partnerName: string; verdict?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { me, them } = trade;
  const accCls = trade.acceptance >= 0.6 ? "good" : trade.acceptance >= 0.4 ? "warn" : "bad";
  return (
    <article className="card trade-card">
      <header className="trade-head">
        <div>
          <div className="eyebrow">with {partnerName}</div>
          {verdict && <span className={`verdict ${verdictClass(verdict)}`}>{verdict}</span>}
        </div>
        <div className={`accept ${accCls}`} title="Rough chance the other manager accepts, from value fairness and their lineup change">
          <span className="accept-num">{pct(trade.acceptance)}</span>
          <span className="accept-label">accept</span>
        </div>
      </header>

      <div className="trade-cols">
        <Side title="You give" players={me.gives} total={me.valueGiven} drops={me.drops} />
        <Side title="You get" players={them.gives} total={them.valueGiven} />
      </div>

      <div className="trade-metrics">
        <Metric label="Your lineup" value={me.lineupDelta} unit=" ppg" />
        <Metric label="Their lineup" value={them.lineupDelta} unit=" ppg" />
        <div className="metric" title="Value they receive ÷ value they give. Above 1.0 means they win on paper.">
          <span className="metric-label">Fairness</span>
          <span className="metric-value">{f1(trade.fairness)}</span>
        </div>
      </div>

      {trade.tags.length > 0 && (
        <div className="tags">
          {trade.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      )}

      <button className="link-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "Hide details" : "Lineup changes & why"}
      </button>
      {open && (
        <div className="trade-details">
          <p>{trade.summary}</p>
          {trade.why && <p className="muted small">{trade.why}</p>}
          {them.drops && them.drops.length > 0 && (
            <p className="muted small">
              {partnerName} would have to drop {them.drops.map((p) => p.name).join(", ")} to make roster room.
            </p>
          )}
          <div className="trade-cols">
            <Changes title="Your lineup" lines={me.lineupChanges} />
            <Changes title={`${partnerName}'s lineup`} lines={them.lineupChanges} />
          </div>
          <ul className="why-list">
            {[...me.gives, ...them.gives].map((p) =>
              p.why ? (
                <li key={p.id}>
                  <span className="strong">{p.name}:</span> {p.why}
                </li>
              ) : null,
            )}
          </ul>
        </div>
      )}
    </article>
  );
}

function Side({ title, players, total, drops }: { title: string; players: VP[]; total: number; drops?: VP[] }) {
  return (
    <div className="trade-side">
      <div className="side-title">
        {title} <span className="muted small">value {f1(total)}</span>
      </div>
      {players.map((p) => (
        <div key={p.id} className="side-player">
          <PlayerChip player={p} />
          <span className="side-meta">
            <span className="muted small">{f1(p.ppg)} ppg</span>
            <Why text={p.why} />
          </span>
        </div>
      ))}
      {drops && drops.length > 0 && (
        <div className="muted small drop-note">
          + you drop {drops.map((p) => `${p.name} (${f1(p.value)})`).join(", ")}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
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
