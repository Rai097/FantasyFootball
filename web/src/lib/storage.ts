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
