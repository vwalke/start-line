/**
 * The fleet up the wind ladder at one moment, for the Race Viewer's ladder rungs (ui/rungs.ts), measured as the
 * Coach's gap chart measures course progress (timeGap.ts legAlong): on the course and leg winds of gapCourse (each
 * leg's one wind from the fleet's wind series, legWinds, so a run reads the gybes where twdSeries.ts has them), a
 * boat's rung (ladder.ts rung: to its leg's end along that wind, or past the layline `hypot(u, c)·cos(a)`), and its
 * course progress (the legs before plus the share of this leg's ladder climbed, scaled to its rhumb length).
 *
 * - Positions are read as progress.ts reads them for the places (PROG_SPAN_S, PROG_NEAR_S). A boat with no position
 *   then, or no known leg, is estimated (`est`): the map's tooltip gives it no place, and it never leads.
 * - A finished boat is ahead of every boat still racing, the earlier finisher first; DNS/DNC/DNE and tracked boats
 *   official results don't list are left out (progress.ts progressAt).
 * - Worked out once per model; each moment fills the same reads in place (no allocation while scrubbing), and the
 *   last moment asked is kept (a pan or a pause asks again).
 */
import { bisectRight } from '../geo';
import type { LegKind, RaceAnalysis } from '../types';
import type { CoachModel } from './index';
import { extraTracked, neverRaced } from './fleet';
import { laylineDeg, legLengths, type Course } from './ladder';
import { PROG_NEAR_S, PROG_SPAN_S } from './progress';
import { gapCourse, type LegWind } from './timeGap';
import { trackLegAt, type CoachTrack } from './tracks';

/** One boat at the moment read (filled in place). */
export interface LadderRead {
  id: string;
  /** When it finished, ms; null: not finished. */
  finishMs: number | null;
  /** Finished at the moment read. */
  done: boolean;
  /** No position then (or its leg unknown): no place, never the leader. */
  est: boolean;
  /** Its leg; −1 when not read. */
  leg: number;
  /** Where it is, m (the analysis's frame). */
  x: number;
  y: number;
  /** Where its leg ends for it (the mark, or on the last leg the finish line extended), m. */
  ex: number;
  ey: number;
  /** Its rung: how far it still has to climb (or run) to `ex, ey` along the leg's wind, m; NaN on a reach. */
  rung: number;
  /** Course progress, m (the legs before plus legAlong). */
  prog: number;
}

export interface LadderNow {
  t: number;
  reads: readonly LadderRead[];
  /** The leader (first by course progress, finished boats first, `est` reads skipped): an index into `reads`, −1 for none. */
  leader: number;
  course: Course;
  /** Each leg's wind (timeGap.ts legWinds): the rungs' wind. */
  lw: readonly LegWind[];
}

/** A leg's ladder, worked out once: its wind as a unit vector into it, the layline and its full rung. */
interface LegLadder {
  kind: LegKind;
  /** Course progress where it starts, m, and its rhumb length. */
  start: number;
  L: number;
  /** Into the wind (bearingVec), and the layline's tan and cos. */
  wx: number;
  wy: number;
  tanA: number;
  cosA: number;
  /** The rung from its start mark (legAlong's `full`); 0: measured along the rhumb line instead. */
  full: number;
}

/**
 * ladder.ts rung without allocating: from (px, py) to the leg's end (ex, ey), along the wind (wx, wy) into it;
 * `up` toward it upwind, away from it downwind; past the layline (tanA, cosA) `hypot(u, c)·cos(a)`.
 */
export function rungXY(px: number, py: number, ex: number, ey: number, wx: number, wy: number, up: boolean, tanA: number, cosA: number): number {
  const vx = ex - px;
  const vy = ey - py;
  const u = vx * wx + vy * wy;
  const c = Math.abs(vx * wy - vy * wx);
  const uu = Math.max(up ? u : -u, 0);
  return c <= uu * tanA ? uu : Math.hypot(uu, c) * cosA;
}

/** Where leg `leg` ends for a boat at (px, py), into `out` (timeGap.ts progressEnd: the last leg's finish line extended). */
function endInto(c: Course, leg: number, px: number, py: number, out: { ex: number; ey: number }): void {
  const f = c.finish;
  const last = leg === c.kinds.length - 1;
  if (f && last) {
    const dx = f.right[0] - f.left[0];
    const dy = f.right[1] - f.left[1];
    const L2 = dx * dx + dy * dy;
    // A line of no length: its left end (ladder.ts legEnd).
    const s = L2 > 0 ? ((px - f.left[0]) * dx + (py - f.left[1]) * dy) / L2 : 0;
    out.ex = f.left[0] + s * dx;
    out.ey = f.left[1] + s * dy;
    return;
  }
  out.ex = c.pts[leg + 1][0];
  out.ey = c.pts[leg + 1][1];
}

function legLadders(c: Course, lw: readonly LegWind[]): LegLadder[] {
  const lens = legLengths(c);
  let start = 0;
  const end = { ex: 0, ey: 0 };
  return c.kinds.map((kind, k) => {
    const w = lw[k];
    const th = ((w?.twdDeg ?? 0) * Math.PI) / 180;
    const a = (laylineDeg(kind, w?.taDeg ?? 90) * Math.PI) / 180;
    const leg: LegLadder = { kind, start, L: lens[k], wx: Math.sin(th), wy: Math.cos(th), tanA: Math.tan(a), cosA: Math.cos(a), full: 0 };
    start += lens[k];
    if (kind !== 'reach' && w && lens[k] > 0) {
      const [px, py] = c.pts[k];
      endInto(c, k, px, py, end);
      leg.full = rungXY(px, py, end.ex, end.ey, leg.wx, leg.wy, kind === 'upwind', leg.tanA, leg.cosA);
    }
    return leg;
  });
}

/** Position at `t` as tracks.ts posAt reads it (fixes ≤ `spanS` apart, one ≤ `nearS` away), into `out`; false when none. */
function posInto(tr: CoachTrack, t: number, spanS: number, nearS: number, out: { x: number; y: number }): boolean {
  const n = tr.t.length;
  if (!n || t < tr.t[0] || t > tr.t[n - 1]) return false;
  const i = bisectRight(tr.t, t);
  if (tr.t[i] === t) {
    out.x = tr.x[i];
    out.y = tr.y[i];
    return true;
  }
  const a = tr.t[i];
  const b = tr.t[i + 1];
  if (b - a > spanS * 1000 || Math.min(t - a, b - t) > nearS * 1000) return false;
  const f = (t - a) / (b - a);
  out.x = tr.x[i] + f * (tr.x[i + 1] - tr.x[i]);
  out.y = tr.y[i] + f * (tr.y[i + 1] - tr.y[i]);
  return true;
}

/**
 * The leader among `reads`: a finished boat first (the earliest finisher), else the furthest by course progress;
 * an estimated read (no position, as the map's tooltip gives it no place) is skipped. −1 with none.
 */
export function leaderOf(reads: readonly Pick<LadderRead, 'est' | 'done' | 'finishMs' | 'prog'>[]): number {
  let best = -1;
  for (let i = 0; i < reads.length; i++) {
    const r = reads[i];
    if (r.est) continue;
    if (best < 0) {
      best = i;
      continue;
    }
    const b = reads[best];
    if (r.done !== b.done ? r.done : r.done ? r.finishMs! < b.finishMs! : r.prog > b.prog) best = i;
  }
  return best;
}

export type LadderReader = (t: number) => LadderNow;

const readers = new WeakMap<CoachModel, LadderReader>();

/** The fleet up the ladder at any moment (above), from the race's coach model; one reader per model. */
export function ladderReader(a: Pick<RaceAnalysis, 'boats' | 'meta'>, m: CoachModel): LadderReader {
  const have = readers.get(m);
  if (have) return have;
  const { course, lw } = gapCourse(m);
  const legs = legLadders(course, lw);
  const extra = extraTracked(a);
  const racing = a.boats.filter((b) => !extra.has(b.sail) && !extra.has(b.id) && !neverRaced(b.finishCode));
  const tracks = racing.map((b) => m.tracks.get(b.id) ?? null);
  const reads: LadderRead[] = racing.map((b) => ({ id: b.id, finishMs: b.finishMs, done: false, est: true, leg: -1, x: NaN, y: NaN, ex: NaN, ey: NaN, rung: NaN, prog: NaN }));
  const now: LadderNow = { t: NaN, reads, leader: -1, course, lw };
  const n = course.kinds.length;
  const read = (r: LadderRead, tr: CoachTrack | null, t: number): void => {
    r.done = r.finishMs != null && t >= r.finishMs;
    r.leg = -1;
    r.rung = NaN;
    r.prog = NaN;
    if (r.done) {
      r.est = false;
      return;
    }
    r.est = true;
    if (!tr || !posInto(tr, t, PROG_SPAN_S, PROG_NEAR_S, r)) return;
    const leg = trackLegAt(tr, t);
    if (leg == null || leg >= n) return;
    const g = legs[leg];
    r.est = false;
    r.leg = leg;
    endInto(course, leg, r.x, r.y, r);
    if (g.full > 0) {
      r.rung = rungXY(r.x, r.y, r.ex, r.ey, g.wx, g.wy, g.kind === 'upwind', g.tanA, g.cosA);
      r.prog = g.start + g.L * (1 - r.rung / g.full);
    } else {
      // A reach (or a leg with no ladder): distance made good along the rhumb line (timeGap.ts legProgress).
      const [x0, y0] = course.pts[leg];
      const [x1, y1] = course.pts[leg + 1];
      r.prog = g.start + (g.L > 0 ? ((r.x - x0) * (x1 - x0) + (r.y - y0) * (y1 - y0)) / g.L : 0);
    }
  };
  const reader: LadderReader = (t) => {
    if (t === now.t) return now;
    now.t = t;
    for (let i = 0; i < reads.length; i++) read(reads[i], tracks[i], t);
    now.leader = leaderOf(reads);
    return now;
  };
  readers.set(m, reader);
  return reader;
}
