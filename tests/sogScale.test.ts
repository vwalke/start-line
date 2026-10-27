import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { trackMap } from '../src/ui/charts';
import {
  binPos,
  SOG_BINS,
  SOG_KEY_NARROW_PX,
  SOG_KEY_WIDE_PX,
  sogBin,
  sogColor,
  sogGradient,
  sogKey,
  sogKnColor,
  sogTicks,
  TICK_GAP_PX,
  TICK_MIN_PX,
  tickLabelBox,
  trackSogRange,
  type SogRange,
} from '../src/ui/sog';
import { contrast, SPEED_BG } from '../src/ui/speed';
import { fixtureRace } from './helpers';

// ---- CIELAB (D65), for the perceptual checks ---------------------------------

const lab = (hex: string): [number, number, number] => {
  const lin = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(1), lin(3), lin(5)];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};
const dE = (p: string, q: string): number => {
  const [a, b] = [lab(p), lab(q)];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};
const hue = (hex: string): number => {
  const [, a, b] = lab(hex);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
};

describe('speed ramp', () => {
  const bins = Array.from({ length: SOG_BINS }, (_, b) => sogColor(binPos(b)));

  it('gives every bin its own colour, each clearly apart from its neighbors (ΔE*ab ≥ 8)', () => {
    expect(new Set(bins).size).toBe(SOG_BINS);
    for (let b = 1; b < SOG_BINS; b++) expect(dE(bins[b - 1], bins[b])).toBeGreaterThanOrEqual(8);
  });

  it('is close to perceptually even: no step between bins more than 2.5× another', () => {
    const steps = bins.slice(1).map((c, b) => dE(bins[b], c));
    expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(2.5);
  });

  it('sweeps the hue wheel one way, blue → green → red (monotonic hue, more than 180°)', () => {
    const hs = bins.map(hue);
    // CIELAB hue falls steadily from blue (~300°) round through green to red (~40°).
    for (let b = 1; b < SOG_BINS; b++) expect(hs[b]).toBeLessThan(hs[b - 1]);
    expect(hs[0] - hs[SOG_BINS - 1]).toBeGreaterThan(180);
  });

  it('keeps both ends at ≥ 3:1 on the day and night map backgrounds', () => {
    for (const bg of [SPEED_BG.light, SPEED_BG.dark]) {
      expect(contrast(bins[0], bg)).toBeGreaterThanOrEqual(3);
      expect(contrast(bins[SOG_BINS - 1], bg)).toBeGreaterThanOrEqual(3);
    }
    // At night every bin reads without a casing.
    for (const c of bins) expect(contrast(c, SPEED_BG.dark)).toBeGreaterThanOrEqual(3);
  });

  it('draws a track at a speed in the same colour the key shows at that speed', () => {
    const r: SogRange = { lo: 4.5, hi: 8 };
    // The key's bar: one hard band per bin.
    const stops = [...sogGradient().matchAll(/(#[0-9a-f]{6}) ([\d.]+)% ([\d.]+)%/g)].map((m) => ({ c: m[1], from: +m[2] / 100, to: +m[3] / 100 }));
    expect(stops).toHaveLength(SOG_BINS);
    const keyAt = (kn: number): string => {
      const p = Math.min(0.999999, Math.max(0, (kn - r.lo) / (r.hi - r.lo)));
      return stops.find((s) => p >= s.from && p < s.to)!.c;
    };
    for (let kn = 4.5; kn < 8; kn += 0.07) {
      const track = sogColor(binPos(sogBin(kn, r)));
      expect(sogKnColor(kn, r)).toBe(track);
      expect(keyAt(kn)).toBe(track);
    }
    // and the map's own paths are drawn in those band colours only
    const a = analyzeRace(fixtureRace());
    const svg = trackMap(a, null, 1, { colour: 'sog' });
    const used = new Set([...svg.matchAll(/<path class="sog" data-bin="(\d+)" d="[^"]+" stroke="(#[0-9a-f]{6})"/g)].map((m) => `${m[1]}:${m[2]}`));
    expect(used.size).toBeGreaterThan(3);
    for (const u of used) {
      const [b, c] = u.split(':');
      expect(stops[+b].c).toBe(c);
    }
  });
});

describe('speed key ticks', () => {
  const ranges: SogRange[] = [
    { lo: 4.5, hi: 8 },
    { lo: 5.5, hi: 6.5 },
    { lo: 0, hi: 1 },
    { lo: 3, hi: 14.5 },
    { lo: 0, hi: 25 },
    { lo: 12, hi: 31.5 },
    { lo: 2, hi: 4 },
    { lo: 0.5, hi: 60 },
  ];
  const widths = [SOG_KEY_WIDE_PX, SOG_KEY_NARROW_PX, 120, 320];
  const labelled = (r: SogRange, w: number) => sogTicks(r, w).filter((t) => t.label);

  for (const r of ranges) {
    for (const w of widths) {
      it(`${r.lo}–${r.hi} kn on ${w} px: ends labelled, in order, on nice steps, no labels touching`, () => {
        const ts = sogTicks(r, w);
        // min and max, always labelled, at the ends
        expect(ts[0]).toMatchObject({ kn: r.lo, pos: 0, end: 'lo' });
        expect(ts.at(-1)).toMatchObject({ kn: r.hi, pos: 1, end: 'hi' });
        expect(ts[0].label).toBe(Number.isInteger(r.lo) ? String(r.lo) : r.lo.toFixed(1));
        expect(ts.at(-1)!.label).toMatch(/ kn$/);
        // strictly increasing in knots and position, all on the bar
        for (let i = 1; i < ts.length; i++) {
          expect(ts[i].kn).toBeGreaterThan(ts[i - 1].kn);
          expect(ts[i].pos).toBeGreaterThan(ts[i - 1].pos);
        }
        for (const t of ts) {
          expect(t.pos).toBeGreaterThanOrEqual(0);
          expect(t.pos).toBeLessThanOrEqual(1);
          expect(t.pos).toBeCloseTo((t.kn - r.lo) / (r.hi - r.lo), 9);
        }
        // every inner tick on a nice step: whole knots or halves, and labelled ones on one of 0.5/1/2/5/10/20/50
        for (const t of ts.slice(1, -1)) expect(t.kn * 2).toBeCloseTo(Math.round(t.kn * 2), 9);
        const inner = labelled(r, w).filter((t) => !t.end);
        if (inner.length > 1) {
          const gaps = inner.slice(1).map((t, i) => +(t.kn - inner[i].kn).toFixed(6));
          const step = Math.min(...gaps);
          expect([0.5, 1, 2, 5, 10, 20, 50]).toContain(step);
          for (const g of gaps) expect(g / step).toBeCloseTo(Math.round(g / step), 9);
          for (const t of inner) expect(t.kn / step).toBeCloseTo(Math.round(t.kn / step), 9);
          expect((step / (r.hi - r.lo)) * w).toBeGreaterThanOrEqual(TICK_MIN_PX);
        }
        // labels keep clear of each other, and stay on the bar
        const boxes = labelled(r, w).map((t) => tickLabelBox(t, w));
        for (let i = 1; i < boxes.length; i++) expect(boxes[i][0] - boxes[i - 1][1]).toBeGreaterThanOrEqual(TICK_GAP_PX);
        expect(boxes[0][0]).toBeGreaterThanOrEqual(0);
        expect(boxes.at(-1)![1]).toBeLessThanOrEqual(w);
      });
    }
  }

  it('labels the finest step that fits: 1 kn across 4.5–8 on a wide bar, coarser when narrower', () => {
    const r = { lo: 4.5, hi: 8 };
    expect(labelled(r, SOG_KEY_WIDE_PX).map((t) => t.label)).toEqual(['4.5', '5', '6', '7', '8 kn']);
    expect(labelled({ lo: 5.5, hi: 6.5 }, SOG_KEY_WIDE_PX).map((t) => t.label)).toEqual(['5.5', '6', '6.5 kn']);
    // a wide planing range: 2 or 5 kn labels, with whole-knot minor ticks between
    const wide = sogTicks({ lo: 3, hi: 14.5 }, SOG_KEY_WIDE_PX);
    // 12 would crowd "14.5 kn", so it stays a tick without a label
    expect(wide.filter((t) => t.label && !t.end).map((t) => t.kn)).toEqual([4, 6, 8, 10]);
    expect(wide.filter((t) => !t.label).map((t) => t.kn)).toEqual([5, 7, 9, 11, 12, 13, 14]);
    const narrow = sogTicks({ lo: 3, hi: 14.5 }, SOG_KEY_NARROW_PX);
    expect(narrow.filter((t) => t.label).length).toBeLessThan(wide.filter((t) => t.label).length);
    expect(narrow.filter((t) => t.label && !t.end).every((t) => t.kn % 5 === 0 || t.kn % 2 === 0)).toBe(true);
  });

  it('adds minor ticks when there is room, never on top of a labelled one', () => {
    for (const r of ranges) {
      for (const w of widths) {
        const ts = sogTicks(r, w);
        expect(new Set(ts.map((t) => t.kn)).size).toBe(ts.length);
        const minor = ts.filter((t) => !t.label);
        for (let i = 1; i < minor.length; i++) expect((minor[i].pos - minor[i - 1].pos) * w).toBeGreaterThanOrEqual(5.99 / 2);
      }
    }
    expect(sogTicks({ lo: 0, hi: 25 }, SOG_KEY_WIDE_PX).some((t) => !t.label)).toBe(true);
  });

  it('renders both tick sets on one bar, with the range for screen readers', () => {
    const r = { lo: 3, hi: 14.5 };
    const html = sogKey(r, 'Whole race');
    expect(html).toContain('<span class="sog-scale" role="img" aria-label="3.0 to 14.5 kn">');
    expect(html).toContain(`--g:${sogGradient()}`);
    const ticks = [...html.matchAll(/<span class="tk ([^"]+)" style="left:([\d.]+)%">(?:<span class="tl">([^<]+)<\/span>)?<\/span>/g)];
    // ends in both sets, labelled in both
    expect(ticks[0][1]).toBe('w lw n ln lo');
    expect(ticks.at(-1)![1]).toBe('w lw n ln hi');
    expect(ticks.at(-1)![3]).toBe('14.5 kn');
    // the wide set's labels are exactly sogTicks at the wide width; likewise narrow
    const lbl = (set: string): string[] => ticks.filter((t) => t[1].split(' ').includes(set)).map((t) => t[3]);
    expect(lbl('lw')).toEqual(sogTicks(r, SOG_KEY_WIDE_PX).filter((t) => t.label).map((t) => t.label));
    expect(lbl('ln')).toEqual(sogTicks(r, SOG_KEY_NARROW_PX).filter((t) => t.label).map((t) => t.label));
    const lefts = ticks.map((t) => +t[2]);
    for (let i = 1; i < lefts.length; i++) expect(lefts[i]).toBeGreaterThan(lefts[i - 1]);
    // the key still reads off the live range
    const a = analyzeRace(fixtureRace());
    const lr = trackSogRange(a, 1)!;
    expect(sogKey(lr, 'Beat 2')).toContain(`aria-label="${lr.lo.toFixed(1)} to ${lr.hi.toFixed(1)} kn"`);
  });
});
