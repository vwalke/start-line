/**
 * Legs from the fleet's own tracks. Mark trackers are often missing, silent
 * or listed as a set rather than in rounding order, so the turns are also
 * found geometrically: along the course's principal axis each boat's
 * position zigzags between the top and the bottom of the course, and the
 * pattern of turns most of the fleet shares gives the legs. Turns are then
 * snapped to a mark tracker where one sits at the turn.
 */
import { circMedian, dot, interp, len, median, sub, vecBearing, type Vec } from './geo';
import { distTo, targetsOf, type Waypoint } from './legs';
import type { XYTrack } from './prepare';

/** Top (furthest along the axis, toward where leg 1 goes) or bottom of the course. */
export type TurnType = 'T' | 'B';

export interface Extreme {
  type: TurnType;
  /** Sample index of the extreme. */
  i: number;
}

/**
 * Alternating extremes of `s` with hysteresis `h`: a top is recorded once s
 * falls `h` below it, a bottom once it rises `h` above it. Before the end, a
 * pending extreme also counts if s has retraced `finalH` from it (a short
 * beat to a finish just above the leeward gate is still a leg).
 */
export function zigzag(s: ArrayLike<number>, h: number, finalH = h): Extreme[] {
  const out: Extreme[] = [];
  const n = s.length;
  if (n < 2) return out;
  let mode = 0;
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < n; i++) {
    const v = s[i];
    if (mode === 0) {
      if (v > s[hi]) hi = i;
      if (v < s[lo]) lo = i;
      if (v - s[lo] >= h) {
        // Only a genuine dip (h below the start) is a bottom.
        if (s[0] - s[lo] >= h) out.push({ type: 'B', i: lo });
        mode = 1;
        hi = i;
      } else if (s[hi] - v >= h) {
        if (s[hi] - s[0] >= h) out.push({ type: 'T', i: hi });
        mode = -1;
        lo = i;
      }
    } else if (mode === 1) {
      if (v > s[hi]) hi = i;
      if (s[hi] - v >= h) {
        out.push({ type: 'T', i: hi });
        mode = -1;
        lo = i;
      }
    } else {
      if (v < s[lo]) lo = i;
      if (v - s[lo] >= h) {
        out.push({ type: 'B', i: lo });
        mode = 1;
        hi = i;
      }
    }
  }
  if (mode === 1 && hi < n - 1 && s[hi] - s[n - 1] >= finalH) out.push({ type: 'T', i: hi });
  if (mode === -1 && lo < n - 1 && s[n - 1] - s[lo] >= finalH) out.push({ type: 'B', i: lo });
  return out;
}

/** Centred moving average over 2·half + 1 samples (truncated at the ends). */
export function smooth(xs: ArrayLike<number>, half: number): number[] {
  const n = xs.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + xs[i];
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = (cum[b] - cum[a]) / (b - a);
  }
  return out;
}

/** Hysteresis for one boat: ~30% of its range along the axis, at least 100 m; a final turn needs 10%, at least 60 m. */
export const turnThresholds = (range: number): { h: number; finalH: number } => ({
  h: Math.max(100, 0.3 * range),
  finalH: Math.max(60, 0.1 * range),
});

const STEP_MS = 1000;
/** ±10 s at 1 Hz: about 20 s of smoothing. */
const SMOOTH_HALF = 10;
/** A leg back down the axis where the fleet swings this far (× the leg's length) to one side rounds a mark the zigzag can't see (a reach). */
const BENT_SWING = 0.4;

export interface FleetBoat {
  id: string;
  tr: XYTrack;
  finishMs: number | null;
}

interface BoatPath {
  id: string;
  finishMs: number | null;
  t: number[];
  x: number[];
  y: number[];
  /** Smoothed position along the axis. */
  s: number[];
  turns: { type: TurnType; t: number; xy: Vec }[];
  pattern: string;
  range: number;
}

export interface FleetTurns {
  /** Unit vector of the course axis, pointing the way leg 1 goes. */
  axis: Vec;
  /** Consensus turn sequence, e.g. "TBT" for two laps finishing downwind. */
  pattern: string;
  /** Finishers per turn pattern. */
  patterns: Map<string, number>;
  /** Finishers sharing the consensus. */
  agreeing: number;
  finishers: number;
  confident: boolean;
  /** Why the geometry wasn't used, when it isn't confident. */
  reason: string | null;
  /** Legs back down the axis that bend at a mark the turns can't place (BENT_SWING), by leg index. */
  bent: number[];
  /** Consensus turn k: type, median position and median time over the agreeing boats. */
  turns: { type: TurnType; xy: Vec; tMs: number }[];
  /** Per boat [gun, t1, …, tN, finish], null once a turn is missed (as splitLegs). */
  times: Map<string, (number | null)[]>;
}

function resample(tr: XYTrack, a: number, b: number): { t: number[]; x: number[]; y: number[] } {
  const t: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  if (tr.t.length < 2) return { t, x, y };
  const t0 = Math.max(a, tr.t[0]);
  const t1 = Math.min(b, tr.t[tr.t.length - 1]);
  for (let k = t0; k <= t1; k += STEP_MS) {
    t.push(k);
    x.push(interp(tr.t, tr.x, k));
    y.push(interp(tr.t, tr.y, k));
  }
  return { t, x, y };
}

/** Principal axis of the boats' positions, each boat weighted equally. */
function principalAxis(paths: { x: number[]; y: number[] }[]): Vec {
  let w = 0;
  let mx = 0;
  let my = 0;
  for (const p of paths) {
    const k = 1 / p.x.length;
    for (let i = 0; i < p.x.length; i++) {
      mx += k * p.x[i];
      my += k * p.y[i];
    }
    w += 1;
  }
  mx /= w;
  my /= w;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of paths) {
    const k = 1 / p.x.length;
    for (let i = 0; i < p.x.length; i++) {
      const dx = p.x[i] - mx;
      const dy = p.y[i] - my;
      sxx += k * dx * dx;
      syy += k * dy * dy;
      sxy += k * dx * dy;
    }
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return [Math.cos(ang), Math.sin(ang)];
}

/** Index of the raw extreme of `s` within ±15 samples of `i`. */
function refine(s: number[], i: number, type: TurnType): number {
  let best = i;
  for (let k = Math.max(0, i - 15); k <= Math.min(s.length - 1, i + 15); k++) {
    if (type === 'T' ? s[k] > s[best] : s[k] < s[best]) best = k;
  }
  return best;
}

/** A hole in the track longer than this can hide a rounding. */
const HOLE_MS = 20_000;

/**
 * A turn at the edge of a telemetry hole is only the last fix before (or first
 * after) it. Extend the boat's speed along the axis from both sides of the
 * hole and turn where they meet (same VMG on in and out), when they do.
 */
function turnInHole(tr: XYTrack, axis: Vec, t: number, type: TurnType): { t: number; xy: Vec } | null {
  const n = tr.t.length;
  let j = 0;
  while (j < n - 1 && tr.t[j] < t) j++;
  let a: number;
  if (j + 1 < n && tr.t[j + 1] - tr.t[j] > HOLE_MS) a = j;
  else if (j > 0 && tr.t[j] - tr.t[j - 1] > HOLE_MS) a = j - 1;
  else return null;
  const ta = tr.t[a];
  const tb = tr.t[a + 1];
  const at = (k: number): Vec => [interp(tr.t, tr.x, k), interp(tr.t, tr.y, k)];
  const pa = at(ta);
  const pb = at(tb);
  const va: Vec = sub(pa, at(ta - 30_000)).map((d) => d / 30) as Vec;
  const vb: Vec = sub(at(tb + 30_000), pb).map((d) => d / 30) as Vec;
  const ua = dot(va, axis);
  const ub = dot(vb, axis);
  const sign = type === 'T' ? 1 : -1;
  if (sign * ua <= 0.2 || sign * ub >= -0.2) return null;
  // s_a + ua·(t − ta) = s_b + ub·(t − tb), in seconds from ta.
  const gap = (tb - ta) / 1000;
  const x = (dot(pb, axis) - dot(pa, axis) - ub * gap) / (ua - ub);
  const dt = Math.max(0, Math.min(gap, x));
  return { t: ta + dt * 1000, xy: [pa[0] + va[0] * dt, pa[1] + va[1] * dt] };
}

/** First time after t0 the path comes within `near` of p, then its closest approach over the next 3 min. */
function approach(p: BoatPath, xy: Vec, t0: number, near: number): number | null {
  let tIn = NaN;
  let best: { t: number; d: number } | null = null;
  for (let i = 0; i < p.t.length; i++) {
    if (p.t[i] <= t0) continue;
    const d = Math.hypot(p.x[i] - xy[0], p.y[i] - xy[1]);
    if (Number.isNaN(tIn)) {
      if (d > near) continue;
      tIn = p.t[i];
    }
    if (p.t[i] > tIn + 180_000) break;
    if (!best || d < best.d) best = { t: p.t[i], d };
  }
  return best?.t ?? null;
}

/** The furthest the path strays from the straight line a → b, signed (+ = left), as a fraction of that line's length. */
function lateralSwing(p: BoatPath, a: number, b: number): number | null {
  const pa: Vec = [interp(p.t, p.x, a), interp(p.t, p.y, a)];
  const chord = sub([interp(p.t, p.x, b), interp(p.t, p.y, b)], pa);
  const L = len(chord);
  if (L < 50) return null;
  let best = 0;
  for (let i = 0; i < p.t.length; i++) {
    if (p.t[i] < a || p.t[i] > b) continue;
    const d = (chord[0] * (p.y[i] - pa[1]) - chord[1] * (p.x[i] - pa[0])) / L;
    if (Math.abs(d) > Math.abs(best)) best = d;
  }
  return best / L;
}

/**
 * Turns along the course axis for every boat, and the fleet's consensus legs.
 * The axis is the boats' principal axis unless `axisHint` (e.g. the wind) is given.
 */
export function fleetTurns(boats: FleetBoat[], gunMs: number, axisHint?: Vec): FleetTurns {
  const paths = boats
    .map((b) => {
      const end = b.finishMs ?? (b.tr.t.length ? b.tr.t[b.tr.t.length - 1] : gunMs);
      return { b, ...resample(b.tr, gunMs, end) };
    })
    .filter((p) => p.t.length >= 60);
  const empty = (reason: string): FleetTurns => ({
    axis: [0, 1],
    pattern: '',
    patterns: new Map(),
    agreeing: 0,
    finishers: 0,
    confident: false,
    reason,
    bent: [],
    turns: [],
    times: new Map(),
  });
  if (!paths.length) return empty('no tracks after the gun');

  let axis = axisHint ?? principalAxis(paths);
  // Point the axis the way the fleet sails off the line (~2.5 min after the gun).
  const early = paths.map((p) => dot([interp(p.t, p.x, gunMs + 150_000) - p.x[0], interp(p.t, p.y, gunMs + 150_000) - p.y[0]], axis));
  if (median(early) < 0) axis = [-axis[0], -axis[1]];

  const bps: BoatPath[] = paths.map((p) => {
    const raw = p.x.map((x, i) => x * axis[0] + p.y[i] * axis[1]);
    const s = smooth(raw, SMOOTH_HALF);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of s) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const range = hi - lo;
    const { h, finalH } = turnThresholds(range);
    const turns = zigzag(s, h, finalH).map((e) => {
      const i = refine(raw, e.i, e.type);
      const hole = turnInHole(p.b.tr, axis, p.t[i], e.type);
      return { type: e.type, t: hole?.t ?? p.t[i], xy: hole?.xy ?? ([p.x[i], p.y[i]] as Vec) };
    });
    return { id: p.b.id, finishMs: p.b.finishMs, t: p.t, x: p.x, y: p.y, s, turns, pattern: turns.map((e) => e.type).join(''), range };
  });

  const fin = bps.filter((p) => p.finishMs != null && p.finishMs > gunMs + 120_000);
  if (!fin.length) return { ...empty('no finishers'), axis };
  const counts = new Map<string, number>();
  for (const p of fin) counts.set(p.pattern, (counts.get(p.pattern) ?? 0) + 1);
  const [pattern, agreeing] = [...counts].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
  const match = fin.filter((p) => p.pattern === pattern);
  const turns = [...pattern].map((type, k) => ({
    type: type as TurnType,
    xy: [median(match.map((p) => p.turns[k].xy[0])), median(match.map((p) => p.turns[k].xy[1]))] as Vec,
    tMs: median(match.map((p) => p.turns[k].t)),
  }));

  let reason: string | null = null;
  const bent: number[] = [];
  if (!pattern) reason = 'the fleet sailed no turns along the course axis';
  else if (agreeing < Math.min(3, fin.length) || agreeing < 0.5 * fin.length) reason = 'the fleet’s tracks don’t agree on the turns';
  else {
    // A reach (e.g. to a wing mark) is no extreme along the axis: it hides inside
    // a leg back down the axis as a swing out to the same side by every boat.
    // Beats and runs spread to both sides, and a one-sided gybe stays under ~0.35.
    for (let k = 0; k <= pattern.length; k++) {
      if (k % 2 === 0) continue;
      const offs = match
        .map((p) => {
          const a = k ? p.turns[k - 1].t : gunMs;
          const e = k < pattern.length ? p.turns[k].t : p.finishMs!;
          return lateralSwing(p, a, e);
        })
        .filter((d): d is number => d != null);
      if (offs.length < 3) continue;
      const m = median(offs);
      const sameSide = offs.filter((d) => Math.sign(d) === Math.sign(m)).length / offs.length;
      if (Math.abs(m) >= BENT_SWING && sameSide >= 0.75) {
        bent.push(k);
        reason ??= `leg ${k + 1} bends at a mark the tracks can’t place`;
      }
    }
  }

  // Each boat takes the consensus turns in order: its own turns when it shares
  // the pattern; else its first extreme of the right type near each turn (an
  // OCS return or penalty wiggle elsewhere is skipped), else its closest
  // approach to the turn; nulls once it missed one. "Near" widens with the
  // agreeing boats' own spread (a mark re-laid mid-leg).
  const base = Math.max(150, 0.2 * median(fin.map((p) => p.range)));
  const near = turns.map((turn, k) => {
    const ds = match.map((p) => len(sub(p.turns[k].xy, turn.xy))).sort((a, b) => a - b);
    return Math.max(base, 1.5 * ds[Math.floor(0.8 * (ds.length - 1))]);
  });
  const times = new Map<string, (number | null)[]>();
  for (const p of bps) {
    const tt: (number | null)[] = [gunMs];
    let prev = gunMs;
    let ok = true;
    for (const [k, turn] of turns.entries()) {
      let t: number | null = null;
      if (ok && p.pattern === pattern) t = p.turns[k].t;
      else if (ok) {
        const hit = p.turns.find((e) => e.type === turn.type && e.t > prev && len(sub(e.xy, turn.xy)) <= near[k]);
        t = hit ? hit.t : approach(p, turn.xy, prev, near[k]);
        if (t != null && p.finishMs != null && t >= p.finishMs) t = null;
      }
      if (t == null) ok = false;
      else prev = t;
      tt.push(t);
    }
    tt.push(ok && p.finishMs != null && p.finishMs > prev ? p.finishMs : null);
    times.set(p.id, tt);
  }
  for (const b of boats) if (!times.has(b.id)) times.set(b.id, [gunMs, ...turns.map(() => null), null]);

  return { axis, pattern, patterns: counts, agreeing, finishers: fin.length, confident: !reason, reason, bent, turns, times };
}

/** Do the mark-based legs match the geometry: same count, and every boundary within `tolMs` for ≥ 60% of finishers? */
export function legsAgree(
  marks: Map<string, (number | null)[]>,
  fleet: Map<string, (number | null)[]>,
  finisherIds: string[],
  tolMs = 120_000,
): boolean {
  if (!finisherIds.length) return false;
  const n = marks.get(finisherIds[0])?.length;
  if (n == null || n !== fleet.get(finisherIds[0])?.length) return false;
  const ok = finisherIds.filter((id) => {
    const m = marks.get(id)!;
    const f = fleet.get(id)!;
    for (let k = 1; k < n - 1; k++) if (m[k] == null || f[k] == null || Math.abs(m[k]! - f[k]!) > tolMs) return false;
    return true;
  }).length;
  return ok >= 0.6 * finisherIds.length;
}

/** Marks named as offsets fold into the following run rather than end a leg of their own. */
export const isOffset = (wp: Waypoint): boolean => /offset/i.test(wp.name);

/**
 * Snap each consensus turn to a mark tracker within `radius` of it (where the
 * mark was at the time). Each boat's turn becomes its closest approach to that
 * mark within ±2 min of its own turn, if it came within 90 m. Mutates `fleet.times`.
 */
export function snapTurns(
  fleet: FleetTurns,
  tracks: Map<string, XYTrack>,
  marks: Waypoint[],
  radius = 100,
): (Waypoint | null)[] {
  const snapped = fleet.turns.map((turn) => {
    let best: { wp: Waypoint; d: number } | null = null;
    for (const wp of marks) {
      if (isOffset(wp)) continue;
      const ps = wp.at ? wp.at(turn.tMs) : wp.xy;
      const c: Vec = [ps.reduce((a, p) => a + p[0], 0) / ps.length, ps.reduce((a, p) => a + p[1], 0) / ps.length];
      const d = Math.min(len(sub(c, turn.xy)), ...ps.map((p) => len(sub(p, turn.xy))));
      if (d <= radius && (!best || d < best.d)) best = { wp, d };
    }
    return best?.wp ?? null;
  });
  for (const [id, tt] of fleet.times) {
    const tr = tracks.get(id);
    if (!tr) continue;
    snapped.forEach((wp, k) => {
      const t = tt[k + 1];
      if (!wp || t == null) return;
      const lo = Math.max(t - 120_000, tt[k]!);
      const next = tt.slice(k + 2).find((x) => x != null);
      const hi = Math.min(t + 120_000, next ?? Infinity);
      const tg = targetsOf(wp);
      let best: { t: number; d: number } | null = null;
      for (let i = 0; i < tr.t.length; i++) {
        if (tr.t[i] <= lo || tr.t[i] >= hi) continue;
        const d = distTo(tr, i, tg);
        if (!best || d < best.d) best = { t: tr.t[i], d };
      }
      if (best && best.d <= 90) tt[k + 1] = best.t;
    });
  }
  return snapped;
}

/** A listed mark inside a bent leg is rounded by a boat that comes this close to it (m)… */
export const BENT_MARK_NEAR_M = 90;
/** …and is the course's when this share of the finishers with that leg do… */
export const BENT_MARK_SHARE = 0.75;
/** …and it sits this far (× the leg's length) off the straight line between the leg's ends: it explains the bend. */
export const BENT_MARK_OFF = 0.3;

/** The fleet's turns with the listed marks hidden inside its bent legs put back in (insertBentMarks). */
export interface MergedTurns {
  /** Per rounding, in order: where (and when, median) the fleet rounded it; `type` places it on the axis. */
  turns: FleetTurns['turns'];
  /** Per rounding, the listed mark; null for a turn no listed mark explains (placed from the tracks, est.). */
  marks: (Waypoint | null)[];
  /** Per boat [gun, r1, …, rN, finish] (a rounding a boat missed is null). */
  times: Map<string, (number | null)[]>;
  /** Per rounding, whether it is a listed mark put back inside a bent leg. */
  inserted: boolean[];
}

/**
 * A triangle course (or any course with a reach to a wing mark): the fleet's turns along the axis find the
 * windward and leeward roundings, every lap, but a leg back down the axis that bends (`fleet.bent`) hides a
 * listed mark the zigzag can't see. Snap the turns to the listed marks (snapTurns), then put back, inside
 * each bent leg, every listed single buoy (no gate or offset) BENT_MARK_SHARE of the finishers came within
 * BENT_MARK_NEAR_M of (timed at each boat's closest approach) that sits BENT_MARK_OFF off the leg's straight
 * line, between its ends, in the order they were reached. A turn no listed mark explains (an untracked
 * leeward mark) stays where the fleet turned. Null when a bent leg has no such mark (the bend stays
 * unexplained) or a listed mark goes unrounded; analyze.ts also drops the merge when its legs don't make a
 * course (a mark twice running, a Beat after a Beat, a mark put back with no reach beside it).
 */
export function insertBentMarks(fleet: FleetTurns, tracks: Map<string, XYTrack>, marks: Waypoint[], finisherIds: string[]): MergedTurns | null {
  if (!fleet.bent.length || !finisherIds.length) return null;
  const copy: FleetTurns = { ...fleet, times: new Map([...fleet.times].map(([id, tt]) => [id, [...tt]])) };
  const snapped = snapTurns(copy, tracks, marks);
  const nT = fleet.turns.length;
  const closest = (tr: XYTrack, wp: Waypoint, a: number, e: number): { t: number; d: number } | null => {
    const tg = targetsOf(wp);
    let best: { t: number; d: number } | null = null;
    for (let i = 0; i < tr.t.length; i++) {
      if (tr.t[i] <= a || tr.t[i] >= e) continue;
      const d = distTo(tr, i, tg);
      if (!best || d < best.d) best = { t: tr.t[i], d };
    }
    return best;
  };
  const centre = (wp: Waypoint, t: number): Vec => {
    const ps = wp.at ? wp.at(t) : wp.xy;
    return [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
  };
  /** The finishers' median position at their own boundary `j` (the gun, a turn, the finish), or null. */
  const endAt = (j: number): Vec | null => {
    const ps: Vec[] = [];
    for (const id of finisherIds) {
      const tr = tracks.get(id);
      const t = copy.times.get(id)?.[j];
      if (tr && t != null && tr.t.length > 1) ps.push([interp(tr.t, tr.x, t), interp(tr.t, tr.y, t)]);
    }
    return ps.length ? [median(ps.map((p) => p[0])), median(ps.map((p) => p[1]))] : null;
  };
  /** Per bent leg k (turn k − 1, or the gun, to turn k, or the finish): the marks inserted, in order, each boat's time at it. */
  const inserts = new Map<number, { wp: Waypoint; tMs: number; at: Map<string, number | null> }[]>();
  for (const k of fleet.bent) {
    const ends = new Set([snapped[k - 1]?.key, snapped[k]?.key]);
    const [p0, p1] = [endAt(k), endAt(k + 1)];
    if (!p0 || !p1) return null;
    const chord = sub(p1, p0);
    const L = len(chord);
    if (L < 50) return null;
    const found: { wp: Waypoint; tMs: number; at: Map<string, number | null> }[] = [];
    for (const wp of marks) {
      // A wing mark: one buoy (a gate or an offset is no reach mark), not the leg's own ends.
      if (wp.xy.length !== 1 || isOffset(wp) || ends.has(wp.key) || found.some((f) => f.wp.key === wp.key)) continue;
      const at = new Map<string, number | null>();
      const hits: number[] = [];
      let sailed = 0;
      for (const [id, tt] of copy.times) {
        const tr = tracks.get(id);
        const a = tt[k];
        const e = tt[k + 1];
        if (!tr || a == null || e == null) continue;
        const c = closest(tr, wp, a, e);
        const ok = c != null && c.d <= BENT_MARK_NEAR_M;
        at.set(id, ok ? c.t : null);
        if (!finisherIds.includes(id)) continue;
        sailed++;
        if (ok) hits.push(c.t);
      }
      if (!sailed || hits.length < BENT_MARK_SHARE * sailed) continue;
      const tMs = median(hits);
      // It explains the bend: well off the straight line between the leg's ends, and between them along it.
      const m = sub(centre(wp, tMs), p0);
      const across = Math.abs(chord[0] * m[1] - chord[1] * m[0]) / L / L;
      const along = dot(m, chord) / L / L;
      if (across >= BENT_MARK_OFF && along > 0.1 && along < 0.9) found.push({ wp, tMs, at });
    }
    if (!found.length) return null;
    inserts.set(k, found.sort((x, y) => x.tMs - y.tMs));
  }
  // Where a listed mark sits along the axis, between the course's top and bottom turns.
  const along = (xy: Vec): number => dot(xy, fleet.axis);
  const tops = fleet.turns.filter((t) => t.type === 'T').map((t) => along(t.xy));
  const bottoms = fleet.turns.filter((t) => t.type === 'B').map((t) => along(t.xy));
  const mid = tops.length && bottoms.length ? (median(tops) + median(bottoms)) / 2 : 0;
  const turns: FleetTurns['turns'] = [];
  const out: (Waypoint | null)[] = [];
  const inserted: boolean[] = [];
  const times = new Map<string, (number | null)[]>();
  for (const id of copy.times.keys()) times.set(id, [copy.times.get(id)![0]]);
  const push = (turn: FleetTurns['turns'][number], wp: Waypoint | null, timeOf: (id: string) => number | null, put = false): void => {
    turns.push(turn);
    out.push(wp);
    inserted.push(put);
    for (const [id, tt] of times) tt.push(timeOf(id));
  };
  for (let k = 0; k <= nT; k++) {
    for (const f of inserts.get(k) ?? []) {
      const xy = centre(f.wp, f.tMs);
      push({ type: along(xy) >= mid ? 'T' : 'B', xy, tMs: f.tMs }, f.wp, (id) => f.at.get(id) ?? null, true);
    }
    if (k < nT) push(fleet.turns[k], snapped[k], (id) => copy.times.get(id)![k + 1]);
  }
  // Strong evidence only: the course the merge reads rounds every listed mark (an estimated turn where a listed mark
  // goes unused is a layline tack or a misread lap).
  const used = new Set(out.map((w) => w?.key));
  if (marks.some((w) => !isOffset(w) && !used.has(w.key))) return null;
  for (const [id, tt] of times) {
    // Each boat's finish, once its roundings are in order.
    const fin = copy.times.get(id)![nT + 1];
    let prev = -Infinity;
    for (let i = 1; i < tt.length; i++) {
      if (tt[i] != null && tt[i]! <= prev) tt[i] = null;
      if (tt[i] != null) prev = tt[i]!;
    }
    tt.push(fin != null && fin > prev ? fin : null);
  }
  return { turns, marks: out, times, inserted };
}

/** Leg mean course: circular median over boats of their displacement bearing, leg start → end. */
export function legCourse(tracks: Map<string, XYTrack>, times: Map<string, (number | null)[]>, li: number): number | null {
  const bs: number[] = [];
  for (const [id, tt] of times) {
    const a = tt[li];
    const e = tt[li + 1];
    const tr = tracks.get(id);
    if (a == null || e == null || !tr || tr.t.length < 2) continue;
    const d: Vec = [interp(tr.t, tr.x, e) - interp(tr.t, tr.x, a), interp(tr.t, tr.y, e) - interp(tr.t, tr.y, a)];
    if (len(d) >= 20) bs.push(vecBearing(d));
  }
  return bs.length ? circMedian(bs) : null;
}
