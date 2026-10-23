/**
 * The wind ladder (methods.md, lib.py ladder_mode / charts.py): how far a boat
 * still has to sail, measured along the wind at that moment, so two boats on
 * the same leg compare at the same instant however far apart they are.
 *
 * - Rung: distance to the leg's mark (on the last leg, the nearest point of the
 *   finish line) along the wind TWD(t); a boat outside the
 *   layline pays `hypot(u, c)·cos(a)` instead (a = half the tack angle,
 *   clamped to 35–65°, on a beat; 30° on a run).
 * - Distance to go D(t): the rung scaled so the leg's full rung is its rhumb
 *   length, plus the rhumb lengths of the legs still to come.
 * - Gap: (rung_b − rung_r) ÷ the fleet's median VMG on that leg, in seconds,
 *   + = behind. Same leg only, and only where both boats have a real fix
 *   (tracks.ts posAt); anything else is null, so a chart breaks there.
 *   (Same leg: the remaining legs cancel; the rung's scale is left out so the
 *   seconds use the VMG as Recall measures it, along the wind.) The chart and the
 *   cards no longer read this gap: they read time at equal course progress
 *   (timeGap.ts groupGap), measured up this ladder along one wind per leg.
 */
import { MS_TO_KN, bearingVec, dot, len, median, sub, type Vec } from '../geo';
import type { LegKind } from '../types';
import { posAt, trackLegAt, type CoachTrack, type LegSpan } from './tracks';

/** Half tack angle used for the upwind layline, clamped (lib.py), °. */
export const LAYLINE_MIN_DEG = 35;
export const LAYLINE_MAX_DEG = 65;
/** Downwind layline: this far off dead downwind, °. */
export const RUN_LAYLINE_DEG = 30;

/** The ladder's half-angle: half the tack angle (clamped) upwind, RUN_LAYLINE_DEG otherwise, °. */
export const laylineDeg = (kind: LegKind, tackAngleDeg: number): number =>
  kind === 'upwind' ? Math.min(LAYLINE_MAX_DEG, Math.max(LAYLINE_MIN_DEG, tackAngleDeg / 2)) : RUN_LAYLINE_DEG;

/**
 * Rung distance from `p` to `mark`, m: the distance along the wind (toward it
 * upwind, away from it otherwise), or past the layline `hypot(u, c)·cos(a)`.
 */
export function rung(p: Vec, mark: Vec, twdDeg: number, kind: LegKind, tackAngleDeg: number): number {
  const w = bearingVec(twdDeg);
  const v = sub(mark, p);
  const u = dot(v, w); // + when the mark is upwind
  const c = Math.abs(v[0] * w[1] - v[1] * w[0]);
  const a = (laylineDeg(kind, tackAngleDeg) * Math.PI) / 180;
  const uu = Math.max(kind === 'upwind' ? u : -u, 0);
  return c <= uu * Math.tan(a) ? uu : Math.hypot(uu, c) * Math.cos(a);
}

export interface Course {
  /** Leg ends: start line middle, turns, finish (RaceAnalysis.legPts). */
  pts: Vec[];
  kinds: LegKind[];
  /** The finish line's ends: the last leg ends anywhere on it, not only at its middle. */
  finish?: { left: Vec; right: Vec } | null;
}

/** Where leg `leg` ends for a boat at `p`: its mark, or on the last leg the nearest point of the finish line. */
export function legEnd(c: Course, leg: number, p: Vec): Vec {
  const f = c.finish;
  if (!f || leg !== c.kinds.length - 1) return c.pts[leg + 1];
  const d = sub(f.right, f.left);
  const L2 = dot(d, d);
  const s = L2 > 0 ? Math.min(1, Math.max(0, dot(sub(p, f.left), d) / L2)) : 0;
  return [f.left[0] + s * d[0], f.left[1] + s * d[1]];
}

/** Rhumb length of each leg, m. */
export const legLengths = (c: Course): number[] => c.kinds.map((_, k) => len(sub(c.pts[k + 1], c.pts[k])));

/** Distance to go on leg `leg` from `p`: the scaled rung plus the legs after it, m. */
export function distToGo(c: Course, leg: number, p: Vec, twdDeg: number, tackAngleDeg: number): number {
  const lens = legLengths(c);
  const L = lens[leg];
  const along = Math.abs(dot(sub(c.pts[leg + 1], c.pts[leg]), bearingVec(twdDeg)));
  const r = rung(p, legEnd(c, leg, p), twdDeg, c.kinds[leg], tackAngleDeg);
  return (r * L) / Math.max(along, 0.3 * L) + lens.slice(leg + 1).reduce((s, x) => s + x, 0);
}

/** The fleet's VMG per leg: the median of the boats' leg VMG (LegResult.vmgKn), m/s; null where nobody completed the leg. */
export function fleetVmg(boats: { legs: ({ vmgKn: number } | null)[] }[], nLegs: number): (number | null)[] {
  return Array.from({ length: nLegs }, (_, k) => {
    const v = boats.map((b) => b.legs[k]?.vmgKn).filter((x): x is number => x != null && x > 0);
    return v.length ? median(v) / MS_TO_KN : null;
  });
}

export interface Wind {
  twdAt: (t: number) => number;
  taAt: (t: number) => number;
}

/** A boat's leg and rung at `t`, or null (no real fix there, or its leg unknown). */
export function ladderAt(c: Course, w: Wind, tr: CoachTrack, t: number): { leg: number; rung: number } | null {
  const leg = trackLegAt(tr, t);
  if (leg == null || leg >= c.kinds.length) return null;
  const p = posAt(tr, t);
  if (!p) return null;
  return { leg, rung: rung(p, legEnd(c, leg, p), w.twdAt(t), c.kinds[leg], w.taAt(t)) };
}

/** Seconds `b` is behind `r` at `t` (+ = behind, − = ahead); null unless both are on the same leg with real fixes. */
export function gapAt(c: Course, w: Wind, vmg: (number | null)[], b: CoachTrack, r: CoachTrack, t: number): number | null {
  const lb = ladderAt(c, w, b, t);
  if (!lb) return null;
  const lr = ladderAt(c, w, r, t);
  if (!lr || lr.leg !== lb.leg) return null;
  const v = vmg[lb.leg];
  return v ? (lb.rung - lr.rung) / v : null;
}

/**
 * The group's median needs at least this share of the group to compare (same leg, real fixes), else it is
 * null: a median over whoever happens to be tracked would jump as boats drop in and out.
 */
export const GROUP_MIN_SHARE = 0.5;

export interface GapPoint {
  tMs: number;
  /** Median over the group of the per-boat gaps, s (+ = behind); null where under GROUP_MIN_SHARE of the group compares. */
  behindS: number | null;
  /** How many group boats the median is over. */
  n: number;
  /** How many of those are read across a tracker hole (timeGap.ts: bridged, estimated); absent: none. */
  est?: number;
  /** Per group boat (in the group's order), s; null where it doesn't compare. */
  each: (number | null)[];
  /** The chosen boat's leg, or null. */
  leg: number | null;
}

/**
 * The chosen boat's same-moment gap to each group boat and to the group (median, GROUP_MIN_SHARE of it), every `stepMs`
 * from `fromMs` to `toMs`. The app no longer reads it (the chart and the cards read timeGap.ts groupGap, time at equal
 * course progress): the tests keep it as the reference the debrief was written from.
 */
export function gapSeries(
  c: Course,
  w: Wind,
  vmg: (number | null)[],
  b: CoachTrack,
  group: CoachTrack[],
  fromMs: number,
  toMs: number,
  stepMs = 10_000,
): GapPoint[] {
  const out: GapPoint[] = [];
  const need = Math.max(1, Math.ceil(GROUP_MIN_SHARE * group.length));
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const lb = ladderAt(c, w, b, t);
    const v = lb ? vmg[lb.leg] : null;
    const each = group.map((r) => {
      if (!lb || !v) return null;
      const lr = ladderAt(c, w, r, t);
      return lr && lr.leg === lb.leg ? (lb.rung - lr.rung) / v : null;
    });
    const ok = each.filter((x): x is number => x != null);
    out.push({ tMs: t, behindS: ok.length >= need ? median(ok) : null, n: ok.length, each, leg: lb?.leg ?? null });
  }
  return out;
}

/** Inferred spans stop at a hole longer than this, s. */
export const INFER_MAX_HOLE_S = 300;
/** Closing on the mark is judged over this far ahead, s… */
export const INFER_LOOK_S = 30;
/** …and a rung may grow this much (noise, a tack) before the boat counts as past the mark, m. */
export const INFER_SLACK_M = 10;

/**
 * Legs across lost roundings (lib.py's hand fix for Good Trade's race 2, made general): from a known
 * rounding forward, the boat is still on that leg while it keeps closing on the leg's mark (its rung
 * not growing over INFER_LOOK_S); likewise back from the next known rounding on the leg that ends
 * there. A hole over INFER_MAX_HOLE_S ends the stretch. What lies between stays unknown.
 */
export function inferLegSpans(c: Course, w: Wind, tr: CoachTrack): LegSpan[] {
  const b = tr.bounds;
  const n = c.kinds.length;
  const t = tr.t;
  const out: LegSpan[] = [];
  const rungOf = (leg: number, i: number): number => {
    const p: Vec = [tr.x[i], tr.y[i]];
    return rung(p, legEnd(c, leg, p), w.twdAt(t[i]), c.kinds[leg], w.taAt(t[i]));
  };
  /** First fix at or after `ms` (t.length when none). */
  const firstAt = (ms: number): number => {
    let lo = 0;
    let hi = t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] < ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /** Still closing on leg's mark at fix i (judged against the fix INFER_LOOK_S on, before `endMs`)? */
  const closing = (leg: number, i: number, endMs: number): boolean => {
    const j = firstAt(t[i] + INFER_LOOK_S * 1000);
    if (j >= t.length || t[j] > endMs || t[j] - t[i] > INFER_MAX_HOLE_S * 1000) return true;
    return rungOf(leg, j) <= rungOf(leg, i) + INFER_SLACK_M;
  };
  for (let k = 0; k < n; k++) {
    if (b[k] == null) continue;
    let j = k + 1;
    while (j <= n && b[j] == null) j++;
    if (j === k + 1 || j > n) continue;
    const from = b[k]!;
    const to = b[j]!;
    // Forward on leg k.
    let fwd: number | null = null;
    for (let i = firstAt(from); i < t.length && t[i] < to; i++) {
      if (t[i] - (i > 0 && t[i - 1] >= from ? t[i - 1] : from) > INFER_MAX_HOLE_S * 1000) break;
      if (!closing(k, i, to)) break;
      fwd = t[i];
    }
    // Back from the next known rounding on leg j - 1.
    let bwd: number | null = null;
    for (let i = firstAt(to) - 1; i >= 0 && t[i] > from; i--) {
      const next = i + 1 < t.length && t[i + 1] <= to ? t[i + 1] : to;
      if (next - t[i] > INFER_MAX_HOLE_S * 1000) break;
      if (!closing(j - 1, i, to)) break;
      bwd = t[i];
    }
    // Overlapping stretches (one leg between, data all through) can't both hold: keep neither.
    if (fwd != null && bwd != null && j === k + 2 && fwd >= bwd) continue;
    if (fwd != null && fwd > from) out.push({ fromMs: from, toMs: fwd, leg: k });
    if (bwd != null && bwd < to) out.push({ fromMs: bwd, toMs: to, leg: j - 1 });
  }
  return out;
}
