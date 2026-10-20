/**
 * One-off gesture hints: shown on touch devices only, until dismissed (× or
 * the gesture itself), and remembered in `recall.hints` (a JSON list of the
 * dismissed hints). Storage that is missing or throws never breaks the page:
 * the hint just comes back next visit.
 */

export const HINTS_KEY = 'recall.hints';
export type HintId = 'pinch';

/** What `isTouch` looks at (window in the app; a stand-in in tests). */
export interface TouchEnv {
  matchMedia?: (q: string) => { matches: boolean };
  ontouchstart?: unknown;
}

/** A coarse (finger) primary pointer; without matchMedia, touch events as a fallback. */
export function isTouch(env: TouchEnv | undefined): boolean {
  if (!env) return false;
  try {
    if (typeof env.matchMedia === 'function') return env.matchMedia('(pointer: coarse)').matches;
  } catch {
    // fall through to the touch-event check
  }
  return 'ontouchstart' in env;
}

type HintStore = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

/** The dismissed hints (empty on missing, corrupt or blocked storage). */
export function dismissedHints(store: HintStore): Set<string> {
  try {
    const v: unknown = JSON.parse(store?.getItem(HINTS_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Remember that `id` was dismissed (best effort). */
export function dismissHint(store: HintStore, id: HintId): void {
  try {
    const s = dismissedHints(store);
    s.add(id);
    store?.setItem(HINTS_KEY, JSON.stringify([...s]));
  } catch {
    // blocked storage: it shows again next visit
  }
}

/** Show hint `id`: on a touch device, not yet dismissed. */
export const showHint = (id: HintId, env: TouchEnv | undefined, store: HintStore): boolean => isTouch(env) && !dismissedHints(store).has(id);

/** localStorage, or null where reading it throws. */
export function hintStore(): HintStore {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
