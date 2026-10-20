import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { ROTATE_ASPECT, rotator, startBoatKey, startFitBox, startFullFrame, startHullScale, startSnapshot } from '../src/ui/charts';
import { carryView, clampView, fitView, presetActive, type Box } from '../src/ui/view';
import { fixtureRace, m24Race } from './helpers';

const races = { j70: analyzeRace(fixtureRace()), m24: analyzeRace(m24Race()) };
const w = (b: Box): number => b.x1 - b.x0;
const h = (b: Box): number => b.y1 - b.y0;
const inside = (inner: Box, outer: Box): boolean => inner.x0 >= outer.x0 - 1e-9 && inner.x1 <= outer.x1 + 1e-9 && inner.y0 >= outer.y0 - 1e-9 && inner.y1 <= outer.y1 + 1e-9;
const vb = (svg: string): number[] => /viewBox="([^"]+)"/.exec(svg)![1].split(' ').map(Number);

/** A phone in portrait and landscape (under the overlay's top bar), and a desktop window. */
const SIZES = { portrait: [390, 700], landscape: [844, 330], desktop: [1400, 800] } as const;
/** Where there's height to spare: a phone in portrait, a tall desktop window. */
const FILL_SIZES = { portrait: [390, 760], desktop: [1440, 940], landscape: [844, 330] } as const;

describe('full-screen start frame', () => {
  for (const [name, a] of Object.entries(races)) {
    describe(name, () => {
      const rot = rotator(a.wind.twdAtGunDeg);
      const L = rot(a.line.left);
      const R = rot(a.line.right);
      const bows = a.drawings.filter((d) => d.bow).map((d) => rot(d.bow!));

      for (const [size, [W, H]] of Object.entries(SIZES)) {
        it(`${size}: takes the viewport's aspect and frames the line and every bow`, () => {
          const f = startFullFrame(a, W, H);
          expect(w(f.box) / h(f.box)).toBeCloseTo(W / H, 6);
          expect(inside(f.core, f.box)).toBe(true);
          for (const p of [L, R, ...bows]) {
            expect(p[0]).toBeGreaterThan(f.box.x0);
            expect(p[0]).toBeLessThan(f.box.x1);
          }
          // The core is the line and the bows only (no trails).
          expect(f.core.x0).toBeCloseTo(Math.min(L[0], R[0], ...bows.map((p) => p[0])), 9);
          expect(f.core.y1).toBeCloseTo(Math.max(L[1], R[1], ...bows.map((p) => p[1])), 9);
          expect(f.refPx).toBe(Math.max(W, 480));
        });
      }

      it('fills the width with the line and fleet in landscape: only margins and the favoured-end label beside them', () => {
        const [W, H] = SIZES.landscape;
        const f = startFullFrame(a, W, H);
        // Line + fleet span most of the width (the rest: 30 px margins and the label, ≤ 22% of the width).
        expect(w(f.core) / w(f.box)).toBeGreaterThan(0.6);
        // Far bigger than the inline Fit drawn at a phone's width.
        const inline = startFitBox(a, 390);
        expect(W / w(f.box)).toBeGreaterThan(1.5 * (390 / w(inline)));
      });

      for (const [size, [W, H]] of Object.entries(FILL_SIZES)) {
        it(`${size}: spare height goes below the line to the trails; the line stays near the top`, () => {
          const f = startFullFrame(a, W, H);
          const pxPerM = W / w(f.box);
          const topPx = (f.core.y0 - f.box.y0) * pxPerM;
          const bottomPx = (f.box.y1 - f.core.y1) * pxPerM;
          expect(inside(f.core, f.box)).toBe(true);
          // Trails are downwind of the line: below it, down the page.
          expect(f.trails.y1).toBeGreaterThan(f.core.y1);
          // The line sits at the top, with only its margin above (the favoured-end label's tip
          // may lift it a little on a slanted line). Spare height is not split above the line.
          expect(topPx).toBeGreaterThanOrEqual(52 - 0.5);
          expect(topPx).toBeLessThan(52 + 40);
          expect(bottomPx).toBeGreaterThanOrEqual(30 - 0.5);
          // Never less trail than a window centred on line + fleet.
          const cy = (f.core.y0 + f.core.y1) / 2;
          const centred: Box = { x0: f.box.x0, x1: f.box.x1, y0: cy - h(f.box) / 2, y1: cy + h(f.box) / 2 };
          const trail = a.drawings.flatMap((d) => [...d.trail.x].map((x, i) => rot([x, d.trail.y[i]])));
          const shown = (b: Box): number => trail.filter(([x, y]) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1).length;
          expect(shown(f.box)).toBeGreaterThanOrEqual(shown(centred));
        });
      }

      it('asks to rotate in portrait only, when line + fleet are framed much wider than tall', () => {
        const portrait = startFullFrame(a, ...SIZES.portrait);
        expect(portrait.rotate).toBe(true);
        expect(w(portrait.core) / h(portrait.core)).toBeGreaterThan(ROTATE_ASPECT);
        expect(startFullFrame(a, ...SIZES.landscape).rotate).toBe(false);
        expect(startFullFrame(a, ...SIZES.desktop).rotate).toBe(false);
      });

      it('draws the snapshot in the frame (viewBox = the box at Fit) with names ~10 px at any size', () => {
        for (const [W, H] of Object.values(SIZES)) {
          const f = startFullFrame(a, W, H);
          const svg = startSnapshot(a, null, undefined, 'boat', { widthPx: W, frame: f });
          vb(svg).forEach((n, i) => expect(n).toBeCloseTo([f.box.x0, f.box.y0, w(f.box), h(f.box)][i], 6));
          const fs = Number(/class="lbl"[^>]*?font-size="([\d.]+)"|font-size="([\d.]+)" text-anchor="middle" class="lbl"/.exec(svg)!.slice(1).find(Boolean));
          // Chart units → css px.
          expect(fs * (W / w(f.box))).toBeCloseTo(10, 1);
        }
      });
    });
  }

  it('the M24 hulls are drawn to scale in landscape full screen, though only markers inline on a phone', () => {
    const a = races.m24;
    const f = startFullFrame(a, 1400, 800);
    expect(startHullScale(a, undefined, 1400, f)?.loaM).toBe(7.31);
    expect(startHullScale(a, undefined, 390)).toBeNull();
  });

  it('with trails longer than the spare height, the line sits at the top under its 52 px margin and the rest is trail', () => {
    // M24 with every trail stretched 4× back from its bow (as a fast fleet's 60 s would be).
    const a = races.m24;
    const long = {
      ...a,
      drawings: a.drawings.map((d) => {
        if (!d.bow) return d;
        const [bx, by] = d.bow;
        return { ...d, trail: { ...d.trail, x: d.trail.x.map((x) => bx + 4 * (x - bx)), y: d.trail.y.map((y) => by + 4 * (y - by)) } };
      }),
    };
    for (const [W, H] of [FILL_SIZES.desktop, FILL_SIZES.landscape]) {
      const f = startFullFrame(long, W, H);
      expect(f.trails.y1).toBeGreaterThan(f.box.y1);
      const pxPerM = W / w(f.box);
      const topPx = (f.core.y0 - f.box.y0) * pxPerM;
      expect(topPx).toBeGreaterThanOrEqual(52 - 0.5);
      expect(topPx).toBeLessThan(52 + 40);
      expect((f.box.y1 - f.core.y1) * pxPerM).toBeGreaterThan(2 * topPx);
    }
  });

  it('falls back to the inline Fit when the chart has no size yet', () => {
    const a = races.j70;
    const f = startFullFrame(a, 0, 0);
    expect(f.box).toEqual(startFitBox(a));
    expect(f.rotate).toBe(false);
  });

  it('boat key: a swatch per boat for a small fleet, nothing for a big one', () => {
    const a = races.j70;
    const key = startBoatKey(a);
    expect(key.match(/class="bk"/g)).toHaveLength(a.boats.length);
    expect(key).toContain(a.boats[0].sail);
    expect(startBoatKey(races.m24)).toBe('');
  });
});

describe('state carried into full screen and back', () => {
  const a = races.m24;
  const inline = startFitBox(a, 390);
  const full = startFullFrame(a, 844, 330).box;

  it('Fit stays Fit both ways', () => {
    const v = carryView(inline, fitView(inline), full);
    expect(presetActive(full, v, 1)).toBe(true);
    expect(presetActive(inline, carryView(full, v, inline), 1)).toBe(true);
    expect(carryView(null, { cx: 9, cy: 9, k: 4 }, full)).toEqual(fitView(full));
  });

  it('a zoom keeps its level and centre (clamped) in and out', () => {
    const rot = rotator(a.wind.twdAtGunDeg);
    const bow = rot(a.drawings.find((d) => d.bow)!.bow!);
    const z = clampView(inline, { cx: bow[0], cy: bow[1], k: 4 });
    const inFull = carryView(inline, z, full);
    expect(inFull.k).toBe(4);
    expect(presetActive(full, inFull, 4)).toBe(true);
    expect(inFull).toEqual(clampView(full, z));
    const back = carryView(full, inFull, inline);
    expect(back.k).toBe(4);
    expect(back).toEqual(clampView(inline, inFull));
  });

  it('the selected boat and Names carry: the overlay draws from the same state', () => {
    const f = startFullFrame(a, 844, 330);
    const id = a.drawings.find((d) => d.bow)!.id;
    const sail = a.boats.find((b) => b.id === id)!.sail;
    const svg = startSnapshot(a, id, undefined, 'boat', { widthPx: 844, frame: f, names: 'off' });
    // Off: only the selected boat is named; everyone else is dimmed.
    const named = [...svg.matchAll(/class="lbl">([^<]+)</g)].map((m) => m[1]);
    expect(named).toEqual([sail]);
    expect(svg).toMatch(new RegExp(`<g class="boat[^"]*" data-id="${id}"`));
    expect(svg).not.toMatch(new RegExp(`<g class="boat[^"]* dim[^"]*" data-id="${id}"`));
    expect(svg).toContain(' dim');
    const all = startSnapshot(a, null, undefined, 'boat', { widthPx: 844, frame: f, names: 'all' });
    expect([...all.matchAll(/class="lbl">/g)].length).toBe(a.drawings.filter((d) => d.bow && d.courseAtGun != null).length);
  });
});
