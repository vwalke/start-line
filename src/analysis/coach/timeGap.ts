/**
 * The rival ladder's gap (the Coach tab's "Gap to rivals" chart): time at equal course progress.
 *
 * - Progress along a leg: the distance made good along its rhumb line, start mark → end mark, the
 *   same on beats and runs. Each boat's leg runs from where it left the mark before (its progress
 *   there) to the furthest it got on the leg (its last record before rounding), mapped onto the
 *   leg's rhumb length, so every boat's legs start and end at the same course progress.
 * - A rounding is ROUNDING_SPAN_M of course progress, crossed linearly in time from the boat's
 *   arrival (its furthest on the leg it ends) to its leaving (the last fix within ROUNDING_LOOK_S
 *   that is no further on the new leg than where it started it, ± ROUNDING_SLACK_M): the turn, an
 *   offset mark, an overstand. So the rounding is continuous, and its time is compared with each
 *   rival's own rounding rather than spiking where one boat stalls and another doesn't.
 * - Each boat's progress over time is read from its records (a fix further on than any before it),
 *   linearly in time between them: monotone, so a tack is spread over the stretch it took. A
 *   stretch with a hole in it (fixes over COACH_MAX_SPAN_S apart, or the leg unknown) has no values;
 *   nor has anything before a boat's first fix or past its furthest.
 * - Gap at `t`: the chosen boat's progress at `t`, and `t` − the time the group boat got that far, s
 *   (+ = behind: it was there earlier). Boats on different legs compare. The group's gap: the median
 *   of the boats' gaps (GROUP_MIN_SHARE of the group).
 */
import { dot, len, median, sub, type Vec } from '../geo';
import { GROUP_MIN_SHARE, legLengths, type Course, type GapPoint } from './ladder';
import { COACH_MAX_SPAN_S, trackLegAt, type CoachTrack } from './tracks';

/** Course progress one rounding takes, m (any length works: every boat crosses it, linearly in time). */
export const ROUNDING_SPAN_M = 10;
/** A boat has left a mark once it is this much further on the new leg than where it started it, m… */
export const ROUNDING_SLACK_M = 5;
/** …looked for this long after the rounding, s. */
export const ROUNDING_LOOK_S = 180;

/** Distance made good along leg `leg`'s rhumb line from its start mark, m (negative behind it, over its length past the end). */
export function legProgress(c: Course, leg: number, p: Vec): number {
  const a = c.pts[leg];
  const d = sub(c.pts[leg + 1], a);
  const L = len(d);
  return L > 0 ? dot(sub(p, a), d) / L : 0;
}

/** A boat's progress records: times and course progress both strictly increasing. */
export interface ProgressTrack {
  t: number[];
  /** m */
  p: number[];
  /** Whether the stretch from the record before is whole (no hole, the leg known throughout). */
  linked: boolean[];
}

export function progressTrack(c: Course, tr: CoachTrack): ProgressTrack {
  const n = c.kinds.length;
  const lens = legLengths(c);
  const legStart = lens.map((_, k) => lens.slice(0, k).reduce((s, x) => s + x + ROUNDING_SPAN_M, 0));
  // The fixes with a known leg, and whether each is joined to the fix before.
  const fx: { t: number; leg: number; q: number; linked: boolean }[] = [];
  let prevOk = false;
  for (let i = 0; i < tr.t.length; i++) {
    const t = tr.t[i];
    const leg = trackLegAt(tr, t);
    if (leg == null || leg >= n) {
      prevOk = false;
      continue;
    }
    fx.push({ t, leg, q: legProgress(c, leg, [tr.x[i], tr.y[i]]), linked: prevOk && t - tr.t[i - 1] <= COACH_MAX_SPAN_S * 1000 });
    prevOk = true;
  }
  const out: ProgressTrack = { t: [], p: [], linked: [] };
  let broken = false;
  const push = (t: number, p: number): void => {
    const m = out.p.length;
    if (m && (p <= out.p[m - 1] || t <= out.t[m - 1])) return;
    out.t.push(t);
    out.p.push(p);
    out.linked.push(m > 0 && !broken);
    broken = false;
  };
  for (let i = 0; i < fx.length; ) {
    const k = fx[i].leg;
    let j = i;
    while (j + 1 < fx.length && fx[j + 1].leg === k) j++;
    // Rounded into this leg with fixes on both sides: it starts where the boat left the mark.
    let from = i;
    let q0 = 0;
    const entered = i > 0 && fx[i].linked && fx[i - 1].leg === k - 1;
    if (entered) {
      q0 = fx[i].q;
      for (let h = i; h <= j && fx[h].t - fx[i].t <= ROUNDING_LOOK_S * 1000 && (h === i || fx[h].linked); h++) {
        if (fx[h].q <= q0 + ROUNDING_SLACK_M) from = h;
      }
      q0 = fx[from].q;
    }
    // Rounded out of it (not the finish) with fixes on both sides: it ends at the boat's furthest.
    const left = k < n - 1 && j + 1 < fx.length && fx[j + 1].linked && fx[j + 1].leg === k + 1;
    let q1 = lens[k];
    if (left) for (let h = from; h <= j; h++) q1 = h === from ? fx[h].q : Math.max(q1, fx[h].q);
    if (!(q1 - q0 > 0.5 * lens[k])) {
      q0 = 0;
      q1 = lens[k];
    }
    for (let h = i; h < from; h++) if (!fx[h + 1].linked) broken = true;
    const lo = k > 0 ? legStart[k] : -Infinity;
    const hi = legStart[k] + lens[k];
    for (let h = from; h <= j; h++) {
      if (h > from && !fx[h].linked) broken = true;
      push(fx[h].t, Math.min(hi, Math.max(lo, legStart[k] + ((fx[h].q - q0) * lens[k]) / (q1 - q0))));
    }
    if (j + 1 < fx.length && !fx[j + 1].linked) broken = true;
    i = j + 1;
  }
  return out;
}

/** Linear between the records `xs`/`ys` (xs increasing) at `x`; null outside them or across a broken stretch. */
function between(xs: number[], ys: number[], linked: boolean[], x: number): number | null {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= xs.length) return null;
  if (xs[lo] === x) return ys[lo];
  if (lo === 0 || !linked[lo]) return null;
  return ys[lo - 1] + ((x - xs[lo - 1]) / (xs[lo] - xs[lo - 1])) * (ys[lo] - ys[lo - 1]);
}

/** The boat's course progress at `t`, m; null outside its records or in a broken stretch. */
export const progressAt = (pt: ProgressTrack, t: number): number | null => between(pt.t, pt.p, pt.linked, t);

/** When the boat got to course progress `p`, ms; null when that was in a broken stretch, before its first fix, or never. */
export const timeAtProgress = (pt: ProgressTrack, p: number): number | null => between(pt.p, pt.t, pt.linked, p);

/** The chosen boat's gap to each group boat and to the group (median, GROUP_MIN_SHARE of it), at equal progress, every `stepMs` from `fromMs` to `toMs`. */
export function timeGapSeries(c: Course, b: CoachTrack, group: CoachTrack[], fromMs: number, toMs: number, stepMs = 10_000): GapPoint[] {
  const out: GapPoint[] = [];
  const need = Math.max(1, Math.ceil(GROUP_MIN_SHARE * group.length));
  const me = progressTrack(c, b);
  const pts = group.map((r) => progressTrack(c, r));
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const prog = progressAt(me, t);
    const each = pts.map((pt) => {
      if (prog == null) return null;
      const at = timeAtProgress(pt, prog);
      return at == null ? null : (t - at) / 1000;
    });
    const ok = each.filter((x): x is number => x != null);
    out.push({ tMs: t, behindS: ok.length >= need ? median(ok) : null, n: ok.length, each, leg: prog == null ? null : trackLegAt(b, t) });
  }
  return out;
}
