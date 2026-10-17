import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { Vec } from '../src/analysis/geo';
import { classDims } from '../src/data/classes';
import { hullOutline, hullPathD, rotator, startHullScale, startSnapshot, zoomCentre } from '../src/ui/charts';
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

describe('zoom centre', () => {
  const L: Vec = [-50, 0];
  const R: Vec = [50, 0];
  const bows: Vec[] = [
    [-20, 10],
    [0, 12],
    [30, 8],
  ];

  it('centres on the focused bow', () => {
    expect(zoomCentre(bows, L, R, [7, 9], 20, 15)).toEqual([7, 9]);
  });

  it('centres between the median bow and its foot on the line when both fit', () => {
    expect(zoomCentre(bows, L, R, null, 40, 30)).toEqual([0, 5]);
  });

  it('falls back to the median bow when the line would not fit', () => {
    expect(zoomCentre(bows, L, R, null, 20, 8)).toEqual([0, 10]);
  });

  it('clamps the foot-point to the line ends', () => {
    expect(zoomCentre([[80, 10]], L, R, null, 100, 100)).toEqual([65, 5]);
  });

  it('keeps the fleet in view at 8x on the demo race', () => {
    const svg = startSnapshot(analysis, null, 8);
    const [x0, y0, w, h] = /viewBox="([^"]+)"/.exec(svg)![1].split(' ').map(Number);
    const rot = rotator(analysis.wind.twdAtGunDeg);
    const inView = analysis.drawings.map((d) => rot(d.bow!)).filter(([x, y]) => x > x0 && x < x0 + w && y > y0 && y < y0 + h);
    expect(inView.length).toBeGreaterThan(0);
    // A highlighted boat is always in the middle.
    const d = analysis.drawings[analysis.drawings.length - 1];
    const [hx0, hy0, hw, hh] = /viewBox="([^"]+)"/.exec(startSnapshot(analysis, d.id, 8))![1].split(' ').map(Number);
    const [bx, by] = rot(d.bow!);
    expect(hx0 + hw / 2).toBeCloseTo(bx, 6);
    expect(hy0 + hh / 2).toBeCloseTo(by, 6);
  });
});

describe('start chart hulls', () => {
  it('draws J/70 hulls to scale at 8x with the bow tip on the DTL bow', () => {
    expect(startHullScale(analysis, 8)?.loaM).toBe(6.934);
    const svg = startSnapshot(analysis, null, 8);
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
    expect(startHullScale(far, 1)).toBeNull();
    const svg = startSnapshot(far, null, 1);
    expect(svg).toContain('boat-min');
    expect(svg).not.toContain('class="hull"');
  });

  it('keeps the plain marker for unknown classes', () => {
    const meta = { ...analysis.meta, boatClass: 'Mystery', division: 'Mystery' };
    const svg = startSnapshot({ ...analysis, meta }, null, 8);
    expect(svg).not.toContain('class="hull"');
    expect(svg).not.toContain('boat-min');
  });
});
