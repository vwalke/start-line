/**
 * Wind direction estimate from the fleet's upwind tack headings. With no
 * wind sensor on the boats, the two steady close-hauled headings straddle
 * the true wind; their bisector is the TWD estimate.
 */
import { circMean, gradientAt, median, wrap180 } from './geo';
import type { LegKind } from './types';

export interface HeadingSeries {
  t: ArrayLike<number>;
  heading: ArrayLike<number>;
  sog: ArrayLike<number>;
}

/**
 * Indices of samples in (a + 20 s, b − 15 s) where the boat is sailing
 * steadily: |turn rate| (median over ~2 s) < 4°/s and SOG above a floor.
 */
export function steadyIndices(s: HeadingSeries, a: number, b: number, minSog = 3): number[] {
  const idx: number[] = [];
  for (let i = 0; i < s.t.length; i++) if (s.t[i] > a + 20_000 && s.t[i] < b - 15_000) idx.push(i);
  if (idx.length < 3) return [];
  const ts = idx.map((i) => s.t[i] / 1000);
  // Unwrapped heading so a 359→1 step is +2°, not −358°.
  const unwrapped: number[] = [];
  let prev = s.heading[idx[0]];
  let acc = prev;
  for (const i of idx) {
    const h = s.heading[i];
    acc += wrap180(h - prev);
    prev = h;
    unwrapped.push(acc);
  }
  const rate = ts.map((_, k) => gradientAt(ts, unwrapped, k));
  const sogs = idx.map((i) => s.sog[i]);
  const floor = Math.min(minSog, 0.6 * median(sogs));
  const out: number[] = [];
  let lo = 0;
  let hi = 0;
  for (let k = 0; k < idx.length; k++) {
    while (ts[lo] < ts[k] - 1) lo++;
    while (hi < idx.length && ts[hi] <= ts[k] + 1) hi++;
    const r = Math.abs(median(rate.slice(lo, hi)));
    if (r < 4 && sogs[k] > floor) out.push(idx[k]);
  }
  return out;
}

/** Two-cluster circular k-means on headings (degrees). */
export function tackModes(headings: number[]): { centers: [number, number]; counts: [number, number] } {
  const m = circMean(headings);
  let c: [number, number] = [m - 45, m + 45];
  let counts: [number, number] = [0, 0];
  for (let iter = 0; iter < 50; iter++) {
    const groups: [number[], number[]] = [[], []];
    for (const h of headings) {
      const d0 = Math.abs(wrap180(h - c[0]));
      const d1 = Math.abs(wrap180(h - c[1]));
      groups[d0 <= d1 ? 0 : 1].push(h);
    }
    const next: [number, number] = [
      groups[0].length ? circMean(groups[0]) : c[0],
      groups[1].length ? circMean(groups[1]) : c[1],
    ];
    counts = [groups[0].length, groups[1].length];
    const moved = Math.abs(wrap180(next[0] - c[0])) + Math.abs(wrap180(next[1] - c[1]));
    c = next;
    if (moved < 1e-6) break;
  }
  return { centers: c, counts };
}

/** TWD from tack headings, or null when the data doesn't look like two tacks. */
export function estimateTwd(headings: number[]): { twdDeg: number; tackAngleDeg: number } | null {
  if (headings.length < 30) return null;
  const { centers, counts } = tackModes(headings);
  const minCount = Math.min(...counts);
  if (minCount < 0.08 * headings.length) return null;
  const tackAngleDeg = Math.abs(wrap180(centers[0] - centers[1]));
  if (tackAngleDeg < 45 || tackAngleDeg > 130) return null;
  return { twdDeg: circMean(centers), tackAngleDeg };
}

/**
 * Did the fleet sail two steady headings either side of `axisDeg` (tacks
 * about the wind upwind, gybes about the downwind direction)? Both clusters
 * need a fair share and must sit on opposite sides, at least 10° off it.
 */
export function straddles(headings: number[], axisDeg: number): boolean {
  if (headings.length < 30) return false;
  const { centers, counts } = tackModes(headings);
  if (Math.min(...counts) < 0.15 * headings.length) return false;
  const a = wrap180(centers[0] - axisDeg);
  const b = wrap180(centers[1] - axisDeg);
  return Math.sign(a) !== Math.sign(b) && Math.abs(a) >= 10 && Math.abs(b) >= 10 && Math.abs(wrap180(centers[0] - centers[1])) >= 30;
}

/**
 * Beat within 50° of upwind, Run within 50° of downwind; in the next 20°
 * band only if the fleet tacked (`tacked`) or gybed (`gybed`) on the leg;
 * anything else is a Reach.
 */
export function classifyLeg(courseDeg: number, twdDeg: number, tacked = false, gybed = false): LegKind {
  const d = Math.abs(wrap180(courseDeg - twdDeg));
  if (d <= 50 || (d <= 70 && tacked)) return 'upwind';
  if (d >= 130 || (d >= 110 && gybed)) return 'downwind';
  return 'reach';
}

/** Piecewise-linear TWD through (t, twd) estimates, clamped at the ends. */
export function makeTwdAt(points: { tMs: number; twdDeg: number }[], fallback: number): (t: number) => number {
  const pts = [...points].sort((a, b) => a.tMs - b.tMs);
  if (!pts.length) return () => fallback;
  return (t) => {
    if (t <= pts[0].tMs) return pts[0].twdDeg;
    const last = pts[pts.length - 1];
    if (t >= last.tMs) return last.twdDeg;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (t <= b.tMs) {
        const f = (t - a.tMs) / (b.tMs - a.tMs);
        return (((a.twdDeg + f * wrap180(b.twdDeg - a.twdDeg)) % 360) + 360) % 360;
      }
    }
    return last.twdDeg;
  };
}
