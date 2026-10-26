/** Every number shown to the user goes through one of these: always 1 decimal. */
export function f1(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"; // unknown, never 0
  const r = Math.round(n * 10) / 10;
  return (Object.is(r, -0) ? 0 : r).toFixed(1);
}

export function signed(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"; // unknown, never 0
  const s = f1(n);
  return n > 0.049 ? `+${s}` : s;
}

export function pct(n: number): string {
  return `${f1(n * 100)}%`;
}

export function deltaClass(n: number | null | undefined, eps = 0.05): string {
  if (n == null || !Number.isFinite(n)) return "neutral";
  if (n > eps) return "pos";
  if (n < -eps) return "neg";
  return "neutral";
}

export function ordinal(n: number): string {
  const v = n % 100;
  const s = v >= 11 && v <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

export function ago(iso: string | undefined): string {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** "Oct 26, 3:04 PM" in the viewer's time zone; "—" when unknown. */
export function stamp(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function record(r?: { wins: number; losses: number; ties: number }): string {
  if (!r) return "—"; // unknown, never 0-0
  return r.ties ? `${r.wins}-${r.losses}-${r.ties}` : `${r.wins}-${r.losses}`;
}
