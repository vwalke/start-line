import { describe, expect, it } from 'vitest';
import { clampView, clientToChart, fitView, pan, presetActive, viewBox, zoomAbout, type View } from '../src/ui/view';

// 300 × 200 m fit box shown in a 600 × 400 px element at (10, 20): 2 px per metre at Fit.
const box = { x0: -100, y0: -50, x1: 200, y1: 150 };
const rect = { left: 10, top: 20, width: 600, height: 400 };

/** Client px of chart point (x, y) in view v (inverse of clientToChart, for checks). */
function chartToClient(v: View, x: number, y: number): [number, number] {
  const vb = viewBox(box, v);
  const s = Math.min(rect.width / vb.w, rect.height / vb.h);
  return [rect.left + (rect.width - vb.w * s) / 2 + (x - vb.x0) * s, rect.top + (rect.height - vb.h * s) / 2 + (y - vb.y0) * s];
}

const zoomed = (v: View, f: number, cx: number, cy: number): View => {
  const [px, py] = clientToChart(box, v, rect, cx, cy);
  return clampView(box, zoomAbout(v, f, px, py));
};

describe('view math', () => {
  it('fits the box at k = 1', () => {
    const f = fitView(box);
    expect(f).toEqual({ cx: 50, cy: 50, k: 1 });
    expect(viewBox(box, f)).toEqual({ x0: -100, y0: -50, w: 300, h: 200 });
    expect(viewBox(box, { cx: 0, cy: 0, k: 4 })).toEqual({ x0: -37.5, y0: -25, w: 75, h: 50 });
  });

  it('keeps the anchor fixed on screen and in the chart when not centre-clamped', () => {
    const start = clampView(box, { cx: 40, cy: 60, k: 4 });
    expect(start).toEqual({ cx: 40, cy: 60, k: 4 });
    for (const f of [1.25, 1.5, 2, 3, 0.8]) {
      for (const [x, y] of [
        [310, 220],
        [100, 100],
        [500, 380],
        [12, 22],
      ]) {
        const before = clientToChart(box, start, rect, x, y);
        const raw = zoomAbout(start, f, before[0], before[1]);
        const v = clampView(box, raw);
        if (v.cx !== raw.cx || v.cy !== raw.cy) continue; // centre clamped: see below
        const after = clientToChart(box, v, rect, x, y);
        expect(after[0]).toBeCloseTo(before[0], 9);
        expect(after[1]).toBeCloseTo(before[1], 9);
        const back = chartToClient(v, before[0], before[1]);
        expect(back[0]).toBeCloseTo(x, 9);
        expect(back[1]).toBeCloseTo(y, 9);
      }
    }
  });

  it('exercises at least the unclamped anchor cases', () => {
    // Guard against the loop above silently skipping everything.
    const v = { cx: 40, cy: 60, k: 4 };
    const raw = zoomAbout(v, 2, 30, 55);
    expect(clampView(box, raw)).toEqual(raw);
    expect(raw).toEqual({ cx: 35, cy: 57.5, k: 8 });
  });

  it('near an edge, centre clamping keeps the view inside and the anchor on screen', () => {
    const v0 = clampView(box, { cx: -80, cy: -40, k: 2 }); // pushed in from the top-left corner
    expect(v0).toEqual({ cx: -25, cy: 0, k: 2 });
    // Zoom out about the top-left client corner from 4x near the corner.
    const v = clampView(box, { cx: -60, cy: -20, k: 4 });
    const z = zoomed(v, 0.5, rect.left, rect.top);
    const b = viewBox(box, z);
    expect(b.x0).toBeGreaterThanOrEqual(box.x0 - 1e-9);
    expect(b.y0).toBeGreaterThanOrEqual(box.y0 - 1e-9);
    // The anchor (the box corner) still maps to the same client px.
    const before = clientToChart(box, v, rect, rect.left, rect.top);
    expect(before).toEqual([-97.5, -45]);
    const back = chartToClient(z, before[0], before[1]);
    expect(back[0]).toBeGreaterThanOrEqual(rect.left);
    expect(back[1]).toBeGreaterThanOrEqual(rect.top);
  });

  it('clamps k to [1, 16] and honours the anchor with the clamped factor', () => {
    const v = { cx: 40, cy: 60, k: 10 };
    const z = zoomAbout(v, 4, 42, 61); // wants 40x
    expect(z.k).toBe(16);
    // Effective factor 1.6: c' = p + (c - p) / 1.6.
    expect(z.cx).toBeCloseTo(42 + (40 - 42) / 1.6, 12);
    expect(z.cy).toBeCloseTo(61 + (60 - 61) / 1.6, 12);
    const before = chartToClient(clampView(box, v), 42, 61);
    const after = chartToClient(clampView(box, z), 42, 61);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(zoomAbout({ cx: 0, cy: 0, k: 1.5 }, 0.1, 5, 5).k).toBe(1);
    expect(clampView(box, { cx: 50, cy: 50, k: 100 }).k).toBe(16);
    expect(clampView(box, { cx: 50, cy: 50, k: 0.2 }).k).toBe(1);
    expect(zoomAbout({ cx: 0, cy: 0, k: 16 }, 2, 5, 5)).toEqual({ cx: 0, cy: 0, k: 16 });
  });

  it('clamps the centre so the view stays inside the box', () => {
    for (const k of [1.01, 2, 3.1, 8, 16]) {
      for (const [cx, cy] of [
        [-1e4, -1e4],
        [1e4, 1e4],
        [-1e4, 1e4],
        [50, 50],
        [199, -49],
      ]) {
        const b = viewBox(box, clampView(box, { cx, cy, k }));
        expect(b.x0).toBeGreaterThanOrEqual(box.x0 - 1e-9);
        expect(b.y0).toBeGreaterThanOrEqual(box.y0 - 1e-9);
        expect(b.x0 + b.w).toBeLessThanOrEqual(box.x1 + 1e-9);
        expect(b.y0 + b.h).toBeLessThanOrEqual(box.y1 + 1e-9);
      }
    }
    expect(clampView(box, pan({ cx: 50, cy: 50, k: 2 }, 1000, 0))).toEqual({ cx: 125, cy: 50, k: 2 });
  });

  it('forces the fit centre at k = 1', () => {
    expect(clampView(box, { cx: 120, cy: -30, k: 1 })).toEqual(fitView(box));
    expect(clampView(box, { cx: 120, cy: -30, k: 0.5 })).toEqual(fitView(box));
    expect(clampView(box, zoomAbout({ cx: 100, cy: 0, k: 2 }, 0.5, 190, 140))).toEqual(fitView(box));
  });

  it('marks presets active only on an exact match', () => {
    const f = fitView(box);
    expect(presetActive(box, f, 1)).toBe(true);
    expect(presetActive(box, { ...f, cx: f.cx + 1e-7 }, 1)).toBe(true);
    expect(presetActive(box, { ...f, cx: f.cx + 1e-3 }, 1)).toBe(false);
    expect(presetActive(box, { ...f, k: 1.001 }, 1)).toBe(false);
    expect(presetActive(box, { cx: 0, cy: 0, k: 2 }, 2)).toBe(true);
    expect(presetActive(box, { cx: 0, cy: 0, k: 2 + 1e-7 }, 2)).toBe(true);
    const pinched = { cx: 10, cy: 20, k: 3.1 };
    expect([1, 2, 4, 8].map((p) => presetActive(box, pinched, p))).toEqual([false, false, false, false]);
    expect(presetActive(box, { cx: 0, cy: 0, k: 4 }, 2)).toBe(false);
    expect(presetActive(box, { cx: 0, cy: 0, k: 8 }, 8)).toBe(true);
  });

  it('maps client px to chart units with letterboxing', () => {
    const f = fitView(box);
    // Exact fit: 2 px per metre, no bars.
    expect(clientToChart(box, f, rect, 10, 20)).toEqual([-100, -50]);
    expect(clientToChart(box, f, rect, 610, 420)).toEqual([200, 150]);
    // Too wide: 1000 × 400 → 2 px/m, 200 px bars left and right.
    const wide = { left: 0, top: 0, width: 1000, height: 400 };
    expect(clientToChart(box, f, wide, 200, 0)).toEqual([-100, -50]);
    expect(clientToChart(box, f, wide, 500, 200)).toEqual([50, 50]);
    expect(clientToChart(box, f, wide, 800, 400)).toEqual([200, 150]);
    // Too tall: 300 × 600 → 1 px/m, 200 px bars top and bottom.
    const tall = { left: 0, top: 0, width: 300, height: 600 };
    expect(clientToChart(box, f, tall, 0, 200)).toEqual([-100, -50]);
    expect(clientToChart(box, f, tall, 300, 400)).toEqual([200, 150]);
    // Zoomed 4x: 8 px per metre around the centre.
    const v = { cx: 40, cy: 60, k: 4 };
    expect(clientToChart(box, v, wide, 500, 200)).toEqual([40, 60]);
    expect(clientToChart(box, v, wide, 508, 216)).toEqual([41, 62]);
  });
});
