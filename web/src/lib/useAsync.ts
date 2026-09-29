import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./errors";

export interface AsyncState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError(e instanceof Error ? e.message : String(e), 0);
}

/** Runs `fn` whenever `deps` change; drops stale responses. `fn` returning null means "nothing to load". */
export function useAsync<T>(fn: () => Promise<T> | null, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const p = fn();
    const my = ++seq.current;
    if (!p) {
      setData(undefined);
      setError(undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    p.then(
      (d) => {
        if (my !== seq.current) return;
        setData(d);
        setLoading(false);
      },
      (e) => {
        if (my !== seq.current) return;
        setError(toApiError(e));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export { toApiError };
