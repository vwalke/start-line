/**
 * When a boat crossed the start line onto the course side (spec §8, D1's
 * input): the first time from `fromMs` its bow goes from the pre-start side
 * to the course side between the ends, linear between two fixes no more than
 * `maxSpanS` apart (a crossing inside a hole is unknown: null).
 */
import { dot, len, sub, type Vec } from '../geo';
import { COVERAGE_GAP_S } from '../coverage';

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
  /** Bow position at fix i (offset along the course to the next / from the previous fix). */
  const bow = (i: number): Vec => {
    const p: Vec = [tr.x[i], tr.y[i]];
    if (!bowM) return p;
    const j = i + 1 < tr.t.length ? i + 1 : i - 1;
    if (j < 0) return p;
    const d = i < j ? sub([tr.x[j], tr.y[j]], p) : sub(p, [tr.x[j], tr.y[j]]);
    const m = len(d);
    return m > 0 ? [p[0] + (d[0] / m) * bowM, p[1] + (d[1] / m) * bowM] : p;
  };
  for (let i = 1; i < tr.t.length; i++) {
    if (tr.t[i] < fromMs) continue;
    if (tr.t[i] - tr.t[i - 1] > maxSpanS * 1000) continue;
    const a = bow(i - 1);
    const b = bow(i);
    const da = dot(sub(a, left), courseSide);
    const db = dot(sub(b, left), courseSide);
    if (!(da <= 0 && db > 0)) continue;
    const f = da === db ? 0 : -da / (db - da);
    const p: Vec = [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
    const s = dot(sub(p, left), dir);
    if (s < -slackM || s > L + slackM) continue;
    const t = tr.t[i - 1] + f * (tr.t[i] - tr.t[i - 1]);
    if (t >= fromMs) return t;
  }
  return null;
}
