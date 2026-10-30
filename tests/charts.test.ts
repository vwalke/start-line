import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import type { Vec } from '../src/analysis/geo';
import { classDims, matchClass } from '../src/data/classes';
import { BOAT_SHAPE_PX, scaleNoteText } from '../src/ui/boatShape';
import { hullOutline, hullPathD, rotator, startClass, startFitBox, startPxPerM, startScale, startSnapshot } from '../src/ui/charts';
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

  it('knows the Cape 31 by every name the feeds use', () => {
    for (const n of ['Cape 31', 'Cape31', 'C31', 'C 31', 'cape-31']) expect(classDims(n)).toEqual({ loaM: 9.55, beamM: 3.05 });
  });

  it('matches the first known name, in order, and says which', () => {
    expect(matchClass(['Mystery', 'C31', 'J/70'])).toEqual({ name: 'C31', dims: { loaM: 9.55, beamM: 3.05 } });
    expect(matchClass([undefined, '', 'Mystery'])).toBeNull();
  });
});

describe('start chart class and scale caption', () => {
  it('looks up boat class, then division, then the event class label', () => {
    const m = analysis.meta;
    expect(startClass({ ...analysis, meta: { ...m, boatClass: 'Cape 31', division: 'J70' } })?.name).toBe('Cape 31');
    expect(startClass({ ...analysis, meta: { ...m, boatClass: 'Mystery', division: 'J70' } })?.name).toBe('J70');
    expect(startClass({ ...analysis, meta: { ...m, boatClass: 'Mystery', division: 'Gold', classLabel: 'C31' } })?.dims.loaM).toBe(9.55);
    expect(startClass({ ...analysis, meta: { ...m, boatClass: 'Mystery', division: 'Gold' } })).toBeNull();
  });

  it('chips how much bigger than scale the hulls are drawn, and names the class, LOA and smallest size in the ⓘ', () => {
    const frame = narrow;
    const ppm = startPxPerM(analysis, undefined, undefined, frame);
    expect(6.934 * ppm).toBeCloseTo(BOAT_SHAPE_PX / 3, 6);
    const s = startScale(analysis, undefined, undefined, frame);
    expect(s.chip).toBe(scaleNoteText({ loaM: 6.934, beamM: 2.249 }, ppm));
    expect(s.chip).toBe('Boats drawn about 3× actual size');
    expect(s.info).toBe(`Hulls: J/70, 6.93 m LOA, along heading; at least ${BOAT_SHAPE_PX} px long to stay readable.`);
  });

  it('no chip once the hulls are to scale on screen (this fixture at Fit; zoomed in on a wide chart)', () => {
    expect(6.934 * startPxPerM(analysis)).toBeGreaterThanOrEqual(BOAT_SHAPE_PX);
    expect(startScale(analysis).chip).toBeNull();
    const viewW = (box.x1 - box.x0) / 8;
    const widthPx = Math.ceil((1.1 * BOAT_SHAPE_PX * viewW) / 6.934);
    expect(6.934 * startPxPerM(analysis, at(8), widthPx)).toBeGreaterThanOrEqual(BOAT_SHAPE_PX);
    expect(startScale(analysis, at(8), widthPx).chip).toBeNull();
  });

  it('measures in the chart’s real width on screen, with 600 px as the fallback', () => {
    const viewW = box.x1 - box.x0;
    expect(startPxPerM(analysis)).toBeCloseTo(600 / viewW, 9);
    const wide = startFitBox(analysis, 900);
    expect(startPxPerM(analysis, undefined, 900)).toBeCloseTo(900 / (wide.x1 - wide.x0), 9);
  });

  it('says so when the class has no dimensions', () => {
    const meta = { ...analysis.meta, boatClass: 'Mystery', division: 'Mystery' };
    expect(startScale({ ...analysis, meta })).toEqual({ chip: 'hulls not to scale', info: 'No dimensions for class "Mystery"; arrows follow course over ground.' });
  });

  it('a chart only 20 px wide: hulls far past scale, said in whole numbers', () => {
    const frame = { box: startFitBox(analysis), refPx: 20 };
    expect(startScale(analysis, undefined, undefined, frame).chip).toMatch(/^Boats drawn about \d+× actual size$/);
  });
});

const box = startFitBox(analysis);
/** The Fit box drawn so narrow that a J/70 is a third of the hulls' smallest size on screen. */
const narrow = { box, refPx: ((BOAT_SHAPE_PX / 3) * (box.x1 - box.x0)) / 6.934 };
/** Each hull's length as drawn, chart units: its bow (the path's start) to the middle of its transom (either side of its one L). */
const hullLens = (svg: string): Map<string, number> => {
  const out = new Map<string, number>();
  for (const m of svg.matchAll(/data-id="([^"]+)">[\s\S]*?<path class="hull[^"]*" d="([^"]+)"/g)) {
    const num = (t: string): number[] => [...t.matchAll(/-?[\d.]+/g)].map((x) => Number(x[0]));
    const [before, after] = m[2].split('L');
    const bow = num(m[2]).slice(0, 2);
    const p = num(before).slice(-2);
    const q = num(after).slice(0, 2);
    out.set(m[1], Math.hypot((p[0] + q[0]) / 2 - bow[0], (p[1] + q[1]) / 2 - bow[1]));
  }
  return out;
};
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
  it('draws J/70 hulls at 8x with the bow tip on the DTL bow', () => {
    const svg = startSnapshot(analysis, null, at(8));
    const ds = [...svg.matchAll(/<path class="hull" d="([^"]+)"/g)].map((m) => m[1]);
    expect(ds).toHaveLength(analysis.drawings.length);
    expect(ds.every((d) => d.includes('C') && d.includes('L') && d.endsWith('Z'))).toBe(true);
    expect(svg).not.toContain('<polygon');
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

  it('at Fit, hulls (never arrows) stretched to BOAT_SHAPE_PX on screen while a J/70 is shorter, bow tip on the DTL bow; to scale once longer', () => {
    // At Fit drawn narrow (a J/70 a third of the smallest size), then this fixture's own Fit (to scale).
    for (const frame of [narrow, undefined]) {
      const ppm = startPxPerM(analysis, undefined, undefined, frame);
      const svg = startSnapshot(analysis, null, undefined, 'boat', { frame });
      expect(svg).not.toContain('<polygon');
      const lens = hullLens(svg);
      expect(lens.size).toBe(analysis.drawings.length);
      for (const len of lens.values()) expect(len * ppm).toBeCloseTo(Math.max(BOAT_SHAPE_PX, 6.934 * ppm), 1);
    }
    // A frame far bigger than the fleet: still hulls, at the smallest size.
    const huge = { x0: box.x0 - 2000, y0: box.y0 - 2000, x1: box.x1 + 2000, y1: box.y1 + 2000 };
    const frame = { box: huge, refPx: 600 };
    const svg = startSnapshot(analysis, null, fitView(huge), 'boat', { frame });
    expect(svg).not.toContain('<polygon');
    for (const len of hullLens(svg).values()) expect(len * startPxPerM(analysis, fitView(huge), undefined, frame)).toBeCloseTo(BOAT_SHAPE_PX, 1);
    // Zoomed in until a J/70 is longer than the smallest size: to scale.
    const viewW = (box.x1 - box.x0) / 8;
    const widthPx = Math.ceil((1.1 * BOAT_SHAPE_PX * viewW) / 6.934);
    for (const len of hullLens(startSnapshot(analysis, null, at(8), 'boat', { widthPx })).values()) expect(len).toBeCloseTo(6.934, 1);
  });

  it('the selected boat the same size as the rest, stretched at Fit and to scale zoomed in, drawn on top', () => {
    const id = analysis.drawings.find((d) => d.bow)!.id;
    for (const [v, frame] of [[undefined, narrow], [at(8), undefined]] as const) {
      const plain = hullLens(startSnapshot(analysis, null, v, 'boat', { frame }));
      const sel = startSnapshot(analysis, id, v, 'boat', { frame });
      const lens = hullLens(sel);
      expect(lens.get(id)).toBeCloseTo(plain.get(id)!, 6);
      for (const len of lens.values()) expect(len).toBeCloseTo(lens.get(id)!, 1);
      expect(sel.lastIndexOf('<g class="boat')).toBe(sel.search(new RegExp(`<g class="boat[^"]*" data-id="${id}"`)));
    }
  });

  it('does not let one boat kilometres from the line stretch the Fit', () => {
    const base = startFitBox(analysis);
    const farId = analysis.drawings.find((d) => d.bow)!.id;
    const far = {
      ...analysis,
      boats: analysis.boats.map((b) => (b.id === farId && b.start ? { ...b, start: { ...b.start, awayFromLine: true, startPlace: null } } : b)),
      drawings: analysis.drawings.map((d) => (d.id === farId && d.bow ? { ...d, bow: [d.bow[0] + 3000, d.bow[1]] as Vec } : d)),
    };
    const box = startFitBox(far);
    expect(Math.max(box.x1 - box.x0, box.y1 - box.y0)).toBeLessThan(Math.max(base.x1 - base.x0, base.y1 - base.y0) + 80);
    expect(Math.max(box.x1 - box.x0, box.y1 - box.y0)).toBeLessThan(800);
  });

  it('keeps the arrow along the course for unknown classes, at Fit and zoomed in', () => {
    const meta = { ...analysis.meta, boatClass: 'Mystery', division: 'Mystery' };
    for (const v of [undefined, at(8)]) {
      const svg = startSnapshot({ ...analysis, meta }, null, v);
      expect(svg).not.toContain('class="hull"');
      expect(svg.match(/<polygon/g)?.length).toBe(analysis.drawings.filter((d) => d.bow && d.courseAtGun != null).length);
    }
  });
});
