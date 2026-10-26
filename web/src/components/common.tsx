import type { ReactNode } from "react";
import { HelpTip } from "./HelpTip";
import type { ApiError } from "../lib/errors";
import { deltaClass, ordinal, signed } from "../lib/format";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden /> {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: ApiError | { message: string; hint?: string }; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <div className="error-title">{error.message}</div>
      {error.hint && <div className="error-hint">{error.hint}</div>}
      {onRetry && (
        <button className="btn small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function PosBadge({ pos }: { pos: string }) {
  return <span className={`pos-badge pos-${pos.toLowerCase()}`}>{pos}</span>;
}

export function Delta({ value, suffix = "" }: { value: number | null | undefined; suffix?: string }) {
  return (
    <span className={`delta ${deltaClass(value)}`}>
      {signed(value)}
      {suffix}
    </span>
  );
}

/** "Why" explanation: tap to toggle (hover title on desktop). The shared HelpTip with a one-sentence text. */
export function Why({ text }: { text?: string }) {
  return text ? <HelpTip text={text} label="Why?" /> : null;
}

export function RankBadge({ rank, of }: { rank: number; of: number }) {
  const tier = rank <= Math.ceil(of / 3) ? "good" : rank > Math.floor((of * 2) / 3) ? "bad" : "mid";
  return (
    <span className={`rank-badge ${tier}`}>
      {ordinal(rank)} of {of}
    </span>
  );
}

/** Headline number card (stat row). `why` = one-sentence tooltip with a tappable "?"; `onClick` makes it a link. */
export function Stat({ label, value, sub, why, onClick }: { label: string; value: string; sub?: string; why?: string; onClick?: () => void }) {
  const body = (
    <>
      <div className="stat-label row between">
        <span>{label}</span>
        {!onClick && <Why text={why} />}
      </div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </>
  );
  return onClick ? (
    <button type="button" className="stat stat-link" title={why} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="stat" title={why}>
      {body}
    </div>
  );
}
