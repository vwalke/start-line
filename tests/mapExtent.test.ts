import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ladderReader } from '../src/analysis/coach/ladderNow';
import { scrubFrame, trackMapView } from '../src/ui/charts';
import { mapScreenOf, visibleExtent, type MapScreen } from '../src/ui/mapExtent';
import type { Box } from '../src/ui/view';
import { coachRace, fixtureRace } from './helpers';

/**
 * What of the track map is visible (ui/mapExtent.ts): the viewBox drawn "meet" into the SVG, with the bands either
 * side on a wide card (above and below on a tall screen); the SVG fills a container that spans the card's padding and
 * clips, so the ladder rungs run to the card's edges and never past the SVG.
 */

const box = (): Box => ({ x0: 0, y0: 0, x1: 0, y1: 0 });
const screen = (w: number, h: number): MapScreen => ({ w, h });

describe('the visible extent', () => {
  const vb: Box = { x0: 100, y0: -50, x1: 1300, y1: 550 };

  it('is the viewBox where it fills the SVG, or with no size on screen', () => {
    expect(visibleExtent(vb, screen(600, 300), box())).toEqual(vb);
    expect(visibleExtent(vb, null, box())).toEqual(vb);
    expect(visibleExtent(vb, screen(0, 0), box())).toEqual(vb);
  });

  it('reaches into the bands either side on a wide card', () => {
    // 1600 × 400 px: 2/3 px a unit, the viewBox 800 px wide, 400 px empty each side (600 units).
    const e = visibleExtent(vb, screen(1600, 400), box());
    expect(e.x0).toBeCloseTo(100 - 600, 9);
    expect(e.x1).toBeCloseTo(1300 + 600, 9);
    expect([e.y0, e.y1]).toEqual([vb.y0, vb.y1]);
  });

  it('reaches above and below on a tall screen', () => {
    // 390 × 800 px: 0.325 px a unit, the viewBox 195 px high, 302.5 px empty above and below.
    const e = visibleExtent(vb, screen(390, 800), box());
    expect([e.x0, e.x1]).toEqual([vb.x0, vb.x1]);
    expect(e.y0).toBeCloseTo(-50 - 302.5 / 0.325, 6);
    expect(e.y1).toBeCloseTo(550 + 302.5 / 0.325, 6);
  });

  it('is the screen’s shape, centred on the view, at Fit and zoomed in, after a pan', () => {
    const { a } = coachRace(fixtureRace());
    const full = trackMapView(a, null).box;
    for (const scr of [screen(1630, 560), screen(360, 700), screen(900, 900)]) {
      for (const k of [1, 2, 4, 8]) {
        const cx = (full.x0 + full.x1) / 2 + (k > 1 ? 120 : 0);
        const cy = (full.y0 + full.y1) / 2 - (k > 1 ? 200 : 0);
        const v = trackMapView(a, null, { cx, cy, k }).view;
        const e = visibleExtent(v, scr, box());
        expect((e.x1 - e.x0) / (e.y1 - e.y0)).toBeCloseTo(scr.w / scr.h, 6);
        // Never smaller than the view, and centred on it.
        expect(e.x0).toBeLessThanOrEqual(v.x0 + 1e-9);
        expect(e.x1).toBeGreaterThanOrEqual(v.x1 - 1e-9);
        expect(e.y0).toBeLessThanOrEqual(v.y0 + 1e-9);
        expect(e.y1).toBeGreaterThanOrEqual(v.y1 - 1e-9);
        expect((e.x0 + e.x1) / 2).toBeCloseTo((v.x0 + v.x1) / 2, 6);
        expect((e.y0 + e.y1) / 2).toBeCloseTo((v.y0 + v.y1) / 2, 6);
      }
    }
  });

  it('measures the SVG’s own box on screen', () => {
    const svg = { left: 101, right: 1731, top: 200, bottom: 760, width: 1630, height: 560 };
    expect(mapScreenOf(svg)).toEqual({ w: 1630, h: 560 });
    expect(mapScreenOf({ ...svg, width: 0, height: 0 })).toBeNull();
  });

  it('reuses the box it is given: the same object back, refilled', () => {
    const out = box();
    expect(visibleExtent(vb, screen(1600, 400), out)).toBe(out);
    expect(visibleExtent(vb, null, out)).toBe(out);
    expect(out).toEqual(vb);
  });
});

describe('the map’s clip', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  /** Every declaration block for a selector list containing `sel`. */
  const rules = (sel: string): string[] => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim() === sel)).map((m) => m[2]);

  it('is a plain container around the SVG that clips, spanning the card’s padding', () => {
    // #map-chart (the SVG goes in it, app.ts renderMap) sits in the card between the tools and the scrubber.
    const card = html.slice(html.indexOf('id="map-full"'));
    expect(card.indexOf('id="map-zoom"')).toBeLessThan(card.indexOf('id="map-chart"'));
    expect(card.indexOf('id="map-chart"')).toBeLessThan(card.indexOf('id="map-scrub"'));
    expect(card).toMatch(/<div class="map-wrap">\s*<div id="map-chart"/);
    expect(rules('#map-chart').join(';')).toMatch(/overflow:\s*hidden/);
    // In the card: out to its inner edges, the padding either side (and the SVG at 100% of it).
    expect(css).toMatch(/\.card\s*\{[^}]*--card-pad-x:\s*14px[^}]*padding:\s*12px var\(--card-pad-x\)/);
    expect(rules('.card > .map-wrap > #map-chart').join(';')).toMatch(/margin:\s*0 calc\(-1 \* var\(--card-pad-x\)\)/);
    expect(rules('svg.chart').join(';')).toMatch(/width:\s*100%/);
  });

  it('never lets the SVG show past its own box: no overflow visible, no negative clip-path', () => {
    for (const sel of ['svg.chart', 'svg.chart.map', '.fs-body svg.chart.map', '#map-chart svg']) {
      for (const r of rules(sel)) expect(r).not.toMatch(/overflow:\s*visible/);
    }
    expect(css).not.toMatch(/svg\.chart\.map[^{]*\{[^}]*overflow:\s*visible/);
    expect(css).not.toMatch(/clip-path:\s*inset\([^)]*-/);
    expect(css).not.toContain('--map-bleed');
    // Nor the TS that draws or styles the map.
    const dir = new URL('../src/ui/', import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      expect(src, f).not.toMatch(/overflow['"]?\s*[:,]\s*['"]?visible/);
      expect(src, f).not.toMatch(/clip-?[pP]ath['"]?\s*[:,]\s*['"`]?inset\([^)]*-/);
      expect(src, f).not.toContain('--map-bleed');
    }
  });
});

describe('rungs to the visible extent', () => {
  const { a, m } = coachRace(fixtureRace());
  const read = ladderReader(a, m);
  const gun = a.meta.gunMs;
  const t = gun + 150_000;
  const now = read(t);
  const sel = now.reads.find((r, i) => i !== now.leader && !r.est && r.leg === now.reads[now.leader].leg)!.id;
  const full = trackMapView(a, null).box;

  it('end on its edges, past the view, with their labels inside it, at Fit and zoomed, on a wide card and a tall screen', () => {
    let past = 0;
    for (const scr of [screen(1630, 560), screen(390, 780)]) {
      for (const k of [1, 2, 4, 8]) {
        const view = { cx: (full.x0 + full.x1) / 2 + (k > 1 ? 80 : 0), cy: (full.y0 + full.y1) / 2 - (k > 1 ? 150 : 0), k };
        const v = trackMapView(a, null, view).view;
        const vis = visibleExtent(v, scr, box());
        const f = scrubFrame(a, sel, null, { view }, { t, win: [t - 120_000, t], trailMs: 120_000, ladder: read(t), screen: scr });
        const unit = Math.max(v.x1 - v.x0, v.y1 - v.y0) / 600;
        for (const d of f.rungs) {
          for (const [x, y] of [
            [d.x1, d.y1],
            [d.x2, d.y2],
          ]) {
            const edge = Math.min(Math.abs(x - vis.x0), Math.abs(x - vis.x1), Math.abs(y - vis.y0), Math.abs(y - vis.y1));
            expect(edge).toBeLessThan(1e-6);
            expect(x).toBeGreaterThanOrEqual(vis.x0 - 1e-6);
            expect(x).toBeLessThanOrEqual(vis.x1 + 1e-6);
            expect(y).toBeGreaterThanOrEqual(vis.y0 - 1e-6);
            expect(y).toBeLessThanOrEqual(vis.y1 + 1e-6);
            if (x < v.x0 - 1 || x > v.x1 + 1 || y < v.y0 - 1 || y > v.y1 + 1) past++;
          }
          // The label inside what is visible, 8 screen units in from its edges.
          const l = d.label;
          if (!l) continue;
          expect(l.box.x0).toBeGreaterThanOrEqual(vis.x0 + 8 * unit - 1e-6);
          expect(l.box.x1).toBeLessThanOrEqual(vis.x1 - 8 * unit + 1e-6);
          expect(l.box.y0).toBeGreaterThanOrEqual(vis.y0 + 8 * unit - 1e-6);
          expect(l.box.y1).toBeLessThanOrEqual(vis.y1 - 8 * unit + 1e-6);
        }
      }
    }
    // The rungs did reach past the viewBox, into the bands either side (or above and below).
    expect(past).toBeGreaterThan(4);
  });

  it('keep the two labels clear of each other in the wider extent', () => {
    const f = scrubFrame(a, sel, null, {}, { t, win: [t - 120_000, t], trailMs: 120_000, ladder: read(t), screen: screen(1630, 560) });
    const [p, q] = f.rungs.map((d) => d.label && { ...d.label.box });
    expect(p && q).toBeTruthy();
    expect(p!.x0 < q!.x1 && q!.x0 < p!.x1 && p!.y0 < q!.y1 && q!.y0 < p!.y1).toBe(false);
  });
});
