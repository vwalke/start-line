/**
 * Wind direction estimate from the fleet's upwind tack headings. With no
 * wind sensor on the boats, the two steady close-hauled headings straddle
 * the true wind; their bisector is the TWD estimate.
 */
import { circMean, gradientAt, median, wrap180 } from './geo';
import type { LegKind, StartWind, WindInfo } from './types';

export interface HeadingSeries {
  t: ArrayLike<number>;
  heading: ArrayLike<number>;
  sog: ArrayLike<number>;
}

/** steadyIndices skips this much after a window opens (the turn onto the leg), ms… */
export const STEADY_LEAD_MS = 20_000;
/** …and this much before it closes (the approach to the mark), ms. */
export const STEADY_TAIL_MS = 15_000;

/**
 * Indices of samples in (a + STEADY_LEAD_MS, b − STEADY_TAIL_MS) where the boat is sailing
 * steadily: |turn rate| (median over ~2 s) < 4°/s and SOG above a floor.
 */
export function steadyIndices(s: HeadingSeries, a: number, b: number, minSog = 3): number[] {
  const idx: number[] = [];
  for (let i = 0; i < s.t.length; i++) if (s.t[i] > a + STEADY_LEAD_MS && s.t[i] < b - STEADY_TAIL_MS) idx.push(i);
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

/** Two-cluster circular k-means on headings (degrees), each `weights[i]` times (else once); `weight` sums each cluster's. */
export function tackModes(
  headings: number[],
  weights?: number[],
): { centers: [number, number]; counts: [number, number]; weight: [number, number] } {
  const m = circMean(headings, weights);
  let c: [number, number] = [m - 45, m + 45];
  let counts: [number, number] = [0, 0];
  let weight: [number, number] = [0, 0];
  for (let iter = 0; iter < 50; iter++) {
    const groups: [number[], number[]] = [[], []];
    const ws: [number[], number[]] = [[], []];
    headings.forEach((h, i) => {
      const d0 = Math.abs(wrap180(h - c[0]));
      const d1 = Math.abs(wrap180(h - c[1]));
      const g = d0 <= d1 ? 0 : 1;
      groups[g].push(h);
      ws[g].push(weights ? weights[i] : 1);
    });
    const next: [number, number] = [
      groups[0].length ? circMean(groups[0], ws[0]) : c[0],
      groups[1].length ? circMean(groups[1], ws[1]) : c[1],
    ];
    counts = [groups[0].length, groups[1].length];
    weight = [ws[0].reduce((x, y) => x + y, 0), ws[1].reduce((x, y) => x + y, 0)];
    const moved = Math.abs(wrap180(next[0] - c[0])) + Math.abs(wrap180(next[1] - c[1]));
    c = next;
    if (moved < 1e-6) break;
  }
  return { centers: c, counts, weight };
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
 * The wind at the gun: the fleet's steady headings from the gun to START_WIND_WINDOW_MS after it (analyze.ts opens
 * steadyIndices' window STEADY_LEAD_MS before the gun and closes it STEADY_TAIL_MS after, so the samples span exactly
 * that). A whole-beat estimate, pinned at the beat's mid-time, carries a shift during the beat back to the gun.
 */
export const START_WIND_WINDOW_MS = 180_000;
/**
 * Each steady heading counts for the time it stands for, its gap to the boat's next fix capped at this, ms (about the
 * span steadyIndices judges the turn rate over): boat-seconds, not fixes, so a device logging every 0.3 s (three in
 * Cascais R2) or a fixture's native-rate minute at the gun doesn't outvote boats logging every few seconds.
 */
export const START_WIND_MAX_DT_MS = 2_000;
/** …needs this many steady headings in all… */
export const START_WIND_MIN_SAMPLES = 300;
/** …this share of their time on each tack (just after the gun most boats are still on starboard)… */
export const START_WIND_MIN_TACK_SHARE = 0.15;
/** …and at least this many on each tack. */
export const START_WIND_MIN_TACK_N = 60;
/**
 * …and a tack angle (45–130°, as estimateTwd) within this of Beat 1's, °: the fleet tacks through about the same angle
 * minutes apart, so a split much narrower or wider is not two tacks (boats reaching along the line, a footing lane).
 */
export const START_WIND_MAX_TACK_DIFF_DEG = 15;

/**
 * TWD from the first minutes' tack headings (each `weights[i]` ms), or null when there are too few, too few on a tack,
 * or they aren't two plausible tacks against Beat 1's tack angle `beatTackAngleDeg`.
 */
export function estimateStartTwd(headings: number[], weights: number[], beatTackAngleDeg: number): Omit<StartWind, 'tMs'> | null {
  if (headings.length < START_WIND_MIN_SAMPLES) return null;
  const { centers, counts, weight } = tackModes(headings, weights);
  if (Math.min(...counts) < START_WIND_MIN_TACK_N || Math.min(...weight) < START_WIND_MIN_TACK_SHARE * (weight[0] + weight[1])) return null;
  const tackAngleDeg = Math.abs(wrap180(centers[0] - centers[1]));
  if (tackAngleDeg < 45 || tackAngleDeg > 130 || Math.abs(tackAngleDeg - beatTackAngleDeg) > START_WIND_MAX_TACK_DIFF_DEG) return null;
  return { twdDeg: circMean(centers), tackAngleDeg, samples: headings.length, tackSamples: counts };
}

/** The (time, TWD) points the wind runs through: the start window's at the gun (when it is the source), then each beat's. */
export function windPoints(w: Pick<WindInfo, 'estimates' | 'startWindow'>): { tMs: number; twdDeg: number }[] {
  return w.startWindow ? [w.startWindow, ...w.estimates] : w.estimates;
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
