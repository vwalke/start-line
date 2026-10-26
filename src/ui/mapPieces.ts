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
 * fixes (every hole filled in first: filledRanges), so it glides across a hole;
 * none before the first fix, and past the last only held there for a while.
 */
import { vecBearing, type Vec } from '../analysis/geo';
import { PRE_LEG, type BoatDrawing, type FullRateTrack } from '../analysis/types';
import { BOAT_SHAPE_MIN_KN, boatStale } from './boatShape';
import { fillRuleOf, fillTrack } from './gapFill';
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

const joined = new WeakMap<SrcTrack, { next: SrcTrack; at: number; out: SrcTrack }>();
/** Source `s` with point `at` of source `next` appended, worked out once per pair. */
function withNext(s: SrcTrack, next: SrcTrack, at: number): SrcTrack {
  const hit = joined.get(s);
  if (hit && hit.next === next && hit.at === at) return hit.out;
  const n = s.t.length;
  const grow32 = (a: Float32Array, v: number): Float32Array => {
    const o = new Float32Array(n + 1);
    o.set(a.subarray(0, n));
    o[n] = v;
    return o;
  };
  const t = new Float64Array(n + 1);
  t.set(s.t.subarray(0, n));
  t[n] = next.t[at];
  const out: SrcTrack = {
    x: grow32(s.x, next.x[at]),
    y: grow32(s.y, next.y[at]),
    t,
    sog: grow32(s.sog, next.sog[at]),
    ...(s.roll ? { roll: grow32(s.roll, next.roll?.[at] ?? NaN) } : {}),
  };
  joined.set(s, { next, at, out });
  return out;
}

/**
 * legRanges with each source's holes judged on the feed's own fixes and every one filled in for drawing
 * (ui/gapFill.ts fillTrack: a thinned segment gets the feed's fixes around each hole back first): the same ranges,
 * over the filled sources. A hole where one range ends and the next begins (a rounding inside it) is filled too: the
 * range runs on across it to the next one's first fix. Display only: the maps' tracks, trails and boats read these.
 */
export function filledRanges(d: BoatDrawing, pre: boolean, full?: FullRateTrack): LegRange[] {
  const rule = fillRuleOf(d);
  const rs = legRanges(d, pre, full);
  return rs.map((r, k) => {
    if (r.hi <= r.lo) return r;
    const next = rs.slice(k + 1).find((q) => q.hi > q.lo);
    const last = r.src.t[r.hi - 1];
    const bridge = next != null && next.src.t[next.lo] - last > rule.holeMs;
    // Bridged: on to the next range's first fix (in the same source at full rate, else appended to a copy).
    const base = bridge && next.src !== r.src ? withNext(r.src, next.src, next.lo) : r.src;
    const endT = bridge ? next.src.t[next.lo] : last;
    const src = fillTrack(base, rule, !full && r.leg !== PRE_LEG);
    if (src === r.src && !bridge) return r;
    return { leg: r.leg, src, lo: lowerBound(src.t, r.src.t[r.lo]), hi: upperBound(src.t, endT) };
  });
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

/** The pieces of drawing `d` the map draws under `o` (holes filled in: filledRanges). */
export function drawingPieces(twd: number, d: BoatDrawing, o: PieceOptions): MapPiece[] {
  const out: MapPiece[] = [];
  for (const r of filledRanges(d, !!o.pre && o.leg == null, o.full?.get(d.id))) {
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

/**
 * Past its final fix (its tracker stopped before it finished), the boat holds there for this long, s (hollow: boatShape.ts
 * boatStale), then it goes: as long as the trail behind it, so a tracker that died is off the map once its trail is.
 */
export const MAP_HOLD_S = 120;
/** Fixes this close (m) give no course over ground. */
const COG_MIN_M = 0.5;

const headCache = new WeakMap<SrcTrack, Int32Array>();
/**
 * Per fix of `src`: the index b of the latest step (b − 1 → b) at or before it that gives a heading (at least
 * COG_MIN_M long, BOAT_SHAPE_MIN_KN or more at either end); −1: none yet. Worked out once per source.
 */
function headingIdx(src: SrcTrack): Int32Array {
  const hit = headCache.get(src);
  if (hit) return hit;
  const { t, x, y, sog } = src;
  const idx = new Int32Array(t.length).fill(-1);
  for (let i = 1; i < t.length; i++) {
    const ok = Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]) >= COG_MIN_M && Math.max(sog[i - 1], sog[i]) >= BOAT_SHAPE_MIN_KN;
    idx[i] = ok ? i : idx[i - 1];
  }
  headCache.set(src, idx);
  return idx;
}

/**
 * The last heading boat track `ranges` (its leg ranges in time order) gave at or before `t`, as a unit direction in
 * map coordinates; null: none yet (no step moving at BOAT_SHAPE_MIN_KN or more). The hull keeps it while the boat is
 * held past its final fix, slow, or has no course this step.
 */
export function lastHeadingAt(ranges: readonly LegRange[], t: number, twd: number): Vec | null {
  for (let ri = ranges.length - 1; ri >= 0; ri--) {
    const r = ranges[ri];
    if (r.hi <= r.lo || t < r.src.t[r.lo]) continue;
    const j = Math.min(upperBound(r.src.t, t, r.lo, r.hi), r.hi) - 1;
    const b = headingIdx(r.src)[j];
    if (b < 1) continue;
    const rot = rotTrack(twd, r.src);
    const dx = rot.x[b] - rot.x[b - 1];
    const dy = rot.y[b] - rot.y[b - 1];
    const l = Math.hypot(dx, dy);
    if (l > 0) return [dx / l, dy / l];
  }
  return null;
}

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
  /** Past its final fix (before its finish), within MAP_HOLD_S of it: shown there (hollow once `stale`). */
  hold: boolean;
  /** Holding: that fix's time. */
  lastFix?: number;
  /** Holding and that fix is stale (boatShape.ts boatStale): drawn hollow. */
  stale: boolean;
  /** The last heading known at or before `t` (lastHeadingAt), where the hull needs it: held, slow or no course; else omitted. */
  lastDir?: Vec | null;
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;
/** Roll between two readings: linear, or whichever is a reading. */
const lerpRoll = (a: number | undefined, b: number | undefined, f: number): number => {
  const fa = a != null && Number.isFinite(a);
  const fb = b != null && Number.isFinite(b);
  return fa && fb ? lerp(a, b, f) : fa ? a : fb ? b! : NaN;
};

/**
 * Until when a boat finishing at `finishMs` (null: no finish) is held past its final fix (boatAt's `endHold`):
 * before its finish. A track that ends at or after the finish is a finished boat, not a lost tracker: not held.
 */
export const endHoldBefore = (finishMs: number | null | undefined): number => finishMs ?? Infinity;

/**
 * Where boat `id`'s track (its leg ranges, in time order, holes filled in: filledRanges) has it at `t`: linear
 * between the points either side, however far apart; at a fix, that fix; none outside the track. Past its final
 * fix (its tracker stopped), held there for up to MAP_HOLD_S, but only before `endHold` (endHoldBefore; -Infinity,
 * the default: never). Later ranges win at a shared fix (the first beat at the gun, not the pre-start stretch that
 * ends there).
 */
export function boatAt(id: string, ranges: readonly LegRange[], t: number, twd: number, endHold = -Infinity): BoatAt | null {
  let final = true;
  for (let ri = ranges.length - 1; ri >= 0; ri--) {
    const r = ranges[ri];
    const tt = r.src.t;
    if (r.hi <= r.lo) continue;
    const end = tt[r.hi - 1];
    const after = final && t > end && t < endHold && t - end <= MAP_HOLD_S * 1000;
    final = false;
    if (t < tt[r.lo] || (t > end && !after)) continue;
    const j = upperBound(tt, t, r.lo, r.hi) - 1;
    const k = Math.min(j + 1, r.hi - 1);
    const s = r.src;
    const rot = rotTrack(twd, s);
    const exact = after || tt[j] === t || k === j;
    const hold = after;
    const f = exact ? 0 : (t - tt[j]) / (tt[k] - tt[j]);
    // Course from the step the boat is on (or, at a fix, the one after it; the one before at the end).
    const [a, b] = k > j ? [j, k] : j > r.lo ? [j - 1, j] : [j, j];
    const dx = s.x[b] - s.x[a];
    const dy = s.y[b] - s.y[a];
    const moving = a !== b && Math.hypot(dx, dy) >= COG_MIN_M;
    const mdx = rot.x[b] - rot.x[a];
    const mdy = rot.y[b] - rot.y[a];
    const ml = Math.hypot(mdx, mdy);
    const dir: Vec | null = moving && ml > 0 ? [mdx / ml, mdy / ml] : null;
    const sog = lerp(s.sog[j], s.sog[k], f);
    return {
      id,
      t,
      leg: r.leg,
      x: lerp(s.x[j], s.x[k], f),
      y: lerp(s.y[j], s.y[k], f),
      mx: lerp(rot.x[j], rot.x[k], f),
      my: lerp(rot.y[j], rot.y[k], f),
      sog,
      cog: moving ? vecBearing([dx, dy]) : NaN,
      dir,
      roll: lerpRoll(s.roll?.[j], s.roll?.[k], f),
      hold,
      ...(hold ? { lastFix: tt[j] } : {}),
      stale: boatStale(hold, tt[j], t),
      ...(hold || !dir || !(sog >= BOAT_SHAPE_MIN_KN) ? { lastDir: lastHeadingAt(ranges, t, twd) } : {}),
    };
  }
  return null;
}
