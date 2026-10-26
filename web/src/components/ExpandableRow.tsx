// Reusable "summary row → tap for details" pattern (owner rule, 2026-10-26): a row shows only short cells and a
// 1–2 sentence summary; the full analysis opens when the row is tapped, as short label/value lines, never prose.
// Used by Waivers first; Trades / Targets / Values / My Team reuse it later (cards, near misses, partner lists).
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";

export interface DetailLine {
  label: string;
  value: string;
  tone?: "pos" | "neg" | "warn";
  /** One-sentence explanation shown as a tooltip. */
  title?: string;
}

/**
 * One expandable row. `head` is the always-visible part (cells / summary); `children` render only when open.
 * The whole head is the toggle: click/tap, Enter or Space; `aria-expanded` + `aria-controls` for screen readers.
 * Interactive elements inside `head` must stop click propagation (the shared `Why` button already does).
 */
export function ExpandableRow({
  head,
  children,
  className = "",
  defaultOpen = false,
  label,
}: {
  head: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  /** Accessible name for the toggle (e.g. the player's name). */
  label?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault(); // Space would scroll the page
      setOpen((o) => !o);
    }
  };
  return (
    <div className={`xrow${open ? " open" : ""} ${className}`.trim()} role="listitem">
      <div
        className="xrow-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={id}
        aria-label={label ? `${label}: ${open ? "hide" : "show"} details` : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
      >
        {head}
        <span className="xrow-chevron" aria-hidden>
          ›
        </span>
      </div>
      {open && (
        <div className="xrow-details" id={id}>
          {children}
        </div>
      )}
    </div>
  );
}

/** A list of ExpandableRows with an optional column header (hidden on phones). */
export function ExpandableList({ header, children, className = "", label }: { header?: ReactNode; children: ReactNode; className?: string; label: string }) {
  return (
    <div className={`xlist ${className}`.trim()}>
      {header && (
        <div className="xlist-head" aria-hidden>
          {header}
          <span />
        </div>
      )}
      <div role="list" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/** Details as short "label: value" lines, one idea per line. */
export function DetailList({ items }: { items: DetailLine[] }) {
  if (!items.length) return null;
  return (
    <ul className="detail-list">
      {items.map((d, i) => (
        <li key={`${d.label}-${i}`} title={d.title}>
          <span className="detail-label">{d.label}</span>
          <span className={`detail-value${d.tone ? ` ${d.tone}` : ""}`}>{d.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** A collapsed-by-default section ("How calls work"), native <details> so it works without JS state. */
export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="disclosure">
      <summary>{title}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
