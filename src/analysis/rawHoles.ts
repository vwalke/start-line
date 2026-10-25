/**
 * The holes in a boat's own feed, for the maps only (ui/gapFill.ts). The drawn segments are thinned to one fix per
 * second, which turns a 1.5 s hole in a 2 Hz feed into a 2–2.5 s step; the map must judge holes on the feed's own
 * fixes. So each drawing carries the feed's usual spacing and, around every hole longer than its hole threshold, the
 * fixes either side (two each way: the curve across it takes its tangents from them).
 *
 * Nothing in the analysis reads this: it is data handed to the drawing code, worked out from the same fixes as the
 * rest, and changes no result.
 */
import { median } from './geo';
import type { RawHoles } from './types';

/** A step between the feed's own fixes is a hole when longer than this, s… */
export const HOLE_MIN_S = 2;
/** …or than this many times the feed's usual (median) step, when that is longer. */
export const HOLE_CADENCE = 2;

/** The hole threshold, ms, for a feed whose usual step is `stepMs`. */
export const holeMsOf = (stepMs: number): number => Math.max(HOLE_MIN_S * 1000, HOLE_CADENCE * stepMs);

/** Fixes `t`, `x`, `y`, `sog` from `fromMs` on: the feed's median step, its hole threshold, when each hole starts and the fixes around it. */
export function rawHoles(t: ArrayLike<number>, x: ArrayLike<number>, y: ArrayLike<number>, sog: ArrayLike<number>, fromMs: number): RawHoles {
  let i0 = 0;
  while (i0 < t.length && t[i0] < fromMs) i0++;
  const steps: number[] = [];
  for (let i = i0 + 1; i < t.length; i++) steps.push(t[i] - t[i - 1]);
  const stepMs = steps.length ? median(steps) : 0;
  const holeMs = holeMsOf(stepMs);
  const keep = new Set<number>();
  const at: number[] = [];
  for (let i = i0; i + 1 < t.length; i++) {
    if (t[i + 1] - t[i] <= holeMs) continue;
    at.push(t[i]);
    for (let k = i - 1; k <= i + 2; k++) if (k >= i0 && k < t.length) keep.add(k);
  }
  const idx = [...keep].sort((p, q) => p - q);
  return {
    stepMs,
    holeMs,
    at: Float64Array.from(at),
    edges: {
      t: Float64Array.from(idx, (k) => t[k]),
      x: Float32Array.from(idx, (k) => x[k]),
      y: Float32Array.from(idx, (k) => y[k]),
      sog: Float32Array.from(idx, (k) => sog[k]),
    },
  };
}
