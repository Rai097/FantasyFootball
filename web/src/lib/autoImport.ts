// Pure text for the auto-import status line (stopgap until the Yahoo API; docs/DESIGN.md "Auto-import (stopgap until
// Yahoo API)"). One short line; the reasoning and exact times go behind a tap (HelpTip items).
import type { AutoImportStatus } from "../api";

const REASON: Record<string, string> = {
  signed_out: "Yahoo signed out",
  captcha: "Yahoo asked for a check (captcha or consent)",
  empty: "Yahoo returned no teams",
  partial: "only part of the league was read",
  timeout: "Yahoo took too long",
  profile_in_use: "the sign-in Chrome was open",
  error: "the import failed",
};

/** Plain words for a failure reason; unknown codes stay visible as-is. */
export function reasonText(reason: string | undefined): string {
  return (reason && REASON[reason]) ?? reason ?? "unknown reason";
}

/** "2:00 PM" today, "Sat 2:00 PM" within a week, else "Nov 3, 2:00 PM"; "—" when missing. */
export function shortTime(iso: string | undefined, now = new Date(), timeZone?: string): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t);
  const day = (x: Date) => x.toLocaleDateString("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  if (day(d) === day(now)) return time;
  if (Math.abs(t - now.getTime()) < 6 * 86_400_000) return `${d.toLocaleDateString("en-US", { timeZone, weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric" })}, ${time}`;
}

export interface AutoImportLine {
  /** The one line shown. */
  text: string;
  warn: boolean;
  /** Tap-to-open reasoning, one idea per bullet. */
  items: { label: string; value: string }[];
}

/** null = nothing to show (auto-import off on this server). */
export function autoImportLine(s: AutoImportStatus | null | undefined, now = new Date(), timeZone?: string): AutoImportLine | null {
  if (!s?.enabled) return null;
  const last = shortTime(s.lastSuccessAt, now, timeZone);
  const next = shortTime(s.nextRunAt, now, timeZone);
  const items = [
    { label: "Last good import", value: last === "—" ? "none yet" : last },
    { label: "Next scheduled try", value: next },
    { label: "What it is", value: "The server reads your Yahoo league on a schedule (a stopgap until Yahoo approves the API)." },
  ];
  if (s.running) return { text: "Auto-import: reading Yahoo now…", warn: false, items };
  if (s.state === "paused") {
    const why = reasonText(s.reason);
    return {
      text: `Auto-import paused: ${why} — use the bookmark`,
      warn: true,
      items: [
        { label: "Why", value: why },
        ...(s.detail ? [{ label: "Detail", value: s.detail }] : []),
        { label: "Last try", value: shortTime(s.lastAttemptAt, now, timeZone) },
        ...items.slice(0, 2),
        { label: "Your data", value: "Nothing was changed: the last good import stays." },
        {
          label: "Fix",
          value:
            s.reason === "signed_out" || s.reason === "captcha"
              ? "Sign in again on the server Mac (npm run yahoo:login), or use the bookmark."
              : s.reason === "profile_in_use"
                ? "Close the yahoo:login Chrome window; the next scheduled run retries."
                : "It retries on schedule; the bookmark works meanwhile.",
        },
      ],
    };
  }
  return { text: `Auto-import: last ${last} · next ${next}`, warn: false, items };
}
