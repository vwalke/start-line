/**
 * D12 · Penalty turns (a 360 or a 720): a genuine loop, found from the boat's raw fixes in the worker
 * (index.ts coachRaw; an uploaded log at its full rate). manoeuvres.ts ignores full turns by design; this is the
 * detector that looks for them.
 *
 * - Course over ground from the positions: the fixes thinned to TURN_STEP_MS and TURN_STEP_M apart (GPS jitter at
 *   low speed would otherwise turn a drifting boat in circles); a pair further apart than TURN_MAX_GAP_S, or a step
 *   that turns more than TURN_MAX_STEP_DEG (ambiguous), breaks the integration: never across a data hole.
 * - The heading changes are integrated (unwrapped) into runs of turning one way. A run ends when the boat turns back
 *   the other way (TURN_REVERSE_DEG in one step) or pauses its turning for TURN_PAUSE_S, and is split wherever it sails
 *   straight: any TURN_STRAIGHT_S of it changing course less than TURN_STRAIGHT_DEG (read over the stretch, so GPS
 *   jitter between fixes can't hide it). A tack and a gybe with straight sailing between them are two manoeuvres, not
 *   a loop. (The scan of the cached races, scratch/turns_scan.md, found a tack + ~10 s straight + a 360 read as one
 *   500° loop, and two manoeuvres 9 s apart read as one, under a per-step rule alone.)
 * - A turn: TURN_ONE_DEG or more within TURN_WINDOW_S (one turn, "360"), TURN_TWO_DEG within 2 × TURN_WINDOW_S
 *   ("720"), from TURN_MIN_SAMPLES heading samples per turn, at TURN_MIN_KN or more on average (a drifting boat's
 *   track wanders), never within TURN_MARK_M of a mark (the roundings' zone geometry, index.ts markPoints and
 *   ZONE_KEEP_M), and only between the boat's start (its line crossing, never before the gun) and its finish.
 * - Seconds lost: the boat's speed (its mean along the track over TURN_PRE_MS before the turn) and course (where it
 *   went over the last TURN_COURSE_MS before it) carried over the turn and TURN_RECOVER_MS after it, against how far it
 *   actually got along that course: (expected − made) ÷ speed. With no clean read before (a hole), the same after it,
 *   once recovered. Along its own course rather than toward the wind: a penalty is taken and the boat carries on as it
 *   was going, and the course needs no wind estimate. (A course read over the whole 30 s, as a displacement, takes an
 *   earlier tack or bear-away for slow sailing: J/111 R2 USA 026 read 0 s lost in the scan.)
 * - Confidence: medium on the public feed, high from an uploaded log at full rate.
 */
import { wrap180, type Vec } from '../../geo';

export const TURN_ONE_DEG = 300;
export const TURN_TWO_DEG = 660;
/** One turn within this long; a 720 within twice it, s. */
export const TURN_WINDOW_S = 60;
/** Fixes thinned to at least this far apart in time, ms… */
export const TURN_STEP_MS = 1_000;
/** …and in distance (below it the bearing is GPS noise), m. */
export const TURN_STEP_M = 2.5;
/** A heading step spanning more than this is a hole: the integration restarts, s. */
export const TURN_MAX_GAP_S = 6;
/** One heading step turning more than this is ambiguous (which way?): the integration restarts, °. */
export const TURN_MAX_STEP_DEG = 135;
/** A step turning back this much ends the run (a tack then a gybe the other way is no loop), °. */
export const TURN_REVERSE_DEG = 20;
/** A step turning slower than this is not turning, °/s… */
export const TURN_RATE_DEG_S = 3;
/** …and this long of it ends the run, s. */
export const TURN_PAUSE_S = 10;
/** Any stretch of a run this long… */
export const TURN_STRAIGHT_S = 8;
/** …changing course less than this is straight sailing: the run splits there, °. */
export const TURN_STRAIGHT_DEG = 20;
/** Heading samples per turn at least. */
export const TURN_MIN_SAMPLES = 6;
/** Mean speed through the turn at least, kn. */
export const TURN_MIN_KN = 1.5;
/** No fix of the turn this close to a mark, m (the zone tracks' radius: index.ts ZONE_KEEP_M). */
export const TURN_MARK_M = 130;
/** The boat's speed before the turn is read over this long, ending TURN_PRE_GAP_MS before it, ms… */
export const TURN_PRE_MS = 30_000;
/** …and its course over this long, ms. */
export const TURN_COURSE_MS = 10_000;
export const TURN_PRE_GAP_MS = 2_000;
/** The loss runs on this long after the turn (getting back up to speed), ms. */
export const TURN_RECOVER_MS = 15_000;

export interface PenaltyTurn {
  /** The loop, ms. */
  t0: number;
  t1: number;
  /** 1 (a 360) or 2 (a 720). */
  turns: 1 | 2;
  /** The heading change integrated over the loop, ° (+ = clockwise). */
  deg: number;
  /** Seconds lost (see the file comment); null when the boat's course around it can't be read. */
  lostS: number | null;
  /** Heading samples in the loop. */
  samples: number;
  conf: 'high' | 'medium';
}

export interface TurnTrack {
  t: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
}

export interface TurnOpts {
  /** Look from (the boat's start: its crossing, never before the gun) to (its finish), ms. */
  fromMs: number;
  toMs: number;
  /** Mark points in the track's frame. */
  marks: readonly Vec[];
  /** The track is an uploaded log at full rate: high confidence. */
  fullRate?: boolean;
}

interface Sample {
  /** Mid-time of the step, ms. */
  t: number;
  /** Step bearing, ° (0 = +y, clockwise). */
  hdg: number;
  /** Indices of the step's fixes. */
  i0: number;
  i1: number;
  /** A break (hole, ambiguous step) before this sample. */
  brk: boolean;
}

const bearing = (dx: number, dy: number): number => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;

/** Heading samples from the positions, thinned (TURN_STEP_MS, TURN_STEP_M); a step across a hole is a break. */
function samples(tr: TurnTrack, a: number, b: number): Sample[] {
  const out: Sample[] = [];
  const n = tr.t.length;
  let i = 0;
  while (i < n && tr.t[i] < a) i++;
  let brk = true;
  while (i < n - 1 && tr.t[i] <= b) {
    let j = i + 1;
    let hole = false;
    while (j < n) {
      if (tr.t[j] - tr.t[j - 1] > TURN_MAX_GAP_S * 1000) {
        hole = true;
        break;
      }
      if (tr.t[j] - tr.t[i] >= TURN_STEP_MS && Math.hypot(tr.x[j] - tr.x[i], tr.y[j] - tr.y[i]) >= TURN_STEP_M) break;
      j++;
    }
    if (j >= n) break;
    if (hole || tr.t[j] - tr.t[i] > TURN_MAX_GAP_S * 1000) {
      brk = true;
      i = j;
      continue;
    }
    out.push({ t: (tr.t[i] + tr.t[j]) / 2, hdg: bearing(tr.x[j] - tr.x[i], tr.y[j] - tr.y[i]), i0: i, i1: j, brk });
    brk = false;
    i = j;
  }
  return out;
}

/** Position at `t` between fixes no more than TURN_MAX_GAP_S apart; null otherwise. */
function posAt(tr: TurnTrack, t: number): Vec | null {
  const n = tr.t.length;
  if (!n || t < tr.t[0] || t > tr.t[n - 1]) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (tr.t[m] <= t) lo = m;
    else hi = m;
  }
  const dt = tr.t[hi] - tr.t[lo];
  if (dt > TURN_MAX_GAP_S * 1000) return null;
  const f = dt > 0 ? (t - tr.t[lo]) / dt : 0;
  return [tr.x[lo] + f * (tr.x[hi] - tr.x[lo]), tr.y[lo] + f * (tr.y[hi] - tr.y[lo])];
}

/** Mean speed along the track from `a` to `b`, m/s; null across a hole or when it barely moved. */
function pathSpeed(tr: TurnTrack, a: number, b: number): number | null {
  const p = posAt(tr, a);
  const q = posAt(tr, b);
  if (!p || !q || b <= a) return null;
  let d = 0;
  let prev = p;
  for (let i = 0; i < tr.t.length; i++) {
    if (tr.t[i] <= a) continue;
    if (tr.t[i] >= b) break;
    d += Math.hypot(tr.x[i] - prev[0], tr.y[i] - prev[1]);
    prev = [tr.x[i], tr.y[i]];
  }
  d += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
  const v = d / ((b - a) / 1000);
  return v >= 0.5 ? v : null;
}

/** The unit course from `a` to `b` (where the boat went); null across a hole or when it barely moved. */
function course(tr: TurnTrack, a: number, b: number): Vec | null {
  const p = posAt(tr, a);
  const q = posAt(tr, b);
  if (!p || !q) return null;
  const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
  return L >= 0.5 * ((b - a) / 1000) ? [(q[0] - p[0]) / L, (q[1] - p[1]) / L] : null;
}

/** Speed and course over a read window ending at `end` (before the turn) or starting at `start` (after it). */
function readAround(tr: TurnTrack, from: number, forward: boolean): { v: number; u: Vec } | null {
  const [a, b] = forward ? [from, from + TURN_PRE_MS] : [from - TURN_PRE_MS, from];
  const [c, d] = forward ? [from, from + TURN_COURSE_MS] : [from - TURN_COURSE_MS, from];
  const v = pathSpeed(tr, a, b);
  const u = course(tr, c, d);
  return v != null && u ? { v, u } : null;
}

/** Seconds lost to a loop over [t0, t1]: the boat's course and speed before it (else after it) against what it made along that course. */
export function turnLossS(tr: TurnTrack, t0: number, t1: number, toMs = Infinity): number | null {
  const end = Math.min(t1 + TURN_RECOVER_MS, toMs);
  const r = readAround(tr, t0 - TURN_PRE_GAP_MS, false) ?? readAround(tr, end, true);
  const p = posAt(tr, t0);
  const q = posAt(tr, end);
  if (!r || !p || !q || !(end > t0)) return null;
  const made = (q[0] - p[0]) * r.u[0] + (q[1] - p[1]) * r.u[1];
  const expected = r.v * ((end - t0) / 1000);
  return Math.max(0, (expected - made) / r.v);
}

interface Run {
  from: number;
  to: number;
}

/** Runs of turning one way: the sample index ranges [from, to] (the deltas between from and to). */
function runs(s: Sample[]): Run[] {
  const out: Run[] = [];
  let k = 1;
  while (k < s.length) {
    // A run starts on a turning step.
    const d0 = s[k].brk ? 0 : wrap180(s[k].hdg - s[k - 1].hdg);
    const rate0 = Math.abs(d0) / Math.max(0.001, (s[k].t - s[k - 1].t) / 1000);
    if (s[k].brk || Math.abs(d0) > TURN_MAX_STEP_DEG || rate0 < TURN_RATE_DEG_S) {
      k++;
      continue;
    }
    const dir = Math.sign(d0);
    const from = k - 1;
    let to = k;
    let lastTurn = s[k].t;
    let j = k + 1;
    for (; j < s.length; j++) {
      if (s[j].brk) break;
      const d = wrap180(s[j].hdg - s[j - 1].hdg);
      if (Math.abs(d) > TURN_MAX_STEP_DEG) break;
      if (-dir * d >= TURN_REVERSE_DEG) break;
      const rate = Math.abs(d) / Math.max(0.001, (s[j].t - s[j - 1].t) / 1000);
      if (dir * d > 0 && rate >= TURN_RATE_DEG_S) {
        lastTurn = s[j].t;
        to = j;
      } else if ((s[j].t - lastTurn) / 1000 > TURN_PAUSE_S) break;
    }
    out.push(...splitStraight(s, { from, to }));
    k = Math.max(k + 1, to + 1);
  }
  return out;
}

/** A run split at its straight stretches (TURN_STRAIGHT_S changing course under TURN_STRAIGHT_DEG): the turning either side. */
function splitStraight(s: Sample[], r: Run): Run[] {
  const out: Run[] = [];
  let start = r.from;
  let i = r.from;
  while (i < r.to) {
    let j = i;
    let net = 0;
    while (j < r.to && (s[j].t - s[i].t) / 1000 < TURN_STRAIGHT_S) {
      j++;
      net += wrap180(s[j].hdg - s[j - 1].hdg);
    }
    if ((s[j].t - s[i].t) / 1000 < TURN_STRAIGHT_S) break;
    if (Math.abs(net) < TURN_STRAIGHT_DEG) {
      if (i > start) out.push({ from: start, to: i });
      start = j;
      i = j;
      continue;
    }
    i++;
  }
  if (r.to > start) out.push({ from: start, to: r.to });
  return out;
}

/** The densest stretch of a run: the most degrees turned within `winS`, with its sample range. */
function bestWindow(s: Sample[], r: Run, dir: number, winS: number): { deg: number; a: number; b: number } {
  let best = { deg: 0, a: r.from, b: r.from };
  for (let a = r.from; a < r.to; a++) {
    let sum = 0;
    for (let b = a + 1; b <= r.to && (s[b].t - s[a].t) / 1000 <= winS; b++) {
      sum += dir * wrap180(s[b].hdg - s[b - 1].hdg);
      if (sum > best.deg) best = { deg: sum, a, b };
    }
  }
  return best;
}

/** The boat's penalty turns between `fromMs` and `toMs` (see the file comment). */
export function findTurns(tr: TurnTrack, o: TurnOpts): PenaltyTurn[] {
  if (!(o.toMs > o.fromMs)) return [];
  const s = samples(tr, o.fromMs, o.toMs);
  const out: PenaltyTurn[] = [];
  const r2 = TURN_MARK_M * TURN_MARK_M;
  for (const r of runs(s)) {
    // The run's way round: its net turn (a split run may open on a step of jitter the other way).
    let net = 0;
    for (let k = r.from + 1; k <= r.to; k++) net += wrap180(s[k].hdg - s[k - 1].hdg);
    const dir = Math.sign(net) || 1;
    const two = bestWindow(s, r, dir, 2 * TURN_WINDOW_S);
    const one = bestWindow(s, r, dir, TURN_WINDOW_S);
    const turns: 0 | 1 | 2 = two.deg >= TURN_TWO_DEG ? 2 : one.deg >= TURN_ONE_DEG ? 1 : 0;
    if (!turns) continue;
    const w = turns === 2 ? two : one;
    const n = w.b - w.a + 1;
    if (n < TURN_MIN_SAMPLES * turns) continue;
    const i0 = s[w.a].i0;
    const i1 = s[w.b].i1;
    const t0 = tr.t[i0];
    const t1 = tr.t[i1];
    if (t0 < o.fromMs || t1 > o.toMs) continue;
    let path = 0;
    let nearMark = false;
    for (let i = i0; i <= i1; i++) {
      if (i > i0) path += Math.hypot(tr.x[i] - tr.x[i - 1], tr.y[i] - tr.y[i - 1]);
      if (o.marks.some((m) => (m[0] - tr.x[i]) ** 2 + (m[1] - tr.y[i]) ** 2 <= r2)) nearMark = true;
    }
    if (nearMark) continue;
    const kn = (path / Math.max(1, (t1 - t0) / 1000)) * 1.943844;
    if (kn < TURN_MIN_KN) continue;
    out.push({ t0, t1, turns, deg: dir * w.deg, lostS: turnLossS(tr, t0, t1, o.toMs), samples: n, conf: o.fullRate ? 'high' : 'medium' });
  }
  return out;
}
