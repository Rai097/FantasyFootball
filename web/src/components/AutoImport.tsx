// Auto-import status (stopgap until the Yahoo API; docs/DESIGN.md "Auto-import (stopgap until Yahoo API)"):
// one short line ("Auto-import: last 2:00 PM · next 6:00 PM" or the paused warning) with the reasoning behind a tap,
// and the admin's "Refresh from Yahoo now" button. Status is fetched once; it is polled only while a run is in progress.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AutoImportStatus } from "../api";
import { autoImportLine } from "../lib/autoImport";
import { toApiError } from "../lib/useAsync";
import { HelpTip } from "./HelpTip";

const POLL_MS = 3000;

/** Auto-import status for the whole desk; `onRunDone` fires when a run this page saw in progress ends (refetch the league). */
export function useAutoImport(onRunDone?: () => void) {
  const [status, setStatus] = useState<AutoImportStatus | null>(null);
  const load = useCallback(() => api.autoImport().then(setStatus, () => setStatus(null)), []);
  useEffect(() => void load(), [load]);
  const running = !!status?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [running, load]);
  const was = useRef(false);
  const done = useRef(onRunDone);
  done.current = onRunDone;
  useEffect(() => {
    if (was.current && !running) done.current?.();
    was.current = running;
  }, [running]);
  return { status, reload: load, markRunning: () => setStatus((s) => (s ? { ...s, running: true } : s)) };
}
export type AutoImportHandle = ReturnType<typeof useAutoImport>;

/** The one line; `pill` = header style. Nothing when auto-import is off on this server. */
export function AutoImportLine({ status, pill }: { status: AutoImportStatus | null; pill?: boolean }) {
  const line = autoImportLine(status);
  if (!line) return null;
  const body = (
    <>
      {line.text}
      <HelpTip items={line.items} label="About auto-import" />
    </>
  );
  return pill ? <span className={`pill ${line.warn ? "warn" : "muted"}`}>{body}</span> : <div className={line.warn ? "notice warn" : "muted small"}>{body}</div>;
}

/** "Refresh from Yahoo now" (admin; the server allows one per 2 minutes and one run at a time). */
export function AutoImportRefresh({ handle }: { handle: AutoImportHandle }) {
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!handle.status?.enabled) return null;
  const running = handle.status.running;
  return (
    <div className="row gap wrap">
      <button
        className="btn refresh-now"
        disabled={busy || running}
        onClick={async () => {
          setBusy(true);
          setMsg(undefined);
          try {
            await api.autoImportRefresh();
            handle.markRunning();
          } catch (e) {
            const err = toApiError(e);
            setMsg(err.status === 429 ? "Refreshed less than 2 minutes ago: try again shortly." : err.message);
          } finally {
            setBusy(false);
            void handle.reload();
          }
        }}
      >
        {running ? "Reading Yahoo…" : "Refresh from Yahoo now"}
      </button>
      {msg && <span className="muted small">{msg}</span>}
    </div>
  );
}
