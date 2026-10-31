// In-process keyed async lock: calls with the same key run one at a time, in call order; different keys run in
// parallel. A failed call never blocks the next one. Used for every read-merge-write of a stored file (imports,
// their history, the projection log) so two writers (a paste and the auto-import) never lose each other's write.
const chains = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  chains.set(key, run);
  void run
    .finally(() => {
      if (chains.get(key) === run) chains.delete(key);
    })
    .catch(() => undefined);
  return run;
}

/** Keys currently held or queued (tests). */
export function lockedKeys(): string[] {
  return [...chains.keys()];
}
