/**
 * Distance sailed: the GPS track summed point to point in projected metres,
 * from the position at `a` (interpolated) through every fix to the position
 * at `b`. Legs share their end points, so leg distances add up to the race.
 */
import { interp } from './geo';
import { rangeIdx } from './prepare';
import { SPAN_MS } from './validity';

export const M_PER_NM = 1852;

export interface PathDistance {
  distNm: number;
  /** Longest hole between fixes bridged by a straight line when longer than SPAN_MS, s; else null. */
  distGapS: number | null;
}

/** Distance along the track between times a and b (a < b). */
export function pathDistance(t: Float64Array, x: Float64Array, y: Float64Array, a: number, b: number): PathDistance {
  const n = t.length;
  if (n < 2 || !(b > a)) return { distNm: 0, distGapS: null };
  const [i0, i1] = rangeIdx(t, a, b);
  let px = interp(t, x, a);
  let py = interp(t, y, a);
  let m = 0;
  for (let k = i0; k < i1; k++) {
    m += Math.hypot(x[k] - px, y[k] - py);
    px = x[k];
    py = y[k];
  }
  m += Math.hypot(interp(t, x, b) - px, interp(t, y, b) - py);

  // Every hole between consecutive fixes that overlaps [a, b], including the
  // ones the end points fall in; time before the first or after the last fix counts too.
  let gap = Math.max(0, t[0] - a, b - t[n - 1]);
  const k0 = Math.max(1, i0 < n && t[i0] === a ? i0 + 1 : i0);
  const k1 = Math.min(n - 1, i1 > 0 && t[i1 - 1] === b ? i1 - 1 : i1);
  for (let k = k0; k <= k1; k++) gap = Math.max(gap, t[k] - t[k - 1]);
  return { distNm: m / M_PER_NM, distGapS: gap > SPAN_MS ? gap / 1000 : null };
}
