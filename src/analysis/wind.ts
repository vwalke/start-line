/**
 * Wind direction estimate from the fleet's upwind tack headings. With no
 * wind sensor on the boats, the two steady close-hauled headings straddle
 * the true wind; their bisector is the TWD estimate.
 */
import { circMean, gradientAt, median, wrap180 } from './geo';
import type { LegKind, StartWind, StartWindFail, WindInfo } from './types';

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
 * The wind at the gun: the fleet's close-hauled headings from START_WIND_FROM_MS after the gun to START_WIND_TO_MS (the
 * first seconds are still the start: luffing on the line, reaching off it, clearing a transom). A whole-beat estimate,
 * pinned at the beat's mid-time, carries a shift during the beat back to the gun.
 */
export const START_WIND_FROM_MS = 30_000;
/** …to this long after the gun, ms (3 min of tacks). */
export const START_WIND_TO_MS = 210_000;
const mss = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}`;
/** The gun window as the labels give it, after the gun: "0:30–3:30". */
export const START_WIND_SPAN = `${mss(START_WIND_FROM_MS)}–${mss(START_WIND_TO_MS)}`;
/** Each boat is read once every this, ms… */
export const START_WIND_GRID_MS = 2_000;
/**
 * …at its nearest fix within this, ms; none that near is a hole and reads nothing. Half the 10 s the feeds and fixtures
 * fall back to, so a boat counts once per step whether it logs every 0.3 s or every 10 s: boat-seconds, not fixes.
 */
export const START_WIND_GRID_TOL_MS = 5_000;
/**
 * Close-hauled: a tack's headings within this of its mode, ° (the mode found among them); footing to clear a transom,
 * reaching or luffing falls outside and is dropped, and the tacks are read again from what is left.
 */
export const START_WIND_BAND_DEG = 10;
/** …needs this many close-hauled headings in all (boat readings, START_WIND_GRID_MS apart)… */
export const START_WIND_MIN_SAMPLES = 150;
/**
 * …this share of them on each tack (just after the gun most boats are still on starboard; under it the few port boats,
 * often ducking or clearing their air, set half the bisector)…
 */
export const START_WIND_MIN_TACK_SHARE = 0.2;
/** …at least this many on each tack… */
export const START_WIND_MIN_TACK_N = 30;
/**
 * …and a tack angle (45–130°, as estimateTwd) within this of Beat 1's, °: the fleet tacks through about the same angle
 * minutes apart, and half the difference is the bisector's error if one tack alone is off.
 */
export const START_WIND_MAX_TACK_DIFF_DEG = 8;

/**
 * A boat's headings in the gun window, one each START_WIND_GRID_MS from gun + START_WIND_FROM_MS to gun +
 * START_WIND_TO_MS (or STEADY_TAIL_MS before `endMs`, its first rounding): its nearest fix within
 * START_WIND_GRID_TOL_MS, when that fix is steady. steadyIndices' window is set so its own trims land on those bounds.
 */
export function startWindHeadings(s: HeadingSeries, gun: number, endMs = Infinity): number[] {
  const from = gun + START_WIND_FROM_MS;
  const to = Math.min(gun + START_WIND_TO_MS, endMs - STEADY_TAIL_MS);
  const steady = new Set(steadyIndices(s, from - STEADY_LEAD_MS, to + STEADY_TAIL_MS));
  const out: number[] = [];
  if (!steady.size) return out;
  let j = 0;
  for (let t = from; t <= to; t += START_WIND_GRID_MS) {
    while (j + 1 < s.t.length && Math.abs(s.t[j + 1] - t) <= Math.abs(s.t[j] - t)) j++;
    if (Math.abs(s.t[j] - t) <= START_WIND_GRID_TOL_MS && steady.has(j)) out.push(s.heading[j]);
  }
  return out;
}

/** Each tack's close-hauled headings: those within START_WIND_BAND_DEG of its mode, the mode their mean (a mean shift). */
export function closeHauled(headings: number[], centers: [number, number]): { centers: [number, number]; kept: [number[], number[]] } {
  const c: [number, number] = [...centers];
  const kept: [number[], number[]] = [[], []];
  for (const k of [0, 1] as const) {
    for (let iter = 0; iter < 50; iter++) {
      kept[k] = headings.filter((h) => Math.abs(wrap180(h - c[k])) <= START_WIND_BAND_DEG);
      if (!kept[k].length) break;
      const next = circMean(kept[k]);
      const moved = Math.abs(wrap180(next - c[k]));
      c[k] = next;
      if (moved < 1e-6) break;
    }
  }
  return { centers: c, kept };
}

/** The angle between the two tacks' close-hauled modes, °: Beat 1's, read as the gun window's are (readStartTwd). */
export function closeHauledTackAngle(headings: number[]): number {
  const { centers } = closeHauled(headings, tackModes(headings).centers);
  return Math.abs(wrap180(centers[0] - centers[1]));
}

/**
 * TWD from the gun window's headings (startWindHeadings, the fleet's): the two tacks' close-hauled modes and their
 * bisector; `fail` when there are too few, too few on a tack, or they aren't two plausible tacks against Beat 1's
 * close-hauled tack angle `beatTackAngleDeg` (closeHauledTackAngle).
 */
export function readStartTwd(headings: number[], beatTackAngleDeg: number): { est: Omit<StartWind, 'tMs'> | null; fail: StartWindFail | null } {
  const no = (fail: StartWindFail): { est: null; fail: StartWindFail } => ({ est: null, fail });
  if (headings.length < START_WIND_MIN_SAMPLES) return no('samples');
  const { centers, kept } = closeHauled(headings, tackModes(headings).centers);
  const counts: [number, number] = [kept[0].length, kept[1].length];
  const samples = counts[0] + counts[1];
  if (samples < START_WIND_MIN_SAMPLES) return no('samples');
  if (Math.min(...counts) < START_WIND_MIN_TACK_N) return no('tack-samples');
  if (Math.min(...counts) < START_WIND_MIN_TACK_SHARE * samples) return no('tack-share');
  const tackAngleDeg = Math.abs(wrap180(centers[0] - centers[1]));
  if (tackAngleDeg < 45 || tackAngleDeg > 130 || Math.abs(tackAngleDeg - beatTackAngleDeg) > START_WIND_MAX_TACK_DIFF_DEG) return no('tack-angle');
  return { est: { twdDeg: circMean(centers), tackAngleDeg, samples, steady: headings.length, tackSamples: counts }, fail: null };
}

/** readStartTwd's estimate, or null. */
export const estimateStartTwd = (headings: number[], beatTackAngleDeg: number): Omit<StartWind, 'tMs'> | null => readStartTwd(headings, beatTackAngleDeg).est;

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
