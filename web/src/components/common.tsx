import { useState, type ReactNode } from "react";
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

/** "Why" explanation: hover tooltip on desktop, tap to toggle on touch. */
export function Why({ text }: { text?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <span className="why">
      <button
        type="button"
        className="why-btn"
        title={text}
        aria-label="Why?"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        ?
      </button>
      {open && (
        <span className="why-pop" role="tooltip" onClick={() => setOpen(false)}>
          {text}
        </span>
      )}
    </span>
  );
}

export function RankBadge({ rank, of }: { rank: number; of: number }) {
  const tier = rank <= Math.ceil(of / 3) ? "good" : rank > Math.floor((of * 2) / 3) ? "bad" : "mid";
  return (
    <span className={`rank-badge ${tier}`}>
      {ordinal(rank)} of {of}
    </span>
  );
}
