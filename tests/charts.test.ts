import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { Vec } from '../src/analysis/geo';
import { classDims } from '../src/data/classes';
import { hullOutline, hullPathD, rotator, startFitBox, startHullScale, startSnapshot } from '../src/ui/charts';
import { clampView, fitView, type View } from '../src/ui/view';
import { fixtureRace } from './helpers';

const analysis = analyzeRace(fixtureRace());

describe('class dimensions', () => {
  it('normalizes class names', () => {
    for (const n of ['J/70', 'J70', 'j-70', ' j 70 ']) expect(classDims(n)).toEqual({ loaM: 6.934, beamM: 2.249 });
    expect(classDims('Laser')).toEqual(classDims('ILCA'));
    expect(classDims('Melges 24')?.loaM).toBe(7.31);
  });

  it('returns null for unknown classes', () => {
    expect(classDims('Optimist')).toBeNull();
    expect(classDims('')).toBeNull();
  });
});

const box = startFitBox(analysis);
const fit = fitView(box);
const at = (k: number): View => clampView(box, { ...fit, k });
const vb = (svg: string): number[] => /viewBox="([^"]+)"/.exec(svg)![1].split(' ').map(Number);

describe('start chart view', () => {
  it('draws the fit box by default and the clamped view otherwise', () => {
    vb(startSnapshot(analysis, null)).forEach((n, i) => expect(n).toBeCloseTo([box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0][i], 9));
    const [x0, y0, w, h] = vb(startSnapshot(analysis, null, at(4)));
    expect(w).toBeCloseTo((box.x1 - box.x0) / 4, 9);
    expect(h).toBeCloseTo((box.y1 - box.y0) / 4, 9);
    expect(x0 + w / 2).toBeCloseTo(fit.cx, 9);
    expect(y0 + h / 2).toBeCloseTo(fit.cy, 9);
    // Out-of-range views are clamped into the box.
    const [cx0, cy0, cw, ch] = vb(startSnapshot(analysis, null, { cx: box.x1 + 500, cy: box.y0 - 500, k: 99 }));
    expect(cw).toBeCloseTo((box.x1 - box.x0) / 16, 9);
    expect(cx0 + cw).toBeCloseTo(box.x1, 9);
    expect(cy0).toBeCloseTo(box.y0, 9);
    expect(ch).toBeGreaterThan(0);
  });

  it('centres an 8x view on a boat bow and draws its hull from the bow', () => {
    const rot = rotator(analysis.wind.twdAtGunDeg);
    const d = analysis.drawings.find((x) => x.bow && x.headingAtSample != null)!;
    const [bx, by] = rot(d.bow!);
    const v = clampView(box, { cx: bx, cy: by, k: 8 });
    expect(v).toEqual({ cx: bx, cy: by, k: 8 });
    const svg = startSnapshot(analysis, d.id, v);
    const [x0, y0, w, h] = vb(svg);
    expect(x0 + w / 2).toBeCloseTo(bx, 6);
    expect(y0 + h / 2).toBeCloseTo(by, 6);
    const g = new RegExp(`data-id="${d.id}"[\\s\\S]*?<path class="hull" d="M(-?[\\d.]+),(-?[\\d.]+)`).exec(svg)!;
    expect(+g[1]).toBeCloseTo(bx, 1);
    expect(+g[2]).toBeCloseTo(by, 1);
  });
});

describe('start chart hulls', () => {
  it('draws J/70 hulls to scale at 8x with the bow tip on the DTL bow', () => {
    expect(startHullScale(analysis, at(8))?.loaM).toBe(6.934);
    const svg = startSnapshot(analysis, null, at(8));
    const ds = [...svg.matchAll(/<path class="hull" d="([^"]+)"/g)].map((m) => m[1]);
    expect(ds).toHaveLength(analysis.drawings.length);
    expect(ds.every((d) => d.includes('C') && d.includes('L') && d.endsWith('Z'))).toBe(true);
    expect(svg).not.toContain('boat-min');
    const rot = rotator(analysis.wind.twdAtGunDeg);
    const bows = analysis.drawings.map((d) => rot(d.bow!));
    for (const d of ds) {
      const m = /^M(-?[\d.]+),(-?[\d.]+)/.exec(d)!;
      const match = bows.find(([x, y]) => Math.abs(x - +m[1]) < 0.01 && Math.abs(y - +m[2]) < 0.01);
      expect(match).toBeDefined();
    }
    const sample = analysis.drawings.find((d) => d.bow && d.headingAtSample != null)!;
    const outline = hullOutline(sample.bow!, sample.headingAtSample!, { loaM: 6.934, beamM: 2.249 });
    const t = outline.length >> 1;
    const aft = [(outline[t][0] + outline[t + 1][0]) / 2, (outline[t][1] + outline[t + 1][1]) / 2];
    expect(Math.hypot(aft[0] - outline[0][0], aft[1] - outline[0][1])).toBeCloseTo(6.934, 1);
  });

  it('splines each side and keeps a straight transom', () => {
    const outline = hullOutline([0, 0], 0, { loaM: 10, beamM: 4 });
    const t = outline.length >> 1;
    const d = hullPathD(outline);
    expect(d.startsWith(`M${outline[0][0].toFixed(2)},${outline[0][1].toFixed(2)}`)).toBe(true);
    expect(d).toContain(`L${outline[t + 1][0].toFixed(2)},${outline[t + 1][1].toFixed(2)}`);
    expect(d).toMatch(/C-?[\d.]+,-?[\d.]+ /);
  });

  it('falls back to the min-size marker when hulls would be under 6 px', () => {
    const far = { ...analysis, drawings: analysis.drawings.map((d, i) => (i ? d : { ...d, bow: [d.bow![0] + 3000, d.bow![1]] as Vec })) };
    expect(startHullScale(far)).toBeNull();
    const svg = startSnapshot(far, null);
    expect(svg).toContain('boat-min');
    expect(svg).not.toContain('class="hull"');
    // Zooming in far enough brings the hulls back.
    const farBox = startFitBox(far);
    const zoomed = clampView(farBox, { ...fitView(farBox), k: 16 });
    expect(startHullScale(far, zoomed)?.loaM).toBe(6.934);
    expect(startSnapshot(far, null, zoomed)).toContain('class="hull"');
  });

  it('keeps the plain marker for unknown classes', () => {
    const meta = { ...analysis.meta, boatClass: 'Mystery', division: 'Mystery' };
    const svg = startSnapshot({ ...analysis, meta }, null, at(8));
    expect(svg).not.toContain('class="hull"');
    expect(svg).not.toContain('boat-min');
  });
});
