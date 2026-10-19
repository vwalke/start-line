import { describe, expect, it } from 'vitest';
import { analyzeRace } from '../src/analysis/analyze';
import { COVERAGE_GAP_S, LOW_COVERAGE, coverage } from '../src/analysis/coverage';
import { c31Race, fixtureRace } from './helpers';

const every = (from: number, to: number, step: number): number[] => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

describe('coverage', () => {
  it('uses the distance ~ threshold and flags below 90%', () => {
    expect(COVERAGE_GAP_S).toBe(5);
    expect(LOW_COVERAGE).toBe(0.9);
  });

  it('is 100% with no gaps, at any fix spacing up to 5 s', () => {
    expect(coverage(every(0, 300_000, 1000), 0, 300_000)).toEqual({ coverage: 1, maxGapS: 1 });
    expect(coverage(every(0, 300_000, 5000), 0, 300_000)).toEqual({ coverage: 1, maxGapS: 5 });
  });

  it('is 90% with one 30 s hole in a 300 s leg', () => {
    const t = [...every(0, 100_000, 1000), ...every(130_000, 300_000, 1000)];
    expect(coverage(t, 0, 300_000)).toEqual({ coverage: 0.9, maxGapS: 30 });
  });

  it('counts only the part of a hole inside the leg, and time outside the track', () => {
    // A 40 s hole from −20 s to +20 s: the leg loses 20 s of 200.
    const t = [...every(-60_000, -20_000, 1000), ...every(20_000, 200_000, 1000)];
    const c = coverage(t, 0, 200_000);
    expect(c.coverage).toBeCloseTo(0.9, 9);
    expect(c.maxGapS).toBe(40);
    // Track ending 20 s before the leg does.
    expect(coverage(every(0, 180_000, 1000), 0, 200_000)).toEqual({ coverage: 0.9, maxGapS: 20 });
    // No fixes at all.
    expect(coverage([], 0, 10_000)).toEqual({ coverage: 0, maxGapS: 10 });
  });

  it('a leg ending exactly on a hole boundary loses none of it', () => {
    const t = [...every(0, 100_000, 1000), ...every(130_000, 200_000, 1000)];
    expect(coverage(t, 0, 100_000).coverage).toBe(1);
    expect(coverage(t, 130_000, 200_000).coverage).toBe(1);
  });
});

describe('coverage on the fixtures', () => {
  it('Benelux J70 r8 (full rate): every leg and race fully covered', () => {
    const a = analyzeRace(fixtureRace());
    for (const b of a.boats) {
      expect(b.coverage).toBe(1);
      expect(b.legs.every((l) => l!.coverage === 1 && l!.maxGapS <= COVERAGE_GAP_S)).toBe(true);
    }
  });

  it('C31 r10: the holes at the gun (Black Pearl 17 s, Milkwave 32 s) fall in leg 1', () => {
    const data = c31Race();
    const a = analyzeRace(data);
    const gun = data.gunMs;
    for (const [sail, hole] of [['GER42', 17.1], ['ITA 78', 31.7]] as const) {
      const t = data.boats.find((b) => b.sail === sail)!.track.t;
      const k = t.findIndex((x) => x > gun);
      expect((t[k] - t[k - 1]) / 1000).toBeCloseTo(hole, 1);
      // The part after the gun is uncovered time in leg 1.
      expect(coverage(t, gun, t[k])).toEqual({ coverage: 0, maxGapS: (t[k] - t[k - 1]) / 1000 });
      const leg1 = a.boats.find((b) => b.sail === sail)!.legs[0]!;
      expect(leg1.startMs).toBe(gun);
      expect(leg1.maxGapS).toBeGreaterThanOrEqual(hole);
      expect(leg1.coverage).toBeLessThan(LOW_COVERAGE);
    }
  });

  it('C31 r10: the public track is mostly holes, and the race figure is the time-weighted legs', () => {
    const a = analyzeRace(c31Race());
    for (const b of a.boats) {
      expect(b.coverage!).toBeLessThan(0.5);
      const T = b.legs.reduce((s, l) => s + l!.timeS, 0);
      expect(b.coverage!).toBeCloseTo(b.legs.reduce((s, l) => s + l!.coverage * l!.timeS, 0) / T, 6);
    }
  });
});
