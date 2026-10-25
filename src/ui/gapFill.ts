/**
 * Short tracker gaps filled in for the maps, as a smooth curve between the fixes either side.
 *
 * DISPLAY-ONLY. The points made here are drawn and nothing else: they must never feed official results,
 * finish detection, OCS, start-line crossing, penalties, places, coverage, or any Coach computation or
 * finding. Only ui/ modules that draw tracks, trails and boats import this; src/analysis and src/data
 * never do (tests/gapFillDisplayOnly.test.ts checks).
 *
 * Holes are judged on the feed's own fixes, never on the drawn segments thinned to one fix per second
 * (that would turn a 1.5 s hole in a 2 Hz feed into a 2.5 s step): a hole is a step between consecutive
 * fixes of the feed longer than its hole threshold (analysis/rawHoles.ts: over 2 s, or twice the feed's
 * usual step). The drawing carries the feed's fixes around each hole (BoatDrawing.holes); a thinned
 * segment gets them merged back in (fillTrack's `thinned`), so a hole is drawn from its real ends.
 *
 * A hole up to SHORT_GAP_S long is filled with a cubic Hermite curve from the two fixes and their
 * velocities (course from the neighboring step on that side, at the fix's SOG), sampled about every
 * FILL_STEP_MS. Where a velocity can't be had (no neighboring step, no SOG) the tangent is Catmull-Rom's,
 * from the fixes either side; a tangent pointing back against the hole's chord isn't used, and one much
 * longer than the chord is shortened, so the curve can't swing wide. A curve that still strays far off
 * its chord is drawn straight. A longer hole is a break, left blank (mapPoints.ts drawingGapMs).
 *
 * The filled points are flagged (`est`) so the views draw them lighter. A track with nothing to merge or
 * fill is returned as it is (the same object), so a clean track draws exactly as before.
 */
import type { Vec } from '../analysis/geo';
import { holeMsOf } from '../analysis/rawHoles';
import type { BoatDrawing } from '../analysis/types';

/** Holes up to this long, s, are filled in on the maps; a longer one is a break, left blank (RaceSense's own viewer bridges up to 30 s). */
export const SHORT_GAP_S = 30;
/** The filled curve is sampled about this often, ms. */
export const FILL_STEP_MS = 1000;
/** How much lighter the filled stretches are drawn: this times the stroke's own opacity. */
export const EST_OPACITY = 0.45;
/** A tangent is shortened to at most this many chord lengths. */
const MAX_TANGENT = 1.5;
/** A tangent more than this far off the chord's direction (cosine) is unreliable. */
const MIN_COS = -0.2;
/** A curve straying further than this many chord lengths off its chord is drawn straight instead. */
const MAX_BULGE = 0.6;
const KN_MS = 1852 / 3600;

/** Whether a step of `dtMs` between fixes is a short gap (filled) under hole threshold `holeMs`. */
export const isShortGap = (dtMs: number, holeMs: number): boolean => dtMs > holeMs && dtMs <= SHORT_GAP_S * 1000;

/** A track to fill: fix times (ms), positions (m, x east, y north), and SOG (kn) and course over ground (° true) where known. */
export interface FillInput {
  t: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  sog?: ArrayLike<number>;
  cog?: ArrayLike<number>;
}

/** Which steps are holes: a threshold, ms (a step longer is one), or a test of step `k` → `k + 1`. */
export type HoleTest = number | ((k: number) => boolean);

/** The points filled into one gap (not its two fixes): times, positions, and the curve's direction there (unit; null: not moving). */
export interface GapPoints {
  t: number[];
  x: number[];
  y: number[];
  dir: (Vec | null)[];
}

const unit = (v: Vec): Vec | null => {
  const l = Math.hypot(v[0], v[1]);
  return l > 0 && Number.isFinite(l) ? [v[0] / l, v[1] / l] : null;
};

const holeAt = (tr: FillInput, holes: HoleTest): ((k: number) => boolean) =>
  typeof holes === 'number' ? (k) => tr.t[k + 1] - tr.t[k] > holes : holes;

/**
 * Fix `i`'s velocity, m/s, from its course and SOG: the course given, else the step on side `side` (−1: the step
 * into it, +1: the one out) when that isn't a hole. Null when either is missing.
 */
function velocity(tr: FillInput, i: number, side: -1 | 1, isHole: (k: number) => boolean): Vec | null {
  const sog = tr.sog?.[i];
  if (sog == null || !Number.isFinite(sog) || sog < 0) return null;
  const cog = tr.cog?.[i];
  let dir: Vec | null = null;
  if (cog != null && Number.isFinite(cog)) {
    const th = (cog * Math.PI) / 180;
    dir = [Math.sin(th), Math.cos(th)];
  } else {
    const j = i + side;
    if (j < 0 || j >= tr.t.length || isHole(Math.min(i, j))) return null;
    dir = unit(side < 0 ? [tr.x[i] - tr.x[j], tr.y[i] - tr.y[j]] : [tr.x[j] - tr.x[i], tr.y[j] - tr.y[i]]);
  }
  return dir ? [dir[0] * sog * KN_MS, dir[1] * sog * KN_MS] : null;
}

/** Catmull-Rom's velocity at fix `i` (m/s): from the fixes either side, or along the gap's chord at an end of the track. */
function catmullRom(tr: FillInput, i: number): Vec | null {
  const lo = Math.max(0, i - 1);
  const hi = Math.min(tr.t.length - 1, i + 1);
  const dt = (tr.t[hi] - tr.t[lo]) / 1000;
  if (hi === lo || !(dt > 0)) return null;
  return [(tr.x[hi] - tr.x[lo]) / dt, (tr.y[hi] - tr.y[lo]) / dt];
}

/** The tangent (m per unit of the curve's parameter) from velocity `v` over `dtS`, or null when it would mislead: against the chord. Shortened to MAX_TANGENT chords. */
function tangent(v: Vec | null, dtS: number, chord: Vec, chordLen: number): Vec | null {
  if (!v) return null;
  const m: Vec = [v[0] * dtS, v[1] * dtS];
  const l = Math.hypot(m[0], m[1]);
  if (!Number.isFinite(l)) return null;
  if (l === 0) return m;
  if ((m[0] * chord[0] + m[1] * chord[1]) / (l * chordLen) < MIN_COS) return null;
  const k = Math.min(1, (MAX_TANGENT * chordLen) / l);
  return [m[0] * k, m[1] * k];
}

/** Distance from `p` to the segment a–b. */
function segDist(p: Vec, a: Vec, b: Vec): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  const f = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - f * vx, p[1] - a[1] - f * vy);
}

/**
 * The points filling the hole between fixes `i` and `i + 1` of `tr` (`holes`: which steps are holes), about every
 * FILL_STEP_MS; null when that step isn't a hole of SHORT_GAP_S or less.
 */
export function fillGap(tr: FillInput, i: number, holes: HoleTest): GapPoints | null {
  if (i < 0 || i + 1 >= tr.t.length) return null;
  const isHole = holeAt(tr, holes);
  const t0 = tr.t[i];
  const t1 = tr.t[i + 1];
  const dtMs = t1 - t0;
  if (!isHole(i) || dtMs > SHORT_GAP_S * 1000) return null;
  const p0: Vec = [tr.x[i], tr.y[i]];
  const p1: Vec = [tr.x[i + 1], tr.y[i + 1]];
  const chord: Vec = [p1[0] - p0[0], p1[1] - p0[1]];
  const chordLen = Math.hypot(chord[0], chord[1]);
  const dtS = dtMs / 1000;
  const n = Math.max(2, Math.ceil(dtMs / FILL_STEP_MS));
  // The same place at both ends: it stayed there.
  if (!(chordLen > 0)) {
    const ks = Array.from({ length: n - 1 }, (_, k) => k + 1);
    return { t: ks.map((k) => t0 + (dtMs * k) / n), x: ks.map(() => p0[0]), y: ks.map(() => p0[1]), dir: ks.map(() => null) };
  }
  const m0 = tangent(velocity(tr, i, -1, isHole), dtS, chord, chordLen) ?? tangent(catmullRom(tr, i), dtS, chord, chordLen) ?? chord;
  const m1 = tangent(velocity(tr, i + 1, 1, isHole), dtS, chord, chordLen) ?? tangent(catmullRom(tr, i + 1), dtS, chord, chordLen) ?? chord;
  const curve = (m0x: number, m0y: number, m1x: number, m1y: number): GapPoints => {
    const out: GapPoints = { t: [], x: [], y: [], dir: [] };
    for (let k = 1; k < n; k++) {
      const s = k / n;
      const s2 = s * s;
      const s3 = s2 * s;
      const h00 = 2 * s3 - 3 * s2 + 1;
      const h10 = s3 - 2 * s2 + s;
      const h01 = -2 * s3 + 3 * s2;
      const h11 = s3 - s2;
      // The derivative, for the hull's heading along the curve.
      const d00 = 6 * s2 - 6 * s;
      const d10 = 3 * s2 - 4 * s + 1;
      const d01 = -6 * s2 + 6 * s;
      const d11 = 3 * s2 - 2 * s;
      out.t.push(t0 + (dtMs * k) / n);
      out.x.push(h00 * p0[0] + h10 * m0x + h01 * p1[0] + h11 * m1x);
      out.y.push(h00 * p0[1] + h10 * m0y + h01 * p1[1] + h11 * m1y);
      out.dir.push(unit([d00 * p0[0] + d10 * m0x + d01 * p1[0] + d11 * m1x, d00 * p0[1] + d10 * m0y + d01 * p1[1] + d11 * m1y]));
    }
    return out;
  };
  let pts = curve(m0[0], m0[1], m1[0], m1[1]);
  // A curve that swings far off the straight line between the fixes is a guess too far: straight instead.
  if (pts.x.some((x, k) => segDist([x, pts.y[k]], p0, p1) > MAX_BULGE * chordLen)) pts = curve(chord[0], chord[1], chord[0], chord[1]);
  return pts;
}

/** A track as the maps draw it (ui/mapPieces.ts SrcTrack's arrays), with `est` set (1) on every filled point. */
export interface FilledTrack {
  x: Float32Array;
  y: Float32Array;
  t: Float64Array;
  sog: Float32Array;
  roll?: Float32Array;
  est?: Uint8Array;
}

/**
 * How a boat's tracks are filled: its feed's hole threshold, and (from BoatDrawing.holes) the feed's fixes around each
 * hole and when each hole starts, for a thinned segment. Without those (an older analysis), the threshold alone.
 */
export interface FillRule {
  holeMs: number;
  /** The fix before each hole → the fix after it, ms. */
  holes: Map<number, number> | null;
  edges: FilledTrack | null;
}

const rules = new WeakMap<object, FillRule>();
/** Drawing `d`'s FillRule, worked out once per drawing. */
export function fillRuleOf(d: Pick<BoatDrawing, 'holes' | 'segments'>): FillRule {
  let r = rules.get(d);
  if (r) return r;
  const h = d.holes;
  if (h) {
    const holes = new Map<number, number>();
    for (const t of h.at) {
      // The next of the feed's fixes after `t` is in `edges`, just after it.
      let lo = 0;
      let hi = h.edges.t.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (h.edges.t[mid] <= t) lo = mid + 1;
        else hi = mid;
      }
      if (lo < h.edges.t.length) holes.set(t, h.edges.t[lo]);
    }
    r = { holeMs: h.holeMs, holes, edges: h.edges };
  } else {
    const steps: number[] = [];
    for (const s of d.segments) for (let i = 1; i < s.t.length; i++) steps.push(s.t[i] - s.t[i - 1]);
    steps.sort((p, q) => p - q);
    r = { holeMs: holeMsOf(steps.length ? steps[steps.length >> 1] : 0), holes: null, edges: null };
  }
  rules.set(d, r);
  return r;
}

/** `src` with the feed's fixes in `edges` that fall inside it, and aren't in it already, merged in by time. */
function mergeEdges(src: FilledTrack, edges: FilledTrack): FilledTrack {
  const n = src.t.length;
  if (n < 2) return src;
  const have = new Set(src.t);
  const add: number[] = [];
  for (let k = 0; k < edges.t.length; k++) if (edges.t[k] > src.t[0] && edges.t[k] < src.t[n - 1] && !have.has(edges.t[k])) add.push(k);
  if (!add.length) return src;
  const m = n + add.length;
  const out: FilledTrack = { x: new Float32Array(m), y: new Float32Array(m), t: new Float64Array(m), sog: new Float32Array(m), ...(src.roll ? { roll: new Float32Array(m) } : {}) };
  let i = 0;
  let j = 0;
  for (let k = 0; k < m; k++) {
    const fromSrc = j >= add.length || (i < n && src.t[i] < edges.t[add[j]]);
    if (fromSrc) {
      [out.t[k], out.x[k], out.y[k], out.sog[k]] = [src.t[i], src.x[i], src.y[i], src.sog[i]];
      if (out.roll) out.roll[k] = src.roll![i];
      i++;
    } else {
      const e = add[j++];
      [out.t[k], out.x[k], out.y[k], out.sog[k]] = [edges.t[e], edges.x[e], edges.y[e], edges.sog[e]];
      if (out.roll) out.roll[k] = NaN;
    }
  }
  return out;
}

const cache = new WeakMap<object, { rule: FillRule | number; thinned: boolean; out: FilledTrack }>();

/**
 * Track `src` as the maps draw it: with `thinned` (a drawn segment) the feed's fixes around each hole merged back in
 * and the holes those mark; else (the feed's own fixes) every step over the hole threshold a hole. Each hole of
 * SHORT_GAP_S or less is filled (fillGap), the filled points flagged in `est`; SOG and roll linear across it. `rule`:
 * the boat's FillRule, or just a hole threshold, ms. `src` itself when there is nothing to merge or fill. Worked out
 * once per track and rule.
 */
export function fillTrack(src: FilledTrack, rule: FillRule | number, thinned = false): FilledTrack {
  const hit = cache.get(src);
  if (hit && hit.rule === rule && hit.thinned === thinned) return hit.out;
  const r: FillRule = typeof rule === 'number' ? { holeMs: rule, holes: null, edges: null } : rule;
  const base = thinned && r.edges ? mergeEdges(src, r.edges) : src;
  const marked = thinned && r.holes;
  const isHole = (k: number): boolean => (marked ? r.holes!.get(base.t[k]) === base.t[k + 1] : base.t[k + 1] - base.t[k] > r.holeMs);
  const n = Math.min(base.t.length, base.x.length, base.y.length, base.sog.length);
  const fills: (GapPoints | null)[] = [];
  let extra = 0;
  for (let i = 0; i + 1 < n; i++) {
    const g = fillGap(base, i, isHole);
    fills.push(g);
    if (g) extra += g.t.length;
  }
  if (!extra) {
    cache.set(src, { rule, thinned, out: base });
    return base;
  }
  const m = n + extra;
  const out: FilledTrack = {
    x: new Float32Array(m),
    y: new Float32Array(m),
    t: new Float64Array(m),
    sog: new Float32Array(m),
    ...(base.roll ? { roll: new Float32Array(m) } : {}),
    est: new Uint8Array(m),
  };
  const roll = (i: number): number => base.roll?.[i] ?? NaN;
  let k = 0;
  for (let i = 0; i < n; i++) {
    out.t[k] = base.t[i];
    out.x[k] = base.x[i];
    out.y[k] = base.y[i];
    out.sog[k] = base.sog[i];
    if (out.roll) out.roll[k] = roll(i);
    if (base.est) out.est![k] = base.est[i];
    k++;
    const g = fills[i];
    if (!g) continue;
    for (let j = 0; j < g.t.length; j++) {
      const f = (g.t[j] - base.t[i]) / (base.t[i + 1] - base.t[i]);
      out.t[k] = g.t[j];
      out.x[k] = g.x[j];
      out.y[k] = g.y[j];
      out.sog[k] = base.sog[i] + (base.sog[i + 1] - base.sog[i]) * f;
      if (out.roll) out.roll[k] = Number.isFinite(roll(i)) && Number.isFinite(roll(i + 1)) ? roll(i) + (roll(i + 1) - roll(i)) * f : NaN;
      out.est![k] = 1;
      k++;
    }
  }
  cache.set(src, { rule, thinned, out });
  return out;
}

/** Whether the step from point `i − 1` to `i` of a filled track is estimated (either end a filled point). */
export const estStep = (est: ArrayLike<number> | undefined, i: number): boolean => !!est && (est[i] === 1 || est[i - 1] === 1);

/** The real fixes around filled point `i` of `t` (`est` flags): the times of the last real fix before it and the first after. */
export function estSpan(t: ArrayLike<number>, est: ArrayLike<number>, i: number): [number, number] {
  let a = i;
  while (a > 0 && est[a] === 1) a--;
  let b = i;
  while (b < t.length - 1 && est[b] === 1) b++;
  return [t[a], t[b]];
}
