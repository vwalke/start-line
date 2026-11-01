/**
 * VMG at a point of a track, for the Race Viewer's "Color: VMG" (ui/vmg.ts): the boat's velocity (SOG, the 4 s mean
 * of analysis/smooth.ts, along its course over ground) made good toward where its leg ends, on the course and wind the
 * ladder rungs read (ladderNow.ts: gapCourse's course, liveWind's smoothed wind of the moment).
 *
 * - A beat: the component of velocity into the wind; a run: the component down it (the ladder's axis).
 * - A reach: the component along the bearing from the boat's bow to its leg's end (the mark; on the last leg its own
 *   point on the finish line extended, ladderNow.ts endInto), as the rungs measure from the bow (ladderNow.ts
 *   bowAheadOf): the bow `bowM` ahead of the tracker along the course over ground, the way the map points the hull.
 * - Before the gun the first leg's, as Boat speed borrows the first leg's scale (ui/sog.ts scaleLeg).
 * - Positive: making ground toward the leg's end; negative: losing it (a penalty turn, sailing past a mark).
 */
import type { CoachModel } from './index';
import type { Course } from './ladder';
import { endInto } from './ladderNow';
import { liveWind } from './liveWind';
import { gapCourse } from './timeGap';

const RAD = Math.PI / 180;

/** What VMG is read on: the ladder's course and the smoothed wind (°, from) at a moment. */
export interface VmgFrame {
  course: Course;
  twdAt: (t: number) => number;
}

const frames = new WeakMap<CoachModel, VmgFrame>();

/** The ladder's course and wind for model `m` (ladderNow.ts reads the same), once per model. */
export function vmgFrame(m: CoachModel): VmgFrame {
  let f = frames.get(m);
  if (!f) {
    const live = liveWind(m);
    frames.set(m, (f = { course: gapCourse(m).course, twdAt: (t) => live.twdAt(t) }));
  }
  return f;
}

const end = { ex: 0, ey: 0 };

/**
 * VMG in knots of a boat with its tracker at (x, y) (m, the analysis's frame) and its bow `bowM` ahead of it, on leg
 * `leg` (before the gun: the first) sailing `sogKn` along `cogDeg` (true), with the wind from `twdDeg`. Not moving (no
 * course): 0. NaN with no speed, no wind on a beat or run, or a leg the course doesn't have.
 */
export function vmgKn(c: Course, twdDeg: number, leg: number, x: number, y: number, sogKn: number, cogDeg: number, bowM = 0): number {
  if (!Number.isFinite(sogKn)) return NaN;
  const k = Math.max(0, leg);
  if (k >= c.kinds.length) return NaN;
  if (!Number.isFinite(cogDeg)) return 0;
  const vx = sogKn * Math.sin(cogDeg * RAD);
  const vy = sogKn * Math.cos(cogDeg * RAD);
  const kind = c.kinds[k];
  if (kind !== 'reach') {
    if (!Number.isFinite(twdDeg)) return NaN;
    const up = vx * Math.sin(twdDeg * RAD) + vy * Math.cos(twdDeg * RAD);
    return kind === 'upwind' ? up : -up;
  }
  const bx = x + bowM * Math.sin(cogDeg * RAD);
  const by = y + bowM * Math.cos(cogDeg * RAD);
  endInto(c, k, bx, by, end);
  const dx = end.ex - bx;
  const dy = end.ey - by;
  const l = Math.hypot(dx, dy);
  return l > 0 ? (vx * dx + vy * dy) / l : 0;
}
