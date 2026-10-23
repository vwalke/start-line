import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { Vec } from '../src/analysis/geo';
import type { RaceAnalysis } from '../src/analysis/types';
import { BOAT_SHAPE_ON_PX, HULL_LABEL_GAP_PX, HULL_LABEL_SIDES, boatShapeOr, hullLabelBox, hullOutlineAt } from '../src/ui/boatShape';
import { boatsAt, mapBox, mapFollowInput, scrubFrame, startClass, trackMapView } from '../src/ui/charts';
import {
  FOLLOW_COURSE_S,
  FOLLOW_DOWNWIND_MIN_DEG,
  FOLLOW_LEAD,
  FOLLOW_SMOOTH_S,
  FOLLOW_SNAP_S,
  FOLLOW_UPWIND_MAX_DEG,
  courseStats,
  followAfter,
  followCam,
  followStep,
  followTarget,
  resetFollow,
  sailMode,
  springStep,
  twaDeg,
  type FollowInput,
} from '../src/ui/follow';
import { textWidth } from '../src/ui/labels';
import { laneScrub } from '../src/ui/laneSnapshots';
import { laneFollowInput, laneFollowTarget, lanePxPerUnit, laneScrubHtml, laneShape, mountLaneSnapshots } from '../src/ui/laneSnapshotsView';
import { attachPanZoom } from '../src/ui/panzoom';
import { scrubWindow, trailWindow } from '../src/ui/scrub';
import { K_MAX, clampView, fitView, viewBox, zoomPreset, type Box, type ClientRect, type View } from '../src/ui/view';
import { j105Race } from './helpers';

/**
 * The maps' look-ahead follow camera (follow.ts): more room ahead upwind, centered (a little astern) downwind, eased
 * in on a steady course and out through a maneuver, screen-relative; the spring that eases it; what turns it on and
 * off; and the sail-number labels kept a few px off their hull at any zoom (both maps).
 */
const UP: Vec = [0, -1];
const DOWN_WIND: Vec = [0, 1]; // the wind blows down the map: wind-up, as both maps draw it
const steady = (d: Vec, n = FOLLOW_COURSE_S): Vec[] => Array.from({ length: n }, () => d);
const dirOf = (deg: number): Vec => [Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)]; // 0 = up the map
/** Where the boat sits along its course, as a share of the view's span from the trailing edge (0.5: the center). */
function fromTrailing(pos: Vec, dir: Vec, c: [number, number], w: number, h: number): number {
  const span = Math.min(Math.abs(dir[0]) > 1e-12 ? w / Math.abs(dir[0]) : Infinity, Math.abs(dir[1]) > 1e-12 ? h / Math.abs(dir[1]) : Infinity);
  const along = (pos[0] - c[0]) * dir[0] + (pos[1] - c[1]) * dir[1];
  return 0.5 + along / span;
}

describe('look-ahead target', () => {
  const pos: Vec = [100, 50];
  const [w, h] = [400, 250];

  it('upwind after a steady stretch: the boat about a third of the way in from the trailing edge (more room ahead)', () => {
    for (const deg of [0, 35, -42, 60]) {
      const d = dirOf(deg);
      expect(sailMode(d, DOWN_WIND)).toBe('upwind');
      const f = fromTrailing(pos, d, followTarget(pos, steady(d), DOWN_WIND, w, h), w, h);
      expect(f).toBeGreaterThanOrEqual(0.3);
      expect(f).toBeLessThanOrEqual(0.35);
    }
    expect(0.5 - FOLLOW_LEAD.upwind).toBeCloseTo(0.33, 9);
  });

  it('downwind: little or no lead, the boat near the center (a little forward of it), showing the boats astern', () => {
    for (const deg of [180, 150, -140]) {
      const d = dirOf(deg);
      expect(sailMode(d, DOWN_WIND)).toBe('downwind');
      const f = fromTrailing(pos, d, followTarget(pos, steady(d), DOWN_WIND, w, h), w, h);
      expect(f).toBeGreaterThanOrEqual(0.5);
      expect(f).toBeLessThanOrEqual(0.56);
    }
  });

  it('reaching, or with no wind: a modest lead', () => {
    const reach = dirOf(90);
    expect(sailMode(reach, DOWN_WIND)).toBe('reach');
    expect(fromTrailing(pos, reach, followTarget(pos, steady(reach), DOWN_WIND, w, h), w, h)).toBeCloseTo(0.4, 9);
    expect(sailMode(UP, null)).toBe('unknown');
    expect(fromTrailing(pos, UP, followTarget(pos, steady(UP), null, w, h), w, h)).toBeCloseTo(0.4, 9);
    // No course known: the boat itself.
    expect(followTarget(pos, steady(null as unknown as Vec), DOWN_WIND, w, h)).toEqual(pos);
  });

  it('the TWA bands', () => {
    expect(twaDeg(dirOf(FOLLOW_UPWIND_MAX_DEG), DOWN_WIND)).toBeCloseTo(70, 9);
    expect(sailMode(dirOf(FOLLOW_UPWIND_MAX_DEG - 0.5), DOWN_WIND)).toBe('upwind');
    expect(sailMode(dirOf(FOLLOW_UPWIND_MAX_DEG + 0.5), DOWN_WIND)).toBe('reach');
    expect(sailMode(dirOf(FOLLOW_DOWNWIND_MIN_DEG - 0.5), DOWN_WIND)).toBe('reach');
    expect(sailMode(dirOf(FOLLOW_DOWNWIND_MIN_DEG + 0.5), DOWN_WIND)).toBe('downwind');
    expect(sailMode(dirOf(-170), DOWN_WIND)).toBe('downwind');
  });

  it('screen-relative: the same share of the view at 2×, 4× and 8× (the offset scales with the view)', () => {
    const box: Box = { x0: -1000, y0: -1000, x1: 1000, y1: 600 };
    const d = dirOf(40);
    const shares = [2, 4, 8].map((k) => {
      const vb = viewBox(box, { cx: 0, cy: 0, k });
      const c = followTarget(pos, steady(d), DOWN_WIND, vb.w, vb.h);
      return { k, dx: (c[0] - pos[0]) / vb.w, dy: (c[1] - pos[1]) / vb.h, f: fromTrailing(pos, d, c, vb.w, vb.h), len: Math.hypot(c[0] - pos[0], c[1] - pos[1]) };
    });
    for (const s of shares) {
      expect(s.dx).toBeCloseTo(shares[0].dx, 9);
      expect(s.dy).toBeCloseTo(shares[0].dy, 9);
      expect(s.f).toBeCloseTo(shares[0].f, 9);
    }
    // In map units it halves with each doubling of the zoom.
    expect(shares[1].len).toBeCloseTo(shares[0].len / 2, 9);
    expect(shares[2].len).toBeCloseTo(shares[0].len / 4, 9);
  });

  it('the smoothed course ignores a single tack or gybe spike', () => {
    const dirs = steady(dirOf(45));
    dirs[7] = dirOf(-45); // one second on the other board
    const c = courseStats(dirs);
    const off = (Math.acos(c.dir![0] * dirOf(45)[0] + c.dir![1] * dirOf(45)[1]) * 180) / Math.PI;
    expect(off).toBeLessThan(5);
    expect(c.steady).toBeGreaterThan(0.9);
    expect(sailMode(c.dir, DOWN_WIND)).toBe('upwind');
    const gybe = steady(dirOf(150));
    gybe[3] = dirOf(-150);
    expect(courseStats(gybe).steady).toBeGreaterThan(0.9);
  });

  it('eases out through a maneuver and back in after a steady stretch', () => {
    // Port tack (−45°) until second 0, a 6 s tack, then starboard (45°): the lead's size each second.
    const course = (s: number): Vec => (s <= 0 ? dirOf(-45) : s >= 6 ? dirOf(45) : dirOf(-45 + (90 * s) / 6));
    const lead = (s: number): number => {
      const dirs = Array.from({ length: FOLLOW_COURSE_S }, (_, i) => course(s - i));
      const c = followTarget(pos, dirs, DOWN_WIND, w, h);
      return Math.hypot(c[0] - pos[0], c[1] - pos[1]);
    };
    const full = lead(0);
    expect(full).toBeGreaterThan(0);
    // Through the tack it falls away to (nearly) nothing: the boat back toward the center.
    expect(lead(4)).toBeLessThan(full);
    expect(Math.min(...[6, 8, 10, 12].map(lead))).toBeLessThan(0.2 * full);
    // Then back in gradually as the new board fills the window, full once it has.
    expect(lead(16)).toBeGreaterThan(lead(12));
    expect(lead(20)).toBeGreaterThan(lead(16) - 1e-9);
    expect(lead(6 + FOLLOW_COURSE_S)).toBeCloseTo(full, 6);
  });
});

describe('the smoothing step: a critically damped spring', () => {
  it('converges without overshoot, any step size, and steps compose exactly', () => {
    for (const dt of [0.05, 0.5, 1, 3]) {
      let s = { x: 1, v: 0 };
      let prev = 1;
      for (let i = 0; i < Math.ceil((12 * FOLLOW_SMOOTH_S) / dt); i++) {
        s = springStep(s.x, s.v, 0, dt);
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThanOrEqual(prev + 1e-12);
        prev = s.x;
      }
      expect(s.x).toBeLessThan(1e-3);
    }
    const one = springStep(0.4, 0.1, -0.2, 2);
    const half = springStep(0.4, 0.1, -0.2, 1);
    const two = springStep(half.x, half.v, -0.2, 1);
    expect(two.x).toBeCloseTo(one.x, 12);
    expect(two.v).toBeCloseTo(one.v, 12);
    // About 95% of the way in 5 time constants; nothing for no time; τ 0 snaps.
    expect(springStep(1, 0, 0, 5 * FOLLOW_SMOOTH_S).x).toBeLessThan(0.05);
    expect(springStep(1, 0, 0, 0)).toEqual({ x: 1, v: 0 });
    expect(springStep(1, 0, 0, 1, 0)).toEqual({ x: 0, v: 0 });
  });

  const box: Box = { x0: -2000, y0: -2000, x1: 2000, y1: 2000 };
  const input = (t: number, pos: Vec, d: Vec = UP): FollowInput => ({ t, pos, dirs: steady(d), down: DOWN_WIND });
  const boatShare = (v: View, p: Vec): Vec => {
    const vb = viewBox(box, v);
    return [(p[0] - v.cx) / vb.w, (p[1] - v.cy) / vb.h];
  };

  it('eases from the view as it is toward the look-ahead, keeping the zoom; the boat never lags as it moves', () => {
    const cam = followCam();
    let v: View = { cx: 0, cy: 0, k: 8 };
    const vb = viewBox(box, v);
    const want = followTarget([0, 0], steady(UP), DOWN_WIND, vb.w, vb.h);
    // From centered on the boat (as a preset would leave it, or a wheel zoom): no jump, then in toward the lead.
    v = followStep(cam, box, v, input(0, [0, 0]));
    expect([v.cx, v.cy]).toEqual([0, 0]);
    let gap = Math.abs(want[1]);
    for (let s = 1; s <= 30; s++) {
      // Sailing up the map at 3 m/s.
      const p: Vec = [0, -3 * s];
      v = followStep(cam, box, v, input(s, p));
      expect(v.k).toBe(8);
      const g = Math.abs(v.cy - p[1] - want[1]);
      expect(g).toBeLessThanOrEqual(gap + 1e-9); // closing in, never past it
      expect(Math.sign(v.cy - p[1])).toBe(Math.sign(want[1]));
      gap = g;
    }
    expect(gap).toBeLessThan(0.01 * Math.abs(want[1]));
    // Settled: the boat holds its place on screen while it sails on (the offset is in the boat's frame).
    const at = boatShare(v, [0, -90]);
    v = followStep(cam, box, v, input(31, [0, -93]));
    expect(boatShare(v, [0, -93])[1]).toBeCloseTo(at[1], 4);
  });

  it('snaps on a big jump in time (a slider drag) and with reduced motion; returns the view itself when nothing moves', () => {
    const cam = followCam();
    let v: View = { cx: 0, cy: 0, k: 4 };
    v = followStep(cam, box, v, input(0, [0, 0]));
    const vb = viewBox(box, v);
    const want = (p: Vec) => followTarget(p, steady(UP), DOWN_WIND, vb.w, vb.h);
    // A jump over FOLLOW_SNAP_S: straight to the target.
    v = followStep(cam, box, v, input(FOLLOW_SNAP_S + 1, [50, -400]));
    expect(v.cx).toBeCloseTo(want([50, -400])[0], 9);
    expect(v.cy).toBeCloseTo(want([50, -400])[1], 9);
    // The same second again: the very same view (no redraw loop).
    expect(followStep(cam, box, v, input(FOLLOW_SNAP_S + 1, [50, -400]))).toBe(v);
    // Reduced motion: every step on target.
    const still = followCam();
    const s0 = followStep(still, box, { cx: 300, cy: 300, k: 4 }, input(0, [0, 0]), true);
    expect([s0.cx, s0.cy]).toEqual(want([0, 0]));
    const s1 = followStep(still, box, s0, input(1, [0, -3], dirOf(90)), true);
    const w1 = followTarget([0, -3], steady(dirOf(90)), DOWN_WIND, vb.w, vb.h);
    expect(s1.cx).toBeCloseTo(w1[0], 9);
    expect(s1.cy).toBeCloseTo(w1[1], 9);
    // A newly selected boat snaps too.
    const sel = followCam();
    followStep(sel, box, { cx: 0, cy: 0, k: 4 }, input(0, [0, 0]));
    resetFollow(sel);
    const s2 = followStep(sel, box, { cx: 0, cy: 0, k: 4 }, input(1, [600, 600]));
    expect([s2.cx, s2.cy]).toEqual(want([600, 600]));
  });

  it('a boat selected at Fit keeps the snap pending: the first step zoomed in (a wheel zoom) snaps to it', () => {
    const cam = followCam();
    followStep(cam, box, { cx: 0, cy: 0, k: 4 }, input(0, [0, 0]));
    resetFollow(cam);
    const fit = fitView(box);
    expect(followStep(cam, box, fit, input(0.5, [600, 600]))).toBe(fit);
    expect(cam.snap).toBe(true);
    // A wheel zoom somewhere else, a moment later: straight onto the selected boat's look-ahead, no easing.
    const v = followStep(cam, box, { cx: -900, cy: -900, k: 4 }, input(1, [600, 600]));
    const vb = viewBox(box, v);
    expect([v.cx, v.cy]).toEqual(followTarget([600, 600], steady(UP), DOWN_WIND, vb.w, vb.h));
    expect(cam.snap).toBe(false);
  });

  it('at Fit, the view as it is; clamped into the map at its edge', () => {
    const cam = followCam();
    const fit = fitView(box);
    expect(followStep(cam, box, fit, input(0, [10, 10]))).toBe(fit);
    const v = followStep(cam, box, { cx: 0, cy: 0, k: 4 }, input(0, [0, -1990]), true);
    expect(v).toEqual(clampView(box, v));
    expect(v.cy).toBeCloseTo(box.y0 + viewBox(box, v).h / 2, 9);
  });
});

/** attachPanZoom on a stand-in element, a 1000 × 500 rect at (100, 50), with pointer events. */
function harness(box: Box, getTarget?: (k: number) => [number, number] | null) {
  const rect: ClientRect = { left: 100, top: 50, width: 1000, height: 500 };
  const on: Record<string, (ev: unknown) => void> = {};
  const el = {
    addEventListener: (t: string, f: (ev: unknown) => void) => (on[t] = f),
    removeEventListener: () => {},
    contains: (x: unknown) => x === el,
    getBoundingClientRect: () => rect,
    classList: { add: () => {}, remove: () => {} },
    hasPointerCapture: () => false,
    setPointerCapture: () => {},
  };
  let view: View = { cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, k: 4 };
  let follow = true;
  attachPanZoom(el as unknown as HTMLElement, { getBox: () => box, getView: () => view, setView: (v) => (view = v), getRect: () => rect, getTarget, follow: (f) => (follow = f) });
  const ptr = (type: string, id: number, x: number, y: number, kind = 'touch') =>
    on[type]({ type, pointerId: id, pointerType: kind, button: 0, isPrimary: id === 1, clientX: x, clientY: y });
  const key = (k: string) => on.keydown({ key: k, altKey: false, ctrlKey: false, metaKey: false, preventDefault: () => {} });
  return {
    el,
    on,
    ptr,
    key,
    view: () => view,
    following: () => follow,
    setFollow: (f: boolean) => (follow = f),
  };
}

describe('follow state: a wheel or pinch zoom keeps it, a pan by hand stops it, the presets resume it, a selection starts it', () => {
  const box: Box = { x0: 0, y0: 0, x1: 1000, y1: 500 };

  it('the rules', () => {
    for (const on of [true, false]) {
      expect(followAfter(on, 'zoom')).toBe(on);
      expect(followAfter(on, 'pan')).toBe(false);
      expect(followAfter(on, 'frame')).toBe(false);
      expect(followAfter(on, 'preset')).toBe(true);
      expect(followAfter(on, 'select')).toBe(true);
    }
  });

  it('wheel and pinch zoom keep the follow; a drag, a double-tap and arrow keys stop it; + / − / 0 resume it', () => {
    const g = globalThis as { document?: unknown };
    const h = harness(box, () => [500, 250]);
    // Ctrl + wheel (a trackpad pinch), and a plain wheel with the map focused.
    h.on.wheel({ deltaY: -50, deltaMode: 0, ctrlKey: true, metaKey: false, clientX: 300, clientY: 200, preventDefault: () => {} });
    g.document = { activeElement: h.el };
    try {
      h.on.wheel({ deltaY: -100, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 300, clientY: 200, preventDefault: () => {} });
    } finally {
      delete g.document;
    }
    expect(h.view().k).toBeGreaterThan(4);
    expect(h.following()).toBe(true);
    // A two-finger pinch.
    const k0 = h.view().k;
    h.ptr('pointerdown', 1, 400, 300);
    h.ptr('pointerdown', 2, 600, 300);
    h.ptr('pointermove', 2, 700, 300);
    h.ptr('pointerup', 2, 700, 300);
    h.ptr('pointerup', 1, 400, 300);
    expect(h.view().k).toBeGreaterThan(k0);
    expect(h.following()).toBe(true);
    // A one-finger drag: off.
    h.ptr('pointerdown', 1, 400, 300);
    h.ptr('pointermove', 1, 450, 320);
    h.ptr('pointerup', 1, 450, 320);
    expect(h.following()).toBe(false);
    // + resumes it, an arrow key stops it, − and 0 resume it.
    h.key('+');
    expect(h.following()).toBe(true);
    h.key('ArrowUp');
    expect(h.following()).toBe(false);
    h.key('-');
    expect(h.following()).toBe(true);
    h.key('ArrowLeft');
    h.key('0');
    expect(h.following()).toBe(true);
    // A double-tap zooms toward the finger: a pan by hand.
    h.key('+');
    h.ptr('pointerdown', 1, 400, 300);
    h.ptr('pointerup', 1, 400, 300);
    h.ptr('pointerdown', 1, 401, 300);
    h.ptr('pointerup', 1, 401, 300);
    expect(h.following()).toBe(false);
  });

  it('a double-tap at 16× goes back to Fit and never resumes the follow', () => {
    const h = harness(box, () => [500, 250]);
    const dbl = () => {
      h.ptr('pointerdown', 1, 400, 300);
      h.ptr('pointerup', 1, 400, 300);
      h.ptr('pointerdown', 1, 401, 300);
      h.ptr('pointerup', 1, 401, 300);
    };
    // + up to the maximum, following.
    for (let i = 0; i < 12; i++) h.key('+');
    expect(h.view().k).toBe(K_MAX);
    expect(h.following()).toBe(true);
    dbl();
    expect(h.view().k).toBe(1);
    expect(h.following()).toBe(false);
    // Off already (an arrow-key pan at 16×): Fit, still off.
    for (let i = 0; i < 16; i++) h.key('+');
    expect(h.view().k).toBe(K_MAX);
    h.key('ArrowUp');
    expect(h.following()).toBe(false);
    dbl();
    expect(h.view().k).toBe(1);
    expect(h.following()).toBe(false);
  });

  it('+ / − center on the target at the new zoom (the look-ahead is a share of that view)', () => {
    const asked: number[] = [];
    const h = harness(box, (k) => {
      asked.push(k);
      return [500, 250];
    });
    h.key('+');
    expect(asked).toEqual([5]);
  });
});

describe('around the gun and the track map on J/105 R1 (USA 527): follow wiring', () => {
  const a = analyzeRace(j105Race(1));
  const ME = 'USA 527';

  function mountOn(state: { me: string | null }) {
    const el = () => {
      const attrs: Record<string, string> = {};
      return { innerHTML: '', textContent: '', value: '', disabled: false, attrs, setAttribute: (k: string, v: string) => (attrs[k] = v) };
    };
    const parts: Record<string, ReturnType<typeof el>> = {};
    const body = { innerHTML: '', querySelector: (sel: string) => (body.innerHTML ? (parts[sel] ??= el()) : null) };
    const on: Record<string, (ev: unknown) => void> = {};
    const root = { open: true, querySelector: () => body, addEventListener: (t: string, f: (ev: unknown) => void) => (on[t] = f) } as unknown as HTMLDetailsElement;
    const lanes = mountLaneSnapshots(root, () => ({ a, me: state.me, group: { kind: 'leaders' } }), () => Promise.resolve([]));
    lanes.refresh();
    return { on, lanes };
  }
  const btn = (attrs: Record<string, string>) => ({ target: { closest: () => ({ dataset: attrs }) } });

  it('Around the gun at 8×, +0:37: the preset frames USA 527 a third of the way in from the trailing edge (upwind)', () => {
    const { on, lanes } = mountOn({ me: ME });
    lanes.cue(37, false);
    on.click(btn({ zoom: '8' }));
    const L = lanes.scrub()!;
    const v = lanes.zoom();
    expect(v.k).toBe(8);
    expect(lanes.following()).toBe(true);
    const input = laneFollowInput(L, ME, 37)!;
    const c = courseStats(input.dirs);
    expect(sailMode(c.dir, input.down)).toBe('upwind');
    expect(v).toEqual(zoomPreset(L.view, 8, laneFollowTarget(L, 37, 8)));
    const vb = viewBox(L.view, v);
    const f = fromTrailing(input.pos, c.dir!, [v.cx, v.cy], vb.w, vb.h);
    expect(f).toBeGreaterThan(0.3);
    expect(f).toBeLessThan(0.36);
    // Stepping on: it stays framed so, the zoom unchanged.
    on.click(btn({ laneStep: '1' }));
    on.click(btn({ laneStep: '1' }));
    const p = laneFollowInput(L, ME, 39)!.pos;
    const now = lanes.zoom();
    expect(now.k).toBe(8);
    expect(fromTrailing(p, c.dir!, [now.cx, now.cy], vb.w, vb.h)).toBeGreaterThan(0.28);
    expect(fromTrailing(p, c.dir!, [now.cx, now.cy], vb.w, vb.h)).toBeLessThan(0.38);
  });

  it('a pan by hand stops it; selecting a boat starts it again and snaps to that boat; a preset resumes it', () => {
    const state = { me: ME as string | null };
    const { on, lanes } = mountOn(state);
    lanes.cue(37, false);
    on.click(btn({ zoom: '8' }));
    lanes.setZoom({ ...lanes.zoom(), cx: lanes.zoom().cx + 30 });
    expect(lanes.following()).toBe(false);
    const held = lanes.zoom();
    on.click(btn({ laneStep: '1' }));
    expect(lanes.zoom()).toEqual(held);
    // Another boat selected (here or on any view): followed, the view on it at once.
    state.me = 'USA 96';
    lanes.refresh();
    expect(lanes.following()).toBe(true);
    const L = lanes.scrub()!;
    expect(lanes.zoom().k).toBe(8);
    const t = laneFollowTarget(L, lanes.second(), 8)!;
    const want = clampView(L.view, { cx: t[0], cy: t[1], k: 8 });
    expect(lanes.zoom().cx).toBeCloseTo(want.cx, 6);
    expect(lanes.zoom().cy).toBeCloseTo(want.cy, 6);
    lanes.setZoom({ ...lanes.zoom(), cy: lanes.zoom().cy + 30 });
    expect(lanes.following()).toBe(false);
    on.click(btn({ zoom: '4' }));
    expect(lanes.following()).toBe(true);
  });

  it('the track map: upwind leads, downwind sits just forward of the center (USA 527 at +8:00 and +28:00)', () => {
    const fit = mapBox(a, null);
    const at = (s: number) => {
      const input = mapFollowInput(a, ME, a.meta.gunMs + s * 1000)!;
      const c = courseStats(input.dirs);
      const vb = viewBox(fit, { cx: 0, cy: 0, k: 8 });
      const t = followTarget(input.pos, input.dirs, input.down, vb.w, vb.h);
      return { mode: sailMode(c.dir, input.down), f: fromTrailing(input.pos, c.dir!, t, vb.w, vb.h), pos: input.pos };
    };
    const up = at(480);
    expect(up.mode).toBe('upwind');
    expect(up.f).toBeGreaterThan(0.3);
    expect(up.f).toBeLessThan(0.35);
    const down = at(1680);
    expect(down.mode).toBe('downwind');
    expect(down.f).toBeGreaterThanOrEqual(0.5);
    expect(down.f).toBeLessThan(0.56);
    // The input's position is the boat drawn by the scrubber.
    const drawn = boatsAt(a, ME, a.meta.gunMs + 480_000).find((b) => b.id === ME)!;
    expect(up.pos).toEqual([drawn.mx, drawn.my]);
    expect(mapFollowInput(a, 'nobody', a.meta.gunMs)).toBeNull();
  });
});

/** Distance, map units, from rect `r` to the hull outline (its points, and along its edges); negative: a point inside the rect. */
function rectToHull(r: { x0: number; y0: number; x1: number; y1: number }, hull: Vec[]): number {
  let best = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const [p, q] = [hull[i], hull[(i + 1) % hull.length]];
    for (let j = 0; j < 10; j++) {
      const x = p[0] + ((q[0] - p[0]) * j) / 10;
      const y = p[1] + ((q[1] - p[1]) * j) / 10;
      const dx = Math.max(r.x0 - x, 0, x - r.x1);
      const dy = Math.max(r.y0 - y, 0, y - r.y1);
      best = Math.min(best, dx === 0 && dy === 0 ? -1 : Math.hypot(dx, dy));
    }
  }
  return best;
}

/** The label's box from its `<text>` (x, baseline y, font size) as both maps size it. */
function textBox(svg: string, cls: string, sail: string): { x0: number; y0: number; x1: number; y1: number } {
  const m = new RegExp(`<text class="${cls}"[^>]* x="([-\\d.]+)" y="([-\\d.]+)" font-size="([-\\d.]+)"[^>]*>${sail}</text>`).exec(svg);
  expect(m).not.toBeNull();
  const [x, y, fs] = [Number(m![1]), Number(m![2]), Number(m![3])];
  return { x0: x, y0: y - 0.85 * fs, x1: x + textWidth(sail, fs), y1: y + 0.25 * fs };
}

/** Labels sit within this many css px of their hull, at any zoom. */
const NEAR_PX = 8;

describe('labels: a few px off the hull at every zoom, on both maps', () => {
  const a: RaceAnalysis = analyzeRace(j105Race(1));
  const ME = 'USA 527';

  it('the box: abeam on the side facing up the screen, never over the hull, the gap exact', () => {
    const dims = { loaM: 10, beamM: 3 };
    for (const deg of [0, 30, 90, 135, -60, 180]) {
      const d = dirOf(deg);
      const hull = hullOutlineAt([0, 0], d, dims);
      for (const side of HULL_LABEL_SIDES) {
        const r = hullLabelBox([0, 0], d, dims, 20, 6, 1, side);
        const gap = rectToHull(r, hull);
        expect(gap).toBeGreaterThan(0.99);
        expect(gap).toBeLessThan(3);
      }
      const r = hullLabelBox([0, 0], d, dims, 20, 6, 1);
      // Abeam: on the side facing up the screen (right when the boat points straight up or down), level with the
      // hull's middle (its corners either side of the abeam line), never off the bow or stern.
      const stbd: Vec = [-d[1], d[0]];
      const up: Vec = stbd[1] < 0 || (stbd[1] === 0 && stbd[0] > 0) ? stbd : [-stbd[0], -stbd[1]];
      const corners: Vec[] = [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]];
      expect(Math.min(...corners.map((q) => q[0] * up[0] + q[1] * up[1]))).toBeGreaterThan(dims.beamM / 2);
      const along = corners.map((q) => q[0] * d[0] + q[1] * d[1]);
      expect(Math.min(...along)).toBeLessThanOrEqual(1e-9);
      expect(Math.max(...along)).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('Around the gun: USA 527’s label within NEAR_PX of its hull at 1×, 4× and 8× (+0:37)', () => {
    const L = laneScrub(a, { me: ME });
    const ppu = lanePxPerUnit(L.view);
    const b = L.frame(37).boats.find((x) => x.id === ME)!;
    const gaps: number[] = [];
    for (const k of [1, 4, 8]) {
      const zoom = zoomPreset(L.view, k, laneFollowTarget(L, 37, k));
      const u = 1 / (ppu * k);
      const html = laneScrubHtml(a, L, undefined, 37, ppu, false, zoom);
      const hull = laneShape(L, b, 1 / u)!;
      expect(hull).not.toBeNull();
      const gap = rectToHull(textBox(html, 'lane-lbl on', ME), hullOutlineAt(b.pos!, hull.dir, hull.dims)) / u;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(NEAR_PX);
      gaps.push(gap);
    }
    // Constant on screen, whatever the zoom.
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(3);
    expect(HULL_LABEL_GAP_PX).toBe(3);
  });

  it('the track map: the selected boat’s label within NEAR_PX of its hull at 1×, 4× and 8× (+8:00)', () => {
    const fit = mapBox(a, null);
    const t = a.meta.gunMs + 480_000;
    const win = trailWindow(t, '30', scrubWindow(a));
    const me = boatsAt(a, ME, t).find((x) => x.id === ME)!;
    const gaps: number[] = [];
    for (const k of [1, 4, 8]) {
      const view = zoomPreset(fit, k, [me.mx, me.my]);
      const { view: vb } = trackMapView(a, null, view);
      const unit = Math.max(vb.x1 - vb.x0, vb.y1 - vb.y0) / 600;
      const dots = scrubFrame(a, ME, null, { view }, { t, win }).dots;
      expect(dots).toContain(`class="dot hull on" data-id="${ME}"`);
      const s = boatShapeOr({ dir: me.dir, hold: me.hold, sog: me.sog, dims: startClass(a)?.dims ?? null, pxPerM: 1 / unit, minPx: BOAT_SHAPE_ON_PX });
      expect('shape' in s).toBe(true);
      if (!('shape' in s)) continue;
      const gap = rectToHull(textBox(dots, 'dot-lbl on', ME), hullOutlineAt([me.mx, me.my], s.shape, s.dims)) / unit;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(NEAR_PX);
      gaps.push(gap);
    }
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(3);
  });
});
