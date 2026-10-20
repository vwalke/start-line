/**
 * Leg splitting. A boat "reaches" a waypoint at its closest approach within
 * a 90 s window that opens the first time it comes within 45 m (the nearer
 * mark counts for a gate), searched only after it reached the previous one.
 */
import type { Vec } from './geo';
import { MS_TO_KN, median, wrap180, vecBearing } from './geo';
import type { XYTrack } from './prepare';
import { SPAN_MS } from './validity';

/** Fixed buoy positions, or positions as a function of time (for marks moved mid-race). */
export type Targets = Vec[] | ((t: number) => Vec[]);

export interface Waypoint {
  name: string;
  /** Identity of the physical mark(s); repeated rounding of the same mark shares a key. */
  key: string;
  /** Representative positions. */
  xy: Vec[];
  /** Positions at time t, when the mark moved during the race. */
  at?: (t: number) => Vec[];
}

export const targetsOf = (wp: Waypoint): Targets => wp.at ?? wp.xy;

export function distTo(tr: XYTrack, i: number, targets: Targets): number {
  const ps = typeof targets === 'function' ? targets(tr.t[i]) : targets;
  let d = Infinity;
  for (const p of ps) d = Math.min(d, Math.hypot(tr.x[i] - p[0], tr.y[i] - p[1]));
  return d;
}

export function firstClosest(
  tr: XYTrack,
  t0: number,
  targets: Targets,
  thresh = 45,
  winMs = 90_000,
  tMax = Infinity,
): { t: number; d: number } | null {
  let t1 = NaN;
  let best: { t: number; d: number } | null = null;
  for (let i = 0; i < tr.t.length; i++) {
    const t = tr.t[i];
    if (t <= t0) continue;
    if (t > tMax && Number.isNaN(t1)) break;
    const d = distTo(tr, i, targets);
    if (Number.isNaN(t1)) {
      if (d < thresh) t1 = t;
      else continue;
    }
    if (t > t1 + winMs) break;
    if (!best || d < best.d) best = { t, d };
  }
  return best;
}

/** Waypoint times for one boat: [gun, r1, …, rN, finish]; null once a rounding is missed. */
export function splitLegs(tr: XYTrack, gunMs: number, wps: Waypoint[], finishMs: number | null): (number | null)[] {
  const out: (number | null)[] = [gunMs];
  let t = gunMs;
  let ok = true;
  const tMax = finishMs ?? Infinity;
  for (const wp of wps) {
    if (!ok) {
      out.push(null);
      continue;
    }
    const tg = targetsOf(wp);
    const hit = firstClosest(tr, t, tg, 45, 90_000, tMax) ?? firstClosest(tr, t, tg, 90, 90_000, tMax);
    if (!hit) {
      ok = false;
      out.push(null);
      continue;
    }
    t = hit.t;
    out.push(t);
  }
  out.push(ok && finishMs != null && finishMs > t ? finishMs : null);
  return out;
}

/** A boundary within this of a fix is timed at that fix (fleet turns are found on a 1 Hz resample), ms. */
export const AT_FIX_MS = 1_500;
/** A rounding timed at the fix next to a hole is approximate (`~`) when the hole, or the sail from that fix to the mark, is at most this, ms. */
export const EDGE_GAP_MS = 60_000;
/** Below this speed the sail to the mark is timed at this speed, m/s. */
const MIN_SPEED_MS = 1;
/** A hole of this share of the fleet's quickest median leg could hide a whole leg's roundings… */
export const HIDE_FRAC = 0.75;
/** …and has, when the leg it sits in took over this many times the fleet's median for that leg. */
export const HIDE_SLOW_X = 2;

export interface CheckedBounds {
  /** Leg boundary times with the ones a telemetry hole leaves unknown set to null (gun and finish kept). */
  tt: (number | null)[];
  /** Per boundary, the hole (> SPAN_MS) its time sits in or next to, s; null when clear. */
  gapS: (number | null)[];
}

/**
 * Which of one boat's leg boundaries (`tt`: gun, roundings…, finish) a
 * telemetry hole leaves in doubt, given the fleet's median time per leg
 * (`legMedians`) and where each rounding is (`marks[k]` for `tt[k + 1]`).
 * A rounding interpolated inside a hole (course.ts turnInHole) is
 * approximate; one timed at the fix next to a hole is approximate when the
 * hole is short or that fix was at most EDGE_GAP_MS's sail from the mark
 * (or the fleet's turn), else unknown: the boat rounded somewhere in the
 * hole. A leg over HIDE_SLOW_X × the fleet's median with a hole that could
 * hide a whole leg (HIDE_FRAC) has likely lost roundings in it (its end is
 * a later lap's), so its end and every rounding after it are unknown.
 */
export function checkBounds(
  tr: { t: ArrayLike<number>; x: ArrayLike<number>; y: ArrayLike<number>; sog: ArrayLike<number> },
  tt: (number | null)[],
  legMedians: number[],
  marks: (Targets | null)[] = [],
): CheckedBounds {
  const out = [...tt];
  const gapS: (number | null)[] = tt.map(() => null);
  const { t } = tr;
  const n = t.length;
  if (n < 2) return { tt: out, gapS };
  const meds = legMedians.filter((m) => m > 0);
  const hideMs = meds.length ? HIDE_FRAC * Math.min(...meds) : Infinity;
  /** Index of the first fix at or after `x`. */
  const after = (x: number): number => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (t[m] < x) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const span = (j: number): number => (j > 0 && j < n ? t[j] - t[j - 1] : 0);
  /** Fix i is within EDGE_GAP_MS's sail (at its own SOG) of rounding k's mark. */
  const nearMark = (k: number, i: number): boolean => {
    const tg = marks[k - 1];
    if (!tg) return false;
    const ps = typeof tg === 'function' ? tg(t[i]) : tg;
    const reach = (Math.max(MIN_SPEED_MS, tr.sog[i] / MS_TO_KN) * EDGE_GAP_MS) / 1000;
    return ps.some((p) => Math.hypot(tr.x[i] - p[0], tr.y[i] - p[1]) <= reach);
  };
  let lost = false;
  for (let k = 1; k < tt.length - 1; k++) {
    const x = tt[k];
    const prev = tt[k - 1];
    if (x == null) continue;
    if (!lost && prev != null && x - prev > HIDE_SLOW_X * (legMedians[k - 1] ?? Infinity)) {
      for (let j = Math.max(1, after(prev)); j < n && t[j - 1] < x; j++) if (span(j) > hideMs) lost = true;
    }
    if (lost) {
      out[k] = null;
      continue;
    }
    const j = after(x);
    const lo = j > 0 ? t[j - 1] : -Infinity;
    const hi = j < n ? t[j] : Infinity;
    const atFix = Math.min(x - lo, hi - x) <= AT_FIX_MS;
    // At a fix: the holes either side of it; inside a hole: that hole.
    const fix = hi - x <= x - lo ? j : j - 1;
    const g = atFix ? Math.max(span(fix), span(fix + 1)) : span(j);
    if (g <= SPAN_MS) continue;
    if (!atFix || g <= EDGE_GAP_MS || nearMark(k, fix)) gapS[k] = g / 1000;
    else out[k] = null;
  }
  return { tt: out, gapS };
}

/** The fleet's median time per leg over the boats that sailed it (`times` as splitLegs), ms; NaN for a leg nobody did. */
export function legMedians(times: Iterable<(number | null)[]>): number[] {
  const per: number[][] = [];
  let nLegs = 0;
  for (const tt of times) {
    nLegs = Math.max(nLegs, tt.length - 1);
    for (let li = 0; li + 1 < tt.length; li++) {
      const a = tt[li];
      const e = tt[li + 1];
      if (a != null && e != null && e > a) (per[li] ??= []).push(e - a);
    }
  }
  return Array.from({ length: nLegs }, (_, li) => (per[li]?.length ? median(per[li]) : NaN));
}

/**
 * Infers the rounding sequence from one track: close approaches (< 45 m)
 * where the course over ground turns by more than 120° (a tack is ~70–100°, wider in light air).
 * Consecutive repeats are collapsed.
 */
export function inferRoundings(tr: XYTrack, gunMs: number, endMs: number, wps: Waypoint[]): string[] {
  const uniq = new Map(wps.map((w) => [w.key, w]));
  const events: { t: number; key: string }[] = [];
  const cog = (a: number, b: number): number | null => {
    let ia = -1;
    let ib = -1;
    for (let i = 0; i < tr.t.length; i++) {
      if (ia < 0 && tr.t[i] >= a) ia = i;
      if (tr.t[i] <= b) ib = i;
    }
    if (ia < 0 || ib <= ia) return null;
    const dx = tr.x[ib] - tr.x[ia];
    const dy = tr.y[ib] - tr.y[ia];
    return Math.hypot(dx, dy) < 5 ? null : vecBearing([dx, dy]);
  };
  for (const wp of uniq.values()) {
    let inside = false;
    let best = { t: 0, d: Infinity };
    for (let i = 0; i < tr.t.length; i++) {
      const t = tr.t[i];
      if (t <= gunMs || t > endMs) continue;
      const d = distTo(tr, i, targetsOf(wp));
      if (d < 45) {
        if (!inside) best = { t, d };
        inside = true;
        if (d < best.d) best = { t, d };
      } else if (inside && d > 60) {
        inside = false;
        events.push({ t: best.t, key: wp.key });
      }
    }
    if (inside) events.push({ t: best.t, key: wp.key });
  }
  events.sort((a, b) => a.t - b.t);
  const seq: string[] = [];
  for (const e of events) {
    const before = cog(e.t - 30_000, e.t - 5_000);
    const after = cog(e.t + 5_000, e.t + 30_000);
    if (before == null || after == null) continue;
    if (Math.abs(wrap180(after - before)) < 120) continue;
    if (seq[seq.length - 1] !== e.key) seq.push(e.key);
  }
  return seq;
}
