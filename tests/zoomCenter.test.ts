import { afterEach, describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { BOAT_SHAPE_MIN_PX } from '../src/ui/boatShape';
import { boatsAt, mapBox, scrubFrame, startClass, trackMapView } from '../src/ui/charts';
import { attachPanZoom, type PanZoomOptions } from '../src/ui/panzoom';
import { scrubWindow, trailWindow } from '../src/ui/scrub';
import {
  K_MAX,
  boatsZoomTarget,
  clientToChart,
  fitView,
  viewBox,
  wheelFactor,
  zoomPreset,
  zoomTarget,
  type Box,
  type ClientRect,
  type View,
} from '../src/ui/view';
import { cascaisRace } from './helpers';

/**
 * Map zoom (view.ts, panzoom.ts), shared by Around the gun and the track map: the presets and + / − centre on the
 * selected boat, else the fleet, else the map's centre; the wheel and pinch zoom toward the pointer; zoomed in, a
 * look-ahead follow (follow.ts) keeps the selected boat framed.
 */
const box: Box = { x0: 0, y0: 0, x1: 1000, y1: 500 };
const centre = (v: View): [number, number] => [v.cx, v.cy];

describe('zoom target: the selected boat, else the fleet, else the map centre', () => {
  it('the selected boat’s position when it has one', () => {
    expect(zoomTarget([120, 40], [[0, 0], [900, 400]])).toEqual([120, 40]);
  });

  it('no selection, or the selection unplaced (a gap): the middle of the fleet’s bounding box', () => {
    expect(zoomTarget(null, [[100, 50], [300, 450], [200, 100]])).toEqual([200, 250]);
    expect(zoomTarget(undefined, [[10, 20]])).toEqual([10, 20]);
    expect(zoomTarget([NaN, 3], [[100, 100], [200, 300]])).toEqual([150, 200]);
    // By id: the selected boat with no position now falls back to the others.
    const boats = [
      { id: 'A', p: [100, 100] as [number, number] },
      { id: 'B', p: null },
      { id: 'C', p: [300, 200] as [number, number] },
    ];
    expect(boatsZoomTarget(boats, 'A', (b) => b.p)).toEqual([100, 100]);
    expect(boatsZoomTarget(boats, 'B', (b) => b.p)).toEqual([200, 150]);
    expect(boatsZoomTarget(boats, null, (b) => b.p)).toEqual([200, 150]);
  });

  it('nobody placed: null, and the preset goes to the map’s centre', () => {
    expect(zoomTarget(null, [])).toBeNull();
    expect(boatsZoomTarget([{ id: 'A' }], 'A', () => null)).toBeNull();
    expect(zoomPreset(box, 4, null)).toEqual({ cx: 500, cy: 250, k: 4 });
  });
});

describe('zoom presets: the target at the view centre', () => {
  it('puts the target at the centre of the view, at the zoom asked for', () => {
    for (const k of [2, 4, 8]) {
      const v = zoomPreset(box, k, [400, 300]);
      expect(v).toEqual({ cx: 400, cy: 300, k });
      const vb = viewBox(box, v);
      expect(vb.x0 + vb.w / 2).toBeCloseTo(400, 9);
      expect(vb.y0 + vb.h / 2).toBeCloseTo(300, 9);
    }
  });

  it('near the map’s edge, clamped so the view stays on the map (the target still in view)', () => {
    const v = zoomPreset(box, 4, [10, 490]);
    const vb = viewBox(box, v);
    expect(vb.x0).toBeCloseTo(0, 9);
    expect(vb.y0 + vb.h).toBeCloseTo(500, 9);
    expect(10).toBeGreaterThanOrEqual(vb.x0);
    expect(490).toBeLessThanOrEqual(vb.y0 + vb.h);
  });

  it('Fit (and anything ≤ 1×) is the whole default extent', () => {
    expect(zoomPreset(box, 1, [10, 10])).toEqual(fitView(box));
    expect(zoomPreset(box, 0.8, null)).toEqual(fitView(box));
  });
});

describe('wheel zoom', () => {
  it('a mouse notch (100 px) is about 1.15×; a trackpad pinch (Ctrl) finer per px; lines and pages made px; at most 2× a step', () => {
    expect(wheelFactor(-100, 0, false)).toBeCloseTo(2 ** 0.2, 9);
    expect(wheelFactor(100, 0, false)).toBeCloseTo(2 ** -0.2, 9);
    expect(wheelFactor(-3, 1, false)).toBeCloseTo(wheelFactor(-48, 0, false), 9);
    expect(wheelFactor(-5, 0, true)).toBeCloseTo(Math.exp(0.05), 9);
    expect(wheelFactor(-1, 2, false)).toBeCloseTo(2 ** 0.8, 9);
    expect(wheelFactor(-2, 2, false)).toBe(2);
    expect(wheelFactor(1000, 0, true)).toBe(0.5);
    expect(wheelFactor(NaN, 0, false)).toBe(1);
  });
});

/** attachPanZoom on a stand-in element: its listeners kept, a 1000 × 500 rect at (100, 50). */
function harness(extra: Partial<PanZoomOptions> = {}) {
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
  let view = fitView(box);
  const follows: boolean[] = [];
  attachPanZoom(el as unknown as HTMLElement, {
    getBox: () => box,
    getView: () => view,
    setView: (v) => (view = v),
    getRect: () => rect,
    follow: (f) => follows.push(f),
    ...extra,
  });
  const wheel = (o: { x: number; y: number; dy: number; ctrl?: boolean }) => {
    let prevented = false;
    on.wheel({ deltaY: o.dy, deltaMode: 0, ctrlKey: !!o.ctrl, metaKey: false, clientX: o.x, clientY: o.y, preventDefault: () => (prevented = true) });
    return prevented;
  };
  const key = (k: string) => {
    let prevented = false;
    on.keydown({ key: k, altKey: false, ctrlKey: false, metaKey: false, preventDefault: () => (prevented = true) });
    return prevented;
  };
  return { el, rect, wheel, key, follows, view: () => view, set: (v: View) => (view = v) };
}

describe('panzoom: wheel and pinch toward the pointer', () => {
  const g = globalThis as { document?: unknown };
  afterEach(() => {
    delete g.document;
  });

  it('Ctrl / ⌘ + wheel (a trackpad pinch) zooms, keeping the point under the cursor fixed', () => {
    const h = harness();
    const at = { x: 400, y: 250 };
    const before = clientToChart(box, h.view(), h.rect, at.x, at.y);
    expect(h.wheel({ ...at, dy: -40, ctrl: true })).toBe(true);
    expect(h.view().k).toBeCloseTo(Math.exp(0.4), 9);
    expect(clientToChart(box, h.view(), h.rect, at.x, at.y)[0]).toBeCloseTo(before[0], 6);
    expect(clientToChart(box, h.view(), h.rect, at.x, at.y)[1]).toBeCloseTo(before[1], 6);
    // Again, from the zoomed view: the same point stays put.
    const p = clientToChart(box, h.view(), h.rect, 700, 300);
    h.wheel({ x: 700, y: 300, dy: -100, ctrl: true });
    const q = clientToChart(box, h.view(), h.rect, 700, 300);
    expect(q[0]).toBeCloseTo(p[0], 6);
    expect(q[1]).toBeCloseTo(p[1], 6);
    // A wheel zoom keeps the follow (only a pan by hand stops it).
    expect(h.follows).toEqual([]);
  });

  it('a plain wheel scrolls the page unless the map has focus; focused, it zooms toward the cursor', () => {
    const h = harness();
    g.document = { activeElement: null };
    expect(h.wheel({ x: 400, y: 250, dy: -100 })).toBe(false);
    expect(h.view()).toEqual(fitView(box));
    g.document = { activeElement: h.el };
    const before = clientToChart(box, h.view(), h.rect, 400, 250);
    expect(h.wheel({ x: 400, y: 250, dy: -100 })).toBe(true);
    expect(h.view().k).toBeCloseTo(2 ** 0.2, 9);
    const after = clientToChart(box, h.view(), h.rect, 400, 250);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
  });

  it('focused, a plain wheel past Fit or the maximum is left to the page; clamped to the zoom limits', () => {
    const h = harness();
    g.document = { activeElement: h.el };
    expect(h.wheel({ x: 400, y: 250, dy: 100 })).toBe(false);
    for (let i = 0; i < 40; i++) h.wheel({ x: 400, y: 250, dy: -100 });
    expect(h.view().k).toBe(K_MAX);
    expect(h.wheel({ x: 400, y: 250, dy: -100 })).toBe(false);
    // Ctrl + wheel at the limit still keeps the browser's page zoom off.
    expect(h.wheel({ x: 400, y: 250, dy: -100, ctrl: true })).toBe(true);
    expect(h.view().k).toBe(K_MAX);
  });
});

describe('panzoom: + / − follow the presets’ centring; 0 is Fit', () => {
  it('+ and − centre on the target, resuming the follow; 0 resets to Fit', () => {
    const h = harness({ getTarget: () => [800, 100] });
    expect(h.key('+')).toBe(true);
    expect(h.view()).toEqual(zoomPreset(box, 1.25, [800, 100]));
    h.key('+');
    h.key('+');
    expect(h.view().k).toBeCloseTo(1.25 ** 3, 9);
    expect(centre(h.view())).toEqual(centre(zoomPreset(box, 1.25 ** 3, [800, 100])));
    h.key('-');
    expect(h.view().k).toBeCloseTo(1.25 ** 2, 9);
    expect(h.follows.every(Boolean)).toBe(true);
    expect(h.key('0')).toBe(true);
    expect(h.view()).toEqual(fitView(box));
  });

  it('with the target null (nobody placed): the map’s centre; without getTarget (the start chart): the view’s centre', () => {
    const h = harness({ getTarget: () => null });
    h.set({ cx: 300, cy: 200, k: 2 });
    h.key('+');
    expect(centre(h.view())).toEqual([500, 250]);
    const s = harness();
    s.set({ cx: 300, cy: 200, k: 2 });
    s.key('+');
    expect(centre(s.view())).toEqual([300, 200]);
  });

  it('arrow keys pan by hand: the follow stops', () => {
    const h = harness({ getTarget: () => [500, 250] });
    h.key('+');
    h.key('ArrowLeft');
    expect(h.follows).toEqual([true, false]);
  });
});

describe('the track map (Cascais R3, J/70s): the zoom target from the scrubber’s boats; dots become hulls zoomed in', () => {
  const a = analyzeRace(cascaisRace('r3'));
  const fit = mapBox(a, null);
  const t = a.meta.gunMs + 120_000;
  const win = trailWindow(t, '30', scrubWindow(a));
  const boats = boatsAt(a, null, t);
  const me = boats.find((b) => b.dir && !b.hold && b.sog > 2)!;

  it('centres on the selected boat at the scrubber’s time, else on the fleet then', () => {
    const f = scrubFrame(a, me.id, null, {}, { t, win });
    const target = boatsZoomTarget(f.boats, me.id, (b) => [b.mx, b.my]);
    expect(target).toEqual([me.mx, me.my]);
    const v = zoomPreset(fit, 4, target);
    expect(v.k).toBe(4);
    const vb = viewBox(fit, v);
    expect(me.mx).toBeGreaterThan(vb.x0);
    expect(me.mx).toBeLessThan(vb.x0 + vb.w);
    expect(me.my).toBeGreaterThan(vb.y0);
    expect(me.my).toBeLessThan(vb.y0 + vb.h);
    // No selection: the fleet's middle, not the map's.
    const fleet = boatsZoomTarget(f.boats, null, (b) => [b.mx, b.my])!;
    const xs = f.boats.map((b) => b.mx);
    expect(fleet[0]).toBeCloseTo((Math.min(...xs) + Math.max(...xs)) / 2, 6);
    expect(fleet).not.toEqual([(fit.x0 + fit.x1) / 2, (fit.y0 + fit.y1) / 2]);
    // Fit: the race map's own fit.
    expect(zoomPreset(fit, 1, target)).toEqual(fitView(fit));
  });

  it('a J/70 is a dot at Fit (under 1.5 px to scale), a hull once zoomed in on it, a dot again back at Fit', () => {
    const dims = startClass(a)!.dims;
    const unitAt = (view?: View): number => {
      const { view: b } = trackMapView(a, null, view);
      return Math.max(b.x1 - b.x0, b.y1 - b.y0) / 600;
    };
    expect(dims.loaM / unitAt()).toBeLessThan(BOAT_SHAPE_MIN_PX);
    const isHull = (view?: View): boolean => new RegExp(`<path class="dot hull[^"]*" data-id="${me.id}"`).test(scrubFrame(a, me.id, null, { view }, { t, win }).dots);
    expect(isHull()).toBe(false);
    const zoomed = zoomPreset(fit, 8, [me.mx, me.my]);
    expect(dims.loaM / unitAt(zoomed)).toBeGreaterThanOrEqual(BOAT_SHAPE_MIN_PX);
    expect(isHull(zoomed)).toBe(true);
    expect(isHull(fitView(fit))).toBe(false);
  });
});
