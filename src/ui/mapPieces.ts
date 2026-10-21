/**
 * What of each boat's track the map draws, as index ranges ("pieces") over
 * its source arrays, never copies: the whole race (Map A), or a race-time
 * window [t − trail, t] while scrubbing (Map B), cut by binary search on t;
 * zoomed in, only the stretches near the view (per-chunk bounding boxes).
 *
 * Sources: the drawing's ~1 Hz segments and its pre-gun track (leg PRE_LEG),
 * or, zoomed in tight (useFullRate), the boat's full-rate track from the
 * worker (analysis/fullRate.ts) split at the same leg times.
 *
 * Also the boat's state at a moment (the scrubber's dots): linear between
 * fixes, none inside a gap (the map's gap rule, mapPoints.ts) beyond a short
 * hold, nor before the first fix or after the last.
 */
import { vecBearing, type Vec } from '../analysis/geo';
import { PRE_LEG, type BoatDrawing, type FullRateTrack } from '../analysis/types';
import type { Box } from './view';

/** A track the map can draw from: positions (east/north metres), fix times, SOG; roll when the source has it. */
export interface SrcTrack {
  x: Float32Array;
  y: Float32Array;
  t: Float64Array;
  sog: Float32Array;
  roll?: Float32Array;
}

/** A stretch of one source drawn on one leg: [i0, i1) of `src`, whose map coordinates are `rx`, `ry` (whole source). */
export interface MapPiece {
  id: string;
  leg: number;
  src: SrcTrack;
  rx: Float64Array;
  ry: Float64Array;
  i0: number;
  i1: number;
  /** The last fix of its leg range inside the time window (a zoomed view may stop the piece short of it). */
  end: number;
}

/** Rotation that puts the wind direction (FROM) at the top; y flipped for SVG. */
export function rotator(twdDeg: number): (p: Vec) => Vec {
  const th = (twdDeg * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  return ([x, y]) => [x * c - y * s, -(x * s + y * c)];
}

const rotCache = new WeakMap<SrcTrack, { twd: number; x: Float64Array; y: Float64Array }>();
/** A source's points in map coordinates (wind at the top), worked out once per source. */
export function rotTrack(twd: number, src: SrcTrack): { x: Float64Array; y: Float64Array } {
  const hit = rotCache.get(src);
  if (hit && hit.twd === twd) return hit;
  const rot = rotator(twd);
  const n = src.x.length;
  const out = { twd, x: new Float64Array(n), y: new Float64Array(n) };
  for (let i = 0; i < n; i++) [out.x[i], out.y[i]] = rot([src.x[i], src.y[i]]);
  rotCache.set(src, out);
  return out;
}

// ---- detail ------------------------------------------------------------------

/** Zoomed in this far (view k) or more, the map draws full-rate points… */
export const MAP_FULL_K = 4;
/** …or when the view spans less than this, metres (a small race's Fit is already close). */
export const MAP_FULL_SPAN_M = 400;

/** Whether the map at view rectangle `view` (map units = metres) and zoom `k` draws full-rate points. */
export const useFullRate = (view: Box, k: number): boolean =>
  k >= MAP_FULL_K || Math.max(view.x1 - view.x0, view.y1 - view.y0) < MAP_FULL_SPAN_M;

/** Full-rate tracks by boat, as the worker sent them. */
export type FullRateSet = ReadonlyMap<string, FullRateTrack>;

// ---- index ranges --------------------------------------------------------------

/** First index with t[i] >= v in [lo, hi). */
export function lowerBound(t: ArrayLike<number>, v: number, lo = 0, hi = t.length): number {
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (t[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** First index with t[i] > v in [lo, hi). */
export function upperBound(t: ArrayLike<number>, v: number, lo = 0, hi = t.length): number {
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (t[m] <= v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** [i0, i1) of the fixes of `t[lo, hi)` with t0 ≤ t ≤ t1. */
export function timeRange(t: ArrayLike<number>, t0: number, t1: number, lo = 0, hi = t.length): [number, number] {
  const i0 = lowerBound(t, t0, lo, hi);
  return [i0, Math.max(i0, upperBound(t, t1, i0, hi))];
}

/** Fixes per spatial chunk (each gets a bounding box, so a zoomed view skips whole chunks off screen). */
export const CHUNK = 32;
/** Fixes kept either side of a stretch near the view: a line leaving the view, and a gap chord out of it, still draw as they did. */
const EDGE = 2;

const chunkCache = new WeakMap<Float64Array, Float64Array>();
/** Per chunk of CHUNK fixes: x0, y0, x1, y1 of its map coordinates (worked out once per source). */
function chunkBoxes(rx: Float64Array, ry: Float64Array): Float64Array {
  let boxes = chunkCache.get(rx);
  if (boxes) return boxes;
  const n = Math.ceil(rx.length / CHUNK);
  boxes = new Float64Array(n * 4);
  for (let c = 0; c < n; c++) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = c * CHUNK; i < Math.min(rx.length, (c + 1) * CHUNK); i++) {
      if (rx[i] < x0) x0 = rx[i];
      if (rx[i] > x1) x1 = rx[i];
      if (ry[i] < y0) y0 = ry[i];
      if (ry[i] > y1) y1 = ry[i];
    }
    boxes.set([x0, y0, x1, y1], c * 4);
  }
  chunkCache.set(rx, boxes);
  return boxes;
}

/** The stretches of [i0, i1) whose chunks touch `clip` (null: all of it), each grown by EDGE fixes, merged where they meet. */
export function nearRanges(rx: Float64Array, ry: Float64Array, i0: number, i1: number, clip: Box | null): [number, number][] {
  if (i1 <= i0) return [];
  if (!clip) return [[i0, i1]];
  const boxes = chunkBoxes(rx, ry);
  const out: [number, number][] = [];
  for (let c = Math.floor(i0 / CHUNK); c * CHUNK < i1; c++) {
    const b = c * 4;
    if (boxes[b] > clip.x1 || boxes[b + 2] < clip.x0 || boxes[b + 1] > clip.y1 || boxes[b + 3] < clip.y0) continue;
    const lo = Math.max(i0, c * CHUNK - EDGE);
    const hi = Math.min(i1, (c + 1) * CHUNK + EDGE);
    const last = out[out.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

// ---- sources ------------------------------------------------------------------

/** One leg's (or the pre-gun) stretch of a source: [lo, hi). */
export interface LegRange {
  leg: number;
  src: SrcTrack;
  lo: number;
  hi: number;
}

/**
 * A drawing's track by leg: its segments (and the pre-gun track first, with `pre`), or with `full` that
 * boat's full-rate track cut at the segments' times (each leg from its first drawn fix to its last, the
 * fixes before the first leg as the pre-gun stretch).
 */
export function legRanges(d: BoatDrawing, pre: boolean, full?: FullRateTrack): LegRange[] {
  const out: LegRange[] = [];
  if (full) {
    const first = d.segments[0]?.t[0];
    if (pre) {
      const hi = first == null ? full.t.length : upperBound(full.t, first);
      if (hi > 0) out.push({ leg: PRE_LEG, src: full, lo: 0, hi });
    }
    for (const s of d.segments) {
      if (!s.t.length) continue;
      const [lo, hi] = timeRange(full.t, s.t[0], s.t[s.t.length - 1]);
      if (hi > lo) out.push({ leg: s.leg, src: full, lo, hi });
    }
    return out;
  }
  if (pre && d.pre?.t.length) out.push({ leg: PRE_LEG, src: d.pre, lo: 0, hi: d.pre.t.length });
  for (const s of d.segments) out.push({ leg: s.leg, src: s, lo: 0, hi: s.t.length });
  return out;
}

export interface PieceOptions {
  /** One leg, or all (null). */
  leg: number | null;
  /** Race-time window [t0, t1], ms; null: the whole track. */
  win?: [number, number] | null;
  /** Only near this map-coordinate box (null: everywhere). */
  clip?: Box | null;
  /** Include the pre-gun track (scrubbing; never with one leg shown). */
  pre?: boolean;
  /** Full-rate tracks to draw from instead, where a boat has one. */
  full?: FullRateSet | null;
}

/** The pieces of drawing `d` the map draws under `o`. */
export function drawingPieces(twd: number, d: BoatDrawing, o: PieceOptions): MapPiece[] {
  const out: MapPiece[] = [];
  for (const r of legRanges(d, !!o.pre && o.leg == null, o.full?.get(d.id))) {
    if (o.leg != null && r.leg !== o.leg) continue;
    const [lo, hi] = o.win ? timeRange(r.src.t, o.win[0], o.win[1], r.lo, r.hi) : [r.lo, r.hi];
    if (hi <= lo) continue;
    const { x: rx, y: ry } = rotTrack(twd, r.src);
    for (const [i0, i1] of nearRanges(rx, ry, lo, hi, o.clip ?? null)) out.push({ id: d.id, leg: r.leg, src: r.src, rx, ry, i0, i1, end: hi - 1 });
  }
  return out;
}

/** Fixes in `pieces` (what a frame draws at most). */
export const pieceCount = (pieces: readonly MapPiece[]): number => pieces.reduce((s, p) => s + p.i1 - p.i0, 0);

// ---- a boat at a moment ----------------------------------------------------------

/** Inside a gap, the dot holds (hollow) at the last fix for this long, s; then it goes. */
export const MAP_HOLD_S = 5;
/** Fixes this close (m) give no course over ground. */
const COG_MIN_M = 0.5;

/** A boat's interpolated state at time `t`. */
export interface BoatAt {
  id: string;
  t: number;
  leg: number;
  /** East/north metres, and map coordinates. */
  x: number;
  y: number;
  mx: number;
  my: number;
  sog: number;
  /** Course over ground, degrees true (NaN: not moving). */
  cog: number;
  /** The direction of travel in map coordinates (unit), or null. */
  dir: Vec | null;
  roll: number;
  /** In a gap, within MAP_HOLD_S of the fix before it: shown there, hollow. */
  hold: boolean;
  /** Holding: that fix's time. */
  lastFix?: number;
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;
/** Roll between two readings: linear, or whichever is a reading. */
const lerpRoll = (a: number | undefined, b: number | undefined, f: number): number => {
  const fa = a != null && Number.isFinite(a);
  const fb = b != null && Number.isFinite(b);
  return fa && fb ? lerp(a, b, f) : fa ? a : fb ? b! : NaN;
};

/**
 * Where boat `id`'s track (its leg ranges, in time order) has it at `t`: linear between the fixes either
 * side; at a fix, that fix; none when the step there is a gap (> gapMs) past MAP_HOLD_S, or outside the track.
 * Later ranges win at a shared fix (the first beat at the gun, not the pre-start stretch that ends there).
 */
export function boatAt(id: string, ranges: readonly LegRange[], t: number, gapMs: number, twd: number): BoatAt | null {
  for (let ri = ranges.length - 1; ri >= 0; ri--) {
    const r = ranges[ri];
    const tt = r.src.t;
    if (r.hi <= r.lo || t < tt[r.lo] || t > tt[r.hi - 1]) continue;
    const j = upperBound(tt, t, r.lo, r.hi) - 1;
    const k = Math.min(j + 1, r.hi - 1);
    const s = r.src;
    const rot = rotTrack(twd, s);
    const step = tt[k] - tt[j];
    const exact = tt[j] === t || k === j;
    let hold = false;
    let f = 0;
    if (!exact) {
      if (step > gapMs) {
        if (t - tt[j] > MAP_HOLD_S * 1000) return null;
        hold = true;
      } else f = (t - tt[j]) / step;
    }
    // Course from the step the boat is on (or, at a fix, the one after it; the one before at the end).
    const [a, b] = k > j && tt[k] - tt[j] <= gapMs ? [j, k] : j > r.lo && tt[j] - tt[j - 1] <= gapMs ? [j - 1, j] : [j, j];
    const dx = s.x[b] - s.x[a];
    const dy = s.y[b] - s.y[a];
    const moving = a !== b && Math.hypot(dx, dy) >= COG_MIN_M;
    const mdx = rot.x[b] - rot.x[a];
    const mdy = rot.y[b] - rot.y[a];
    const ml = Math.hypot(mdx, mdy);
    return {
      id,
      t,
      leg: r.leg,
      x: lerp(s.x[j], s.x[k], f),
      y: lerp(s.y[j], s.y[k], f),
      mx: lerp(rot.x[j], rot.x[k], f),
      my: lerp(rot.y[j], rot.y[k], f),
      sog: lerp(s.sog[j], s.sog[k], f),
      cog: moving ? vecBearing([dx, dy]) : NaN,
      dir: moving && ml > 0 ? [mdx / ml, mdy / ml] : null,
      roll: lerpRoll(s.roll?.[j], s.roll?.[k], f),
      hold,
      ...(hold ? { lastFix: tt[j] } : {}),
    };
  }
  return null;
}
