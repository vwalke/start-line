/**
 * The rival ladder's gap (the Coach tab's "Gap to rivals" chart): time at equal course progress.
 *
 * - Progress along a leg (legAlong): on beats and runs, the share of the leg's wind ladder climbed
 *   (ladder.ts rung, along one wind for the whole leg: the fleet's mean on it), scaled to the leg's
 *   rhumb length; on reaches, the distance made good along the rhumb line. 0 at the leg's start mark,
 *   its rhumb length at its end, one scale for every boat. Course progress adds the legs before.
 *   Before the start line (progress < 0 on the first leg) there is none.
 * - A rounding is a zone of course progress: the last ROUNDING_IN_M of the leg it ends and the first
 *   ROUNDING_OUT_M of the next. Inside it a boat makes no progress records; it crosses the zone
 *   linearly in time, from when it got ROUNDING_IN_M from the mark to when it got ROUNDING_OUT_M down
 *   the next leg. The turn, an offset mark, an overstand or a stall in a rounding pack are spread
 *   over that time, so boats compare rounding against rounding, never a stall against another boat
 *   sailing. A leg too short for the zones is all zone.
 * - Each boat's progress over time is read from its records (a fix, or a zone edge, further on than
 *   any before), linearly in time between them: monotone, so a tack is spread over the stretch it
 *   took. A rounding timed inside a hole (the leg bounds) is a point at the mark, so a straight line
 *   across the hole bends there. Each stretch keeps its longest time between fixes (a fix with the leg
 *   unknown counts as missing).
 * - Readings (progressAt, timeAtProgress):
 *   - as positions are read (tracks.ts posAt): only across stretches with fixes at most
 *     COACH_MAX_SPAN_S apart, and only at a time within COACH_NEAR_FIX_S of a real fix. Each group
 *     boat's own (thin) line uses this, so it breaks at a hole;
 *   - across holes up to a given length, for the group line. Progress and time-at-progress are
 *     monotone, so a straight line across a hole stays between the truth's two ends.
 * - Gap at `t`: the chosen boat's progress at `t`, and `t` − the time the group boat got that far, s
 *   (+ = behind: it was there earlier). Boats on different legs compare.
 * - The group's gap (bold line): the median over a fixed set of boats, each read across holes up to
 *   GROUP_BRIDGE_S, so a boat in a hole keeps its place in the median instead of dropping out of it
 *   (with a split group, one boat fewer moves the median from one cluster to the other). Drawn only
 *   where at least GROUP_MIN_SHARE of the group's gaps are read across holes of GROUP_DRAW_HOLE_S or
 *   less (a median of straight lines across a shared hole is a guess). Where the set with a value
 *   changes anyway (a track starts or ends, a hole over GROUP_BRIDGE_S), the line breaks for a point
 *   rather than step to a median over other boats.
 */
import { circMean, dot, len, median, sub, type Vec } from '../geo';
import { GROUP_MIN_SHARE, legEnd, legLengths, rung, type Course, type GapPoint, type Wind } from './ladder';
import { COACH_MAX_SPAN_S, COACH_NEAR_FIX_S, trackLegAt, type CoachTrack } from './tracks';

/**
 * A rounding zone starts this far before the mark, m: past where boats pass it (J/70 Worlds race 2's
 * first windward mark: the boats near USA 833 got to between 23 m short of it and 5 m past it), short
 * enough that the zone is the rounding and not the approach.
 */
export const ROUNDING_IN_M = 30;
/** …and ends this far down the new leg, m: past an offset mark's sideways leg, the bear-away or the hoist, a gate's far mark. */
export const ROUNDING_OUT_M = 30;
/**
 * The group line reads a boat across holes up to this long, s (its thin line doesn't), so the median
 * keeps the same boats. The trackers here lose boats for minutes in rounding packs (J/105 CBC race 2:
 * every boat for 4–5 min at the windward mark, USA 313 for 7 min down the first run). Over 10 min the
 * straight line would span most of a leg: the boat leaves the median there, and the line breaks.
 */
export const GROUP_BRIDGE_S = 600;
/**
 * The group line is drawn only where at least GROUP_MIN_SHARE of its gaps are read across holes no
 * longer than this (for both boats), s: twice the position rule's span (COACH_MAX_SPAN_S), ~60–120 m
 * of a leg, over which a straight line is off by a second or two. Across a hole the whole fleet shared,
 * a median of straight lines is no measurement: with 60 s, J/105 CBC race 2 Beat 2 (every boat 20–55 s
 * between fixes) moved 13 s in 10 s, faster than a gap can grow; across J/70 Worlds race 2's 10 min
 * hole on the first run, a 50 s dip that wasn't.
 */
export const GROUP_DRAW_HOLE_S = 30;

/** Distance made good along leg `leg`'s rhumb line from its start mark, m (negative behind it, over its length past the end; 0 on a leg of no length). */
export function legProgress(c: Course, leg: number, p: Vec): number {
  const a = c.pts[leg];
  const d = sub(c.pts[leg + 1], a);
  const L = len(d);
  return L > 0 ? dot(sub(p, a), d) / L : 0;
}

/** The wind a leg's ladder is laid along: one for the whole leg and every boat, °. */
export interface LegWind {
  twdDeg: number;
  /** Tack angle (the upwind laylines), °. */
  taDeg: number;
}

/** Sampling for legWinds, ms. */
const LEG_WIND_STEP_MS = 30_000;

/** Each leg's wind: the mean over the fleet's time on it (the first boat to start it to the last to finish it; else the whole of `fromMs`–`toMs`). */
export function legWinds(c: Course, w: Wind, tracks: Iterable<Pick<CoachTrack, 'bounds'>>, fromMs: number, toMs: number): LegWind[] {
  const all = [...tracks];
  return c.kinds.map((_, k) => {
    const starts = all.map((tr) => tr.bounds[k]).filter((x): x is number => x != null);
    const ends = all.map((tr) => tr.bounds[k + 1]).filter((x): x is number => x != null);
    const a = starts.length ? Math.min(...starts) : fromMs;
    const b = Math.max(a, ends.length ? Math.max(...ends) : toMs);
    const ts: number[] = [];
    for (let t = a; t <= b; t += LEG_WIND_STEP_MS) ts.push(t);
    return { twdDeg: circMean(ts.map((t) => w.twdAt(t))), taDeg: median(ts.map((t) => w.taAt(t))) };
  });
}

/**
 * How far along leg `leg` a boat at `p` is, m: 0 at its start mark, its rhumb length at its end (0 on a leg
 * of no length). Beats and runs: the share of the leg's ladder climbed (ladder.ts rung along `lw[leg]`),
 * scaled to the rhumb length, so on a leg skewed to the wind both tacks or gybes get the same credit for
 * the same VMG (along the rhumb line, the gybe that points down it gains ~40 % on the other at a 20°
 * skew). One wind per leg keeps it a fixed scale: the same place is the same progress for every boat at
 * every moment. Reaches: distance made good along the rhumb line.
 */
export function legAlong(c: Course, lw: readonly LegWind[], leg: number, p: Vec): number {
  const a = c.pts[leg];
  const L = len(sub(c.pts[leg + 1], a));
  const kind = c.kinds[leg];
  if (!(L > 0)) return 0;
  if (kind === 'reach' || !lw[leg]) return legProgress(c, leg, p);
  const { twdDeg, taDeg } = lw[leg];
  const full = rung(a, legEnd(c, leg, a), twdDeg, kind, taDeg);
  return full > 0 ? L * (1 - rung(p, legEnd(c, leg, p), twdDeg, kind, taDeg) / full) : legProgress(c, leg, p);
}

/** A boat's progress records: times and course progress both strictly increasing. */
export interface ProgressTrack {
  t: number[];
  /** m */
  p: number[];
  /** The longest time between fixes from the record before to this one, s (Infinity for the first). */
  holeS: number[];
  /** The boat's fix times, ms (the near-fix rule). */
  fixT: ArrayLike<number>;
}

/** Where each leg starts in course progress, m. */
const legStarts = (lens: number[]): number[] => lens.map((_, k) => lens.slice(0, k).reduce((s, x) => s + x, 0));

/** Leg `k`'s stretch outside the rounding zones, along it: [lo, hi] (none when hi < lo). */
function legSpan(lens: number[], k: number): [number, number] {
  return [k === 0 ? 0 : ROUNDING_OUT_M, k === lens.length - 1 ? lens[k] : lens[k] - ROUNDING_IN_M];
}

export function progressTrack(c: Course, lw: readonly LegWind[], tr: CoachTrack): ProgressTrack {
  const n = c.kinds.length;
  const lens = legLengths(c);
  const start = legStarts(lens);
  const spans = lens.map((_, k) => legSpan(lens, k));
  // Where records start and stop: the start line, then each leg's ends outside the zones.
  const edges = spans.flatMap(([lo, hi], k) => (hi >= lo ? [start[k] + lo, start[k] + hi] : []));
  const out: ProgressTrack = { t: [], p: [], holeS: [], fixT: tr.t };
  let hole = Infinity;
  const push = (t: number, p: number, after: number): void => {
    const m = out.p.length;
    if (m && (p <= out.p[m - 1] || t <= out.t[m - 1])) return;
    out.t.push(t);
    out.p.push(p);
    out.holeS.push(hole);
    hole = after;
  };
  // (Set by `step`, so not narrowed to null here.)
  let prev = null as { t: number; leg: number; u: number; top: number } | null;
  /** On from `prev` to `u` on `leg` at `t`, inside a stretch whose fixes are `gap` s apart: records at the edges crossed, then there (`anchor`: not a fix). */
  const step = (t: number, leg: number, u: number, gap: number, anchor: boolean): void => {
    const [lo, hi] = spans[leg];
    // No further than this leg's rounding zone while still on the leg (an overstand).
    const top = Math.min(u, start[leg] + hi);
    if (prev) {
      for (const e of edges) {
        if (e <= prev.top || e > top) continue;
        const f = u > prev.u ? Math.min(1, Math.max(0, (e - prev.u) / (u - prev.u))) : 1;
        push(prev.t + f * (t - prev.t), e, gap);
      }
    }
    if (hi >= lo && top >= start[leg] + lo) push(t, top, anchor ? gap : 0);
    prev = { t, leg, u, top };
  };
  for (let i = 0; i < tr.t.length; i++) {
    const t = tr.t[i];
    const leg = trackLegAt(tr, t);
    if (leg == null || leg >= n) continue;
    const gap = prev ? (t - prev.t) / 1000 : Infinity;
    hole = Math.max(hole, gap);
    // A rounding timed inside a hole: the boat was at that mark then.
    for (let k = (prev?.leg ?? leg) + 1; prev && k <= leg; k++) {
      const r = tr.bounds[k];
      if (r != null && r > prev.t && r < t) step(r, k, start[k], gap, true);
    }
    // Along its own leg from the course's start: continuous through a mark (the end of a leg is the start of the next).
    step(t, leg, start[leg] + legAlong(c, lw, leg, [tr.x[i], tr.y[i]]), gap, false);
  }
  return out;
}

/** The leg a course progress is on; a rounding zone counts to the leg it ends. */
export function legOfProgress(c: Course, p: number): number {
  const lens = legLengths(c);
  const start = legStarts(lens);
  for (let k = 0; k < lens.length - 1; k++) if (p < start[k + 1] + ROUNDING_OUT_M) return k;
  return lens.length - 1;
}

/** Linear between the records `xs`/`ys` (xs increasing) at `x`; null outside them or across a stretch with a hole over `maxHoleS`. */
function between(xs: number[], ys: number[], holeS: number[], x: number, maxHoleS: number): number | null {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= xs.length) return null;
  if (xs[lo] === x) return ys[lo];
  if (lo === 0 || holeS[lo] > maxHoleS) return null;
  return ys[lo - 1] + ((x - xs[lo - 1]) / (xs[lo] - xs[lo - 1])) * (ys[lo] - ys[lo - 1]);
}

/** Whether `t` is within COACH_NEAR_FIX_S of one of the fixes `ts` (increasing). */
function nearFix(ts: ArrayLike<number>, t: number): boolean {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo < ts.length ? ts[lo] - t : Infinity, lo > 0 ? t - ts[lo - 1] : Infinity) <= COACH_NEAR_FIX_S * 1000;
}

/**
 * The boat's course progress at `t`, m: as positions are read (no `maxHoleS`: across fixes up to COACH_MAX_SPAN_S
 * apart, within COACH_NEAR_FIX_S of one), or across holes up to `maxHoleS`; null outside its records or across a longer hole.
 */
export function progressAt(pt: ProgressTrack, t: number, maxHoleS?: number): number | null {
  const p = between(pt.t, pt.p, pt.holeS, t, maxHoleS ?? COACH_MAX_SPAN_S);
  return p == null || (maxHoleS == null && !nearFix(pt.fixT, t)) ? null : p;
}

/** When the boat got to course progress `p`, ms (read as progressAt); null before its first record, if it never got there, or in a hole. */
export function timeAtProgress(pt: ProgressTrack, p: number, maxHoleS?: number): number | null {
  const t = between(pt.p, pt.t, pt.holeS, p, maxHoleS ?? COACH_MAX_SPAN_S);
  return t == null || (maxHoleS == null && !nearFix(pt.fixT, t)) ? null : t;
}

/** The chosen boat's gap to each group boat (as positions are read) and to the group (the bold line), at equal progress, every `stepMs` from `fromMs` to `toMs`. */
export function timeGapSeries(c: Course, lw: readonly LegWind[], b: CoachTrack, group: CoachTrack[], fromMs: number, toMs: number, stepMs = 10_000): GapPoint[] {
  const out: GapPoint[] = [];
  const need = Math.max(1, Math.ceil(GROUP_MIN_SHARE * group.length));
  const me = progressTrack(c, lw, b);
  const pts = group.map((r) => progressTrack(c, lw, r));
  const gap = (t: number, at: number | null): number | null => (at == null ? null : (t - at) / 1000);
  let setBefore: string | null = null;
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const exact = progressAt(me, t);
    const prog = progressAt(me, t, GROUP_BRIDGE_S);
    const near = progressAt(me, t, GROUP_DRAW_HOLE_S) != null;
    const each = pts.map((pt) => (exact == null ? null : gap(t, timeAtProgress(pt, exact))));
    const all = pts.map((pt) => (prog == null ? null : gap(t, timeAtProgress(pt, prog, GROUP_BRIDGE_S))));
    const ok = all.filter((x): x is number => x != null);
    const seen = near ? pts.filter((pt) => timeAtProgress(pt, prog!, GROUP_DRAW_HOLE_S) != null).length : 0;
    // The same boats as the point before, or a break: never a step from one set's median to another's.
    const set = ok.length >= need ? all.map((x) => (x == null ? '-' : '+')).join('') : null;
    const steady = setBefore == null || set === setBefore;
    setBefore = set;
    out.push({ tMs: t, behindS: set != null && steady && seen >= need ? median(ok) : null, n: ok.length, each, leg: prog == null ? null : legOfProgress(c, prog) });
  }
  return out;
}
