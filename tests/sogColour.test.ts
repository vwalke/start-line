import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { SOG_GAP_MS, smoothSog } from '../src/analysis/smooth';
import { START_TRAIL_MS } from '../src/analysis/types';
import { startSnapshot, trackMap, trackSogIndex } from '../src/ui/charts';
import {
  addSogTrack,
  binPos,
  emptySogPaths,
  hasGaps,
  nearestSample,
  parseStartColour,
  percentile,
  segmentTimes,
  sogBin,
  SOG_BINS,
  sogCasedByDay,
  sogColor,
  sogIndex,
  sogKey,
  sogPathsSvg,
  sogRange,
  startColourControls,
  startSogRange,
  trackSogRange,
  viridis,
} from '../src/ui/sog';
import { contrast, plasma, SPEED_BG } from '../src/ui/speed';
import { fixtureRace, m24Race } from './helpers';

const close = (xs: ArrayLike<number>, ys: number[], d = 5): void => {
  expect(xs.length).toBe(ys.length);
  ys.forEach((y, i) => expect(xs[i]).toBeCloseTo(y, d));
};

describe('SOG smoothing', () => {
  it('takes the centred ±2 s mean at 1 Hz', () => {
    const t = [0, 1000, 2000, 3000, 4000, 5000];
    const s = [0, 0, 6, 0, 0, 0];
    // window [t-2 s, t+2 s]: index 2 sees 0..4 (5 fixes), index 0 sees 0..2 (3 fixes)
    close(smoothSog(t, s), [2, 1.5, 1.2, 1.2, 1.5, 0]);
  });

  it('weights by fixes in time, not by index, for uneven sampling', () => {
    // A burst at 5 Hz around t = 10 s, then 1 Hz: the window is still ±2 s of time.
    const t = [10_000, 10_200, 10_400, 10_600, 10_800, 11_000, 13_500];
    const s = [5, 5, 5, 5, 5, 5, 9];
    const out = smoothSog(t, s);
    close(out.slice(0, 6), [5, 5, 5, 5, 5, 5]); // 13.5 s is out of every burst fix's reach (> 2 s after 11.0 s)
    expect(out[6]).toBeCloseTo(9, 5);
  });

  it('never averages across a telemetry gap (> 5 s), even with a wide window', () => {
    const t = [0, 1000, 2000, 9000, 10_000];
    const s = [4, 4, 4, 10, 10];
    close(smoothSog(t, s, 30_000), [4, 4, 4, 10, 10]);
    // exactly the gap threshold is not a gap
    close(smoothSog([0, SOG_GAP_MS], [2, 4], 30_000), [3, 3]);
  });

  it('skips non-finite values and handles empty input', () => {
    close(smoothSog([0, 1000, 2000], [4, NaN, 6]), [5, 5, 5]);
    expect(smoothSog([], [])).toHaveLength(0);
  });

  it('is what the analysis stores on the drawn tracks and the start trails', () => {
    const a = analyzeRace(fixtureRace());
    for (const d of a.drawings) {
      expect(d.trail.t.length).toBe(d.trail.x.length);
      expect(d.trail.sog.length).toBe(d.trail.x.length);
      for (const s of d.segments) {
        expect(s.t).toBeInstanceOf(Float64Array);
        expect(s.sog).toBeInstanceOf(Float32Array);
        expect(s.t.length).toBe(s.x.length);
        expect(s.sog.length).toBe(s.x.length);
        for (let i = 1; i < s.t.length; i++) expect(s.t[i]).toBeGreaterThan(s.t[i - 1]);
      }
      if (d.bow) {
        // the trail ends at the DTL sample, inside the 60 s window
        const tn = d.trail.t[d.trail.t.length - 1];
        expect(tn).toBeLessThanOrEqual(a.meta.gunMs);
        expect(d.trail.t[0]).toBeGreaterThanOrEqual(a.meta.gunMs - START_TRAIL_MS);
      }
    }
  });
});

describe('SOG range', () => {
  it('interpolates percentiles of a sorted array', () => {
    expect(percentile([0, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBeNaN();
  });

  it('spans the 5th–95th percentile, rounded out to 0.5 kn', () => {
    // 0..100 in 0.1 kn steps: p5 = 5, p95 = 95; outliers beyond don't stretch it
    const xs = Array.from({ length: 1001 }, (_, i) => i / 10);
    expect(sogRange(xs)).toEqual({ lo: 5, hi: 95 });
    const ys = Array.from({ length: 101 }, (_, i) => 4.23 + (i / 100) * 3.5);
    const r = sogRange([...ys, 40, 0])!;
    expect(r.lo).toBe(4.0);
    expect(r.hi).toBe(8.0);
    expect(r.lo * 2).toBe(Math.round(r.lo * 2));
  });

  it('guards degenerate and empty input', () => {
    expect(sogRange([])).toBeNull();
    expect(sogRange([NaN, -1, Infinity])).toBeNull();
    expect(sogRange([6, 6, 6])).toEqual({ lo: 5.5, hi: 6.5 });
    expect(sogRange([0, 0, 0.1])).toEqual({ lo: 0, hi: 1 });
  });

  it('fits the map to the visible leg and the start chart to its window', () => {
    const a = analyzeRace(fixtureRace());
    const all = trackSogRange(a, null)!;
    const leg = trackSogRange(a, 1)!;
    const start = startSogRange(a)!;
    for (const r of [all, leg, start]) {
      expect(r.hi).toBeGreaterThan(r.lo);
      expect(r.lo).toBeGreaterThanOrEqual(0);
    }
    expect(trackSogRange(a, 1)).toBe(leg); // cached per analysis
    const legVals = a.drawings.flatMap((d) => d.segments.filter((s) => s.leg === 1).flatMap((s) => [...s.sog]));
    expect(leg).toEqual(sogRange(legVals));
    expect(start).toEqual(sogRange(a.drawings.flatMap((d) => [...d.trail.sog])));
  });
});

describe('SOG bins and colours', () => {
  const r = { lo: 4, hi: 8 };
  it('maps knots to SOG_BINS bins, clamping outside the range', () => {
    expect(SOG_BINS).toBeGreaterThanOrEqual(16);
    expect(SOG_BINS).toBeLessThanOrEqual(24);
    expect(sogBin(4, r)).toBe(0);
    expect(sogBin(3, r)).toBe(0);
    expect(sogBin(8, r)).toBe(SOG_BINS - 1);
    expect(sogBin(20, r)).toBe(SOG_BINS - 1);
    expect(sogBin(6, r)).toBe(SOG_BINS / 2);
    expect(sogBin(NaN, r)).toBe(0);
    expect(sogBin(6, r, 4)).toBe(2);
    const seen = new Set<number>();
    for (let v = 3; v <= 9; v += 0.01) seen.add(sogBin(v, r));
    expect(seen.size).toBe(SOG_BINS);
  });

  it('uses viridis, not the rank plasma, and brightens from slow to fast in both schemes', () => {
    expect(viridis(0)).toBe('#440154');
    expect(viridis(1)).toBe('#fde725');
    expect(sogColor(0)).toBe('#440154');
    expect(sogColor(1, 'dark')).toBe('#fde725');
    // Mid-scale reads teal/green, plasma's magenta/orange: clearly different hues.
    const mid = sogColor(0.5, 'dark');
    expect(mid).not.toBe(plasma(0.5));
    const g = parseInt(mid.slice(3, 5), 16);
    const red = parseInt(mid.slice(1, 3), 16);
    expect(g).toBeGreaterThan(red);
    for (const scheme of ['light', 'dark'] as const) {
      let prev = -1;
      for (let b = 0; b < SOG_BINS; b++) {
        const lum = contrast(sogColor(binPos(b), scheme), '#000000');
        expect(lum).toBeGreaterThan(prev);
        prev = lum;
      }
    }
  });

  it('keeps both ends readable: night slowest ≥ 2.5:1, day slowest dark, pale day bins cased', () => {
    expect(contrast(sogColor(0, 'dark'), SPEED_BG.dark)).toBeGreaterThanOrEqual(2.5);
    expect(contrast(sogColor(0), SPEED_BG.light)).toBeGreaterThan(10);
    expect(contrast(sogColor(1, 'dark'), SPEED_BG.dark)).toBeGreaterThan(10);
    expect(sogCasedByDay(SOG_BINS - 1)).toBe(true);
    expect(sogCasedByDay(0)).toBe(false);
  });
});

describe('batched SOG paths', () => {
  const r = { lo: 0, hi: 10 };
  const xs = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

  it('joins same-bin steps into one run and starts the next on the shared point', () => {
    const acc = emptySogPaths(10);
    addSogTrack(acc, xs(5), [0, 0, 0, 0, 0], [0, 1000, 2000, 3000, 4000], [2.2, 2.4, 2.4, 7.5, 7.5], r);
    expect(acc.bins[2]).toBe('M0.0,0.0L1.0,0.0L2.0,0.0');
    // the step 2 → 3 averages 4.95 kn (bin 4), then 7.5 (bin 7): each run begins where the last ended
    expect(acc.bins[4]).toBe('M2.0,0.0L3.0,0.0');
    expect(acc.bins[7]).toBe('M3.0,0.0L4.0,0.0');
    expect(acc.gap).toBe('');
  });

  it('draws steps over 5 s as grey gap segments, not in any colour run', () => {
    const acc = emptySogPaths(10);
    addSogTrack(acc, xs(4), [0, 0, 0, 0], [0, 1000, 8000, 9000], [5, 5, 5, 5], r);
    expect(acc.gap).toBe('M1.0,0.0L2.0,0.0');
    expect(acc.bins[5]).toBe('M0.0,0.0L1.0,0.0M2.0,0.0L3.0,0.0');
    const svg = sogPathsSvg(acc, 1.4, 1);
    expect(svg).toMatch(/<path class="sog-gap" d="M1\.0,0\.0L2\.0,0\.0" stroke-dasharray="[\d.]+ [\d.]+"\/>/);
    expect(hasGaps([[0, 1000, 8000]])).toBe(true);
    expect(hasGaps([[0, 1000, 6000]])).toBe(false);
  });

  it('skips steps leaving the clip region', () => {
    const acc = emptySogPaths(10);
    addSogTrack(acc, xs(4), [0, 0, 0, 0], [0, 1000, 2000, 3000], [5, 5, 5, 5], r, (i) => i !== 2);
    expect(acc.bins[5]).toBe('M0.0,0.0L1.0,0.0');
  });

  it('emits per boat at most one path per bin plus one gap path, however long the track', () => {
    const a = analyzeRace(fixtureRace());
    const svg = trackMap(a, null, null, { colour: 'sog' });
    expect(svg).not.toContain('<polyline class="trk');
    const groups = [...svg.matchAll(/<g class="sog-trk[^"]*" data-id="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
    expect(groups.length).toBe(a.drawings.filter((d) => d.segments.some((s) => s.x.length > 1)).length);
    let samples = 0;
    for (const d of a.drawings) for (const s of d.segments) samples += s.x.length;
    expect(samples).toBeGreaterThan(20 * groups.length * (SOG_BINS + 1)); // far more fixes than paths
    for (const [, , body] of groups) {
      const colour = (body.match(/<path class="sog" /g) ?? []).length;
      const gaps = (body.match(/<path class="sog-gap"/g) ?? []).length;
      const cases = (body.match(/<path class="sog-case"/g) ?? []).length;
      expect(colour).toBeGreaterThan(1);
      expect(colour + gaps).toBeLessThanOrEqual(SOG_BINS + 1);
      expect(gaps).toBeLessThanOrEqual(1);
      expect(cases).toBeLessThanOrEqual(1);
      const bins = [...body.matchAll(/data-bin="(\d+)"/g)].map((m) => m[1]);
      expect(new Set(bins).size).toBe(bins.length); // one path per bin
    }
    expect(svg).toMatch(/<path class="sog" data-bin="\d+" d="M[^"]+" stroke="#[0-9a-f]{6}" style="--cd:#[0-9a-f]{6}"\/>/);
    expect(svg).toContain('aria-label="Tracks coloured by boat speed (SOG)');
  });

  it('fits a single leg and labels it', () => {
    const a = analyzeRace(fixtureRace());
    const svg = trackMap(a, null, 1, { colour: 'sog' });
    const r1 = trackSogRange(a, 1)!;
    expect(svg).toContain(`coloured by boat speed (SOG), ${r1.lo.toFixed(1)} to ${r1.hi.toFixed(1)} kn`);
    expect(svg).toMatch(/aria-label="Tracks on [^"]+, coloured by boat speed/);
    expect(sogKey(r1, 'Beat 2', hasGaps(segmentTimes(a, 1)))).toContain(`${r1.lo.toFixed(1)} kn`);
  });

  it('puts the selected boat on top, thicker, outlined; the rest dimmed', () => {
    const a = analyzeRace(fixtureRace());
    const id = a.drawings[0].id;
    const svg = trackMap(a, id, null, { colour: 'sog' });
    const groups = [...svg.matchAll(/<g class="(sog-trk[^"]*)" data-id="([^"]+)" stroke-width="([\d.]+)"/g)];
    const last = groups[groups.length - 1];
    expect(last[1]).toBe('sog-trk on');
    expect(last[2]).toBe(id);
    expect(groups.slice(0, -1).every((g) => g[1] === 'sog-trk dim')).toBe(true);
    expect(Number(last[3])).toBeGreaterThan(Number(groups[0][3]));
    expect(svg).toMatch(/<path class="sog-sel" d="M[^"]+" stroke-width="[\d.]+"\/><g class="sog-trk on"/);
  });
});

describe('hover lookup', () => {
  const ix = sogIndex(
    [
      { id: 'a', x: [0, 10, 20], y: [0, 0, 0], t: [1, 2, 3], sog: [4, 5, 6] },
      { id: 'b', x: [0, 10], y: [5, 5], t: [7, 8], sog: [1, 2] },
    ],
    3,
  );
  it('finds the nearest fix within the radius, of anyone', () => {
    expect(nearestSample(ix, 9, 1, 3)).toBe(1);
    expect(ix.ids[ix.boat[nearestSample(ix, 9, 4, 3)]]).toBe('b');
    expect(nearestSample(ix, 50, 50, 3)).toBe(-1);
    expect(ix.sog[nearestSample(ix, 19, 0, 2)]).toBe(6);
  });

  it('restricts to one boat when one is selected', () => {
    const i = nearestSample(ix, 9, 4.5, 20, 'a');
    expect(ix.ids[ix.boat[i]]).toBe('a');
    expect(ix.t[i]).toBe(2);
    expect(nearestSample(ix, 9, 4.5, 20, 'nobody')).toBe(-1);
  });

  it('agrees with a linear scan over a real race', () => {
    const a = analyzeRace(fixtureRace());
    const real = trackSogIndex(a, null);
    for (let k = 0; k < 40; k++) {
      const j = (k * 7919) % real.x.length;
      const [x, y] = [real.x[j] + 3, real.y[j] - 2];
      let best = -1;
      let bd = 25;
      for (let i = 0; i < real.x.length; i++) {
        const d = (real.x[i] - x) ** 2 + (real.y[i] - y) ** 2;
        if (d <= bd) [bd, best] = [d, i];
      }
      const got = nearestSample(real, x, y, 5);
      expect((real.x[got] - x) ** 2 + (real.y[got] - y) ** 2).toBeCloseTo((real.x[best] - x) ** 2 + (real.y[best] - y) ** 2, 9);
    }
  });
});

describe('start chart in Speed', () => {
  const a = analyzeRace(m24Race());
  const starters = a.boats.filter((b) => b.start && a.drawings.find((d) => d.id === b.id)?.bow);
  const fast = starters.reduce((p, q) => (q.start!.speedKn > p.start!.speedKn ? q : p));
  const slow = starters.reduce((p, q) => (q.start!.speedKn < p.start!.speedKn ? q : p));
  const svg = startSnapshot(a, null, undefined, 'speed');
  const r = startSogRange(a)!;

  it('batches the trails by bin across the fleet, not per fix', () => {
    expect(svg).not.toContain('<polyline class="trail');
    const paths = svg.match(/<path class="sog" /g) ?? [];
    expect(paths.length).toBeGreaterThan(3);
    expect(paths.length).toBeLessThanOrEqual(2 * SOG_BINS);
    expect(svg).toMatch(/<g class="trail sog" stroke-width="[\d.]+">/);
  });

  it('fits the range to the 60 s window', () => {
    const vals = a.drawings.flatMap((d) => [...d.trail.sog]).filter(Number.isFinite);
    expect(r).toEqual(sogRange(vals));
    expect(svg).toContain(`coloured by speed over ground, ${r.lo.toFixed(1)} to ${r.hi.toFixed(1)} kn`);
  });

  it('shows a fast boat at the gun clearly apart from a slow one', () => {
    expect(fast.start!.speedKn - slow.start!.speedKn).toBeGreaterThan(2);
    const fill = (id: string): string => new RegExp(`data-id="${id}">[\\s\\S]*?class="(?:hull )?sog-fill"[^>]*fill="(#[0-9a-f]{6})"`).exec(svg)![1];
    expect(fill(fast.id)).not.toBe(fill(slow.id));
    expect(sogBin(fast.start!.speedKn, r) - sogBin(slow.start!.speedKn, r)).toBeGreaterThanOrEqual(SOG_BINS / 4);
    // and the last stretch of each trail (into the bow) lands in different bins
    const tail = (id: string): number => {
      const d = a.drawings.find((x) => x.id === id)!.trail;
      const n = d.sog.length;
      return sogBin((d.sog[n - 2] + d.sog[n - 1]) / 2, r);
    };
    expect(tail(fast.id)).toBeGreaterThan(tail(slow.id));
    expect(svg).toMatch(new RegExp(`<title>#${fast.sail}: [^<]*SOG ${fast.start!.speedKn.toFixed(1)} kn at the gun</title>`));
  });

  it('keeps Boat as before, and dims trails of others under a selection', () => {
    expect(startSnapshot(a, null)).toBe(startSnapshot(a, null, undefined, 'boat'));
    expect(startSnapshot(a, null)).toContain('<polyline class="trail');
    const sel = startSnapshot(a, fast.id, undefined, 'speed');
    expect(sel).toMatch(/<g class="trail sog dim"/);
  });

  it('renders the toggle and parses its stored value', () => {
    expect(startColourControls('boat')).toContain('data-start-colour="boat" aria-pressed="true"');
    expect(startColourControls('speed')).toContain('data-start-colour="speed" aria-pressed="true"');
    expect(startColourControls('speed')).toMatch(/role="group" aria-label="Colour start trails by"/);
    expect(parseStartColour('speed')).toBe('speed');
    for (const bad of [null, undefined, '', 'Speed', 'sog']) expect(parseStartColour(bad)).toBe('boat');
  });
});
