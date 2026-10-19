/**
 * Data coverage: how much of a stretch of race the public track actually
 * covers. Time between consecutive fixes counts as covered when they are at
 * most COVERAGE_GAP_S apart (the threshold behind the distance `~`); a longer
 * hole, or time before the first / after the last fix, does not.
 */
import { rangeIdx } from './prepare';
import { SPAN_MS } from './validity';

/** Fixes further apart than this leave the time between them uncovered, s (= the distance `~` threshold). */
export const COVERAGE_GAP_S = SPAN_MS / 1000;

/** Below this fraction a leg (or race) is flagged as poorly covered. */
export const LOW_COVERAGE = 0.9;

export interface Coverage {
  /** Covered fraction of [a, b], 0–1. */
  coverage: number;
  /** Longest interval between fixes overlapping [a, b] (the whole interval, not just the overlap), or the time before the first / after the last fix if longer, s. */
  maxGapS: number;
}

/** Coverage of [a, b] (ms, a < b) by the fix times `t` (sorted). */
export function coverage(t: ArrayLike<number> & { length: number }, a: number, b: number, gapS = COVERAGE_GAP_S): Coverage {
  const n = t.length;
  if (!(b > a)) return { coverage: 0, maxGapS: 0 };
  if (n === 0) return { coverage: 0, maxGapS: (b - a) / 1000 };
  const gapMs = gapS * 1000;
  const tt = t instanceof Float64Array ? t : Float64Array.from(t);
  const [i0, i1] = rangeIdx(tt, a, b);
  let covered = 0;
  let maxGap = Math.max(0, Math.min(tt[0], b) - a, b - Math.max(tt[n - 1], a));
  // Intervals [t[k-1], t[k]] that overlap [a, b]: from the one holding a to the one holding b.
  for (let k = Math.max(1, i0); k <= Math.min(n - 1, i1); k++) {
    const lo = Math.max(tt[k - 1], a);
    const hi = Math.min(tt[k], b);
    if (hi <= lo) continue;
    const span = tt[k] - tt[k - 1];
    if (span <= gapMs) covered += hi - lo;
    maxGap = Math.max(maxGap, span);
  }
  return { coverage: Math.min(1, covered / (b - a)), maxGapS: maxGap / 1000 };
}
