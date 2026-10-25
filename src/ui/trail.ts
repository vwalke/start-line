/**
 * The short trail behind each boat while scrubbing or playing (the track map's "Race Viewer" and the Start tab's
 * "Start Playback"): its last BOAT_TRAIL_MS, in the boat's own color, fading toward the tail in TRAIL_FADE slices
 * (one path per slice, so a frame only sets a few `d` attributes per boat), never bridging a tracker gap; a short gap
 * filled in for display (ui/gapFill.ts, its points flagged `est`) goes to a second, lighter set of slices. Pure: SVG
 * path data from a boat's fixes in map coordinates; ui/trailLayer.ts paints them.
 */
import type { Vec } from '../analysis/geo';
import { lowerBound, upperBound } from './mapPieces';
import type { Box } from './view';

/** How far back the trail behind each boat reaches, ms (the scrubber's default trail, "2 min"). */
export const BOAT_TRAIL_MS = 120_000;
/** The trail's fade: the opacity of each equal slice of its length, head to tail. */
export const TRAIL_FADE: readonly number[] = [0.9, 0.6, 0.35, 0.15];
/** A trail draws at most about this many points (a 10 Hz log's two minutes are thinned to it; gaps and ends are kept). */
export const TRAIL_MAX_PTS = 240;

/** One stretch of a boat's fixes, [i0, i1) of time `t` and map coordinates `x`, `y` (a leg range of one source). */
export interface TrailStretch {
  t: ArrayLike<number>;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  i0: number;
  i1: number;
  /** 1 on a point filled into a short gap (ui/gapFill.ts); absent: every point is a fix. */
  est?: ArrayLike<number>;
}

/** A trail's path data per fade slice, head first: the steps between fixes (`d`), and those to or from a filled-in point (`est`, drawn lighter). */
export interface TrailSlices {
  d: string[];
  est: string[];
}

/** Which slice of the trail (0: the head) a moment `age` ms old falls in, of `n` over `lenMs`. */
export const fadeSlice = (age: number, lenMs: number, n = TRAIL_FADE.length): number =>
  Math.max(0, Math.min(n - 1, Math.floor((age / lenMs) * n)));

const f1 = (v: number): string => v.toFixed(1);

/**
 * A boat's trail at `now` as path data, one per fade slice (head first; '' where a slice has nothing): its fixes in
 * `stretches` (time order; a fix shared where one stretch ends and the next begins is taken once) from `now − lenMs`
 * to `now`, then `head` (the boat's position now; null: none, e.g. held in a gap). Broken wherever consecutive fixes
 * are over `gapMs` apart (the map's gap rule), never bridged. Each step goes to the slice of its middle; with `clip`,
 * only steps whose bounding box overlaps it (one crossing the view with both ends outside is kept). Thinned to
 * about TRAIL_MAX_PTS points (never across a gap). The steps between fixes only: trailSlices has the filled-in ones too.
 */
export function trailPaths(stretches: readonly TrailStretch[], now: number, lenMs: number, gapMs: number, head: Vec | null = null, clip: Box | null = null, slices = TRAIL_FADE.length): string[] {
  return trailSlices(stretches, now, lenMs, gapMs, head, clip, slices).d;
}

/**
 * trailPaths, with each step to or from a point filled into a short gap (the stretches' `est`) in `est` instead of
 * `d`; never thinned across where the trail turns from fixes to filled points or back. `head` counts as filled in
 * with `headEst` (the boat placed on a filled stretch).
 */
export function trailSlices(
  stretches: readonly TrailStretch[],
  now: number,
  lenMs: number,
  gapMs: number,
  head: Vec | null = null,
  clip: Box | null = null,
  slices = TRAIL_FADE.length,
  headEst = false,
): TrailSlices {
  const from = now - lenMs;
  // Each stretch's fixes inside [from, now] (binary search: a stretch may run well past the trail).
  const spans = stretches.map((s): [number, number] => [lowerBound(s.t, from, s.i0, s.i1), upperBound(s.t, now, s.i0, s.i1)]);
  let n = 0;
  for (const [i0, i1] of spans) n += Math.max(0, i1 - i0);
  const stride = Math.max(1, Math.ceil((n + 1) / TRAIL_MAX_PTS));
  const out: TrailSlices = { d: new Array<string>(slices).fill(''), est: new Array<string>(slices).fill('') };
  /** Per kind and slice: the point its path's pen is on (a count of points taken), -1: lifted. */
  const pen: Record<keyof TrailSlices, number[]> = { d: new Array<number>(slices).fill(-1), est: new Array<number>(slices).fill(-1) };
  const near = (ax: number, ay: number, bx: number, by: number): boolean =>
    !clip || (Math.min(ax, bx) <= clip.x1 && Math.max(ax, bx) >= clip.x0 && Math.min(ay, by) <= clip.y1 && Math.max(ay, by) >= clip.y0);
  // The last point drawn to (its time, place and whether it is filled in), how many points were taken, and the last point fed.
  let pt = NaN;
  let px = 0;
  let py = 0;
  let pe = false;
  let taken = 0;
  let sinceT = NaN;
  let sinceE = false;
  let skipped = 0;
  const step = (t: number, x: number, y: number, e: boolean, last: boolean): void => {
    const gap = Number.isFinite(sinceT) && t - sinceT > gapMs;
    const turn = Number.isFinite(sinceT) && e !== sinceE;
    sinceT = t;
    sinceE = e;
    // Thinning: skip a fix unless it ends a stretch without gaps, starts one, turns between fixes and filled points, or the stride is up.
    if (!gap && !turn && Number.isFinite(pt) && !last && ++skipped < stride) return;
    skipped = 0;
    if (Number.isFinite(pt) && !gap && near(px, py, x, y)) {
      const sl = fadeSlice(now - (pt + t) / 2, lenMs, slices);
      const kind: keyof TrailSlices = pe || e ? 'est' : 'd';
      if (pen[kind][sl] !== taken) out[kind][sl] += `M${f1(px)},${f1(py)}`;
      out[kind][sl] += `L${f1(x)},${f1(y)}`;
      pen[kind][sl] = taken + 1;
    }
    pt = t;
    px = x;
    py = y;
    pe = e;
    taken++;
  };
  // A fix just before a gap (or where the trail turns between fixes and filled points) ends its stretch: look one ahead so it is never thinned away.
  let held = null as { t: number; x: number; y: number; e: boolean } | null;
  const feed = (t: number, x: number, y: number, e: boolean): void => {
    if (held) step(held.t, held.x, held.y, held.e, t - held.t > gapMs || e !== held.e);
    held = { t, x, y, e };
  };
  stretches.forEach((s, k) => {
    for (let i = spans[k][0]; i < spans[k][1]; i++) {
      const t = s.t[i];
      if (held && t <= held.t) continue;
      feed(t, s.x[i], s.y[i], s.est?.[i] === 1);
    }
  });
  if (head && (!held || now > held.t)) feed(now, head[0], head[1], headEst);
  if (held) step(held.t, held.x, held.y, held.e, true);
  return out;
}
