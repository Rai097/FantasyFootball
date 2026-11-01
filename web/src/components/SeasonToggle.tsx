// "Out for season": the chip shown wherever a player's call is out for the season, and the owner's toggle row
// (DESIGN "Season-over injuries (2026-10-31)"). One component for every details panel (Values "?", Stash watch rows).
import { useState, type MouseEvent } from "react";
import { api, type Active, type SeasonStatus } from "../api";
import { HelpTip } from "./HelpTip";

const SOURCE: Record<NonNullable<SeasonStatus["auto"]>["source"], string> = { report: "Injury report", sleeper: "Sleeper", espn: "ESPN" };
const TIP =
  "Out for season = 0 points for every remaining week, and he leaves Stash watch, Targets and waiver claims. Auto follows ESPN, Sleeper and the injury report; your choice always wins.";

/** "Out for season" chip; nothing when he is not out for the season. */
export function SeasonChip({ status }: { status?: SeasonStatus }) {
  if (!status?.over) return null;
  return (
    <span className="tag small-tag warn-tag season-chip" title={status.why}>
      Out for season
    </span>
  );
}

type Choice = "auto" | "out" | "notOut";
const choiceOf = (s?: SeasonStatus): Choice => (s?.owner === true ? "out" : s?.owner === false ? "notOut" : "auto");

/**
 * One toggle row: Auto / Out / Not out (league owner on an imported league), else the current call read-only. The
 * automatic finding is shown with its source ("ESPN: return Feb 15, 2027, after the final week"). `onSaved` reloads
 * the view that shows him.
 */
export function SeasonToggle({ playerId, status, active, canEdit, onSaved }: { playerId: string; status?: SeasonStatus; active: Pick<Active, "provider" | "id">; canEdit: boolean; onSaved?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [choice, setChoice] = useState<Choice>(choiceOf(status));
  const autoText = status?.auto ? `${status.auto.why.startsWith(SOURCE[status.auto.source]) ? "" : `${SOURCE[status.auto.source]}: `}${status.auto.why}` : "no source says out for the season";
  const pick = (next: Choice) => (e: MouseEvent) => {
    e.stopPropagation(); // inside a tappable row or a "?" popover: only the toggle reacts
    if (busy || next === choice) return;
    setBusy(true);
    setErr(undefined);
    api
      .seasonMark(active, playerId, next === "auto" ? null : next === "out")
      .then(() => {
        setChoice(next);
        onSaved?.();
      })
      .catch((x: Error) => setErr(x.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="season-toggle" onClick={(e) => e.stopPropagation()}>
      <div className="season-toggle-head">
        <span className="detail-label">Out for season</span>
        <HelpTip text={TIP} label="What does Out for season do?" />
        {!canEdit && <span className="detail-value">{status?.over ? "yes" : "no"}{status?.owner !== undefined ? " (set by the league owner)" : ""}</span>}
      </div>
      {canEdit && (
        <div className="seg" role="group" aria-label="Out for season">
          {(
            [
              ["auto", "Auto"],
              ["out", "Out for season"],
              ["notOut", "Not out"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" className={`seg-btn${choice === k ? " active" : ""}`} aria-pressed={choice === k} disabled={busy} onClick={pick(k)}>
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="muted small">Auto: {autoText}</div>
      {err && <div className="notice warn small">{err}</div>}
    </div>
  );
}
