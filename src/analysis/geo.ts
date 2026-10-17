/** Small geometry/stats helpers in a local east-north (ENU) plane, metres. */
import type { LatLon } from '../data/types';

export const EARTH_R = 6_371_000;
export const MS_TO_KN = 1.943844;
const RAD = Math.PI / 180;

export type Vec = [number, number];

/** Equirectangular local projection about an origin; accurate to well under 0.1% over a race course. */
export interface Projection {
  origin: LatLon;
  toXY(lat: number, lon: number): Vec;
}

export function makeProjection(origin: LatLon): Projection {
  const k = Math.cos(origin.lat * RAD) * EARTH_R * RAD;
  const ky = EARTH_R * RAD;
  return {
    origin,
    toXY: (lat, lon) => [(lon - origin.lon) * k, (lat - origin.lat) * ky],
  };
}

/** Wrap an angle to (-180, 180]. */
export function wrap180(a: number): number {
  const r = (((a + 180) % 360) + 360) % 360 - 180;
  return r === -180 ? 180 : r;
}

export function norm360(a: number): number {
  return ((a % 360) + 360) % 360;
}

/** Circular mean of angles in degrees, result in [0, 360). */
export function circMean(angles: ArrayLike<number>): number {
  let s = 0;
  let c = 0;
  for (let i = 0; i < angles.length; i++) {
    s += Math.sin(angles[i] * RAD);
    c += Math.cos(angles[i] * RAD);
  }
  return norm360(Math.atan2(s, c) / RAD);
}

/** Unit vector pointing toward compass bearing `deg` (east, north). */
export function bearingVec(deg: number): Vec {
  return [Math.sin(deg * RAD), Math.cos(deg * RAD)];
}

/** Compass bearing of a vector (east, north). */
export function vecBearing(v: Vec): number {
  return norm360(Math.atan2(v[0], v[1]) / RAD);
}

export const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1];
export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k];
export const len = (a: Vec): number => Math.hypot(a[0], a[1]);

export function median(xs: ArrayLike<number>): number {
  const s = Array.from(xs).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Index of the last element <= x in a sorted array (-1 if none). */
export function bisectRight(arr: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Linear interpolation of ys at x (clamped to the ends, like numpy.interp). */
export function interp(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (!n) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  const i = bisectRight(xs, x);
  const x0 = xs[i];
  const x1 = xs[i + 1];
  const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
  return ys[i] + f * (ys[i + 1] - ys[i]);
}

/** Interpolate a heading series through its sin/cos so 359→1 doesn't pass through 180. */
export function interpAngle(xs: ArrayLike<number>, deg: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (!n) return NaN;
  if (x <= xs[0]) return norm360(deg[0]);
  if (x >= xs[n - 1]) return norm360(deg[n - 1]);
  const i = bisectRight(xs, x);
  const f = xs[i + 1] === xs[i] ? 0 : (x - xs[i]) / (xs[i + 1] - xs[i]);
  const s = (1 - f) * Math.sin(deg[i] * RAD) + f * Math.sin(deg[i + 1] * RAD);
  const c = (1 - f) * Math.cos(deg[i] * RAD) + f * Math.cos(deg[i + 1] * RAD);
  return norm360(Math.atan2(s, c) / RAD);
}

/** numpy.gradient-style derivative dy/dx at sample i (central inside, one-sided at the ends). */
export function gradientAt(xs: ArrayLike<number>, ys: ArrayLike<number>, i: number): number {
  const n = xs.length;
  if (n < 2) return 0;
  if (i <= 0) return (ys[1] - ys[0]) / (xs[1] - xs[0]);
  if (i >= n - 1) return (ys[n - 1] - ys[n - 2]) / (xs[n - 1] - xs[n - 2]);
  // Non-uniform central difference, as numpy does.
  const h1 = xs[i] - xs[i - 1];
  const h2 = xs[i + 1] - xs[i];
  return (h1 * h1 * ys[i + 1] - h2 * h2 * ys[i - 1] + (h2 * h2 - h1 * h1) * ys[i]) / (h1 * h2 * (h1 + h2));
}
