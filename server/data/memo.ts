// Promise memo shared by the data loaders (player database, Model v4 signal / projection tables).

/**
 * Promise memo whose entries expire after `ttlMs` (and on rejection), bounded to `max` keys (oldest dropped).
 * `now` is injectable for tests (fake clock).
 */
export function staleMemo<V>(ttlMs: number, max: number, now: () => number = Date.now) {
  const m = new Map<string, { at: number; value: Promise<V> }>();
  return {
    get(key: string, make: () => Promise<V>): Promise<V> {
      const hit = m.get(key);
      if (hit && now() - hit.at <= ttlMs) return hit.value;
      m.delete(key);
      if (m.size >= max) m.delete(m.keys().next().value!);
      const value = make();
      const entry = { at: now(), value };
      m.set(key, entry);
      value.catch(() => {
        if (m.get(key) === entry) m.delete(key);
      });
      return value;
    },
    size: () => m.size,
  };
}
