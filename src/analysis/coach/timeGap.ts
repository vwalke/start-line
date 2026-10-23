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
 * - The finish is anchored to the finish times. The last leg is measured to the line the finishers crossed:
 *   fitted through where they were at their finish times (finishLine), else the feed's; extended past its
 *   ends, so a boat level with it is there (the run's layline, ladder.ts rung, to the nearest end reads it
 *   100 m or more short). The feed's line can be elsewhere: on J/70 Worlds race 3 the boats crossed it
 *   14–29 s before their finish times, most of them past its left end. And the finish is a zone, like a
 *   rounding: a boat with a finish time makes no records in the last FINISH_IN_M of the course; it crosses
 *   it linearly in time, from when it got FINISH_IN_M from the line to its finish time, where its progress
 *   is the course's length. So at the chosen boat's finish its gap to each finisher is the difference of
 *   their finish times (the same gun: elapsed), and a fix at or past the line before the finish time can't
 *   end the course early.
 * - Each boat's progress over time is read from its records (a fix, or a zone edge, further on than
 *   any before), linearly in time between them: monotone, so a tack is spread over the stretch it
 *   took. A rounding timed inside a hole (the leg bounds) is a point at the mark, so a straight line
 *   across the hole bends there. Each stretch keeps its longest time between fixes (a fix with the leg
 *   unknown counts as missing), of the gaps that end further on: one ending on a fix no further on than the
 *   records (a tack back, a stall inside a rounding zone) hid no progress, so a stretch of ~10 s fixes isn't
 *   read as a hole for one longer gap where the boat made none.
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
 * The finish zone, m before the end of the course: as a rounding's (ROUNDING_IN_M), the finish and not the last run.
 * On the line the finishers crossed (finishLine) the progress is good to the line; the trackers stop 1–10 s before the
 * finish time, so the last few seconds are a straight line to it anyway. (120 m smoothed the fixtures' worst last points
 * by spreading real slow finishes, a boat 2 min over its last 120 m, over ~25 s more of every run.)
 */
export const FINISH_IN_M = 30;
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

/** Where leg `leg` ends for the chart, for a boat at `p`: its mark, or on the last leg the nearest point of the finish line extended past its ends. */
function progressEnd(c: Course, leg: number, p: Vec): Vec {
  const f = c.finish;
  if (!f || leg !== c.kinds.length - 1) return legEnd(c, leg, p);
  const d = sub(f.right, f.left);
  const L2 = dot(d, d);
  if (!(L2 > 0)) return legEnd(c, leg, p);
  const s = dot(sub(p, f.left), d) / L2;
  return [f.left[0] + s * d[0], f.left[1] + s * d[1]];
}

/** A finisher's position counts for the finish line fit when its last fix is at most this long before its finish time, s (the trackers here stop 1–10 s before it). */
const FINISH_FIX_S = 12;
/** The fit drops positions further than this from its line, m (the finishers' fit within ~1–4 m rms where it holds), then fits again. */
const FINISH_FIT_OUT_M = 15;
/** The fit needs this many finishers' positions, and at least FINISH_FIT_SHARE of them on its line, over at least FINISH_FIT_SPREAD_M along it. */
const FINISH_FIT_MIN = 5;
const FINISH_FIT_SHARE = 2 / 3;
const FINISH_FIT_SPREAD_M = 20;
/** The first fit leaves out positions further than this from the finishers' median one, m (J/70 Worlds race 3: two tracks end ~2 km off). */
const FINISH_FIT_NEAR_M = 1000;

/** Where a boat was at its finish time, m: between the fixes around it, else its last fix carried on at the speed from the fix before (fixes ≤ COACH_MAX_SPAN_S apart). */
function finishPos(tr: CoachTrack, fin: number): Vec | null {
  let i = -1;
  for (let k = 0; k < tr.t.length && tr.t[k] <= fin; k++) i = k;
  if (i < 0 || fin - tr.t[i] > FINISH_FIX_S * 1000) return null;
  const j = i + 1 < tr.t.length && tr.t[i + 1] - tr.t[i] <= COACH_MAX_SPAN_S * 1000 ? i + 1 : i > 0 && tr.t[i] - tr.t[i - 1] <= COACH_MAX_SPAN_S * 1000 ? i - 1 : -1;
  if (j < 0) return null;
  const f = (fin - tr.t[i]) / (tr.t[j] - tr.t[i]);
  return [tr.x[i] + f * (tr.x[j] - tr.x[i]), tr.y[i] + f * (tr.y[j] - tr.y[i])];
}

/** The total least squares line through `ps`: its centre and direction (unit). */
function fitLine(ps: Vec[]): { c: Vec; u: Vec } {
  const c: Vec = [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of ps) {
    sxx += (x - c[0]) ** 2;
    syy += (y - c[1]) ** 2;
    sxy += (x - c[0]) * (y - c[1]);
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { c, u: [Math.cos(th), Math.sin(th)] };
}

/**
 * The finish line the chart measures the last leg to: the line through where the finishers were at their finish times
 * (tracks' last bound), fitted when at least FINISH_FIT_MIN of them lie on one (FINISH_FIT_SHARE within FINISH_FIT_OUT_M,
 * FINISH_FIT_SPREAD_M along it); else the feed's. The feed's line can be elsewhere: on the fixtures the finishers lie on a
 * line within ~1–4 m rms, 4–12 m from the feed's where it holds (J/105, J/24, Benelux), 77–384 m from it on J/70 Worlds
 * races 2 and 3, Melges 24 race 5 and Viper race 2.
 */
export function finishLine(c: Course, tracks: Iterable<CoachTrack>): Course['finish'] {
  const n = c.kinds.length;
  const all: Vec[] = [];
  for (const tr of tracks) {
    const fin = tr.bounds[n];
    const p = fin == null ? null : finishPos(tr, fin);
    if (p) all.push(p);
  }
  if (all.length < FINISH_FIT_MIN) return c.finish ?? null;
  // From the median position (a track that ends far off can't pull the first fit), then without the positions off the line.
  const mid: Vec = [median(all.map((p) => p[0])), median(all.map((p) => p[1]))];
  let ps = all.filter((p) => len(sub(p, mid)) <= FINISH_FIT_NEAR_M);
  for (let k = 0; k < 3 && ps.length >= FINISH_FIT_MIN; k++) {
    const { c: o, u } = fitLine(ps);
    ps = all.filter((p) => Math.abs((p[0] - o[0]) * u[1] - (p[1] - o[1]) * u[0]) <= FINISH_FIT_OUT_M);
  }
  if (ps.length < Math.max(FINISH_FIT_MIN, FINISH_FIT_SHARE * all.length)) return c.finish ?? null;
  const { c: o, u } = fitLine(ps);
  const s = ps.map((p) => dot(sub(p, o), u));
  const lo = Math.min(...s);
  const hi = Math.max(...s);
  if (hi - lo < FINISH_FIT_SPREAD_M) return c.finish ?? null;
  return { left: [o[0] + lo * u[0], o[1] + lo * u[1]], right: [o[0] + hi * u[0], o[1] + hi * u[1]] };
}

/**
 * How far along leg `leg` a boat at `p` is, m: 0 at its start mark, its rhumb length at its end (0 on a leg
 * of no length; the last leg ends on the finish line extended). Beats and runs: the share of the leg's ladder
 * climbed (ladder.ts rung along `lw[leg]`), scaled to the rhumb length, so on a leg skewed to the wind both
 * tacks or gybes get the same credit for the same VMG (along the rhumb line, the gybe that points down it
 * gains ~40 % on the other at a 20° skew). One wind per leg keeps it a fixed scale: the same place is the
 * same progress for every boat at every moment. Reaches: distance made good along the rhumb line.
 */
export function legAlong(c: Course, lw: readonly LegWind[], leg: number, p: Vec): number {
  const a = c.pts[leg];
  const L = len(sub(c.pts[leg + 1], a));
  const kind = c.kinds[leg];
  if (!(L > 0)) return 0;
  if (kind === 'reach' || !lw[leg]) return legProgress(c, leg, p);
  const { twdDeg, taDeg } = lw[leg];
  const full = rung(a, progressEnd(c, leg, a), twdDeg, kind, taDeg);
  return full > 0 ? L * (1 - rung(p, progressEnd(c, leg, p), twdDeg, kind, taDeg) / full) : legProgress(c, leg, p);
}

/** A boat's progress records: times and course progress both strictly increasing. */
export interface ProgressTrack {
  t: number[];
  /** m */
  p: number[];
  /** The longest time between fixes from the record before to this one, s (Infinity for the first); a gap ending on a fix that made no record doesn't count. */
  holeS: number[];
  /** Whether each record is at a fix (else a zone edge or a rounding in a hole: a time interpolated by construction). */
  atFix: boolean[];
  /** The boat's fix times, ms (the near-fix rule). */
  fixT: ArrayLike<number>;
}

/** Where each leg starts in course progress, m. */
const legStarts = (lens: number[]): number[] => lens.map((_, k) => lens.slice(0, k).reduce((s, x) => s + x, 0));

/** Leg `k`'s stretch outside the rounding zones (and the finish zone, for a boat with a finish time), along it: [lo, hi] (none when hi < lo). */
function legSpan(lens: number[], k: number, finished: boolean): [number, number] {
  const last = k === lens.length - 1;
  return [k === 0 ? 0 : ROUNDING_OUT_M, lens[k] - (!last ? ROUNDING_IN_M : finished ? FINISH_IN_M : 0)];
}

export function progressTrack(c: Course, lw: readonly LegWind[], tr: CoachTrack): ProgressTrack {
  const n = c.kinds.length;
  const lens = legLengths(c);
  const start = legStarts(lens);
  // The finish time: the end of the course (its finish zone crossed linearly in time up to it).
  const fin = tr.bounds[n] ?? null;
  const spans = lens.map((_, k) => legSpan(lens, k, fin != null));
  // Where records start and stop: the start line, then each leg's ends outside the zones.
  const edges = spans.flatMap(([lo, hi], k) => (hi >= lo ? [start[k] + lo, start[k] + hi] : []));
  const out: ProgressTrack = { t: [], p: [], holeS: [], atFix: [], fixT: tr.t };
  // The longest gap between fixes since the last record, s, of the gaps that count: one that ends on a fix no
  // further on than the records (a tack back, a stall inside a rounding zone) hid no progress, so it doesn't.
  let hole = Infinity;
  /** A record at `t` with `holeS`; `after`: the part of a gap after it (0 at a fix). Not further on in both: none. */
  const push = (t: number, p: number, holeS: number, after: number, atFix: boolean): void => {
    const m = out.p.length;
    if (m && (p <= out.p[m - 1] || t <= out.t[m - 1])) return;
    out.t.push(t);
    out.p.push(p);
    out.holeS.push(holeS);
    out.atFix.push(atFix);
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
      const from = prev;
      for (const e of edges) {
        if (e <= from.top || e > top) continue;
        const f = u > from.u ? Math.min(1, Math.max(0, (e - from.u) / (u - from.u))) : 1;
        // An edge the point before was already past (an overstand, capped) is crossed there: the gap after it is not before it.
        push(from.t + f * (t - from.t), e, f > 0 ? Math.max(hole, gap) : hole, gap, false);
      }
    }
    if (hi >= lo && top >= start[leg] + lo) push(t, top, Math.max(hole, gap), anchor ? gap : 0, !anchor);
    prev = { t, leg, u, top };
  };
  for (let i = 0; i < tr.t.length; i++) {
    const t = tr.t[i];
    // A fix at the finish time is the finish (below).
    if (fin != null && t >= fin) break;
    const leg = trackLegAt(tr, t);
    if (leg == null || leg >= n) continue;
    const gap = prev ? (t - prev.t) / 1000 : Infinity;
    // A rounding timed inside a hole: the boat was at that mark then.
    for (let k = (prev?.leg ?? leg) + 1; prev && k <= leg; k++) {
      const r = tr.bounds[k];
      if (r != null && r > prev.t && r < t) step(r, k, start[k], gap, true);
    }
    // Along its own leg from the course's start: continuous through a mark (the end of a leg is the start of the next).
    step(t, leg, start[leg] + legAlong(c, lw, leg, [tr.x[i], tr.y[i]]), gap, false);
  }
  // The finish: the course's length at the finish time, from the last fix on the last leg (or a rounding into it timed
  // in the hole before), through the finish zone's edge if that fix was short of it.
  const total = start[n - 1] + lens[n - 1];
  if (fin != null && prev && prev.t < fin && prev.leg === n - 1) {
    const gap = (fin - prev.t) / 1000;
    step(fin, n - 1, total, gap, true);
    push(fin, total, Math.max(hole, gap), 0, false);
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

/**
 * Linear between the records `xs`/`ys` (xs increasing) at `x`, and whether that rests on positions (both records it
 * lies between, or the one it is at, are fixes); null outside them or across a stretch with a hole over `maxHoleS`.
 */
function between(pt: ProgressTrack, xs: number[], ys: number[], x: number, maxHoleS: number): { v: number; onFixes: boolean } | null {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= xs.length) return null;
  if (xs[lo] === x) return { v: ys[lo], onFixes: pt.atFix[lo] };
  if (lo === 0 || pt.holeS[lo] > maxHoleS) return null;
  return { v: ys[lo - 1] + ((x - xs[lo - 1]) / (xs[lo] - xs[lo - 1])) * (ys[lo] - ys[lo - 1]), onFixes: pt.atFix[lo - 1] && pt.atFix[lo] };
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
 * A stretch that starts or ends at a zone edge (the approach to a rounding zone, the zone, the way out of it) is linear in
 * time by construction, not read from the nearest fix: there only the span rule holds, so a ~10 s track (a fix every
 * 10.5 s is 5.25 s from the nearest at the middle) doesn't drop points at the edges.
 */
export function progressAt(pt: ProgressTrack, t: number, maxHoleS?: number): number | null {
  const r = between(pt, pt.t, pt.p, t, maxHoleS ?? COACH_MAX_SPAN_S);
  return r == null || (maxHoleS == null && r.onFixes && !nearFix(pt.fixT, t)) ? null : r.v;
}

/** When the boat got to course progress `p`, ms (read as progressAt); null before its first record, if it never got there, or in a hole. */
export function timeAtProgress(pt: ProgressTrack, p: number, maxHoleS?: number): number | null {
  const r = between(pt, pt.p, pt.t, p, maxHoleS ?? COACH_MAX_SPAN_S);
  return r == null || (maxHoleS == null && r.onFixes && !nearFix(pt.fixT, r.v)) ? null : r.v;
}

/** The gap series' time step, ms: the chart's points, and what the cards read (the same points). */
export const GAP_STEP_MS = 10_000;

/** The chosen boat's gap to each group boat (as positions are read) and to the group (the bold line), at equal progress, every `stepMs` from `fromMs` to `toMs`. */
export function timeGapSeries(c: Course, lw: readonly LegWind[], b: CoachTrack, group: CoachTrack[], fromMs: number, toMs: number, stepMs = GAP_STEP_MS): GapPoint[] {
  return gapPoints(
    c,
    progressTrack(c, lw, b),
    group.map((r) => progressTrack(c, lw, r)),
    fromMs,
    toMs,
    stepMs,
  );
}

function gapPoints(c: Course, me: ProgressTrack, pts: ProgressTrack[], fromMs: number, toMs: number, stepMs: number): GapPoint[] {
  const out: GapPoint[] = [];
  const need = Math.max(1, Math.ceil(GROUP_MIN_SHARE * pts.length));
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
    // In the median but not there as positions are read: bridged across a hole (estimated).
    const est = prog == null ? 0 : pts.filter((pt, k) => all[k] != null && timeAtProgress(pt, prog) == null).length;
    // The same boats as the point before, or a break: never a step from one set's median to another's.
    const set = ok.length >= need ? all.map((x) => (x == null ? '-' : '+')).join('') : null;
    const steady = setBefore == null || set === setBefore;
    setBefore = set;
    out.push({ tMs: t, behindS: set != null && steady && seen >= need ? median(ok) : null, n: ok.length, est, each, leg: prog == null ? null : legOfProgress(c, prog) });
  }
  return out;
}

/** What groupGap reads of a coach model (index.ts CoachModel). */
export interface GapModel {
  course: Course;
  wind: Wind;
  tracks: Map<string, CoachTrack>;
  gunMs: number;
  endMs: number;
}

interface GapCache {
  course: Course;
  lw: LegWind[];
  pts: Map<string, ProgressTrack>;
  series: Map<string, GapPoint[]>;
}
const gapCaches = new WeakMap<GapModel, GapCache>();

function gapCache(m: GapModel): GapCache {
  let cache = gapCaches.get(m);
  if (!cache) {
    const course = { ...m.course, finish: finishLine(m.course, m.tracks.values()) };
    gapCaches.set(m, (cache = { course, lw: legWinds(course, m.wind, m.tracks.values(), m.gunMs, m.endMs), pts: new Map(), series: new Map() }));
  }
  return cache;
}

/** The course and leg winds the chart measures progress on: the model's, with the finish line where its finishers crossed it (finishLine). */
export function gapCourse(m: GapModel): { course: Course; lw: LegWind[] } {
  const { course, lw } = gapCache(m);
  return { course, lw };
}

/**
 * The chosen boat's gap to the boats `ids` (those tracked, in that order: `each`): the one series the chart (index.ts
 * rivalLadder) and the cards (detectors/context.ts `gaps`) both read. Every GAP_STEP_MS from the gun to the model's
 * end, each leg's wind from the whole fleet (legWinds), on gapCourse; the points in [fromMs, toMs]. The same model, boat
 * and boats always give the same points (worked out once, kept with the model), so a card's seconds are the chart's.
 */
export function groupGap(m: GapModel, boat: string, ids: readonly string[], fromMs = m.gunMs, toMs = m.endMs): GapPoint[] {
  const me = m.tracks.get(boat);
  if (!me) return [];
  const c = gapCache(m);
  const ptOf = (tr: CoachTrack): ProgressTrack => {
    let pt = c.pts.get(tr.id);
    if (!pt) c.pts.set(tr.id, (pt = progressTrack(c.course, c.lw, tr)));
    return pt;
  };
  const group = ids.map((id) => m.tracks.get(id)).filter((x): x is CoachTrack => !!x);
  const key = [boat, ...group.map((r) => r.id)].join('\n');
  let all = c.series.get(key);
  if (!all) c.series.set(key, (all = gapPoints(c.course, ptOf(me), group.map(ptOf), m.gunMs, m.endMs, GAP_STEP_MS)));
  // The points are the gun + k · GAP_STEP_MS: from the first at or after `fromMs` to the last at or before `toMs`.
  const i0 = Math.max(0, Math.ceil((fromMs - m.gunMs) / GAP_STEP_MS));
  const i1 = Math.min(all.length - 1, Math.floor((toMs - m.gunMs) / GAP_STEP_MS));
  return i1 >= i0 ? all.slice(i0, i1 + 1) : [];
}
