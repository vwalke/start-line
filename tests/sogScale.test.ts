import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { trackMap } from '../src/ui/charts';
import {
  binPos,
  estimatedTickMetrics,
  SOG_BINS,
  SOG_KEY_NARROW_PX,
  SOG_KEY_WIDE_PX,
  sogBin,
  sogColor,
  sogGradient,
  sogKey,
  sogKnColor,
  sogLegKey,
  sogTicks,
  TICK_CHAR_EM,
  TICK_FONT_REM,
  TICK_GAP_EM,
  TICK_MIN_EM,
  tickLabelBox,
  tickMetrics,
  tickStep,
  trackSogRange,
  type SogRange,
  type SogScheme,
  type TickMetrics,
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

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
/** The declarations of the first rule with exactly this selector. */
const rule = (sel: string): string => new RegExp(`(?:^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

/** The night ramp's 20 bins as they were when one ramp served both schemes: night must not move. */
const NIGHT_BINS = [
  '#4475e7', '#4194fc', '#37a7f9', '#2db6f0', '#24c1e5', '#1eced6', '#19dbc5', '#21e6b2', '#2ef09d', '#46f786',
  '#66fb6a', '#8ffe49', '#b2f53c', '#d0e935', '#e3d938', '#f1c638', '#fbb035', '#fb9229', '#f5701b', '#db440c',
];

describe('speed ramp', () => {
  const ramp = (scheme: SogScheme): string[] => Array.from({ length: SOG_BINS }, (_, b) => sogColor(binPos(b), scheme));
  const day = ramp('light');
  const night = ramp('dark');

  it('leaves the night ramp exactly as it was', () => {
    expect(night).toEqual(NIGHT_BINS);
    for (const c of night) expect(contrast(c, SPEED_BG.dark)).toBeGreaterThanOrEqual(3);
  });

  it('by day, puts every bin at ≥ 3:1 on the light map background (turbo’s pale middle was ~1.3:1)', () => {
    for (const c of day) expect(contrast(c, SPEED_BG.light)).toBeGreaterThanOrEqual(3);
    expect(Math.min(...NIGHT_BINS.map((c) => contrast(c, SPEED_BG.light)))).toBeLessThan(1.5);
    // the ends were already dark enough, so they stay put
    expect(sogColor(0)).toBe(sogColor(0, 'dark'));
    expect(sogColor(1)).toBe(sogColor(1, 'dark'));
  });

  for (const [scheme, bins] of [
    ['day', day],
    ['night', night],
  ] as const) {
    it(`${scheme}: gives every bin its own colour, each clearly apart from its neighbors (ΔE*ab ≥ 8)`, () => {
      expect(new Set(bins).size).toBe(SOG_BINS);
      for (let b = 1; b < SOG_BINS; b++) expect(dE(bins[b - 1], bins[b])).toBeGreaterThanOrEqual(8);
    });

    it(`${scheme}: is close to perceptually even: no step between bins more than 2.5× another`, () => {
      const steps = bins.slice(1).map((c, b) => dE(bins[b], c));
      expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(2.5);
    });

    it(`${scheme}: sweeps the hue wheel one way, blue → green → red (monotonic hue, more than 180°)`, () => {
      const hs = bins.map(hue);
      // CIELAB hue falls steadily from blue (~300°) round through green to red (~40°).
      for (let b = 1; b < SOG_BINS; b++) expect(hs[b]).toBeLessThan(hs[b - 1]);
      expect(hs[0] - hs[SOG_BINS - 1]).toBeGreaterThan(180);
    });
  }

  it('keeps the day ramp in the night one’s hue order, bin for bin (only lightness and chroma move)', () => {
    for (let b = 0; b < SOG_BINS; b++) expect(Math.abs(hue(day[b]) - hue(night[b]))).toBeLessThan(4);
  });

  it('draws a track at a speed in the same colour the key shows at that speed, in each scheme', () => {
    const r: SogRange = { lo: 4.5, hi: 8 };
    const a = analyzeRace(fixtureRace());
    const svg = trackMap(a, null, 1, { colour: 'sog' });
    const used = [...svg.matchAll(/<path class="sog" data-bin="(\d+)" d="[^"]+" stroke="(#[0-9a-f]{6})" style="--cd:(#[0-9a-f]{6})"\/>/g)];
    expect(new Set(used.map((m) => m[1])).size).toBeGreaterThan(3);
    for (const scheme of ['light', 'dark'] as const) {
      // The key's bar: one hard band per bin.
      const stops = [...sogGradient(scheme).matchAll(/(#[0-9a-f]{6}) ([\d.]+)% ([\d.]+)%/g)].map((m) => ({ c: m[1], from: +m[2] / 100, to: +m[3] / 100 }));
      expect(stops).toHaveLength(SOG_BINS);
      const keyAt = (kn: number): string => {
        const p = Math.min(0.999999, Math.max(0, (kn - r.lo) / (r.hi - r.lo)));
        return stops.find((s) => p >= s.from && p < s.to)!.c;
      };
      for (let kn = 4.5; kn < 8; kn += 0.07) {
        const track = sogColor(binPos(sogBin(kn, r)), scheme);
        expect(sogKnColor(kn, r, scheme)).toBe(track);
        expect(keyAt(kn)).toBe(track);
      }
      // and the map's own paths are drawn in those band colours only: day as the stroke, night as --cd
      for (const m of used) expect(stops[+m[1]].c).toBe(scheme === 'light' ? m[2] : m[3]);
    }
  });

  it('draws the key the way the tracks are drawn: no casing on either, and the bar’s end bands at full width', () => {
    const a = analyzeRace(fixtureRace());
    const map = trackMap(a, null, null, { colour: 'sog' });
    // Tracks: no casing path, and no stroke on the bins but their own colour.
    expect(map).not.toContain('sog-case');
    expect(css).not.toMatch(/sog-case/);
    expect(rule('svg .sog, svg .sog-sel')).not.toMatch(/stroke:/);
    // Key: the same uncased bands, by day and by night, and square ends so nothing clips the first or last band.
    for (const sel of ['.speed-key .sog-bar', '.sog-scale .sog-bar']) {
      const decl = rule(sel);
      expect(decl).not.toBe('');
      expect(decl).not.toMatch(/border|box-shadow|outline|clip|mask/);
    }
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{[^}]*\}?[^@]*\.speed-key \.sog-bar \{ background: var\(--gd\); \}/);
    expect(css.indexOf('.speed-key .sog-bar { background: var(--gd); }')).toBeGreaterThan(css.indexOf('.speed-key .sog-bar { display'));
    for (const scheme of ['light', 'dark'] as const) {
      const bands = [...sogGradient(scheme).matchAll(/#[0-9a-f]{6} ([\d.]+)% ([\d.]+)%/g)].map((m) => +m[2] - +m[1]);
      expect(bands[0]).toBeCloseTo(100 / SOG_BINS, 6);
      expect(bands.at(-1)).toBeCloseTo(100 / SOG_BINS, 6);
    }
    const key = sogKey({ lo: 4.5, hi: 8 }, 'Whole race');
    expect(key).toContain(`<span class="sog-bar" style="--g:${sogGradient()};--gd:${sogGradient('dark')}"></span>`);
    expect(sogLegKey(a)).toContain(`<span class="sog-bar" style="--g:${sogGradient()};--gd:${sogGradient('dark')}" aria-hidden="true"></span>`);
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
  const m = tickMetrics();
  const labelled = (r: SogRange, w: number) => sogTicks(r, w).filter((t) => t.label);

  for (const r of ranges) {
    for (const w of widths) {
      it(`${r.lo}–${r.hi} kn on ${w} px: ends labelled, in order, on nice steps, no labels touching`, () => {
        const ts = sogTicks(r, w);
        // min and max, always labelled, at the ends
        expect(ts[0]).toMatchObject({ kn: r.lo, pos: 0, end: 'lo' });
        expect(ts.at(-1)).toMatchObject({ kn: r.hi, pos: 1, end: 'hi' });
        expect(ts[0].label).toBe(Number.isInteger(r.lo) ? String(r.lo) : r.lo.toFixed(1));
        // the unit isn't on the max label (it sits beside the bar), so the fast end's label stays short
        expect(ts.at(-1)!.label).toBe(Number.isInteger(r.hi) ? String(r.hi) : r.hi.toFixed(1));
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
          expect((step / (r.hi - r.lo)) * w).toBeGreaterThanOrEqual(TICK_MIN_EM * m.fontPx);
        }
        // labels keep clear of each other, and stay on the bar
        const boxes = labelled(r, w).map((t) => tickLabelBox(t, w));
        for (let i = 1; i < boxes.length; i++) expect(boxes[i][0] - boxes[i - 1][1]).toBeGreaterThanOrEqual(TICK_GAP_EM * m.fontPx);
        expect(boxes[0][0]).toBeGreaterThanOrEqual(0);
        expect(boxes.at(-1)![1]).toBeLessThanOrEqual(w);
      });
    }
  }

  it('labels the finest step that fits: 1 kn across 4.5–8 on a wide bar, coarser when narrower', () => {
    const r = { lo: 4.5, hi: 8 };
    expect(labelled(r, SOG_KEY_WIDE_PX).map((t) => t.label)).toEqual(['4.5', '5', '6', '7', '8']);
    expect(labelled({ lo: 5.5, hi: 6.5 }, SOG_KEY_WIDE_PX).map((t) => t.label)).toEqual(['5.5', '6', '6.5']);
    // a wide planing range: 2 or 5 kn labels, with whole-knot minor ticks between
    const wide = sogTicks({ lo: 3, hi: 14.5 }, SOG_KEY_WIDE_PX);
    // with "kn" off the max label, 12 has room beside "14.5"; 14 crowds it, so stays a tick without a label
    expect(wide.filter((t) => t.label && !t.end).map((t) => t.kn)).toEqual([4, 6, 8, 10, 12]);
    expect(wide.filter((t) => !t.label).map((t) => t.kn)).toEqual([5, 7, 9, 11, 13, 14]);
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
    expect(ticks.at(-1)![3]).toBe('14.5');
    // the unit once, just past the bar's end, inside the labelled image
    expect(html).toMatch(/<span class="tu">kn<\/span><\/span>/);
    expect(html.match(/>kn</g)).toHaveLength(1);
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

  it('tries the next nice step when one has no value inside the range or doesn’t fit, instead of giving up', () => {
    // 4.5–5.5 kn on a 35 px bar: 0.5 and 1 kn are too dense, 2 kn has nothing inside, 5 kn has 5
    expect(tickStep({ lo: 4.5, hi: 5.5 }, 35)).toBe(5);
    expect(sogTicks({ lo: 4.5, hi: 5.5 }, 35).map((t) => t.kn)).toEqual([4.5, 5, 5.5]);
    // likewise 20 kn misses 45–55 where 50 kn hits it
    expect(tickStep({ lo: 45, hi: 55 }, 35)).toBe(50);
    // a step whose labels collide passes to a coarser one
    const tight: TickMetrics = { fontPx: 11.52, width: (l) => l.length * 30 };
    const s = tickStep({ lo: 0, hi: 25 }, 320, tight)!;
    expect(s).toBeGreaterThan(tickStep({ lo: 0, hi: 25 }, 320)!);
    expect(tickStep({ lo: 0, hi: 0.5 }, 240)).toBeNull();
  });

  it('sizes labels and spacing by the labels’ font: em-based, measured in a browser, estimated without a DOM', () => {
    // No DOM here: estimated from character counts at 0.72 of a 16 px root.
    expect(m.fontPx).toBeCloseTo(16 * TICK_FONT_REM, 9);
    expect(m.width('14.5')).toBeCloseTo(4 * TICK_CHAR_EM * m.fontPx, 9);
    expect(tickLabelBox({ kn: 6, pos: 0.5, label: '6' }, 200)).toEqual([100 - (TICK_CHAR_EM * m.fontPx) / 2, 100 + (TICK_CHAR_EM * m.fontPx) / 2]);
    // A bigger font (a 24 px root) never labels more, and still keeps an em of clear space between labels.
    const big = estimatedTickMetrics(24 * TICK_FONT_REM);
    for (const r of ranges) {
      for (const w of widths) {
        const ls = sogTicks(r, w, big).filter((t) => t.label);
        expect(ls.length).toBeLessThanOrEqual(labelled(r, w).length);
        const boxes = ls.map((t) => tickLabelBox(t, w, big));
        for (let i = 1; i < boxes.length; i++) expect(boxes[i][0] - boxes[i - 1][1]).toBeGreaterThanOrEqual(TICK_GAP_EM * big.fontPx);
      }
    }
    expect(sogTicks({ lo: 3, hi: 14.5 }, SOG_KEY_WIDE_PX, big).filter((t) => t.label).length).toBeLessThan(labelled({ lo: 3, hi: 14.5 }, SOG_KEY_WIDE_PX).length);
    // Any measurement is used as given: wide glyphs push labels apart.
    const wideGlyphs: TickMetrics = { fontPx: m.fontPx, width: (l) => l.length * 12 };
    expect(tickLabelBox({ kn: 4.5, pos: 0, label: '4.5', end: 'lo' }, 240, wideGlyphs)).toEqual([0, 36]);
    // style.css sets the labels in that font, and sizes the scale and its ticks in em of it.
    expect(rule('.speed-key .sog-scale')).toContain(`font-size: ${TICK_FONT_REM}rem`);
    expect(rule('.speed-key .sog-scale')).toMatch(/--bar-h: [\d.]+em/);
    expect(rule('.speed-key .sog-scale')).toMatch(/height: calc\(var\(--bar-h\) \+ [\d.]+em\)/);
    expect(rule('.sog-scale .sog-bar')).toContain('height: var(--bar-h)');
    expect(rule('.sog-scale .tk')).toMatch(/top: var\(--bar-h\);.* height: [\d.]+em/);
    expect(rule('.sog-scale .tk.ln')).toMatch(/height: [\d.]+em/);
    expect(rule('.sog-scale .tl')).toMatch(/top: [\d.]+em/);
    expect(rule('.sog-scale .tl')).not.toContain('font-size');
    for (const sel of ['.speed-key .sog-scale', '.sog-scale .tk', '.sog-scale .tk.ln', '.sog-scale .tl', '.sog-scale .tu']) {
      expect(rule(sel).replace(/(min-width|width|margin-left): -?[\d.]+px/g, '')).not.toMatch(/(height|top): [\d.]+px/);
    }
    // the unit label sits past the bar's end, with room kept for it
    expect(rule('.sog-scale .tu')).toContain('left: 100%');
    expect(rule('.speed-key .sog-scale')).toMatch(/margin-right: [\d.]+em/);
  });

  it('shows the sparser narrow tick set unless the browser can check the bar’s width (container queries)', () => {
    // Narrow by default...
    expect(rule('.sog-scale .tk.n')).toContain('display: block');
    expect(rule('.sog-scale .tk.ln .tl')).toContain('display: block');
    expect(rule('.sog-scale .tk')).toContain('display: none');
    // ...the wide set only inside a min-width container query, which a browser without them skips.
    const cq = /@container \(min-width: ([\d.]+)px\) \{([^@]*?)\n\}/.exec(css);
    expect(cq).not.toBeNull();
    expect(+cq![1]).toBeLessThanOrEqual(SOG_KEY_WIDE_PX);
    expect(+cq![1]).toBeGreaterThan(SOG_KEY_WIDE_PX - 0.1);
    expect(cq![2]).toContain('.sog-scale .tk.w { display: block; }');
    expect(cq![2]).toContain('.sog-scale .tk.lw .tl { display: block; }');
    expect(cq![2]).toContain('.sog-scale .tk.n, .sog-scale .tk.ln .tl { display: none; }');
    expect(css.replace(cq![0], '')).not.toMatch(/\.tk\.w \{|\.tk\.lw \.tl \{/);
    expect(css).not.toMatch(/@container \(max-width/);
  });
});
