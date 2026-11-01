import { describe, expect, it } from 'vitest';
import { GAIN_STEP_MS, gainAt, gainRates, gainSeries, type LadderGrid } from '../src/analysis/coach/gainLoss';
import { ladderReader } from '../src/analysis/coach/ladderNow';
import { mapKey } from '../src/ui/captions';
import { scrubFrame, trackMap, trackPoints } from '../src/ui/charts';
import { GAIN_COLORS, GAIN_NEUTRAL_DAY, gainColor, gainKey, gainRateColor, gainTipLine, GAIN_BINS, GAIN_KEY_TEXT, trackGainRange } from '../src/ui/gain';
import { mapTipLines } from '../src/ui/mapPoints';
import { NEUTRAL_DAY, NEUTRAL_NIGHT, sogKey } from '../src/ui/sog';
import { colourControls, contrast, needsCoach, parseTrackColour, SPEED_BG } from '../src/ui/speed';
import { coachRace, fixtureRace } from './helpers';

/**
 * Color: Gain/loss (ui/gain.ts, coach/gainLoss.ts): each boat's rate of gain on the median boat up its leg's ladder,
 * m/min over 30 s, on a red–gray–green scale.
 */

/** A grid of `rates` boats (m/min down the ladder each), all on `legs[b]`, starting `d0` m from the leg's end. */
function grid(perMin: number[], legs: number[], n = 24, d0 = 2000): LadderGrid {
  const boats = perMin.length;
  const g: LadderGrid = { boats, n, leg: new Int16Array(boats * n), dist: new Float64Array(boats * n), prog: new Float64Array(boats * n) };
  for (let b = 0; b < boats; b++) {
    for (let j = 0; j < n; j++) {
      const made = (perMin[b] * j * GAIN_STEP_MS) / 60_000;
      g.leg[b * n + j] = legs[b];
      g.dist[b * n + j] = d0 - made;
      g.prog[b * n + j] = 10_000 * legs[b] + made;
    }
  }
  return g;
}
/** #rrggbb in OKLab: lightness, and chroma (how far from gray). */
function oklab(hex: string): { L: number; C: number; a: number } {
  const lin = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(1), lin(3), lin(5)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), a };
}
const mid = (r: Float32Array, b: number, n: number): number => r[b * n + Math.floor(n / 2)];

describe('gain rate on the fleet’s median boat (coach/gainLoss.ts)', () => {
  // Median boat: 60 m/min. The closer: 72 (+12); the faller: 48 (−12); the pacer: 60 (~0).
  const speeds = [72, 48, 60, 60, 66];
  const n = 24;
  const r = gainRates(grid(speeds, [0, 0, 0, 0, 0], n));

  it('reads positive closing on the median, negative falling back, ~0 keeping pace', () => {
    expect(mid(r, 0, n)).toBeCloseTo(12, 4);
    expect(mid(r, 1, n)).toBeCloseTo(-12, 4);
    expect(mid(r, 2, n)).toBeCloseTo(0, 4);
    expect(mid(r, 4, n)).toBeCloseTo(6, 4);
    // No reading until a whole window fits.
    expect(r[0]).toBeNaN();
  });

  it('draws them green, red and the neutral gray', () => {
    const range = { lo: -10, hi: 10 };
    expect(gainRateColor(mid(r, 0, n), range)).toBe(gainColor(1 - 0.5 / GAIN_BINS));
    expect(gainRateColor(mid(r, 1, n), range)).toBe(gainColor(0.5 / GAIN_BINS));
    expect(gainRateColor(mid(r, 2, n), range)).toBe(GAIN_NEUTRAL_DAY);
    expect(gainRateColor(mid(r, 2, n), range, 'dark')).toBe(NEUTRAL_NIGHT);
    expect(gainRateColor(NaN, range)).toBe(GAIN_NEUTRAL_DAY);
  });

  it('is gray only in the middle bin: the bins beside it already clearly red and green, the ends strongest', () => {
    const half = (GAIN_BINS - 1) / 2;
    for (const scheme of ['light', 'dark'] as const) {
      const bins = GAIN_COLORS[scheme];
      expect(bins.length).toBe(GAIN_BINS);
      expect(new Set(bins).size).toBe(GAIN_BINS);
      // Each bin's own color on the tracks and in the key.
      bins.forEach((c, b) => expect(gainColor((b + 0.5) / GAIN_BINS, scheme)).toBe(c));
      const lab = bins.map(oklab);
      // The middle bin is the gray (the night one the app's slate gray, a faint blue cast).
      expect(lab[half].C).toBeLessThan(0.03);
      for (let b = 0; b < GAIN_BINS; b++) {
        // Every bin reads on its chart.
        expect(contrast(bins[b], SPEED_BG[scheme])).toBeGreaterThanOrEqual(3);
        if (b === half) continue;
        // Saturated, not grayish, right next to the middle; red below it, green above.
        expect(lab[b].C).toBeGreaterThanOrEqual(0.14);
        expect(Math.sign(lab[b].a)).toBe(b < half ? 1 : -1);
      }
      // Stepping out: the ends are further from the middle bin than the bins beside it.
      const dist = (b: number): number => Math.hypot(lab[b].L - lab[half].L, lab[b].C);
      expect(dist(0)).toBeGreaterThan(dist(half - 1));
      expect(dist(GAIN_BINS - 1)).toBeGreaterThan(dist(half + 1));
      // The red darker than the green throughout (a lightness step for red-green color-blind viewers).
      const redL = Math.max(...lab.slice(0, half).map((x) => x.L));
      const greenL = Math.min(...lab.slice(half + 1).map((x) => x.L));
      expect(greenL - redL).toBeGreaterThanOrEqual(0.03);
    }
  });

  it('compares on course progress with the fleet when fewer than 3 share the leg', () => {
    // Two boats alone on leg 1, three on leg 0.
    const g = grid([60, 70, 60, 60, 60], [1, 1, 0, 0, 0], n);
    const q = gainRates(g);
    expect(mid(q, 0, n)).toBeCloseTo(0, 4);
    expect(mid(q, 1, n)).toBeCloseTo(10, 4);
    // Too few racing at all: no reading.
    expect(Number.isNaN(mid(gainRates(grid([60, 70], [0, 0], n)), 0, n))).toBe(true);
  });

  it('leaves a boat that rounded in the window out of the fleet’s median on course progress', () => {
    // Fewer than 3 on each leg: 50 and 60 m/min on leg 1, 70 on leg 2, so the fleet's median is 60. Boat 3 rounds from
    // leg 1 into leg 2 at sample 12, its course progress jumping 400 m there (the next leg's scale).
    const g = grid([50, 60, 70, 60], [1, 1, 2, 1], n);
    for (let j = 12; j < n; j++) {
      g.leg[3 * n + j] = 2;
      g.prog[3 * n + j] += 400;
    }
    const q = gainRates(g);
    for (const j of [10, 12, 14]) {
      // With it in the pool the median would be 65: the pacer would read −5.
      expect(q[1 * n + j]).toBeCloseTo(0, 4);
      expect(q[0 * n + j]).toBeCloseTo(-10, 4);
      expect(q[2 * n + j]).toBeCloseTo(10, 4);
    }
  });

  it('has no reading off the leg (finished, unplaced)', () => {
    const g = grid(speeds, [0, 0, 0, 0, 0], n);
    for (let j = 10; j < n; j++) g.leg[0 * n + j] = -1;
    const q = gainRates(g);
    expect(q[0 * n + 15]).toBeNaN();
    expect(q[1 * n + 15]).toBeCloseTo(-12, 4); // the rest still read, on the median of the four left (60)
  });
});

describe('Gain/loss on the race viewer map', () => {
  const { a, m } = coachRace(fixtureRace());

  it('is worked out once, on its own ladder reader (the rungs’ moment is left as it was)', () => {
    const read = ladderReader(a, m);
    const t = a.meta.gunMs + 200_000;
    const before = read(t).reads.map((x) => x.rung);
    const s = gainSeries(a, m);
    expect(gainSeries(a, m)).toBe(s);
    expect(read(t).t).toBe(t);
    expect(read(t).reads.map((x) => x.rung)).toEqual(before);
    let finite = 0;
    for (const v of s.rate) if (Number.isFinite(v)) finite++;
    expect(finite).toBeGreaterThan(s.rate.length / 4);
    // A boat racing reads; before the gun, none.
    const id = s.ids[0];
    expect(Number.isFinite(gainAt(s, id, t))).toBe(true);
    expect(gainAt(s, id, a.meta.gunMs - 60_000)).toBeNaN();
  });

  it('draws red–gray–green paths per bin, one symmetric range, and gray until the wind is in', () => {
    const svg = trackMap(a, null, null, { colour: 'gain', coach: m });
    const r = trackGainRange(a, m, null);
    expect(r.lo).toBe(-r.hi);
    expect(r.hi % 5).toBe(0);
    const bins = new Set([...svg.matchAll(/<path class="sog" data-bin="(\d+)"/g)].map((x) => Number(x[1])));
    expect(bins.size).toBeGreaterThan(2);
    for (const b of bins) expect(b).toBeLessThan(GAIN_BINS);
    expect(svg).toContain(`stroke="${gainColor(0.5)}"`);
    expect(svg).toMatch(/tracks colored by gain or loss on the fleet(&#39;|')s median boat, up to \d+ m\/min either way: red losing, gray even, green gaining/);
    expect(trackMap(a, null, 1, { colour: 'gain', coach: m })).toContain('<g class="sog-trk"');
    const waiting = trackMap(a, null, null, { colour: 'gain' });
    expect(waiting).toContain(`stroke="${NEUTRAL_DAY}"`);
    expect(waiting).not.toMatch(/data-bin="[1-9]/);
    const t = a.meta.gunMs + 300_000;
    const fr = scrubFrame(a, null, null, { colour: 'gain', coach: m, scrub: true }, { t, win: [a.meta.gunMs, t] });
    expect(fr.tracks).toContain('<g class="sog-trk"');
  });

  it('says "+12 m/min vs fleet" on hover; its key and caption', () => {
    const p = trackPoints(a, null);
    const id = p.ix.ids[0];
    const [i0, i1] = p.ix.span[0];
    let line: string | undefined;
    for (let i = i0; i < i1 && !line; i += 5) {
      const lines = mapTipLines(a, p, { kind: 'fix', i }, { valueLine: (q) => gainTipLine(a, m, q.id, q.t) });
      line = lines.find((l) => l.endsWith('m/min vs fleet'));
    }
    expect(id).toBeTruthy();
    expect(line).toMatch(/^(\+[1-9]\d*|−[1-9]\d*|0) m\/min vs fleet$/);
    const key = gainKey(a, m, null);
    expect(key).toContain(GAIN_KEY_TEXT);
    expect(GAIN_KEY_TEXT).toBe('Gain/loss vs fleet · m/min');
    // The unit is in the title, not past the bar's end (it ran into the title); VMG's and SOG's keep theirs.
    expect(key).not.toContain('class="tu"');
    for (const [, label] of key.matchAll(/<span class="tl">([^<]*)<\/span>/g)) expect(label).toMatch(/^([+−]\d+(\.\d)?|0)$/);
    expect(key).toContain('aria-label="-');
    expect(key).toMatch(/ m\/min"><span class="sog-bar"/);
    expect(sogKey({ lo: 4, hi: 8 }, 'Beat 1')).toContain('<span class="tu">kn</span>');
    expect(key).toMatch(/<span class="tl">−\d+<\/span>/);
    expect(key).toMatch(/<span class="tl">\+\d+<\/span>/);
    expect(gainKey(a, undefined, null)).toContain('Gain/loss vs fleet · m/min');
    for (const html of [key, gainKey(a, undefined, 0)]) expect(html).not.toMatch(/no data|gap|colour/i);
    const cap = mapKey(a, { colour: 'gain', leg: null });
    const b = cap.bullets.find((x) => x.startsWith('Gain/loss: '));
    expect(b).toContain('m/min over 30 s');
    expect(cap.bullets.join(' ')).not.toMatch(/\bgap\b|over early|OCS/i);
  });

  it('is in the menu, and its stored value parses', () => {
    expect(colourControls('gain', 'leg', null)).toContain('data-colour="gain" aria-pressed="true">Gain/loss</button>');
    expect(colourControls('gain', 'leg', null)).not.toContain('data-sog-scale');
    expect(parseTrackColour('gain')).toBe('gain');
    expect(parseTrackColour('vmg')).toBe('vmg');
    expect(parseTrackColour('speed')).toBe('rank');
    expect(needsCoach('gain')).toBe(true);
  });
});
