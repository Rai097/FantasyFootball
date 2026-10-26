// One tappable "?" for every number and column (owner rule: header `title=` tooltips are hover-only and
// invisible on phones). Shows a one-sentence text, or bullet items ("label: value"), optionally loaded on
// first tap (the Values tab fetches a player's value bullets only when asked, keeping the list payload small).
import { useState, type MouseEvent, type ReactNode } from "react";

export interface HelpItem {
  label: string;
  value: string;
}

export function HelpTip({
  text,
  items,
  load,
  label = "What does this mean?",
}: {
  text?: string;
  items?: HelpItem[];
  /** Loads the items on first open (cached by the caller). */
  load?: () => Promise<HelpItem[]>;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<HelpItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  if (!text && !items?.length && !load) return null;
  const list = items?.length ? items : loaded;
  const toggle = (e: MouseEvent) => {
    e.stopPropagation(); // inside a sortable header or a tappable row: only the "?" reacts
    const next = !open;
    setOpen(next);
    if (next && load && !loaded) {
      setFailed(false);
      load()
        .then(setLoaded)
        .catch(() => setFailed(true));
    }
  };
  return (
    <span className="why">
      <button type="button" className="why-btn" title={text} aria-label={label} aria-expanded={open} onClick={toggle}>
        ?
      </button>
      {open && (
        <span
          className="why-pop"
          role="tooltip"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
        >
          {text && <span className="help-text">{text}</span>}
          {list ? (
            <ul className="help-items">
              {list.map((d, i) => (
                <li key={`${d.label}-${i}`}>
                  <span className="detail-label">{d.label}</span> <span>{d.value}</span>
                </li>
              ))}
            </ul>
          ) : load ? (
            <span className="muted">{failed ? "Could not load the explanation." : "Loading…"}</span>
          ) : null}
        </span>
      )}
    </span>
  );
}

/** A column header / metric label with its tappable "?" beside it (never inside a sort button). */
export function ColumnHelp({ children, tip }: { children: ReactNode; tip?: string }) {
  return (
    <span className="th-why">
      {children}
      <HelpTip text={tip} />
    </span>
  );
}
