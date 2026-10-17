import { describe, expect, it } from 'vitest';
import {
  bearingVec,
  circMean,
  gradientAt,
  interp,
  interpAngle,
  makeProjection,
  median,
  vecBearing,
  wrap180,
} from '../src/analysis/geo';
import { firstClosest } from '../src/analysis/legs';
import type { XYTrack } from '../src/analysis/prepare';
import { estimateTwd, makeTwdAt, tackModes } from '../src/analysis/wind';

describe('angles', () => {
  it('wraps to (-180, 180]', () => {
    expect(wrap180(190)).toBe(-170);
    expect(wrap180(-190)).toBe(170);
    expect(wrap180(180)).toBe(180);
    expect(wrap180(-180)).toBe(180);
    expect(wrap180(12 - 335)).toBeCloseTo(37);
  });

  it('takes circular means across north', () => {
    expect(circMean([350, 10])).toBeCloseTo(0, 6);
    expect(circMean([340, 50])).toBeCloseTo(15, 6);
  });

  it('round-trips bearings and vectors', () => {
    for (const b of [0, 45, 112, 270, 359]) expect(vecBearing(bearingVec(b))).toBeCloseTo(b, 6);
  });
});

describe('interpolation', () => {
  it('matches numpy.interp including clamping', () => {
    expect(interp([0, 10], [0, 100], 2.5)).toBe(25);
    expect(interp([0, 10], [0, 100], -5)).toBe(0);
    expect(interp([0, 10], [0, 100], 50)).toBe(100);
  });

  it('interpolates headings through north the short way', () => {
    expect(interpAngle([0, 1], [350, 10], 0.5)).toBeCloseTo(0, 6);
  });

  it('computes numpy.gradient-style derivatives on uneven spacing', () => {
    const x = [0, 1, 3, 6];
    const y = x.map((v) => v * v);
    expect(gradientAt(x, y, 1)).toBeCloseTo(2, 9); // exact for quadratics
    expect(gradientAt(x, y, 0)).toBe(1);
  });

  it('medians', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('local projection', () => {
  it('gives ~111 km per degree of latitude and shrinks longitude by cos(lat)', () => {
    const p = makeProjection({ lat: 52.345, lon: 5.076 });
    const [, y] = p.toXY(52.355, 5.076);
    expect(y).toBeCloseTo(1112, 0);
    const [x] = p.toXY(52.345, 5.086);
    expect(x).toBeCloseTo(1112 * Math.cos((52.345 * Math.PI) / 180), 0);
  });
});

describe('wind from tack headings', () => {
  // Wind from 10°, tacking through ~76°: headings ~ 332° and ~48° with noise.
  const hs: number[] = [];
  for (let i = 0; i < 200; i++) hs.push(332 + ((i * 7) % 9) - 4, 48 + ((i * 5) % 9) - 4);

  it('finds the two tack modes', () => {
    const { centers, counts } = tackModes(hs);
    const sorted = centers.map((c) => wrap180(c)).sort((a, b) => a - b);
    expect(sorted[0]).toBeCloseTo(-28, 0);
    expect(sorted[1]).toBeCloseTo(48, 0);
    expect(counts).toEqual([200, 200]);
  });

  it('takes the bisector as the TWD', () => {
    const est = estimateTwd(hs)!;
    expect(est.twdDeg).toBeCloseTo(10, 0);
    expect(est.tackAngleDeg).toBeCloseTo(76, 0);
  });

  it('refuses one-tack data', () => {
    expect(estimateTwd(hs.filter((h) => h > 300))).toBeNull();
  });

  it('blends estimates linearly in time and clamps outside', () => {
    const f = makeTwdAt(
      [
        { tMs: 0, twdDeg: 350 },
        { tMs: 100, twdDeg: 10 },
      ],
      0,
    );
    expect(f(-5)).toBe(350);
    expect(f(50)).toBeCloseTo(0, 6);
    expect(f(500)).toBe(10);
  });
});

describe('mark approach', () => {
  // A boat sailing north along x = 20 past a mark at (0, 100).
  const n = 200;
  const tr: XYTrack = {
    t: Float64Array.from({ length: n }, (_, i) => i * 1000),
    x: new Float64Array(n).fill(20),
    y: Float64Array.from({ length: n }, (_, i) => i),
    sog: new Float64Array(n).fill(2),
    heading: new Float64Array(n),
  };

  it('returns the closest approach after first coming within range', () => {
    const hit = firstClosest(tr, 0, [[0, 100]]);
    expect(hit!.t).toBe(100_000);
    expect(hit!.d).toBeCloseTo(20);
  });

  it('uses the nearer mark of a gate', () => {
    const hit = firstClosest(tr, 0, [
      [100, 50],
      [30, 150],
    ]);
    expect(hit!.t).toBe(150_000);
  });

  it('follows a mark that is moved mid-race', () => {
    // Mark sits at (20, 100) until t = 50 s, then is re-laid at (500, 100).
    const moving = (t: number): [number, number][] => [t < 50_000 ? [20, 100] : [500, 100]];
    expect(firstClosest(tr, 0, moving)).toBeNull();
    const early = (t: number): [number, number][] => [t < 150_000 ? [20, 100] : [500, 100]];
    expect(firstClosest(tr, 0, early)!.t).toBe(100_000);
  });

  it('returns null when never in range', () => {
    expect(firstClosest(tr, 0, [[500, 100]])).toBeNull();
  });
});
