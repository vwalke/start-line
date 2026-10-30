/**
 * The wind at any moment for the replay's ladder (ladderNow.ts) and the map tooltip's places (progress.ts): the
 * fleet's minute-by-minute series (twdSeries.ts twdAt, the runs read from the gybes where it has them), smoothed by a
 * centred rolling circular mean over LIVE_HALF_MS either side, so the rungs turn with a shift but not with the
 * minute-to-minute wobble of the clusters' medians.
 *
 * - Centred, not trailing: a replay knows the minutes after the moment, and a trailing mean would turn the rungs a
 *   minute after the fleet tacked on the shift (the lag one wind per leg had all the way down the leg).
 * - Circular: the mean of unit vectors, so 355° and 5° average to 0°, not 180°.
 * - No gaps: a sample the series can't give (not finite) is left out of the means; a stretch of windows with none is
 *   filled straight between the readings either side (the shorter way round), so the rungs turn across it rather
 *   than jump; before the first reading and after the last, they are held, as before the gun and after the end.
 * - Sampled every LIVE_STEP_MS from the gun to the model's end into typed arrays, once per wind series; each moment
 *   is then read in O(1), between the two samples around it, without allocating.
 */
import { norm360, wrap180 } from '../geo';
import type { Wind } from './ladder';

/** The smoothed wind is sampled this often, ms. */
export const LIVE_STEP_MS = 5_000;
/** …and is the circular mean over this long either side of the moment, ms (2 min in all: the beats' own window, twdSeries.ts TWD_WINDOW_MS). */
export const LIVE_HALF_MS = 60_000;

const RAD = Math.PI / 180;

/**
 * The circular mean of `deg` over `half` samples either side of each (fewer at the ends), °; a sample that isn't
 * finite counts for nothing, and one whose window has none (or whose vectors cancel) is filled from the means either
 * side (fillHoles). NaN throughout only with no finite sample at all.
 */
export function circSmooth(deg: ArrayLike<number>, half: number): Float64Array {
  const n = deg.length;
  const cs = new Float64Array(n + 1);
  const ss = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const ok = Number.isFinite(deg[i]);
    cs[i + 1] = cs[i] + (ok ? Math.cos(deg[i] * RAD) : 0);
    ss[i + 1] = ss[i] + (ok ? Math.sin(deg[i] * RAD) : 0);
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    const c = cs[b] - cs[a];
    const s = ss[b] - ss[a];
    out[i] = Math.hypot(c, s) > 1e-9 ? norm360(Math.atan2(s, c) / RAD) : NaN;
  }
  fillHoles(out, true);
  return out;
}

/** The rolling mean of `v` (not finite: left out) over `half` samples either side, filled as circSmooth fills. */
function lineSmooth(v: ArrayLike<number>, half: number): Float64Array {
  const n = v.length;
  const sum = new Float64Array(n + 1);
  const cnt = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const ok = Number.isFinite(v[i]);
    sum[i + 1] = sum[i] + (ok ? v[i] : 0);
    cnt[i + 1] = cnt[i] + (ok ? 1 : 0);
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    const k = cnt[b] - cnt[a];
    out[i] = k > 0 ? (sum[b] - sum[a]) / k : NaN;
  }
  fillHoles(out, false);
  return out;
}

/**
 * Each run of NaN in `v` filled from the finite values either side: straight between them (along the shorter way
 * round for an `angle`, °), or the one there is at an end. Left as is with none.
 */
function fillHoles(v: Float64Array, angle: boolean): void {
  const n = v.length;
  let i = 0;
  while (i < n) {
    if (!Number.isNaN(v[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && Number.isNaN(v[j])) j++;
    const a = i - 1;
    if (a >= 0 || j < n) {
      const va = a >= 0 ? v[a] : v[j];
      const d = a >= 0 && j < n ? (angle ? wrap180(v[j] - va) : v[j] - va) : 0;
      for (let k = i; k < j; k++) {
        const x = va + (a >= 0 && j < n ? (d * (k - a)) / (j - a) : 0);
        v[k] = angle ? norm360(x) : x;
      }
    }
    i = j;
  }
}

/** The smoothed wind, sampled: sin and cos of the direction, and the tack angle, every `stepMs` from `t0`. */
export interface LiveWind extends Wind {
  t0: number;
  stepMs: number;
  sin: Float64Array;
  cos: Float64Array;
  ta: Float64Array;
}

/** The wind series `w` smoothed (above) over `fromMs`–`toMs`; `fallbackDeg` (and 90° for the tack angle) only where `w` gives nothing at all. */
export function liveWindOf(w: Wind, fromMs: number, toMs: number, fallbackDeg = 0, stepMs = LIVE_STEP_MS, halfMs = LIVE_HALF_MS): LiveWind {
  const n = Math.max(1, Math.floor(Math.max(0, toMs - fromMs) / stepMs) + 2);
  const deg = new Float64Array(n);
  const ta = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    deg[i] = w.twdAt(fromMs + i * stepMs);
    ta[i] = w.taAt(fromMs + i * stepMs);
  }
  const half = Math.max(0, Math.round(halfMs / stepMs));
  const sm = circSmooth(deg, half);
  const tm = lineSmooth(ta, half);
  const sin = new Float64Array(n);
  const cos = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = Number.isNaN(sm[i]) ? fallbackDeg : sm[i];
    sin[i] = Math.sin(d * RAD);
    cos[i] = Math.cos(d * RAD);
    if (Number.isNaN(tm[i])) tm[i] = 90;
  }
  // Between the samples around `t` (n ≥ 2), held at the ends: the index in `k`, the share of the way to the next returned.
  let k = 0;
  const pos = (t: number): number => {
    const x = Number.isFinite(t) ? Math.min(n - 1, Math.max(0, (t - fromMs) / stepMs)) : 0;
    k = Math.min(n - 2, Math.floor(x));
    return x - k;
  };
  return {
    t0: fromMs,
    stepMs,
    sin,
    cos,
    ta: tm,
    twdAt: (t) => {
      const f = pos(t);
      return norm360(Math.atan2(sin[k] + f * (sin[k + 1] - sin[k]), cos[k] + f * (cos[k + 1] - cos[k])) / RAD);
    },
    taAt: (t) => {
      const f = pos(t);
      return tm[k] + f * (tm[k + 1] - tm[k]);
    },
  };
}

/** What liveWind reads of a coach model (index.ts CoachModel). */
export interface LiveWindModel {
  wind: Wind & { twd?: ArrayLike<number> };
  gunMs: number;
  endMs: number;
}

const cache = new WeakMap<Wind, LiveWind>();

/** The model's smoothed wind (liveWindOf, from the gun to its end), worked out once per wind series. */
export function liveWind(m: LiveWindModel): LiveWind {
  let lw = cache.get(m.wind);
  if (!lw) {
    let first = 0;
    const twd = m.wind.twd ?? [];
    for (let i = twd.length - 1; i >= 0; i--) if (Number.isFinite(twd[i])) first = twd[i];
    cache.set(m.wind, (lw = liveWindOf(m.wind, m.gunMs, m.endMs, first)));
  }
  return lw;
}
