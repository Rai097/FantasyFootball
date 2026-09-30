import { MOCK, type Active } from "../api";

// Mock mode keeps its own key so fixture ids never leak into a real session.
const KEY = MOCK ? "tradeDesk.active.mock.v1" : "tradeDesk.active.v1";

export function loadActive(): Active | null {
  try {
    const raw = localStorage.getItem(KEY);
    const v = (raw ? JSON.parse(raw) : {}) as Partial<Active>;
    if ((v.provider === "demo" || v.provider === "yahoo" || v.provider === "import") && typeof v.id === "string" && v.id) {
      return { provider: v.provider, id: v.id, team: typeof v.team === "string" && v.team ? v.team : undefined };
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  // In mock mode start on the demo league so every tab has data immediately.
  return MOCK ? { provider: "demo", id: "42" } : null;
}

export function saveActive(a: Active | null): void {
  try {
    if (a) localStorage.setItem(KEY, JSON.stringify(a));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// Browser-side backup of imported leagues. Hosted servers (e.g. Render's free
// plan) lose .data/ on restart, so the UI re-uploads the backup when the server
// answers 404 for an imported league.
const importKey = (id: string) => `tradeDesk.import.${id}`;

export function saveImportBackup(s: { id: string }): void {
  try {
    localStorage.setItem(importKey(s.id), JSON.stringify(s));
  } catch {
    /* quota or storage unavailable: the server copy still works */
  }
}

export function loadImportBackup(id: string): unknown | null {
  try {
    const raw = localStorage.getItem(importKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function removeImportBackup(id: string): void {
  try {
    localStorage.removeItem(importKey(id));
  } catch {
    /* ignore */
  }
}
