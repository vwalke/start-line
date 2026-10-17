/**
 * Leg splitting. A boat "reaches" a waypoint at its closest approach within
 * a 90 s window that opens the first time it comes within 45 m (the nearer
 * mark counts for a gate), searched only after it reached the previous one.
 */
import type { Vec } from './geo';
import { wrap180, vecBearing } from './geo';
import type { XYTrack } from './prepare';

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
