/**
 * Coach input: each racing boat's track (gun → its last fix, ~1 Hz, the
 * drawn segments joined) and its leg boundaries as the legs were timed
 * (LegResult; a rounding a telemetry hole leaves in doubt is null). Positions
 * are read only next to real fixes, never across a hole.
 */
import type { Track } from '../../data/types';
import { COVERAGE_GAP_S } from '../coverage';
import { bisectRight, type Projection, type Vec } from '../geo';
import type { RaceAnalysis } from '../types';

/** Fixes further apart than this are a hole: no position is read between them (lib.py's pos_interp maxgap), s. */
export const COACH_MAX_SPAN_S = 15;
/** …and a position is read only this close to a real fix (the coverage gap), s. */
export const COACH_NEAR_FIX_S = COVERAGE_GAP_S;

export interface CoachTrack {
  id: string;
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
  /** Leg boundary times: [gun, end of leg 1, …, finish]; n legs → n + 1; null = unknown. */
  bounds: (number | null)[];
  /**
   * Where `bounds` leave the leg unknown (roundings lost in a hole), stretches next to a known
   * rounding where the boat was still closing on that leg's mark (ladder.ts inferLegSpans).
   */
  spans?: LegSpan[];
}

/** A stretch of track known to be on `leg` although its roundings are not. */
export interface LegSpan {
  fromMs: number;
  toMs: number;
  leg: number;
}

/**
 * The leg a boat is on at `t`, or null when unknown. Between two known
 * boundaries that's the leg they bound (several unknown roundings between
 * them: unknown). Past the last known boundary with nothing known after it
 * (no finish: the track ends in a hole), the leg that boundary starts.
 */
export function legAt(bounds: readonly (number | null)[], t: number): number | null {
  const n = bounds.length - 1;
  if (n < 1 || bounds[0] == null || t < bounds[0]) return null;
  let k = -1;
  for (let i = 0; i <= n; i++) if (bounds[i] != null && bounds[i]! <= t) k = i;
  if (k === n) return t === bounds[n] ? n - 1 : null; // finished
  let j = k + 1;
  while (j <= n && bounds[j] == null) j++;
  if (j > n) return k; // nothing known after: still on the leg it started
  return j === k + 1 ? k : null;
}

/** The leg at `t` from the timed roundings (legAt), else from an inferred span; null when unknown. */
export function trackLegAt(tr: Pick<CoachTrack, 'bounds' | 'spans'>, t: number): number | null {
  const k = legAt(tr.bounds, t);
  if (k != null) return k;
  for (const s of tr.spans ?? []) if (t >= s.fromMs && t <= s.toMs) return s.leg;
  return null;
}

/** Position at `t`: interpolated between the bracketing fixes only when they are ≤ COACH_MAX_SPAN_S apart and one is ≤ COACH_NEAR_FIX_S away. */
export function posAt(tr: Pick<CoachTrack, 't' | 'x' | 'y'>, t: number, maxSpanS = COACH_MAX_SPAN_S, nearS = COACH_NEAR_FIX_S): Vec | null {
  const n = tr.t.length;
  if (!n || t < tr.t[0] || t > tr.t[n - 1]) return null;
  const i = bisectRight(tr.t, t);
  if (tr.t[i] === t) return [tr.x[i], tr.y[i]];
  const a = tr.t[i];
  const b = tr.t[i + 1];
  if (b - a > maxSpanS * 1000 || Math.min(t - a, b - t) > nearS * 1000) return null;
  const f = (t - a) / (b - a);
  return [tr.x[i] + f * (tr.x[i + 1] - tr.x[i]), tr.y[i] + f * (tr.y[i + 1] - tr.y[i])];
}

/** Leg boundaries from the timed legs: each known leg gives its start and end; the gun and the finish anchor the ends. */
export function boundsOf(legs: RaceAnalysis['boats'][number]['legs'], gunMs: number, finishMs: number | null): (number | null)[] {
  const n = legs.length;
  const out: (number | null)[] = Array.from({ length: n + 1 }, () => null);
  out[0] = gunMs;
  legs.forEach((l, k) => {
    if (!l) return;
    out[k] = l.startMs;
    out[k + 1] = l.endMs;
  });
  if (finishMs != null && finishMs > gunMs) out[n] = finishMs;
  return out;
}

/**
 * Positions only, for the worker's wind series. RaceData tracks are already
 * sorted with duplicates removed, so this skips projectTrack's defensive
 * re-sort and the heading/SOG fill (100 boats × 5 Hz would pay both).
 */
export function projectCoachTrack(track: Track, proj: Projection): Pick<CoachTrack, 't' | 'x' | 'y'> {
  const n = track.t.length;
  const t = new Float64Array(n);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = proj.toXY(track.lat[i], track.lon[i]);
    t[i] = track.t[i];
    x[i] = p[0];
    y[i] = p[1];
  }
  return { t, x, y };
}

/** Every racing boat's coach track, from the analysis's drawn segments (gun → end, ~1 Hz). */
export function coachTracks(a: RaceAnalysis): CoachTrack[] {
  const gun = a.meta.gunMs;
  return a.boats.map((b) => {
    const segs = a.drawings.find((d) => d.id === b.id)?.segments ?? [];
    const t: number[] = [];
    const x: number[] = [];
    const y: number[] = [];
    for (const s of [...segs].sort((p, q) => p.leg - q.leg)) {
      for (let i = 0; i < s.t.length; i++) {
        if (s.t[i] < gun || (t.length && s.t[i] <= t[t.length - 1])) continue;
        t.push(s.t[i]);
        x.push(s.x[i]);
        y.push(s.y[i]);
      }
    }
    return { id: b.id, t: Float64Array.from(t), x: Float64Array.from(x), y: Float64Array.from(y), bounds: boundsOf(b.legs, gun, b.finishMs) };
  });
}

/** The longest hole (fixes over COVERAGE_GAP_S apart, or no fix yet after the gun) in [from, to]: its ends, ms; null when there is none. */
export function longestHole(t: ArrayLike<number>, from: number, to: number): { fromMs: number; toMs: number } | null {
  let best: { fromMs: number; toMs: number } | null = null;
  const consider = (a: number, b: number): void => {
    const lo = Math.max(a, from);
    const hi = Math.min(b, to);
    if (b - a > COVERAGE_GAP_S * 1000 && hi > lo && (!best || hi - lo > best.toMs - best.fromMs)) best = { fromMs: lo, toMs: hi };
  };
  if (!t.length) return to > from ? { fromMs: from, toMs: to } : null;
  consider(from, t[0]);
  for (let i = 1; i < t.length; i++) consider(t[i - 1], t[i]);
  consider(t[t.length - 1], to);
  return best;
}
