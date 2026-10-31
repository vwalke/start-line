/**
 * Loads that can finish out of order (the Start tab's earlier attempts: one asked for, then another before the first
 * came back): only the latest asked for is ever drawn. Each load takes a token; asking again, or cancelling, aborts the
 * one before it (when it gave a way to) and makes its token stale, so a late answer to it is dropped.
 */

/** One load: its answer, and a way to stop it (the worker's cancel) when the loader has one. */
export interface Load<R> {
  done: Promise<R>;
  abort?: () => void;
}

/** `want(key, …)` loads `key` unless it's the one already loading; `draw` gets the answer only while `key` is still the latest. */
export function latestLoader<K, R>(
  load: (k: K) => Load<R>,
  draw: (k: K, r: R) => void,
): { want(key: string, k: K): void; cancel(): void; loading(): string | null } {
  let token = 0;
  let pending: { key: string; abort?: () => void } | null = null;
  const cancel = (): void => {
    token++;
    const p = pending;
    pending = null;
    p?.abort?.();
  };
  return {
    want(key, k) {
      if (pending?.key === key) return;
      cancel();
      const mine = token;
      const { done, abort } = load(k);
      pending = { key, abort };
      void done.then((r) => {
        if (mine !== token) return;
        pending = null;
        draw(k, r);
      });
    },
    cancel,
    loading: () => pending?.key ?? null,
  };
}
