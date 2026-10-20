/**
 * When a boat crossed the start line onto the course side (spec §8, D1's
 * input): the first time from `fromMs` its bow goes from the pre-start side
 * to the course side between the ends, linear between two fixes no more than
 * `maxSpanS` apart (a crossing inside a hole is unknown: null). The bow
 * crosses `bowM ÷ speed` before the antenna (start.py: a track whose fixes
 * are seconds apart would otherwise miss a bow that crossed inside a hole).
 */
import { dot, len, sub, type Vec } from '../geo';
import { COVERAGE_GAP_S } from '../coverage';

/** Speed floor for the bow's time offset, m/s. */
export const BOW_MIN_SPEED_MS = 0.5;

export interface LineCrossOptions {
  /** Bow ahead of the antenna along the direction of travel, m. */
  bowM?: number;
  /** Ends tolerance along the line, m (a crossing just outside an end still counts). */
  slackM?: number;
  maxSpanS?: number;
}

export function lineCrossing(
  tr: { t: ArrayLike<number>; x: ArrayLike<number>; y: ArrayLike<number> },
  left: Vec,
  right: Vec,
  /** Unit normal pointing to the course side. */
  courseSide: Vec,
  fromMs: number,
  opts: LineCrossOptions = {},
): number | null {
  const { bowM = 0, slackM = 10, maxSpanS = COVERAGE_GAP_S } = opts;
  const along = sub(right, left);
  const L = len(along);
  if (!(L > 0)) return null;
  const dir: Vec = [along[0] / L, along[1] / L];
  for (let i = 1; i < tr.t.length; i++) {
    if (tr.t[i] < fromMs) continue;
    const dt = tr.t[i] - tr.t[i - 1];
    if (dt > maxSpanS * 1000) continue;
    const a: Vec = [tr.x[i - 1], tr.y[i - 1]];
    const b: Vec = [tr.x[i], tr.y[i]];
    const da = dot(sub(a, left), courseSide);
    const db = dot(sub(b, left), courseSide);
    if (!(da <= 0 && db > 0)) continue;
    const f = da === db ? 0 : -da / (db - da);
    const p: Vec = [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
    const s = dot(sub(p, left), dir);
    if (s < -slackM || s > L + slackM) continue;
    const t = tr.t[i - 1] + f * dt;
    if (t < fromMs) continue;
    // The bow got there bowM sooner, at the pair's speed (floored: a boat stopped on the line).
    const v = dt > 0 ? len(sub(b, a)) / (dt / 1000) : 0;
    return t - (bowM / Math.max(BOW_MIN_SPEED_MS, v)) * 1000;
  }
  return null;
}
