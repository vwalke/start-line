/**
 * Light smoothing for the speed-coloured tracks: a centred time-window mean
 * of SOG. Time-based, so it copes with uneven sampling (the public feed is a
 * lossy ~5 Hz), and it never averages across a telemetry hole.
 */

/** Width of the centred window, ms (±2 s). */
export const SOG_SMOOTH_MS = 4_000;

/** Consecutive fixes further apart than this are a telemetry gap (as `distance.ts` / the table's ~). */
export const SOG_GAP_MS = 5_000;

/**
 * Mean of the finite `sog` values within ±windowMs/2 of each sample, never
 * reaching past a gap (consecutive `t` more than `gapMs` apart). `t` sorted
 * ascending. A sample with no finite neighbour keeps its own (non-finite) value.
 * O(n): two pointers over prefix sums.
 */
export function smoothSog(
  t: ArrayLike<number>,
  sog: ArrayLike<number>,
  windowMs = SOG_SMOOTH_MS,
  gapMs = SOG_GAP_MS,
): Float32Array {
  const n = Math.min(t.length, sog.length);
  const out = new Float32Array(n);
  const sum = new Float64Array(n + 1);
  const cnt = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const ok = Number.isFinite(sog[i]);
    sum[i + 1] = sum[i] + (ok ? sog[i] : 0);
    cnt[i + 1] = cnt[i] + (ok ? 1 : 0);
  }
  const half = windowMs / 2;
  let runStart = 0;
  let lo = 0;
  let hi = 0; // exclusive
  for (let i = 0; i < n; i++) {
    if (i > 0 && t[i] - t[i - 1] > gapMs) runStart = i;
    if (lo < runStart) lo = runStart;
    if (hi < i + 1) hi = i + 1;
    while (t[i] - t[lo] > half) lo++;
    while (hi < n && t[hi] - t[i] <= half && t[hi] - t[hi - 1] <= gapMs) hi++;
    const c = cnt[hi] - cnt[lo];
    out[i] = c ? (sum[hi] - sum[lo]) / c : sog[i];
  }
  return out;
}
