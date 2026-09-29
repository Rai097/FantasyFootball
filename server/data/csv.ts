/** Minimal RFC-4180-ish CSV parser. Returns rows as objects keyed by header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() ?? [];
  return rows
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""))
    .map((r) => {
      const o: Record<string, string> = {};
      header.forEach((h, i) => (o[h] = r[i] ?? ""));
      return o;
    });
}

export const num = (v: string | undefined): number => {
  if (v === undefined || v === "" || v === "NA" || v === "NULL") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
export const opt = (v: string | undefined): string | undefined =>
  v === undefined || v === "" || v === "NA" ? undefined : v;
