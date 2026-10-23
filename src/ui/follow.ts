/**
 * The maps' look-ahead follow camera (Around the gun and the track map), as pure math plus one small stepper.
 *
 * Zoomed in on a selected boat, the view's centre is the boat's position plus a lead along its smoothed course
 * (the circular mean of its course over the last FOLLOW_COURSE_S seconds), so more of the view lies where the boat
 * is going: upwind the boat sits about a third of the way in from the trailing edge; downwind it sits a little
 * forward of the centre, to show the boats astern (on its wind); reaching, or with no wind, a modest lead. The lead
 * is a fraction of the view's own size along the course (the same on screen at any zoom), scaled by how steady the
 * course has been, so it eases in after a steady stretch and back out through a tack, gybe or rounding.
 *
 * The camera eases toward that framing with a critically damped spring (no overshoot) in the boat's own frame:
 * the boat is always exactly at centre + offset, only the offset is smoothed, so a moving boat never lags or
 * jitters. Time is race time (seconds), so the easing is the same whether played, stepped or scrubbed; a jump
 * past FOLLOW_SNAP_S (a slider drag), reduced motion, or a newly selected boat snaps instead.
 */
import type { Vec } from '../analysis/geo';
import { clampView, viewBox, type Box, type View } from './view';

/** The course is smoothed over this many seconds (one sample a second, the latest included). */
export const FOLLOW_COURSE_S = 18;
/** |TWA| up to this, degrees: upwind. */
export const FOLLOW_UPWIND_MAX_DEG = 70;
/** |TWA| from this, degrees: downwind (between the two: reaching). */
export const FOLLOW_DOWNWIND_MIN_DEG = 115;

export type SailMode = 'upwind' | 'reach' | 'downwind' | 'unknown';

/**
 * The lead by sailing mode, as a share of the view's span along the course: the boat sits 0.5 − lead of the way
 * in from the trailing edge after a steady stretch (upwind 0.33, reaching or no wind 0.40, downwind 0.54: a
 * little forward of centre, showing the boats astern).
 */
export const FOLLOW_LEAD: Record<SailMode, number> = { upwind: 0.17, reach: 0.1, downwind: -0.04, unknown: 0.1 };

/** A course sample within this of the mean, degrees, counts as fully steady… */
export const FOLLOW_STEADY_DEG = 10;
/** …and none from this (a tack's or gybe's other board): steadiness falls off between the two. */
export const FOLLOW_TURNING_DEG = 40;

/** The spring's time constant, race seconds (critically damped: ω = 1 / τ; about 95% of the way in 5τ). */
export const FOLLOW_SMOOTH_S = 2.5;
/** A jump in race time over this, seconds (a slider drag, a deep link), snaps the camera without easing. */
export const FOLLOW_SNAP_S = 15;

const DEG = Math.PI / 180;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const unit = (v: Vec | null | undefined): Vec | null => {
  if (!v || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) return null;
  const l = Math.hypot(v[0], v[1]);
  return l > 0 ? [v[0] / l, v[1] / l] : null;
};

/**
 * The smoothed course of `dirs` (directions of travel, map coordinates; null: not known that second) and how
 * steady it was, 0…1: each sample's weight (1 within FOLLOW_STEADY_DEG of the circular mean, 0 from
 * FOLLOW_TURNING_DEG, linear in cos between), averaged over every sample asked for (unknown ones count 0).
 * A single stray sample barely moves either; half the window on another board (mid-tack) gives 0.
 */
export function courseStats(dirs: readonly (Vec | null)[]): { dir: Vec | null; steady: number } {
  const ok = dirs.map(unit).filter((d): d is Vec => d != null);
  if (!ok.length) return { dir: null, steady: 0 };
  const dir = unit([ok.reduce((s, d) => s + d[0], 0), ok.reduce((s, d) => s + d[1], 0)]);
  if (!dir) return { dir: null, steady: 0 };
  const hi = Math.cos(FOLLOW_STEADY_DEG * DEG);
  const lo = Math.cos(FOLLOW_TURNING_DEG * DEG);
  const w = ok.reduce((s, d) => s + clamp01((d[0] * dir[0] + d[1] * dir[1] - lo) / (hi - lo)), 0);
  return { dir, steady: w / dirs.length };
}

/** |TWA|, degrees, of a course `dir` with the wind blowing toward `down` (both map coordinates); null: either unknown. */
export function twaDeg(dir: Vec | null, down: Vec | null): number | null {
  const d = unit(dir);
  const w = unit(down);
  if (!d || !w) return null;
  // Into the wind is −down.
  const c = -(d[0] * w[0] + d[1] * w[1]);
  return Math.acos(Math.min(1, Math.max(-1, c))) / DEG;
}

/** The sailing mode from |TWA| (FOLLOW_UPWIND_MAX_DEG / FOLLOW_DOWNWIND_MIN_DEG); no course or no wind: unknown. */
export function sailMode(dir: Vec | null, down: Vec | null): SailMode {
  const twa = twaDeg(dir, down);
  if (twa == null) return 'unknown';
  return twa <= FOLLOW_UPWIND_MAX_DEG ? 'upwind' : twa >= FOLLOW_DOWNWIND_MIN_DEG ? 'downwind' : 'reach';
}

/** The view's span through its centre along unit direction `d`, for a view `w` × `h`. */
export function spanAlong(d: Vec, w: number, h: number): number {
  const sx = Math.abs(d[0]) > 1e-12 ? w / Math.abs(d[0]) : Infinity;
  const sy = Math.abs(d[1]) > 1e-12 ? h / Math.abs(d[1]) : Infinity;
  return Math.min(sx, sy);
}

/**
 * Where the camera wants the view's centre for the boat at `pos` in a view `w` × `h` (chart units): the boat plus
 * the look-ahead lead, FOLLOW_LEAD for the mode × the course's steadiness × the view's span along the course
 * (screen-relative: the same share at any zoom). No course: the boat itself.
 */
export function followTarget(pos: Vec, dirs: readonly (Vec | null)[], down: Vec | null, w: number, h: number): [number, number] {
  const { dir, steady } = courseStats(dirs);
  if (!dir || !(steady > 0)) return [pos[0], pos[1]];
  const lead = FOLLOW_LEAD[sailMode(dir, down)] * steady * spanAlong(dir, w, h);
  return [pos[0] + lead * dir[0], pos[1] + lead * dir[1]];
}

/**
 * One step of a critically damped spring (exact, any `dt` ≥ 0) from `x` moving at `v` toward `target`, time
 * constant `tau`: from rest it closes in monotonically, never overshooting.
 */
export function springStep(x: number, v: number, target: number, dt: number, tau = FOLLOW_SMOOTH_S): { x: number; v: number } {
  if (!(dt > 0)) return { x, v };
  if (!(tau > 0)) return { x: target, v: 0 };
  const w = 1 / tau;
  const e = x - target;
  const j = v + w * e;
  const decay = Math.exp(-w * dt);
  return { x: target + (e + j * dt) * decay, v: (v - w * j * dt) * decay };
}

/** The camera's state between steps (followStep). */
export interface FollowCam {
  /** The view centre's offset from the boat as shares of the view (x of width, y of height); null: not yet tracking. */
  off: Vec | null;
  vel: Vec;
  /** The race time of the last step, s. */
  t: number;
  /** The view the last step gave (a different one now: moved by a zoom, so the offset is taken from it). */
  out: View | null;
  /** Snap to the target on the next step (a newly selected boat). */
  snap: boolean;
}

export const followCam = (): FollowCam => ({ off: null, vel: [0, 0], t: NaN, out: null, snap: false });

/** Start afresh, snapping to the target on the next step (a boat newly selected, follow turned on by it). */
export function resetFollow(cam: FollowCam): void {
  Object.assign(cam, followCam(), { snap: true });
}

export interface FollowInput {
  /** The race time shown, seconds (any origin, the same throughout). */
  t: number;
  /** The selected boat's position, chart units. */
  pos: Vec;
  /** Its direction of travel each second over the last FOLLOW_COURSE_S seconds (any order; null: unknown). */
  dirs: readonly (Vec | null)[];
  /** The way the wind blows, chart units (null: unknown). */
  down: Vec | null;
}

const near = (a: View, b: View, w: number): boolean => Math.abs(a.k - b.k) < 1e-9 && Math.abs(a.cx - b.cx) <= 1e-9 * w && Math.abs(a.cy - b.cy) <= 1e-9 * w;

/**
 * One camera step for the view `v` on fit box `box`: the view centred so the boat sits at the eased look-ahead
 * offset, clamped into the box; the zoom never changes. At Fit, or with no position, `v` as it is. A view
 * changed since the last step (a wheel or pinch zoom, a preset) is taken as it is and eased from; `still`
 * (reduced motion), a newly selected boat or a jump over FOLLOW_SNAP_S snap. Returns `v` itself when nothing moves.
 */
export function followStep(cam: FollowCam, box: Box, v: View, input: FollowInput, still = false): View {
  const { pos, t } = input;
  if (v.k <= 1 || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1]) || !Number.isFinite(t)) {
    cam.off = null;
    cam.out = null;
    // At Fit there is nothing to snap: a zoom in afterwards (a preset, the wheel) is eased from as it is.
    if (v.k <= 1) cam.snap = false;
    return v;
  }
  const vb = viewBox(box, v);
  // The wanted offset as shares of the view.
  const [tx, ty] = followTarget(pos, input.dirs, input.down, vb.w, vb.h);
  const want: Vec = [(tx - pos[0]) / vb.w, (ty - pos[1]) / vb.h];
  const dt = Number.isFinite(cam.t) ? Math.abs(t - cam.t) : 0;
  if (cam.snap || still || dt > FOLLOW_SNAP_S) {
    cam.off = want;
    cam.vel = [0, 0];
  } else {
    if (!cam.off || !cam.out || !near(cam.out, v, vb.w)) {
      // Moved since (a zoom, a preset): ease on from where the boat is now.
      cam.off = [(v.cx - pos[0]) / vb.w, (v.cy - pos[1]) / vb.h];
      cam.vel = [0, 0];
    }
    const sx = springStep(cam.off[0], cam.vel[0], want[0], dt);
    const sy = springStep(cam.off[1], cam.vel[1], want[1], dt);
    cam.off = [sx.x, sy.x];
    cam.vel = [sx.v, sy.v];
  }
  cam.snap = false;
  cam.t = t;
  const next = clampView(box, { cx: pos[0] + cam.off[0] * vb.w, cy: pos[1] + cam.off[1] * vb.h, k: v.k });
  const out = near(next, v, vb.w) ? v : next;
  cam.out = out;
  return out;
}

/** What turns the follow on or off: a hand pan, a wheel or pinch zoom, a preset (buttons, + / −, 0, Fit), a boat selected, a replay or card window framing the map. */
export type FollowEvent = 'pan' | 'zoom' | 'preset' | 'select' | 'frame';

/** The follow after `ev`: a hand pan or a replay / card window stops it; a preset or a selection starts it; a wheel or pinch zoom keeps it as it was. */
export function followAfter(on: boolean, ev: FollowEvent): boolean {
  if (ev === 'pan' || ev === 'frame') return false;
  if (ev === 'preset' || ev === 'select') return true;
  return on;
}

/** The user asks for reduced motion (the camera snaps instead of easing). */
export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
